import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { advanceRecurringReminder, applyEventEdit, CompanionReminder, createQuickNote, getReminders, monthlyEquivalentCost } from "./data";
import type { RecurKind } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { formatDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_REMINDERS = "companion-reminders-view";

/**
 * A simple list of every Reminder note, grouped by due status. "Due"
 * mirrors due_reminders.py's own threshold exactly (date <= today) so the
 * view and the script never disagree about what counts as due.
 */
type SortBy = "date" | "title";
type SortDir = "asc" | "desc";

export class RemindersView extends ItemView {
	private reminders: CompanionReminder[] = [];
	private creating = false;
	private sortBy: SortBy = "date";
	private sortDir: SortDir = "asc";
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
		const base = this.sortBy === "title" ? byTitle : byDate;
		const dir = this.sortDir === "desc" ? -1 : 1;
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
		if (this.creating) {
			this.renderQuickCreateForm(root);
		}
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

		const sortSelect = controls.createEl("select", { cls: "companion-sort-select" });
		sortSelect.createEl("option", { text: "Sort: Due date", attr: { value: "date" } });
		sortSelect.createEl("option", { text: "Sort: Title", attr: { value: "title" } });
		sortSelect.value = this.sortBy;
		sortSelect.onchange = () => {
			this.sortBy = sortSelect.value as SortBy;
			this.render();
		};

		const sortDirBtn = controls.createEl("button", {
			cls: "companion-icon-btn",
			attr: { "aria-label": this.sortDir === "asc" ? "Ascending -- click for descending" : "Descending -- click for ascending" },
		});
		setIcon(sortDirBtn, this.sortDir === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
		sortDirBtn.onclick = () => {
			this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
			this.render();
		};

		const addBtn = controls.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(addBtn, "plus");
		addBtn.createSpan({ text: "Reminder" });
		addBtn.onclick = () => {
			this.creating = true;
			this.render();
		};
	}

	/** Inline "new reminder" form — created dated to today, same pattern as the calendar and task board. */
	private renderQuickCreateForm(parent: HTMLElement): void {
		const form = parent.createDiv({ cls: "companion-quick-create" });
		const input = form.createEl("input", { attr: { type: "text", placeholder: "New reminder title…" } });

		let submitted = false;
		const submit = () => {
			if (submitted) return; // guards against Enter and the Create button both firing
			submitted = true;
			const title = input.value;
			this.creating = false;
			createQuickNote(this.app, "reminder", formatDate(new Date()), title).then(
				() => {
					this.refresh();
				},
				(err: Error) => {
					new Notice(err.message);
					this.render();
				}
			);
		};
		input.onkeydown = (e) => {
			if (e.key === "Enter") submit();
			if (e.key === "Escape") {
				this.creating = false;
				this.render();
			}
		};
		const controls = form.createDiv({ cls: "companion-quick-create-controls" });
		const confirm = controls.createEl("button", { text: "Create", cls: "mod-cta" });
		confirm.onclick = submit;
		const cancel = controls.createEl("button", {
			cls: "companion-icon-btn",
			attr: { "aria-label": "Cancel" },
		});
		setIcon(cancel, "x");
		cancel.onclick = () => {
			this.creating = false;
			this.render();
		};
		window.setTimeout(() => input.focus());
	}

	private renderList(parent: HTMLElement): void {
		const list = parent.createDiv({ cls: "companion-reminders-list" });
		const todayStr = formatDate(new Date());

		// A subscription is a reminder with both a repeat rule and a cost --
		// not a separate note type, just those two fields together (see
		// CompanionReminder in data.ts). Shown as its own section, above
		// everything else, so it isn't mixed in with plain due-date reminders.
		const visible = this.visibleReminders();
		const isSubscription = (r: CompanionReminder) => !!r.recur && r.cost != null;
		const subscriptions = visible.filter(isSubscription).sort(this.sortComparator());
		const plain = visible.filter((r) => !isSubscription(r));

		// Matches due_reminders.py exactly: due is date <= today. Undated
		// reminders surface in their own group rather than being hidden --
		// they're real reminders, just ones the script itself would never
		// resurface until a date is added.
		const sortFn = this.sortComparator();
		const due = plain.filter((r) => r.date && r.date <= todayStr).sort(sortFn);
		const upcoming = plain.filter((r) => r.date && r.date > todayStr).sort(sortFn);
		const undated = plain.filter((r) => !r.date).sort(this.sortDir === "desc" ? (a, b) => byTitle(b, a) : byTitle);

		this.renderSubscriptions(list, subscriptions, todayStr);
		this.renderGroup(list, "Due", due, todayStr);
		this.renderGroup(list, "Upcoming", upcoming, todayStr);
		this.renderGroup(list, "No date", undated, todayStr);

		if (this.reminders.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No reminders yet." });
		} else if (visible.length === 0) {
			list.createDiv({ cls: "companion-empty", text: "No reminders match your filter." });
		}

		parent.createDiv({
			cls: "companion-note",
			text:
				"Due matches what due_reminders.py surfaces — date today or earlier. A reminder with both a repeat " +
				"rule and a cost shows as a subscription above, with a Renew button that pushes its due date forward " +
				"one period in place. Right-click (or press and hold on mobile) for Edit/Select/Delete; Shift+click " +
				"also selects on desktop. Once selecting, tap or click other items to add them, then Clear to finish.",
		});
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
					}
				);

			row.createDiv({
				cls: "companion-list-row-date",
				text: reminder.date ? formatDisplayDate(reminder.date) : "No date",
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
		}
	}

	/** Subscriptions -- reminders with both a repeat rule and a cost -- get
	 * their own section above everything else: a running monthly-equivalent
	 * total in the section header, and a Renew action per row that rolls
	 * the reminder's own due date forward one period in place (see
	 * advanceRecurringReminder in data.ts) rather than creating any new
	 * note. Edit/Select/Delete work the same as any other reminder row. */
	private renderSubscriptions(parent: HTMLElement, items: CompanionReminder[], todayStr: string): void {
		if (items.length === 0) return;

		const total = items.reduce((sum, r) => sum + monthlyEquivalentCost(r.cost ?? 0, r.recur as RecurKind), 0);
		const groupTitle = parent.createDiv({ cls: "companion-list-group-title" });
		groupTitle.createSpan({ text: `Subscriptions (${items.length}) — £${total.toFixed(2)}/month` });

		for (const sub of items) {
			const row = parent.createDiv({ cls: "companion-list-row" });
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
				text: sub.date ? formatDisplayDate(sub.date) : "No date",
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
				advanceRecurringReminder(this.app, sub.file).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			};
		}
	}

	/** Opens the shared editor modal (title, time, repeat, and -- since
	 * every reminder here is type "reminder" -- cost) on an existing
	 * reminder, the same modal the calendar uses. Undated reminders default
	 * to today if a date's ever needed by a field change. */
	private openEditor(reminder: CompanionReminder): void {
		new EventEditorModal(
			this.app,
			"edit",
			{ title: reminder.title, type: "reminder", timeStr: reminder.time, recur: reminder.recur, cost: reminder.cost },
			(result) => {
				applyEventEdit(this.app, reminder.file, "reminder", {
					title: result.title,
					type: result.type,
					dateStr: reminder.date ?? formatDate(new Date()),
					timeStr: result.allDay ? "00:00" : result.startTime,
					endTimeStr: result.allDay ? undefined : result.endTime,
					client: result.client,
					recur: result.recur,
					cost: result.cost,
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
	return "yr";
}

function byDate(a: CompanionReminder, b: CompanionReminder): number {
	return (a.date ?? "").localeCompare(b.date ?? "");
}

function byTitle(a: CompanionReminder, b: CompanionReminder): number {
	return a.title.localeCompare(b.title);
}

function formatDisplayDate(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("default", { day: "numeric", month: "short" });
}
