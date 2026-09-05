import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { applyEventEdit, CompanionReminder, createQuickNote, getReminders, snoozeReminder } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { formatDate, formatDisplayShortDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { addOverflowMenu } from "./overflowMenu";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_REMINDERS = "companion-reminders-view";

/**
 * A simple list of every Reminder note, grouped by due status. "Due"
 * mirrors due_reminders.py's own threshold exactly (date <= today) so the
 * view and the script never disagree about what counts as due.
 */
type SortKey = "date-asc" | "date-desc" | "title-asc" | "title-desc";

export class RemindersView extends ItemView {
	private reminders: CompanionReminder[] = [];
	private sortKey: SortKey = "date-asc";
	private selection = new Selection();
	private filterText = "";

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_REMINDERS;
	}

	getDisplayText(): string {
		return "Reminders";
	}

	getIcon(): string {
		return "bell";
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to tear down — no timers, no external connections
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault changes. */
	refresh(): void {
		this.reminders = getReminders(this.app);
		this.render();
	}

	/** this.reminders narrowed by the filter box, title match only --
	 * client-side, no change to what's actually read from the vault. */
	private visibleReminders(): CompanionReminder[] {
		const q = this.filterText.trim().toLowerCase();
		if (!q) return this.reminders;
		return this.reminders.filter((r) => r.title.toLowerCase().includes(q));
	}

	private selectedFiles(): TFile[] {
		const selected = new Set(this.selection.all());
		return this.reminders.filter((r) => selected.has(r.file.path)).map((r) => r.file);
	}

	private afterDelete(): void {
		this.selection.clear();
		this.refresh();
	}

	/** Combines the sort-by field with the ascending/descending toggle into
	 * one comparator, so callers don't juggle both separately. */
	private sortComparator(): (a: CompanionReminder, b: CompanionReminder) => number {
		const base = this.sortKey.startsWith("title") ? byTitle : byDate;
		const dir = this.sortKey.endsWith("desc") ? -1 : 1;
		return (a, b) => dir * base(a, b);
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-reminders-root");

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
		this.renderList(root);
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-reminders-header" });
		header.createEl("h2", { text: "Reminders" });

		const controls = header.createDiv({ cls: "companion-reminders-header-controls" });
		const filterInput = controls.createEl("input", {
			cls: "companion-filter-input",
			attr: { type: "text", placeholder: "Filter…" },
		});
		filterInput.value = this.filterText;
		filterInput.oninput = () => {
			this.filterText = filterInput.value;
			this.render();
			// render() rebuilds the input and loses focus/caret -- restore both
			// so typing multiple characters doesn't need re-clicking each time.
			const restored = parent.querySelector<HTMLInputElement>(".companion-filter-input");
			restored?.focus();
			restored?.setSelectionRange(this.filterText.length, this.filterText.length);
		};

		const sortOptions: { value: SortKey; label: string }[] = [
			{ value: "date-asc", label: "Sort: Due date (soonest first)" },
			{ value: "date-desc", label: "Sort: Due date (latest first)" },
			{ value: "title-asc", label: "Sort: Title (A–Z)" },
			{ value: "title-desc", label: "Sort: Title (Z–A)" },
		];
		const setSort = (key: SortKey) => {
			this.sortKey = key;
			this.render();
		};

		const sortSelect = controls.createEl("select", { cls: "companion-sort-select companion-mobile-hide" });
		for (const opt of sortOptions) sortSelect.createEl("option", { text: opt.label, value: opt.value });
		sortSelect.value = this.sortKey;
		sortSelect.onchange = () => setSort(sortSelect.value as SortKey);

		// Mobile equivalent of the sort dropdown above -- see overflowMenu.ts.
		addOverflowMenu(
			controls,
			sortOptions.map((opt) => ({ label: opt.label, isActive: this.sortKey === opt.value, onClick: () => setSort(opt.value) }))
		);

		const addBtn = controls.createEl("button", { cls: "mod-cta companion-btn-icon-text companion-create-pill" });
		setIcon(addBtn, "plus");
		addBtn.createSpan({ text: "Reminder" });
		addBtn.onclick = () => this.openCreate();
	}

	/** Opens the same shared editor modal the pencil uses, locked to plain
	 * Reminder -- no type dropdown (everything created from here is a
	 * Reminder by definition, same reasoning as Finance's own narrowed "+")
	 * and no Cost field unless one's actually entered, matching the same
	 * cost-visibility rule the modal already applies everywhere else.
	 * Replaces the old bare-title inline form, which had no way to set a
	 * date, repeat rule or advance reminder at creation time. */
	private openCreate(): void {
		new EventEditorModal(
			this.app,
			"create",
			{ title: "", type: "reminder", date: formatDate(new Date()), timeStr: "00:00" },
			(result) => {
				createQuickNote(
					this.app,
					"reminder",
					result.date,
					result.title,
					result.allDay ? "00:00" : result.startTime,
					result.allDay ? undefined : result.endTime,
					undefined,
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
			"Reminder"
		).open();
	}

	private renderList(parent: HTMLElement): void {
		const list = parent.createDiv({ cls: "companion-reminders-list" });
		const todayStr = formatDate(new Date());

		// Subscriptions (a reminder with both a repeat rule and a cost) live
		// in the Finance tab now, not here -- see FinanceView.ts. Filtered
		// out so a subscription doesn't show up in two places at once.
		const isSubscription = (r: CompanionReminder) => !!r.recur && r.cost != null;
		const visible = this.visibleReminders().filter((r) => !isSubscription(r));

		// Matches due_reminders.py exactly: due is date <= today. Undated
		// reminders surface in their own group rather than being hidden --
		// they're real reminders, just ones the script itself would never
		// resurface until a date is added.
		const sortFn = this.sortComparator();
		const due = visible.filter((r) => r.date && r.date <= todayStr).sort(sortFn);
		const upcoming = visible.filter((r) => r.date && r.date > todayStr).sort(sortFn);
		const undated = visible.filter((r) => !r.date).sort(this.sortKey.endsWith("desc") ? (a, b) => byTitle(b, a) : byTitle);

		this.renderGroup(list, "Due", due, todayStr);
		this.renderGroup(list, "Upcoming", upcoming, todayStr);
		this.renderGroup(list, "No date", undated, todayStr);

		if (this.reminders.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No reminders yet." });
		} else if (visible.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No reminders match your filter." });
		}

	}

	private renderGroup(parent: HTMLElement, label: string, items: CompanionReminder[], todayStr: string): void {
		if (items.length === 0) return;

		const groupTitle = parent.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `${label} (${items.length})` });

		for (const reminder of items) {
			const row = parent.createDiv({ cls: "companion-list-row" });
			row.toggleClass("is-selected", this.selection.has(reminder.file.path));
			row.oncontextmenu = (e) =>
				showDeleteMenu(
					this.app,
					e,
					reminder.file,
					this.selectedFiles(),
					this.settings.confirmBeforeDelete,
					() => this.afterDelete(),
					() => this.openEditor(reminder),
					() => {
						this.selection.toggle(reminder.file.path);
						this.render();
					},
					() => {
						this.selection.clear();
						this.render();
					},
					reminder.recur
				);

			row.createDiv({
				cls: "companion-list-row-date",
				text: reminder.date ? formatDisplayShortDate(reminder.date) : "No date",
			});
			if (reminder.date && reminder.date < todayStr) {
				row.addClass("companion-reminder-overdue");
			}
			const title = row.createDiv({ cls: "companion-list-row-title", text: reminder.title });
			makeOpenable(this.app, title, reminder.file, {
				onToggleSelect: () => {
					this.selection.toggle(reminder.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});

			if (reminder.date) {
				const snooze = row.createSpan({ cls: "companion-item-rename-btn", attr: { "aria-label": "Snooze" } });
				setIcon(snooze, "alarm-clock");
				snooze.onclick = (e) => {
					e.stopPropagation();
					this.showSnoozeMenu(e, reminder);
				};
			}
		}
	}

	/** A small menu of fixed snooze amounts rather than a free-text time
	 * picker -- matches the lightweight, no-modal interaction the rest of
	 * this view uses (Renew, Edit/Select/Delete). */
	private showSnoozeMenu(event: MouseEvent, reminder: CompanionReminder): void {
		const menu = new Menu();
		const options: [string, number][] = [
			["1 hour", 60],
			["3 hours", 3 * 60],
			["Tomorrow", 24 * 60],
			["1 week", 7 * 24 * 60],
		];
		for (const [label, minutes] of options) {
			menu.addItem((item) =>
				item.setTitle(label).setIcon("alarm-clock").onClick(() => {
					snoozeReminder(this.app, reminder.file, minutes).then(
						() => this.refresh(),
						(err: Error) => new Notice(err.message)
					);
				})
			);
		}
		menu.showAtMouseEvent(event);
	}

	/** Opens the shared editor modal (title, time, repeat, and -- since
	 * every reminder here is type "reminder" -- cost) on an existing
	 * reminder, the same modal the calendar uses. Undated reminders default
	 * to today if a date's ever needed by a field change. */
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
			}
		).open();
	}
}

function byDate(a: CompanionReminder, b: CompanionReminder): number {
	return (a.date ?? "").localeCompare(b.date ?? "");
}

function byTitle(a: CompanionReminder, b: CompanionReminder): number {
	return a.title.localeCompare(b.title);
}
