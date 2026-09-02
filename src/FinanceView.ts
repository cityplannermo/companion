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

	/** Every invoice's amount, bucketed by currency symbol -- the running
	 * total ever raised, and the subset of it actually marked paid. Shared
	 * by renderIncome() (the Invoiced section's own header line) and
	 * renderOverview() below, so the two can never drift apart. */
	private invoiceTotals(): { total: Map<string, number>; paid: Map<string, number> } {
		const total = new Map<string, number>();
		const paid = new Map<string, number>();
		for (const inv of this.invoices) {
			if (inv.amount == null) continue;
			const key = inv.currencySymbol || "£";
			total.set(key, (total.get(key) ?? 0) + inv.amount);
			if (inv.paid) paid.set(key, (paid.get(key) ?? 0) + inv.amount);
		}
		return { total, paid };
	}

	/** "To date" -- money actually in hand (paid invoices + one-off Income)
	 * against money actually out (one-off Expenses), netted. Deliberately
	 * excludes recurring Subscriptions/Income: Companion only tracks a
	 * recurring item's *next* due date, not how many periods have actually
	 * elapsed and been paid since it started, so a running total for those
	 * would be a guess dressed up as a fact -- the Recurring run-rate line
	 * below covers them instead, as a forward-looking monthly figure, not a
	 * total. £ only for Expenses/Income (see CompanionEvent.income) -- a $
	 * total from invoices, if there is one, is reported alongside rather
	 * than merged into a total that would mean nothing without an exchange
	 * rate. Hidden entirely when there's nothing to report at all. */
	private renderOverview(parent: HTMLElement): void {
		const { paid: paidInvoices } = this.invoiceTotals();
		const paidGBP = paidInvoices.get("£") ?? 0;
		const otherPaid = [...paidInvoices.entries()].filter(([sym]) => sym !== "£");

		const oneOffIncome = this.incomeReminders()
			.filter((r) => !r.recur)
			.reduce((sum, r) => sum + (r.cost ?? 0), 0);
		const oneOffExpenses = this.expenses().reduce((sum, r) => sum + (r.cost ?? 0), 0);
		const income = paidGBP + oneOffIncome;

		if (income === 0 && oneOffExpenses === 0 && otherPaid.length === 0) return;

		const net = income - oneOffExpenses;
		const netText = net === 0 ? "break-even" : `net £${Math.abs(net).toFixed(2)} ${net > 0 ? "in" : "out"}`;
		const otherPaidText = otherPaid.length
			? ` (+ ${otherPaid.map(([sym, amt]) => `${sym}${amt.toFixed(2)}`).join(" + ")} invoiced, paid)`
			: "";

		parent.createDiv({
			cls: "companion-finance-overview",
			text: `To date: £${income.toFixed(2)} in, £${oneOffExpenses.toFixed(2)} out — ${netText}${otherPaidText}`,
		});
	}

	/** A one-line "how much moves every month" figure -- Subscriptions'
	 * monthly-equivalent total against recurring Income's own (both use the
	 * same monthlyEquivalentCost() normalisation across daily/weekly/
	 * monthly/yearly/biennial), netted. Deliberately excludes one-off
	 * Expenses and Income -- those aren't recurring, so they'd distort a
	 * per-month figure rather than inform it; Income (Invoices) below has
	 * its own "paid so far" line for actuals. Hidden entirely when there's
	 * nothing recurring on either side, rather than showing "£0.00". */
	private renderMonthlyRunRate(parent: HTMLElement): void {
		const outgoing = this.subscriptions().reduce((sum, r) => sum + monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind), 0);
		const incoming = this.incomeReminders()
			.filter((r) => !!r.recur)
			.reduce((sum, r) => sum + monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind), 0);
		if (outgoing === 0 && incoming === 0) return;

		const net = incoming - outgoing;
		const netText = net === 0 ? "break-even" : `net £${Math.abs(net).toFixed(2)}/month ${net > 0 ? "in" : "out"}`;
		parent.createDiv({
			cls: "companion-finance-run-rate",
			text: `Recurring: £${incoming.toFixed(2)}/month in, £${outgoing.toFixed(2)}/month out — ${netText}`,
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

		const total = items.reduce((sum, r) => sum + monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind), 0);
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Subscriptions (${items.length}) — £${total.toFixed(2)}/month` });

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
				text: `£${(sub.cost ?? 0).toFixed(2)}/${periodSuffix(sub.recur as RecurKind)}`,
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

		const total = items.reduce((sum, r) => sum + (r.cost ?? 0), 0);
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Expenses (${items.length}) — £${total.toFixed(2)}` });

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

			row.createDiv({ cls: "companion-subscription-cost", text: `£${(exp.cost ?? 0).toFixed(2)}` });
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

		const total = items.filter((r) => !r.recur).reduce((sum, r) => sum + (r.cost ?? 0), 0);
		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Income (${items.length})${total ? ` — £${total.toFixed(2)}` : ""}` });

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

			const costText = inc.recur ? `£${(inc.cost ?? 0).toFixed(2)}/${periodSuffix(inc.recur)}` : `£${(inc.cost ?? 0).toFixed(2)}`;
			row.createDiv({ cls: "companion-subscription-cost", text: costText });
		}
	}

	/** Invoiced income -- every invoice ever generated (see getInvoices in
	 * data.ts), summed per currency symbol since a client can be billed in
	 * a different currency from another and the two shouldn't be merged
	 * into one misleading total. The headline total is every invoice ever
	 * raised, invoiced not collected, same as always -- but each row also
	 * carries its own `paid` flag now (see setInvoicePaid in data.ts), and
	 * the line under the total splits out how much of it has actually come
	 * in. Otherwise still read-only: rows open the invoice note itself, and
	 * creating or amending an invoice's own content goes through the
	 * dedicated Invoice Create Procedure, not this view -- Paid is the one
	 * thing this view itself writes. */
	private renderIncome(parent: HTMLElement): void {
		const items = this.invoices;
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No invoices yet." });
			return;
		}

		const { total: totals, paid: paidTotals } = this.invoiceTotals();
		const totalText = [...totals.entries()].map(([sym, amt]) => `${sym}${amt.toFixed(2)}`).join(" + ");
		const paidText = [...paidTotals.entries()].map(([sym, amt]) => `${sym}${amt.toFixed(2)}`).join(" + ");

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
					result.income
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
