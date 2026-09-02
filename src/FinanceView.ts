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
import { formatDate, formatDisplayShortDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_FINANCE = "companion-finance-view";

/**
 * Companion's Finance tab: Subscriptions, Expenses, Income (Reminders) and
 * Income (Invoices), each an ordinary Reminder or Invoice note distinguished
 * purely by which fields are set -- see subscriptions()/expenses()/
 * incomeReminders() below and CompanionReminder/CompanionInvoice in
 * data.ts. No dedicated note type for any of it. Creating and editing all
 * go through the exact same New/Edit item dropdown as the Calendar's own
 * "+" (see openCreate/openEditor below) -- one unified workflow, not a
 * separate one per section.
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

		const totals = new Map<string, number>();
		const paidTotals = new Map<string, number>();
		for (const inv of items) {
			if (inv.amount == null) continue;
			const key = inv.currencySymbol || "£";
			totals.set(key, (totals.get(key) ?? 0) + inv.amount);
			if (inv.paid) paidTotals.set(key, (paidTotals.get(key) ?? 0) + inv.amount);
		}
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

	/** Opens the exact same shared New/Edit item modal as the Calendar's
	 * own "+" -- full type dropdown (Meeting/Event/Reminder/Subscription/
	 * Invoice reminder/Income/Task/Post), not a Finance-specific locked
	 * one. Whatever's picked is created the normal way; if it lands as a
	 * Subscription, Expense or Income, it shows up here on refresh -- if
	 * not, it simply doesn't, same as creating it from the Calendar would.
	 * One workflow, entered from either tab. */
	private openCreate(): void {
		new EventEditorModal(this.app, "create", { title: "", type: "reminder", date: formatDate(new Date()), timeStr: "00:00" }, (result) => {
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
		}).open();
	}

	/** Opens the shared editor modal on an existing Subscription, Expense
	 * or Income reminder -- same dropdown-enabled modal the Calendar uses
	 * for its own items, so changing Repeat/Cost/the Income flag (or the
	 * type entirely) here behaves identically to doing it from there. */
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
			}
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
