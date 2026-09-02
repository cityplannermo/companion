import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	advanceRecurringOccurrence,
	applyEventEdit,
	CompanionInvoice,
	CompanionOtherIncome,
	CompanionReminder,
	createOtherIncome,
	createQuickNote,
	getInvoices,
	getOtherIncome,
	getReminders,
	monthlyEquivalentCost,
	setInvoicePaid,
} from "./data";
import type { RecurKind } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { AddIncomeModal } from "./financeUI";
import { formatDate, formatDisplayShortDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_FINANCE = "companion-finance-view";

/**
 * Companion's Finance tab: Subscriptions, Expenses, and Income, each a
 * Reminder note (or, for Income, an Invoice note) distinguished purely by
 * which fields are set -- see subscriptions()/expenses() below and
 * CompanionReminder/CompanionInvoice in data.ts. No new note types, just
 * three views onto notes that already exist elsewhere in the vault.
 */
export class FinanceView extends ItemView {
	private reminders: CompanionReminder[] = [];
	private invoices: CompanionInvoice[] = [];
	private otherIncome: CompanionOtherIncome[] = [];
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
		this.otherIncome = await getOtherIncome(this.app);
		this.render();
	}

	/** Subscriptions and expenses are both cost-bearing Reminders,
	 * distinguished only by whether a repeat rule is set -- every such
	 * Reminder lands in exactly one of these two lists. */
	private subscriptions(): CompanionReminder[] {
		return this.reminders.filter((r) => !!r.recur && r.cost != null).sort(byDate);
	}

	private expenses(): CompanionReminder[] {
		return this.reminders.filter((r) => !r.recur && r.cost != null).sort(byDate);
	}

	private selectableItems(): { file: TFile }[] {
		return [...this.subscriptions(), ...this.expenses(), ...this.otherIncome];
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
		this.renderSubscriptions(root);
		this.renderExpenses(root);
		this.renderIncome(root);
		this.renderOtherIncome(root);
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-finance-header" });
		header.createEl("h2", { text: "Finance" });

		const actions = header.createDiv({ cls: "companion-finance-header-actions" });

		const subBtn = actions.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(subBtn, "plus");
		subBtn.createSpan({ text: "Subscription" });
		subBtn.onclick = () => this.openCreateCost("Subscription — a recurring Reminder with a cost, created here as one.");

		const expBtn = actions.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(expBtn, "plus");
		expBtn.createSpan({ text: "Expense" });
		expBtn.onclick = () => this.openCreateCost("Expense — a one-off Reminder with a cost, created here as one.");

		const incomeBtn = actions.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(incomeBtn, "plus");
		incomeBtn.createSpan({ text: "Income" });
		incomeBtn.onclick = () => this.openAddIncome();
	}

	/** Subscriptions -- reminders with both a repeat rule and a cost -- get
	 * a running monthly-equivalent total in the section header, and a Renew
	 * action per row that rolls the reminder's own due date forward one
	 * period in place (see advanceRecurringOccurrence in data.ts) rather than
	 * creating any new note. Edit/Select/Delete work the same as any other
	 * reminder row. */
	private renderSubscriptions(parent: HTMLElement): void {
		const items = this.subscriptions();
		const todayStr = formatDate(new Date());
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({
				cls: "companion-empty",
				text: "No subscriptions yet. A subscription is a Reminder with both a repeat rule and a cost.",
			});
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
					() => this.openEditorCost(sub, "Subscription — a recurring Reminder with a cost, edited here as one."),
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

	/** Expenses -- one-off reminders with a cost but no repeat rule, the
	 * exact complement of subscriptions() above. A running total in the
	 * section header; no Renew button, since a one-off has nothing to roll
	 * forward. */
	private renderExpenses(parent: HTMLElement): void {
		const items = this.expenses();
		const todayStr = formatDate(new Date());
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({
				cls: "companion-empty",
				text: "No expenses yet. An expense is a Reminder with a cost and no repeat rule.",
			});
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
					() => this.openEditorCost(exp, "Expense — a one-off Reminder with a cost, edited here as one."),
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

	/** Income -- every invoice ever generated (see getInvoices in data.ts),
	 * summed per currency symbol since a client can be billed in a
	 * different currency from another and the two shouldn't be merged into
	 * one misleading total. The headline total is every invoice ever
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
		groupTitle.createSpan({ text: `Income (${items.length})${totalText ? ` — ${totalText} invoiced` : ""}` });
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

	/** Other income -- ad hoc, one-off receipts (a Twitch tip, a one-off
	 * sale) that don't fit the Invoice shape at all (see CompanionOtherIncome
	 * in data.ts). A separate total per currency from Income above, since
	 * "invoiced" and "just showed up" shouldn't be merged into one figure.
	 * No paid toggle here -- unlike an invoice, an ad hoc income note only
	 * ever gets created once the money's already in hand, so there's no
	 * unpaid state to track. Delete-only via the usual right-click menu;
	 * no dedicated edit modal for v1 -- open the note itself for a
	 * correction, same as any other note in the wiki. */
	private renderOtherIncome(parent: HTMLElement): void {
		const items = this.otherIncome;
		const list = parent.createDiv({ cls: "companion-finance-list" });

		if (items.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No other income yet. Use “+ Income” above for anything outside Invoicing -- a Twitch tip, a one-off sale." });
			return;
		}

		const totals = new Map<string, number>();
		for (const inc of items) {
			const key = inc.currencySymbol || "£";
			totals.set(key, (totals.get(key) ?? 0) + inc.amount);
		}
		const totalText = [...totals.entries()].map(([sym, amt]) => `${sym}${amt.toFixed(2)}`).join(" + ");

		const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Other income (${items.length})${totalText ? ` — ${totalText}` : ""}` });

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
					undefined,
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

			const title = row.createDiv({ cls: "companion-list-row-title", text: inc.source });
			makeOpenable(this.app, title, inc.file, {
				onToggleSelect: () => {
					this.selection.toggle(inc.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});

			row.createDiv({ cls: "companion-subscription-cost", text: `${inc.currencySymbol}${inc.amount.toFixed(2)}` });
		}
	}

	/** Opens the shared editor modal to create a new subscription or
	 * expense -- type is locked to Reminder here (see label below), since
	 * anything created from the Finance tab is one or the other by
	 * definition; the dropdown is only offered where the type is genuinely
	 * still a choice, e.g. the Calendar's own "+ New item". `recur` is left
	 * unset either way -- the field is present for the user to fill in
	 * (a subscription needs one, an expense doesn't), and which list a note
	 * lands in is decided by whether it ends up set, not by which button
	 * created it. */
	private openCreateCost(label: string): void {
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
					result.remind
				).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			label
		).open();
	}

	/** Opens the shared editor modal (title, time, repeat, cost) on an
	 * existing subscription or expense, the same modal the calendar and
	 * Reminders view use. */
	private openEditorCost(reminder: CompanionReminder, label: string): void {
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
				}).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			label
		).open();
	}

	/** Opens the small Add income modal, then writes a new ad hoc income
	 * note straight away (see createOtherIncome in data.ts) -- no shared
	 * editor detour, since none of that modal's fields (type, repeat,
	 * remind, client) apply here. `knownSources` seeds the datalist with
	 * whatever's already been used, so "Twitch" only needs typing once. */
	private openAddIncome(): void {
		const knownSources = [...new Set(this.otherIncome.map((i) => i.source))];
		new AddIncomeModal(this.app, knownSources, (source, amount, currencySymbol, dateStr) => {
			createOtherIncome(this.app, source, amount, currencySymbol, dateStr).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
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
