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
import { addStatTile, toneFor } from "./statTiles";
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

// Each of Finance's four lists (Subscriptions/Expenses/Income/Invoiced) gets
// its own independent fold state, filter text, sort choice and "how many
// rows to show" -- added 2 September 2026 once Mo's own lists grew past a
// screenful and he asked for fold/filter/sort/pagination rather than one
// long scroll. State is in-memory only (reset on view close/reopen), the
// same convention Task board's own column folding already uses -- not
// worth a new persisted-settings key for something this cheap to redo.
type FinanceSectionKey = "subscriptions" | "expenses" | "income" | "invoiced";
type SortKey = "date-desc" | "date-asc" | "amount-desc" | "amount-asc" | "title-asc" | "title-desc";
const DEFAULT_SORT: SortKey = "date-desc";
const PAGE_SIZE = 15;

const SORT_OPTIONS: [SortKey, string][] = [
	["date-desc", "Sort: Newest first"],
	["date-asc", "Sort: Oldest first"],
	["amount-desc", "Sort: Amount (high–low)"],
	["amount-asc", "Sort: Amount (low–high)"],
	["title-asc", "Sort: Title (A–Z)"],
	["title-desc", "Sort: Title (Z–A)"],
];

interface SectionUIState {
	filter: string;
	sort: SortKey;
	visibleCount: number;
}

function newSectionState(): SectionUIState {
	return { filter: "", sort: DEFAULT_SORT, visibleCount: PAGE_SIZE };
}

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
	private collapsed: Set<FinanceSectionKey> = new Set();
	private sectionState: Record<FinanceSectionKey, SectionUIState> = {
		subscriptions: newSectionState(),
		expenses: newSectionState(),
		income: newSectionState(),
		invoiced: newSectionState(),
	};

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
		this.renderOverviewTiles(root);
		if (this.settings.financeShowSubscriptions) this.renderSubscriptions(root);
		if (this.settings.financeShowExpenses) this.renderExpenses(root);
		if (this.settings.financeShowIncome) this.renderIncomeReminders(root);
		if (this.settings.financeShowInvoiced) this.renderIncome(root);
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
	 * renderOverviewTiles(), so a Subscription in USD is never silently
	 * added to one in GBP -- Mo's own "all currencies, since this is a
	 * public tool" request from 2 September 2026. */
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
	 * one-off Income entry ("GBP") would land in two different buckets.
	 * Shared by renderIncome() (the Invoiced section's own header line) and
	 * renderOverviewTiles() below, so the two can never drift apart. */
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

	/** "At a glance" overview -- a small grid of stat tiles for the figures
	 * Mo actually checks day to day: money in hand to date, recurring
	 * run-rate, and how invoicing's going. Deliberately tiles-only, no
	 * charts (Mo's own call, 2 September 2026: "nothing overblown just
	 * working with what i actually need to use it for").
	 *
	 * Tiles show DEFAULT_CURRENCY (GBP) figures only -- the common case for
	 * Mo's own books, and the only shape that fits a fixed grid without
	 * growing a fresh row of tiles per currency in use. Any activity in
	 * another currency is never dropped, just demoted to a compact text
	 * line underneath (see the "other currencies" block below), the same
	 * currency-safety principle as bucketByCurrency() -- nothing is ever
	 * merged across currencies into a number an exchange rate would be
	 * needed to make meaningful.
	 *
	 * "To date" (paid invoices + one-off Income, netted against one-off
	 * Expenses) deliberately excludes recurring Subscriptions/Income, same
	 * reasoning as always: Companion only tracks a recurring item's *next*
	 * due date, not how many periods have actually elapsed and been paid,
	 * so a running total for those would be a guess dressed up as a fact --
	 * the Recurring tile covers them instead, as a forward-looking monthly
	 * figure, not a total. */
	private renderOverviewTiles(parent: HTMLElement): void {
		const { total: invoiceTotal, paid: paidInvoices } = this.invoiceTotals();
		const oneOffIncome = this.bucketByCurrency(
			this.incomeReminders().filter((r) => !r.recur),
			(r) => r.cost ?? 0
		);
		const oneOffExpenses = this.bucketByCurrency(this.expenses(), (r) => r.cost ?? 0);
		const inTotals = new Map<string, number>(oneOffIncome);
		for (const [code, amt] of paidInvoices) inTotals.set(code, (inTotals.get(code) ?? 0) + amt);

		const recurOut = this.bucketByCurrency(this.subscriptions(), (r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind));
		const recurIn = this.bucketByCurrency(
			this.incomeReminders().filter((r) => !!r.recur),
			(r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind)
		);

		const hasToDate = inTotals.size > 0 || oneOffExpenses.size > 0;
		const hasRecurring = recurOut.size > 0 || recurIn.size > 0;
		const hasInvoiced = invoiceTotal.size > 0;
		if (!hasToDate && !hasRecurring && !hasInvoiced) return;

		const grid = parent.createDiv({ cls: "companion-stat-tiles" });

		if (hasToDate) {
			const income = inTotals.get(DEFAULT_CURRENCY) ?? 0;
			const expense = oneOffExpenses.get(DEFAULT_CURRENCY) ?? 0;
			const net = income - expense;
			addStatTile(grid, "Income to date", formatMoney(DEFAULT_CURRENCY, income), "positive");
			addStatTile(grid, "Expenses to date", formatMoney(DEFAULT_CURRENCY, expense), "negative");
			addStatTile(grid, "Net to date", formatMoney(DEFAULT_CURRENCY, net), toneFor(net));
		}

		if (hasRecurring) {
			const currencies = new Set([...recurIn.keys(), ...recurOut.keys()]);
			if (currencies.size <= 1) {
				const code = [...currencies][0] ?? DEFAULT_CURRENCY;
				const net = (recurIn.get(code) ?? 0) - (recurOut.get(code) ?? 0);
				addStatTile(grid, "Recurring, net/month", `${formatMoney(code, Math.abs(net))} ${net >= 0 ? "in" : "out"}`, toneFor(net));
			} else {
				addStatTile(grid, "Recurring in/month", this.formatBucketed(recurIn) || formatMoney(DEFAULT_CURRENCY, 0), "positive");
				addStatTile(grid, "Recurring out/month", this.formatBucketed(recurOut) || formatMoney(DEFAULT_CURRENCY, 0), "negative");
			}
		}

		if (hasInvoiced) {
			addStatTile(grid, "Invoiced total", formatMoney(DEFAULT_CURRENCY, invoiceTotal.get(DEFAULT_CURRENCY) ?? 0));
			addStatTile(grid, "Paid so far", formatMoney(DEFAULT_CURRENCY, paidInvoices.get(DEFAULT_CURRENCY) ?? 0), "positive");
		}

		const otherLines: string[] = [];
		const otherIn = withoutCode(inTotals, DEFAULT_CURRENCY);
		const otherOut = withoutCode(oneOffExpenses, DEFAULT_CURRENCY);
		if (otherIn.size || otherOut.size) {
			otherLines.push(`To date, other currencies: ${this.formatBucketed(otherIn) || "—"} in, ${this.formatBucketed(otherOut) || "—"} out`);
		}
		const otherRecurIn = withoutCode(recurIn, DEFAULT_CURRENCY);
		const otherRecurOut = withoutCode(recurOut, DEFAULT_CURRENCY);
		if (otherRecurIn.size || otherRecurOut.size) {
			otherLines.push(
				`Recurring, other currencies: ${this.formatBucketed(otherRecurIn, "/month") || "—"} in, ${this.formatBucketed(otherRecurOut, "/month") || "—"} out`
			);
		}
		const otherInvoiced = withoutCode(invoiceTotal, DEFAULT_CURRENCY);
		const otherPaid = withoutCode(paidInvoices, DEFAULT_CURRENCY);
		if (otherInvoiced.size) {
			const paidNote = otherPaid.size ? ` (${this.formatBucketed(otherPaid)} paid)` : "";
			otherLines.push(`Invoiced, other currencies: ${this.formatBucketed(otherInvoiced)}${paidNote}`);
		}
		if (otherLines.length > 0) {
			const note = parent.createDiv({ cls: "companion-finance-other-currencies" });
			for (const line of otherLines) note.createDiv({ text: line });
		}
	}

	/** Shared chrome for every collapsible Finance list section: a
	 * foldable header (chevron, label, running total, click anywhere to
	 * fold), an optional subtitle line that stays visible even while
	 * folded (Invoiced's "paid so far"), a filter box + sort dropdown
	 * shown only while expanded, the section's own rows via `renderRow`,
	 * paginated to a "Load more" button, and empty states that
	 * distinguish "nothing here at all" from "nothing matches your
	 * filter". Generic over T so the same method serves both
	 * CompanionReminder (Subscriptions/Expenses/Income) and
	 * CompanionInvoice (Invoiced) sections. */
	private renderSection<T>(
		parent: HTMLElement,
		key: FinanceSectionKey,
		allItems: T[],
		opts: {
			titleText: string;
			totalText: string;
			subtitleText?: string;
			emptyText: string;
			searchText: (item: T) => string;
			sortComparators: Record<SortKey, (a: T, b: T) => number>;
			renderRow: (list: HTMLElement, item: T) => void;
		}
	): void {
		const state = this.sectionState[key];
		const isCollapsed = this.collapsed.has(key);

		const section = parent.createDiv({ cls: "companion-finance-section" });
		section.setAttribute("data-finance-section", key);

		const header = section.createDiv({ cls: "companion-list-group-title" });
		const chevron = header.createSpan({ cls: "companion-list-group-chevron" });
		setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: `${opts.titleText} (${allItems.length})${opts.totalText ? ` — ${opts.totalText}` : ""}` });
		header.onclick = () => {
			if (isCollapsed) this.collapsed.delete(key);
			else this.collapsed.add(key);
			this.render();
		};

		if (opts.subtitleText) {
			section.createDiv({ cls: "companion-empty", text: opts.subtitleText });
		}

		if (isCollapsed) return;

		if (allItems.length === 0) {
			section.createDiv({ cls: "companion-empty", text: opts.emptyText });
			return;
		}

		const controls = section.createDiv({ cls: "companion-finance-section-controls" });
		const filterInput = controls.createEl("input", {
			cls: "companion-filter-input",
			attr: { type: "text", placeholder: "Filter…" },
		});
		filterInput.value = state.filter;
		filterInput.oninput = () => {
			state.filter = filterInput.value;
			state.visibleCount = PAGE_SIZE; // a new search starts from the top
			this.render();
			// render() rebuilds every input and loses focus/caret -- restore
			// both, scoped to this section specifically since there are now
			// four independent filter boxes on the page at once.
			const restored = this.contentEl.querySelector<HTMLInputElement>(
				`[data-finance-section="${key}"] .companion-filter-input`
			);
			restored?.focus();
			restored?.setSelectionRange(state.filter.length, state.filter.length);
		};

		const sortSelect = controls.createEl("select", { cls: "companion-sort-select" });
		for (const [value, text] of SORT_OPTIONS) sortSelect.createEl("option", { text, attr: { value } });
		sortSelect.value = state.sort;
		sortSelect.onchange = () => {
			state.sort = sortSelect.value as SortKey;
			this.render();
		};

		const query = state.filter.trim().toLowerCase();
		const filtered = query ? allItems.filter((item) => opts.searchText(item).toLowerCase().includes(query)) : allItems;

		if (filtered.length === 0) {
			section.createDiv({ cls: "companion-empty", text: `No matches for "${state.filter.trim()}".` });
			return;
		}

		const sorted = [...filtered].sort(opts.sortComparators[state.sort]);
		const visible = sorted.slice(0, state.visibleCount);

		const list = section.createDiv({ cls: "companion-finance-list" });
		for (const item of visible) opts.renderRow(list, item);

		const remaining = sorted.length - visible.length;
		if (remaining > 0) {
			const loadMore = section.createEl("button", {
				cls: "companion-load-more-btn",
				text: `Load ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)`,
			});
			loadMore.onclick = () => {
				state.visibleCount += PAGE_SIZE;
				this.render();
			};
		}
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
		const totals = this.bucketByCurrency(items, (r) => monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind));

		this.renderSection(parent, "subscriptions", items, {
			titleText: "Subscriptions",
			totalText: this.formatBucketed(totals, "/month"),
			emptyText: "No subscriptions yet.",
			searchText: (r) => r.title,
			sortComparators: REMINDER_COMPARATORS,
			renderRow: (list, sub) => {
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
			},
		});
	}

	/** Expenses -- one-off reminders with a cost but no repeat rule and no
	 * income flag, the exact complement of subscriptions() above. A running
	 * total in the section header; no Renew button, since a one-off has
	 * nothing to roll forward. */
	private renderExpenses(parent: HTMLElement): void {
		const items = this.expenses();
		const todayStr = formatDate(new Date());
		const totals = this.bucketByCurrency(items, (r) => r.cost ?? 0);

		this.renderSection(parent, "expenses", items, {
			titleText: "Expenses",
			totalText: this.formatBucketed(totals),
			emptyText: "No expenses yet.",
			searchText: (r) => r.title,
			sortComparators: REMINDER_COMPARATORS,
			renderRow: (list, exp) => {
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
			},
		});
	}

	/** Income (Reminders) -- ad hoc or recurring incoming money with no
	 * client or invoice behind it (see CompanionEvent.income in data.ts),
	 * the mirror image of Subscriptions/Expenses above: same Reminder
	 * shape, `income: true` instead of absent, `recur` optional either
	 * way. A running total (one-off entries only, same convention as
	 * Expenses' total -- recurring ones are in the Recurring tile
	 * instead). No Paid toggle here -- unlike an Invoice, one of these only
	 * ever gets created once the money's already in hand or is a standing
	 * expectation, not something invoiced and awaiting payment. */
	private renderIncomeReminders(parent: HTMLElement): void {
		const items = this.incomeReminders();
		const todayStr = formatDate(new Date());
		const totals = this.bucketByCurrency(
			items.filter((r) => !r.recur),
			(r) => r.cost ?? 0
		);

		this.renderSection(parent, "income", items, {
			titleText: "Income",
			totalText: this.formatBucketed(totals),
			emptyText: "No other income yet.",
			searchText: (r) => r.title,
			sortComparators: REMINDER_COMPARATORS,
			renderRow: (list, inc) => {
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
			},
		});
	}

	/** Invoiced income -- every invoice ever generated (see getInvoices in
	 * data.ts), summed per currency (see invoiceTotals() above) since a
	 * client can be billed in a different currency from another and the two
	 * shouldn't be merged into one misleading total. The headline total is
	 * every invoice ever raised, invoiced not collected, same as always --
	 * but each row also carries its own `paid` flag (see setInvoicePaid in
	 * data.ts), and a subtitle line shows how much of it has actually come
	 * in, staying visible even while the section's folded. Otherwise still
	 * read-only: rows open the invoice note itself, and creating or
	 * amending an invoice's own content goes through the dedicated Invoice
	 * Create Procedure, not this view -- Paid is the one thing this view
	 * itself writes. */
	private renderIncome(parent: HTMLElement): void {
		const items = this.invoices;
		const { total: totals, paid: paidTotals } = this.invoiceTotals();
		const totalText = this.formatBucketed(totals);
		const paidText = this.formatBucketed(paidTotals);

		this.renderSection(parent, "invoiced", items, {
			titleText: "Invoiced",
			totalText: totalText ? `${totalText} invoiced` : "",
			subtitleText: paidText ? `${paidText} paid so far` : undefined,
			emptyText: "No invoices yet.",
			searchText: (inv) => inv.client,
			sortComparators: INVOICE_COMPARATORS,
			renderRow: (list, inv) => {
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
			},
		});
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
					result.currency,
					result.status ?? undefined,
					result.priority
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

// Structural on `date` alone so the same comparator sorts both
// CompanionReminder and CompanionInvoice -- both shapes carry a
// `date: string | null` field, and nothing else about either type matters
// here. Ascending (oldest/undated first); callers wanting newest-first
// flip the arguments rather than negating the result, so undated items
// ("" sorts first) land predictably at whichever end "oldest" means for
// that direction.
function byDate(a: { date: string | null }, b: { date: string | null }): number {
	return (a.date ?? "").localeCompare(b.date ?? "");
}

const REMINDER_COMPARATORS: Record<SortKey, (a: CompanionReminder, b: CompanionReminder) => number> = {
	"date-desc": (a, b) => byDate(b, a),
	"date-asc": (a, b) => byDate(a, b),
	"amount-desc": (a, b) => (b.cost ?? 0) - (a.cost ?? 0),
	"amount-asc": (a, b) => (a.cost ?? 0) - (b.cost ?? 0),
	"title-asc": (a, b) => a.title.localeCompare(b.title),
	"title-desc": (a, b) => b.title.localeCompare(a.title),
};

const INVOICE_COMPARATORS: Record<SortKey, (a: CompanionInvoice, b: CompanionInvoice) => number> = {
	"date-desc": (a, b) => byDate(b, a),
	"date-asc": (a, b) => byDate(a, b),
	"amount-desc": (a, b) => (b.amount ?? 0) - (a.amount ?? 0),
	"amount-asc": (a, b) => (a.amount ?? 0) - (b.amount ?? 0),
	"title-asc": (a, b) => a.client.localeCompare(b.client),
	"title-desc": (a, b) => b.client.localeCompare(a.client),
};

function withoutCode(totals: Map<string, number>, code: string): Map<string, number> {
	const copy = new Map(totals);
	copy.delete(code);
	return copy;
}
