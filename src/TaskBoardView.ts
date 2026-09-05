import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { propertyVisibilityItems } from "./cardProperties";
import { CompanionTask, TASK_STATUSES, TaskStatus, TaskPriority, createQuickNote, getTasks, setTaskPriority, setTaskStatus } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { formatDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { addOverflowMenu } from "./overflowMenu";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_TASKS = "companion-task-board-view";

// Same pattern as CalendarView's own drag-to-reschedule: a dedicated MIME
// type carries the dragged task's file path from card to column, so a
// drag from outside Companion (or from the calendar) is never mistaken
// for a status change.
const DRAG_MIME = "application/x-companion-task-path";

type Mode = "board" | "list";
type SortKey = "date-asc" | "date-desc" | "title-asc" | "title-desc";

export class TaskBoardView extends ItemView {
	private tasks: CompanionTask[] = [];
	private mode: Mode = "board";
	private sortKey: SortKey = "date-asc";
	private collapsed: Set<TaskStatus> = new Set();
	private selection = new Selection();
	private filterText = "";

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings,
		private persistSettings: () => Promise<void> = async () => {}
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TASKS;
	}

	getDisplayText(): string {
		return "Tasks";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to tear down — no timers, no external connections
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault changes. */
	refresh(): void {
		this.tasks = getTasks(this.app);
		this.render();
	}

	/** this.tasks narrowed by the filter box, title match only -- client-side,
	 * no change to what's actually read from the vault. */
	private visibleTasks(): CompanionTask[] {
		const q = this.filterText.trim().toLowerCase();
		if (!q) return this.tasks;
		return this.tasks.filter((t) => t.title.toLowerCase().includes(q));
	}

	private selectedFiles(): TFile[] {
		const selected = new Set(this.selection.all());
		return this.tasks.filter((t) => selected.has(t.file.path)).map((t) => t.file);
	}

	private afterDelete(): void {
		this.selection.clear();
		this.refresh();
	}

	/** Bulk status/priority for the right-click menu -- see showDeleteMenu's
	 * own `bulkTaskActions` param in deleteUI.ts. Only ever exercised when
	 * 2+ tasks are selected (deleteUI.ts's own gate), so `this.selection`
	 * here is exactly the set the menu was opened against. */
	private bulkTaskActions(): { onSetStatus: (status: TaskStatus) => void; onSetPriority: (priority: TaskPriority | null) => void } {
		return {
			onSetStatus: (status) => {
				const files = this.selectedFiles();
				Promise.all(files.map((f) => setTaskStatus(this.app, f, status))).then(
					() => {
						this.selection.clear();
						this.refresh();
					},
					(err: Error) => new Notice(err.message)
				);
			},
			onSetPriority: (priority) => {
				const files = this.selectedFiles();
				Promise.all(files.map((f) => setTaskPriority(this.app, f, priority))).then(
					() => {
						this.selection.clear();
						this.refresh();
					},
					(err: Error) => new Notice(err.message)
				);
			},
		};
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-task-root");

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

		if (this.mode === "board") {
			this.renderBoard(root);
		} else {
			this.renderList(root);
		}
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-task-header" });
		header.createEl("h2", { text: "Tasks" });

		const controls = header.createDiv({ cls: "companion-task-header-controls" });

		const filterInput = controls.createEl("input", {
			cls: "companion-filter-input",
			attr: { type: "text", placeholder: "Filter…" },
		});
		filterInput.value = this.filterText;
		filterInput.oninput = () => {
			this.filterText = filterInput.value;
			this.render();
			const restored = parent.querySelector<HTMLInputElement>(".companion-filter-input");
			restored?.focus();
			restored?.setSelectionRange(this.filterText.length, this.filterText.length);
		};

		const toggle = controls.createDiv({ cls: "companion-mode-toggle companion-mobile-hide" });
		const boardBtn = toggle.createEl("button", { text: "Board" });
		const listBtn = toggle.createEl("button", { text: "List" });
		boardBtn.toggleClass("is-active", this.mode === "board");
		listBtn.toggleClass("is-active", this.mode === "list");
		const setMode = (mode: Mode) => {
			this.mode = mode;
			this.render();
		};
		boardBtn.onclick = () => setMode("board");
		listBtn.onclick = () => setMode("list");

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

		// Mobile equivalent of the Board/List toggle and sort dropdown above,
		// plus "Show on cards" -- see overflowMenu.ts and cardProperties.ts.
		addOverflowMenu(controls, [
			{ label: "Board", isActive: this.mode === "board", onClick: () => setMode("board") },
			{ label: "List", isActive: this.mode === "list", onClick: () => setMode("list") },
			...sortOptions.map((opt) => ({ label: opt.label, isActive: this.sortKey === opt.value, onClick: () => setSort(opt.value) })),
			...propertyVisibilityItems(
				this.settings,
				[
					{ key: "taskShowDate", label: "Show date" },
					{ key: "taskShowPriority", label: "Show priority" },
					{ key: "taskShowChecklist", label: "Show checklist progress" },
				],
				this.persistSettings,
				() => this.render()
			),
		]);

		const addTask = controls.createEl("button", { cls: "mod-cta companion-btn-icon-text companion-create-pill" });
		setIcon(addTask, "plus");
		addTask.createSpan({ text: "Task" });
		addTask.onclick = () => this.openCreate();
	}

	/** Opens the shared editor modal locked to Task -- no type dropdown
	 * (everything created from the board's own "+" is a Task by definition)
	 * but with Status and Priority available alongside date/repeat/remind,
	 * so a task can be fully set up in one place instead of created "To Do"/
	 * no-priority and fixed up on the board afterwards. Replaces the old
	 * bare-title inline form. */
	private openCreate(): void {
		new EventEditorModal(
			this.app,
			"create",
			{ title: "", type: "task", date: formatDate(new Date()), timeStr: "00:00" },
			(result) => {
				createQuickNote(
					this.app,
					"task",
					result.date,
					result.title,
					result.allDay ? "00:00" : result.startTime,
					result.allDay ? undefined : result.endTime,
					undefined,
					result.recur,
					undefined,
					undefined,
					result.remind,
					undefined,
					undefined,
					result.status ?? undefined,
					result.priority
				).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			"Task"
		).open();
	}

	private renderBoard(parent: HTMLElement): void {
		const board = parent.createDiv({ cls: "companion-board" });
		const sortFn = this.sortComparator();

		const visible = this.visibleTasks();
		for (const status of TASK_STATUSES) {
			const tasksInColumn = visible.filter((t) => t.status === status).sort(sortFn);

			const column = board.createDiv({ cls: "companion-column" });
			const title = column.createDiv({ cls: "companion-column-title" });
			title.createSpan({ text: status });
			title.createSpan({ text: String(tasksInColumn.length) });

			if (tasksInColumn.length === 0) {
				const columnHasAny = this.tasks.some((t) => t.status === status);
				column.createDiv({ cls: "companion-empty", text: columnHasAny ? "No matches." : "Nothing here." });
			}
			for (const task of tasksInColumn) {
				this.renderCard(column, task);
			}

			this.makeStatusDropTarget(column, status);
		}
	}

	/** Accepts a card dragged from another column and writes its new status — the only field touched. */
	private makeStatusDropTarget(column: HTMLElement, status: TaskStatus): void {
		column.ondragover = (e) => {
			if (e.dataTransfer?.types.includes(DRAG_MIME)) {
				e.preventDefault();
				column.addClass("companion-column-dragover");
			}
		};
		column.ondragleave = () => column.removeClass("companion-column-dragover");
		column.ondrop = (e) => {
			e.preventDefault();
			column.removeClass("companion-column-dragover");
			const path = e.dataTransfer?.getData(DRAG_MIME);
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			const task = this.tasks.find((t) => t.file.path === path);
			if (!task || task.status === status) return;
			void setTaskStatus(this.app, file, status).then(() => this.refresh());
		};
	}

	private renderCard(parent: HTMLElement, task: CompanionTask): void {
		const card = parent.createDiv({ cls: "companion-card" });
		card.toggleClass("is-selected", this.selection.has(task.file.path));
		card.oncontextmenu = (e) =>
			showDeleteMenu(
				this.app,
				e,
				task.file,
				this.selectedFiles(),
				this.settings.confirmBeforeDelete,
				() => this.afterDelete(),
				undefined,
				() => {
					this.selection.toggle(task.file.path);
					this.render();
				},
				() => {
					this.selection.clear();
					this.render();
				},
				task.recur,
				this.bulkTaskActions()
			);

		// Desktop drag-and-drop between columns; the ‹ › controls below cover
		// the same move on mobile, where HTML5 drag-and-drop isn't reliable.
		card.draggable = true;
		card.ondragstart = (e) => {
			if (!e.dataTransfer) return;
			e.dataTransfer.setData(DRAG_MIME, task.file.path);
			e.dataTransfer.effectAllowed = "move";
		};

		const title = card.createDiv({ cls: "companion-card-title", text: task.title });
		makeOpenable(this.app, title, task.file, {
			onToggleSelect: () => {
				this.selection.toggle(task.file.path);
				this.render();
			},
			isSelecting: () => this.selection.size > 0,
		});

		const meta = card.createDiv({ cls: "companion-card-meta" });
		if (this.settings.taskShowDate) {
			const dateEl = meta.createDiv({
				cls: "companion-card-date",
				text: task.date ? formatDisplayDate(task.date) : "No date",
			});
			if (isOverdue(task)) dateEl.addClass("companion-task-overdue");
		}
		this.renderBadges(meta, task);

		this.renderMoveControls(card, task, "companion-card-controls");
	}

	private renderList(parent: HTMLElement): void {
		const list = parent.createDiv({ cls: "companion-list" });
		const sortFn = this.sortComparator();

		const visible = this.visibleTasks();
		for (const status of TASK_STATUSES) {
			const tasksInGroup = visible.filter((t) => t.status === status).sort(sortFn);
			const isCollapsed = this.collapsed.has(status);

			const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
			const chevron = groupTitle.createSpan({ cls: "companion-list-group-chevron" });
			setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
			groupTitle.createSpan({ text: `${status} (${tasksInGroup.length})` });
			groupTitle.onclick = () => {
				if (isCollapsed) this.collapsed.delete(status);
				else this.collapsed.add(status);
				this.render();
			};

			if (isCollapsed) continue;

			if (tasksInGroup.length === 0) {
				const groupHasAny = this.tasks.some((t) => t.status === status);
				list.createDiv({ cls: "companion-empty", text: groupHasAny ? "No matches." : "Nothing here." });
				continue;
			}
			for (const task of tasksInGroup) {
				const row = list.createDiv({ cls: "companion-list-row" });
				row.toggleClass("is-selected", this.selection.has(task.file.path));
				row.oncontextmenu = (e) =>
					showDeleteMenu(
						this.app,
						e,
						task.file,
						this.selectedFiles(),
						this.settings.confirmBeforeDelete,
						() => this.afterDelete(),
						undefined,
						() => {
							this.selection.toggle(task.file.path);
							this.render();
						},
						() => {
							this.selection.clear();
							this.render();
						},
						task.recur,
						this.bulkTaskActions()
					);
				const dateEl = row.createDiv({
					cls: "companion-list-row-date",
					text: task.date ? formatDisplayDate(task.date) : "No date",
				});
				if (isOverdue(task)) dateEl.addClass("companion-task-overdue");
				const title = row.createDiv({ cls: "companion-list-row-title", text: task.title });
				makeOpenable(this.app, title, task.file, {
					onToggleSelect: () => {
						this.selection.toggle(task.file.path);
						this.render();
					},
					isSelecting: () => this.selection.size > 0,
				});
				this.renderBadges(row, task);
				this.renderMoveControls(row, task, "companion-list-row-controls");
			}
		}

	}

	/** A checklist-progress badge (read-only, counted from the note's own
	 * markdown checkboxes -- see countChecklist in data.ts) when the note
	 * has any, plus a priority dot that cycles None -> Low -> Medium -> High
	 * -> None on click, the same lightweight "click to change" interaction
	 * the move controls already use rather than a full edit form. */
	private renderBadges(parent: HTMLElement, task: CompanionTask): void {
		if (this.settings.taskShowChecklist && task.checklistTotal > 0) {
			parent.createDiv({
				cls: "companion-task-checklist",
				text: `${task.checklistDone}/${task.checklistTotal}`,
				attr: { "aria-label": "Checklist progress" },
			});
		}

		if (this.settings.taskShowPriority) {
			const priorityBtn = parent.createDiv({
				cls: `companion-task-priority is-${task.priority ?? "none"}`,
				attr: { "aria-label": task.priority ? `Priority: ${task.priority} — click to change` : "No priority — click to set" },
			});
			priorityBtn.onclick = (e) => {
				e.stopPropagation();
				void this.cyclePriority(task);
			};
		}
	}

	private async cyclePriority(task: CompanionTask): Promise<void> {
		const order: (TaskPriority | null)[] = [null, "low", "medium", "high"];
		const next = order[(order.indexOf(task.priority) + 1) % order.length];
		await setTaskPriority(this.app, task.file, next);
		this.refresh();
	}

	private renderMoveControls(parent: HTMLElement, task: CompanionTask, cls: string): void {
		const controls = parent.createDiv({ cls });
		const index = TASK_STATUSES.indexOf(task.status);

		const prev = controls.createEl("button", { attr: { "aria-label": "Move to previous status" } });
		setIcon(prev, "chevron-left");
		prev.disabled = index <= 0;
		prev.onclick = () => void this.moveTask(task, index - 1);

		const next = controls.createEl("button", { attr: { "aria-label": "Move to next status" } });
		setIcon(next, "chevron-right");
		next.disabled = index >= TASK_STATUSES.length - 1;
		next.onclick = () => void this.moveTask(task, index + 1);
	}

	/** Combines the sort-by field with the ascending/descending toggle into
	 * one comparator, so callers don't juggle both separately. */
	private sortComparator(): (a: CompanionTask, b: CompanionTask) => number {
		const base = this.sortKey.startsWith("title") ? byTitle : byDateThenTitle;
		const dir = this.sortKey.endsWith("desc") ? -1 : 1;
		return (a, b) => dir * base(a, b);
	}

	private async moveTask(task: CompanionTask, newIndex: number): Promise<void> {
		const newStatus: TaskStatus | undefined = TASK_STATUSES[newIndex];
		if (!newStatus || newStatus === task.status) return;
		await setTaskStatus(this.app, task.file, newStatus);
		this.refresh();
	}
}

function isOverdue(task: CompanionTask): boolean {
	return !!task.date && task.date < formatDate(new Date()) && task.status !== "Done";
}

function byDateThenTitle(a: CompanionTask, b: CompanionTask): number {
	if (a.date && b.date) return a.date.localeCompare(b.date);
	if (a.date) return -1; // dated tasks sort before undated ones
	if (b.date) return 1;
	return a.title.localeCompare(b.title);
}

function byTitle(a: CompanionTask, b: CompanionTask): number {
	return a.title.localeCompare(b.title);
}

function formatDisplayDate(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("default", { day: "numeric", month: "short" });
}
