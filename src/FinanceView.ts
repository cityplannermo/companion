import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	advanceRecurringOccurrence,
	applyEventEdit,
	CompanionInvoice,
	CompanionReminder,
	createQuickNote,
	getInvoices,
	getReminders,
	monthlyEquivalentCost,
	setInvoicePaid,
} from "./data";
import type { RecurKind } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import type { DropdownValue } from "./eventEditorUI";
import { DEFAULT_CURRENCY, codeForInvoiceMarker, formatMoney } from "./currencies";
import { formatDate, formatDisplayShortDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_FINANCE = "companion-finance-view";

// Finance's own "+ New item" only ever wants to create one of these three --
// unlike the Calendar's "+", which is a genuine choice across every
// convertible type, anything created from Finance is inherently one of
// Subscription/Expense/Income by definition of being started from this tab.
// Offering Meeting/Event/Reminder/Invoice reminder/Task/Post here would just
// be a way to create the wrong kind of note and have it show up on the
// calendar instead of in this list -- see openCreate/openEditor below.
const FINANCE_ALLOWED_TYPES: DropdownValue[] = ["subscription", "expense", "income"];

/**
 * Companion's Finance tab: Subscriptions, Expenses, Income (Reminders) and
 * Income (Invoices), each an ordinary Reminder or Invoice note distinguished
 * purely by which fields are set -- see subscriptions()/expenses()/
 * incomeReminders() below and CompanionReminder/CompanionInvoice in
 * data.ts. No dedicated note type for any of it. Creating and editing all
 * go through the same New/Edit item modal as the Calendar's own "+" (see
 * openCreate/openEditor below), just with its type dropdown narrowed to
 * the three financial types -- see FINANCE_ALLOWED_TYPES above.
 */
export class FinanceView extends ItemView {
	private reminders: CompanionReminder[] = [];
	private invoices: CompanionInvoice[] = [];
	private selection = new Selection();

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FINANCE;
	}

	getDisplayText(): string {
		return "Finance";
	}

	getIcon(): string {
		return "wallet";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to tear down — no timers, no external connections
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault
	 * changes. Invoices need an async content read per file (their total
	 * lives only in body text -- see getInvoices), so this whole method is
	 * async; callers that can't await just let the returned promise run. */
	async refresh(): Promise<void> {
		this.reminders = getReminders(this.app);
		this.invoices = await getInvoices(this.app);
		this.render();
	}

	/** Subscriptions, Expenses and Income (Reminders) are all cost-bearing
	 * Reminders, distinguished by `recur` and the `income` flag -- every
	 * such Reminder lands in exactly one of these three lists. See
	 * CompanionEvent.income in data.ts for why direction is a flag rather
	 * than a separate note type. */
	private subscriptions(): CompanionReminder[] {
		return this.reminders.filter((r) => !!r.recur && r.cost != null && !r.income).sort(byDate);
	}

	private expenses(): CompanionReminder[] {
		return this.reminders.filter((r) => !r.recur && r.cost != null && !r.income).sort(byDate);
	}

	private incomeReminders(): CompanionReminder[] {
		return this.reminders.filter((r) => r.cost != null && r.income).sort(byDate);
	}

	private selectableItems(): CompanionReminder[] {
		return [...this.subscriptions(), ...this.expenses(), ...this.incomeReminders()];
	}

	private selectedFiles(): TFile[] {
		const selected = new Set(this.selection.all());
		return this.selectableItems().filter((r) => selected.has(r.file.path)).map((r) => r.file);
	}

	private afterDelete(): void {
		this.selection.clear();
		void this.refresh();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-finance-root");

		this.renderHeader(root);
		renderSelectionBar(
			root,
			this.selection.size,
			() => confirmAndDelete(this.app, this.selectedFiles(), this.settings.confirmBeforeDelete, () => this.afterDelete()),
			() => {
				this.selection.clear();
				this.render();
			}
		);
		this.renderOverview(root);
		this.renderMonthlyRunRate(root);
		this.renderSubscriptions(root);
		this.renderExpenses(root);
		this.renderIncomeReminders(root);
		this.renderIncome(root);
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-finance-header" });
		header.createEl("h2", { text: "Finance" });

		const actions = header.createDiv({ cls: "companion-finance-header-actions" });
		const addBtn = actions.createEl("button", { cls: "companion-icon-btn companion-icon-btn-accent mod-cta", attr: { "aria-label": "New item" } });
		setIcon(addBtn, "plus");
		addBtn.onclick = () => this.openCreate();
	}

	/** Buckets a list of cost-bearing reminders by currency code (an entry
	 * with no `currency` field defaults to DEFAULT_CURRENCY -- everything
	 * written before currencies existed), summing each bucket through
	 * `amountFn`. Shared by every per-section total below and by
	 * renderOverview()/renderMonthlyRunRate(), so a Subscription in USD is
	 * never silently added to one in GBP -- Mo's own "all currencies, since
	 * this is a public tool" request from 2 September 2026. */
	private bucketByCurrency(items: CompanionReminder[], amountFn: (r: CompanionReminder) => number): Map<string, number> {
		const totals = new Map<string, number>();
		for (const r of items) {
			const code = r.currency ?? DEFAULT_CURRENCY;
			totals.set(code, (totals.get(code) ?? 0) + amountFn(r));
		}
		return totals;
	}

	/** Renders a currency-bucketed total as e.g. "£45.00/month + USD
	 * 20.00/month" -- DEFAULT_CURRENCY first (Mo's own), then every other
	 * currency present, alphabetically by code. Zero-amount buckets are
	 * dropped. "" when there's nothing to show at all. */
	private formatBucketed(totals: Map<string, number>, suffix = ""): string {
		const entries = [...totals.entries()].filter(([, amt]) => amt !== 0);
		entries.sort(([a], [b]) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)));
		return entries.map(([code, amt]) => `${formatMoney(code, amt)}${suffix}`).join(" + ");
	}

	/** Every invoice's amount, bucketed by currency code -- the running
	 * total ever raised, and the subset of it actually marked paid. An
	 * invoice's own `currencySymbol` is whatever marker was actually
	 * written into its body (a bare symbol for GBP/EUR/JPY, "CODE " for
	 * everything else -- see currencies.ts), so codeForInvoiceMarker()
	 * recovers the code before bucketing, the same way bucketByCurrency()
	 * above does for Reminders -- otherwise a GBP invoice ("£") and a GBP
	 * one-off Income entry ("GBP") would land in two different buckets in
	 * renderOverview() below. Shared by renderIncome() (the Invoiced
	 * section's own header line) and renderOverview() below, so the two can
	 * never drift apart. */
	private invoiceTotals(): { total: Map<string, number>; paid: Map<string, number> } {
		const total = new Map<string, number>();
		const paid = new Map<string, number>();
		for (const inv of this.invoices) {
			if (inv.amount == null) continue;
			const code = codeForInvoiceMarker(inv.currencySymbol || "£");
			total.set(code, (total.get(code) ?? 0) + inv.amount);
			if (inv.paid) paid.set(code, (paid.get(code) ?? 0) + inv.amount);
		}
		return { total, paid };
	}

	/** "To date" -- money actually in hand (paid invoices + one-off Income)
	 * against money actually out (one-off Expenses), netted per currency.
	 * Deliberately excludes recurring Subscriptions/Income: Companion only
	 * tracks a recurring item's *next* due date, not how many periods have
	 * actually elapsed and been paid since it started, so a running total
	 * for those would be a guess dressed up as a fact -- the Recurring
	 * run-rate line below covers them instead, as a forward-looking monthly
	 * figure, not a total. Each currency present gets its own in/out/net --
	 * never merged into one number across currencies, since that would need
	 * an exchange rate Companion doesn't have. Hidden entirely when there's
	 * nothing to report at all. */
	private renderOverview(parent: HTMLElement): void {
		const { paid: paidInvoices } = this.invoiceTotals();
		const oneOffIncome = this.bucketByCurrency(
			this.incomeReminders().filter((r) => !r.recur),
			(r) => r.cost ?? 0
		);
		const oneOffExpenses = this.bucketByCurrency(this.expenses(), (r) => r.cost ?? 0);

		const inTotals = new Map<string, number>(oneOffIncome);
		for (const [code, amt] of paidInvoices) inTotals.set(code, (inTotals.get(code) ?? 0) + amt);

		if (inTotals.size === 0 && oneOffExpenses.size === 0) return;

		const currencies = [...new Set([...inTotals.keys(), ...oneOffExpenses.keys()])].sort((a, b) =>
			a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)
		);
		const lines = currencies.map((code) => {
			const income = inTotals.get(code) ?? 0;
			const expense = oneOffExpenses.get(code) ?? 0;
			const net = income - expense;
			const netText = net === 0 ? "break-even" : `net ${formatMoney(code, Math.abs(net))} ${net > 0 ? "in" : "out"}`;
			return `${formatMoney(code, income)} in, ${formatMoney(code, expense)} out — ${netText}`;
		});

		parent.createDiv({
			cls: "companion-finance-overview",
			text: `To date: ${lines.join("; ")}`,
		});
	}

	/** A one-line "how much moves every month" figure -- Subscriptions'
	 * monthly-equivalent total against recurring Income's own (both use the
	 * same monthlyEquivalentCost() normalisation across daily/weekly/
	 * monthly/yearly/biennial), netted per currency. Deliberately excludes
	 * one-off Expenses and Income -- those aren't recurring, so they'd
	 * distort a per-month figure rather than inform it; Income (Invoices)
	 * below has its own "paid so far" line for actuals. Hidden entirely
	 * when there's nothing recurring on either side, rather than showing
	 * "£0.00". Nets in and out for a currency only when that currency is
	 * the only one recurring on either side -- summing two different
	 * currencies into one net figure would need an exchange rate. */
	private renderMonthlyRunRate(parent: HTMLElement): void {
		const outgoing = this.bucketByCurrency(this.subscriptions(), (r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind));
		const incoming = this.bucketByCurrency(
			this.incomeReminders().filter((r) => !!r.recur),
			(r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind)
		);
		if (outgoing.size === 0 && incoming.size === 0) return;

		const inText = this.formatBucketed(incoming, "/month") || `${formatMoney(DEFAULT_CURRENCY, 0)}/month`;
		const outText = this.formatBucketed(outgoing, "/month") || `${formatMoney(DEFAULT_CURRENCY, 0)}/month`;

		const currencies = new Set([...outgoing.keys(), ...incoming.keys()]);
		let netText = "";
		if (currencies.size <= 1) {
			const code = [...currencies][0] ?? DEFAULT_CURRENCY;
			const net = (incoming.get(code) ?? 0) - (outgoing.get(code) ?? 0);
			netText = net === 0 ? " — break-even" : ` — net ${formatMoney(code, Math.abs(net))}/month ${net > 0 ? "in" : "out"}`;
		}

		parent.createDiv({
			cls: "companion-finance-run-rate",
			text: `Recurring: ${inText} in, ${outText} out${netText}`,
		});
	}

	/** Subscriptions -- reminders with both a repeat rule and a cost, no
	 * income flag -- get a running monthly-equivalent total in the section
	 * header, and a Renew action per row that rolls the reminder's own due
	 * date forward one period in place (see advanceRecurringOccurrence in
	 * data.ts) rather than creating any new note. Edit/Select/Delete work
	 * the same as any other reminder row. */
	private renderSubscriptions(parent: HTMLElement): void {
		const items = this.subscriptions();
		const todayStr = formatDate(new Date());
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No subscriptions yet." });
			return;
		}

		const totals = this.bucketByCurrency(items, (r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind));
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Subscriptions (${items.length}) — ${this.formatBucketed(totals, "/month")}` });

		for (const sub of items) {
			const row = list.createDiv({ cls: "companion-list-row" });
			row.toggleClass("is-selected", this.selection.has(sub.file.path));
			row.oncontextmenu = (e) =>
				showDeleteMenu(
					this.app,
					e,
					sub.file,
					this.selectedFiles(),
					this.settings.confirmBeforeDelete,
					() => this.afterDelete(),
					() => this.openEditor(sub),
					() => {
						this.selection.toggle(sub.file.path);
						this.render();
					},
					() => {
						this.selection.clear();
						this.render();
					}
				);

			row.createDiv({
				cls: "companion-list-row-date",
				text: sub.date ? formatDisplayShortDate(sub.date) : "No date",
			});
			if (sub.date && sub.date < todayStr) row.addClass("companion-reminder-overdue");

			const title = row.createDiv({ cls: "companion-list-row-title", text: sub.title });
			makeOpenable(this.app, title, sub.file, {
				onToggleSelect: () => {
					this.selection.toggle(sub.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});

			row.createDiv({
				cls: "companion-subscription-cost",
				text: `${formatMoney(sub.currency ?? DEFAULT_CURRENCY, sub.cost ?? 0)}/${periodSuffix(sub.recur as RecurKind)}`,
			});

			const renew = row.createSpan({ cls: "companion-item-rename-btn", attr: { "aria-label": "Renew -- push the due date forward one period" } });
			setIcon(renew, "rotate-cw");
			renew.onclick = (e) => {
				e.stopPropagation();
				advanceRecurringOccurrence(this.app, sub.file).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			};
		}
	}

	/** Expenses -- one-off reminders with a cost but no repeat rule and no
	 * income flag, the exact complement of subscriptions() above. A running
	 * total in the section header; no Renew button, since a one-off has
	 * nothing to roll forward. */
	private renderExpenses(parent: HTMLElement): void {
		const items = this.expenses();
		const todayStr = formatDate(new Date());
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No expenses yet." });
			return;
		}

		const totals = this.bucketByCurrency(items, (r) => r.cost ?? 0);
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Expenses (${items.length}) — ${this.formatBucketed(totals)}` });

		for (const exp of items) {
			const row = list.createDiv({ cls: "companion-list-row" });
			row.toggleClass("is-selected", this.selection.has(exp.file.path));
			row.oncontextmenu = (e) =>
				showDeleteMenu(
					this.app,
					e,
					exp.file,
					this.selectedFiles(),
					this.settings.confirmBeforeDelete,
					() => this.afterDelete(),
					() => this.openEditor(exp),
					() => {
						this.selection.toggle(exp.file.path);
						this.render();
					},
					() => {
						this.selection.clear();
						this.render();
					}
				);

			row.createDiv({
				cls: "companion-list-row-date",
				text: exp.date ? formatDisplayShortDate(exp.date) : "No date",
			});
			if (exp.date && exp.date < todayStr) row.addClass("companion-reminder-overdue");

			const title = row.createDiv({ cls: "companion-list-row-title", text: exp.title });
			makeOpenable(this.app, title, exp.file, {
				onToggleSelect: () => {
					this.selection.toggle(exp.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});

			row.createDiv({ cls: "companion-subscription-cost", text: formatMoney(exp.currency ?? DEFAULT_CURRENCY, exp.cost ?? 0) });
		}
	}

	/** Income (Reminders) -- ad hoc or recurring incoming money with no
	 * client or invoice behind it (see CompanionEvent.income in data.ts),
	 * the mirror image of Subscriptions/Expenses above: same Reminder
	 * shape, `income: true` instead of absent, `recur` optional either
	 * way. A running total (one-off entries only, same convention as
	 * Expenses' total -- recurring ones are in the run-rate line above
	 * instead). No Paid toggle here -- unlike an Invoice, one of these only
	 * ever gets created once the money's already in hand or is a standing
	 * expectation, not something invoiced and awaiting payment. */
	private renderIncomeReminders(parent: HTMLElement): void {
		const items = this.incomeReminders();
		const todayStr = formatDate(new Date());
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No other income yet." });
			return;
		}

		const totals = this.bucketByCurrency(
			items.filter((r) => !r.recur),
			(r) => r.cost ?? 0
		);
		const totalText = this.formatBucketed(totals);
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Income (${items.length})${totalText ? ` — ${totalText}` : ""}` });

		for (const inc of items) {
			const row = list.createDiv({ cls: "companion-list-row" });
			row.toggleClass("is-selected", this.selection.has(inc.file.path));
			row.oncontextmenu = (e) =>
				showDeleteMenu(
					this.app,
					e,
					inc.file,
					this.selectedFiles(),
					this.settings.confirmBeforeDelete,
					() => this.afterDelete(),
					() => this.openEditor(inc),
					() => {
						this.selection.toggle(inc.file.path);
						this.render();
					},
					() => {
						this.selection.clear();
						this.render();
					}
				);

			row.createDiv({
				cls: "companion-list-row-date",
				text: inc.date ? formatDisplayShortDate(inc.date) : "No date",
			});
			if (inc.date && inc.date < todayStr) row.addClass("companion-reminder-overdue");

			const title = row.createDiv({ cls: "companion-list-row-title", text: inc.title });
			makeOpenable(this.app, title, inc.file, {
				onToggleSelect: () => {
					this.selection.toggle(inc.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});

			const amount = formatMoney(inc.currency ?? DEFAULT_CURRENCY, inc.cost ?? 0);
			const costText = inc.recur ? `${amount}/${periodSuffix(inc.recur)}` : amount;
			row.createDiv({ cls: "companion-subscription-cost", text: costText });
		}
	}

	/** Invoiced income -- every invoice ever generated (see getInvoices in
	 * data.ts), summed per currency (see invoiceTotals() above) since a
	 * client can be billed in a different currency from another and the two
	 * shouldn't be merged into one misleading total. The headline total is
	 * every invoice ever raised, invoiced not collected, same as always --
	 * but each row also carries its own `paid` flag now (see
	 * setInvoicePaid in data.ts), and the line under the total splits out
	 * how much of it has actually come in. Otherwise still read-only: rows
	 * open the invoice note itself, and creating or amending an invoice's
	 * own content goes through the dedicated Invoice Create Procedure, not
	 * this view -- Paid is the one thing this view itself writes. */
	private renderIncome(parent: HTMLElement): void {
		const items = this.invoices;
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No invoices yet." });
			return;
		}

		const { total: totals, paid: paidTotals } = this.invoiceTotals();
		const totalText = this.formatBucketed(totals);
		const paidText = this.formatBucketed(paidTotals);

		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Invoiced (${items.length})${totalText ? ` — ${totalText} invoiced` : ""}` });
		if (paidText) {
			list.createDiv({ cls: "companion-empty", text: `${paidText} paid so far` });
		}

		for (const inv of items) {
			const row = list.createDiv({ cls: "companion-list-row" });
			row.toggleClass("companion-invoice-row-paid", inv.paid);

			row.createDiv({
				cls: "companion-list-row-date",
				text: inv.date ? formatDisplayShortDate(inv.date) : "No date",
			});

			const title = row.createDiv({ cls: "companion-list-row-title", text: inv.client });
			makeOpenable(this.app, title, inv.file);

			row.createDiv({
				cls: "companion-subscription-cost",
				text: inv.amount != null ? `${inv.currencySymbol}${inv.amount.toFixed(2)}` : "—",
			});

			const paidBtn = row.createEl("button", {
				cls: "companion-icon-btn",
				attr: { "aria-label": inv.paid ? "Mark unpaid" : "Mark paid" },
			});
			paidBtn.toggleClass("companion-invoice-paid-btn-active", inv.paid);
			setIcon(paidBtn, inv.paid ? "check-circle" : "circle");
			paidBtn.onclick = () => {
				setInvoicePaid(this.app, inv.file, !inv.paid).then(
					() => void this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			};
		}
	}

	/** Opens the same shared New item modal as the Calendar's own "+", but
	 * with its type dropdown narrowed to Subscription/Expense/Income only
	 * (see FINANCE_ALLOWED_TYPES above) -- anything created from Finance is
	 * one of the three by definition, so there's no reason to also offer
	 * Meeting/Event/Reminder/Invoice reminder/Task/Post here. Cost is
	 * required for all three (enforced by the modal itself), so whatever's
	 * created always lands in one of subscriptions()/expenses()/
	 * incomeReminders() on refresh. */
	private openCreate(): void {
		new EventEditorModal(
			this.app,
			"create",
			{ title: "", type: "reminder", date: formatDate(new Date()), timeStr: "00:00" },
			(result) => {
				createQuickNote(
					this.app,
					result.type,
					result.date,
					result.title,
					result.allDay ? "00:00" : result.startTime,
					result.allDay ? undefined : result.endTime,
					result.client,
					result.recur,
					result.cost,
					result.invoiceReminder,
					result.remind,
					result.income,
					result.currency
				).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			undefined,
			FINANCE_ALLOWED_TYPES
		).open();
	}

	/** Opens the shared editor modal on an existing Subscription, Expense
	 * or Income reminder -- same modal the Calendar uses for its own items,
	 * with the same Subscription/Expense/Income-only dropdown as
	 * openCreate() above, so changing Repeat/Cost/the Income flag (or
	 * switching between the three) here behaves identically to creating
	 * one, just pre-filled. */
	private openEditor(reminder: CompanionReminder): void {
		new EventEditorModal(
			this.app,
			"edit",
			{
				title: reminder.title,
				type: "reminder",
				date: reminder.date ?? formatDate(new Date()),
				timeStr: reminder.time,
				recur: reminder.recur,
				remind: reminder.remind,
				cost: reminder.cost,
				currency: reminder.currency,
				invoiceReminder: reminder.invoiceReminder,
				income: reminder.income,
			},
			(result) => {
				applyEventEdit(this.app, reminder.file, "reminder", {
					title: result.title,
					type: result.type,
					dateStr: result.date,
					timeStr: result.allDay ? "00:00" : result.startTime,
					endTimeStr: result.allDay ? undefined : result.endTime,
					client: result.client,
					recur: result.recur,
					remind: result.remind,
					cost: result.cost,
					currency: result.currency,
					invoiceReminder: result.invoiceReminder,
					income: result.income,
				}).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			undefined,
			FINANCE_ALLOWED_TYPES
		).open();
	}
}

function periodSuffix(kind: RecurKind): string {
	if (kind === "daily") return "day";
	if (kind === "weekly") return "week";
	if (kind === "monthly") return "mo";
	if (kind === "yearly") return "yr";
	return "2yr";
}

function byDate(a: CompanionReminder, b: CompanionReminder): number {
	return (a.date ?? "").localeCompare(b.date ?? "");
}
