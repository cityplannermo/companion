import { App, Menu, Modal, Notice, TFile } from "obsidian";
import { advanceRecurringOccurrence, deleteCompanionFile, RecurKind, TASK_PRIORITIES, TASK_STATUSES, TaskPriority, TaskStatus } from "./data";

function doDelete(app: App, files: TFile[], onDone: () => void): void {
	Promise.all(files.map((f) => deleteCompanionFile(app, f))).then(
		() => {
			new Notice(files.length === 1 ? "Deleted." : `Deleted ${files.length} notes.`);
			onDone();
		},
		(err: Error) => new Notice(err.message)
	);
}

/** Shown only when the "Confirm before deleting" setting is on -- off by
 * default, in which case delete fires immediately (see confirmAndDelete). */
class ConfirmDeleteModal extends Modal {
	constructor(
		app: App,
		private count: number,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.count === 1 ? "Delete this note?" : `Delete ${this.count} notes?` });
		contentEl.createEl("p", { text: "Moved to trash -- not permanent." });

		const controls = contentEl.createDiv({ cls: "companion-timer-controls" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const del = controls.createEl("button", { text: "Delete", cls: "mod-warning" });
		del.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Moves one or more notes to Obsidian's own trash (system or .trash, per
 * Settings -> Files & Links) -- reversible, never a permanent delete.
 * Fires immediately unless the "Confirm before deleting" setting is on
 * (off by default), in which case a small modal asks first. The single
 * path every Companion view's delete affordance (right-click menu,
 * selection bar) ends up calling.
 */
export function confirmAndDelete(app: App, files: TFile[], confirmFirst: boolean, onDone: () => void): void {
	if (files.length === 0) return;
	if (confirmFirst) {
		new ConfirmDeleteModal(app, files.length, () => doDelete(app, files, onDone)).open();
	} else {
		doDelete(app, files, onDone);
	}
}

/**
 * Right-click (desktop) or press-and-hold (touch -- the browser's own
 * long-press gesture fires this same "contextmenu" event) menu for a
 * single item. If that item is part of an active multi-selection (2+
 * items), Delete targets the whole selection -- otherwise just this one
 * note. This is the only way to delete from Companion; there's no toolbar
 * trash icon cluttering every row.
 *
 * "Select"/"Deselect" is also this menu's entry point into multi-select on
 * touch, where there's no Shift key to hold -- see openHandlers.ts for why
 * a direct press-and-hold-to-select gesture doesn't work (it collides with
 * this very menu). Once one item's selected, isSelecting on the view's
 * other makeOpenable calls means a plain tap adds the next one, so this
 * menu only needs to start the selection, not maintain it.
 *
 * "Clear selection" is here too, once 2+ items are selected -- reaching
 * the "N selected" bar's own Clear button means scrolling all the way back
 * to wherever the list currently is, which defeats the point on a long
 * list on a phone. This menu is already open wherever the finger already
 * is, so it's the more convenient place to end a selection too.
 *
 * A multi-selection stays delete-only everywhere except the Task board,
 * which additionally passes `bulkTaskActions` -- see its own comment below.
 */
export function showDeleteMenu(
	app: App,
	event: MouseEvent,
	file: TFile,
	selectedFiles: TFile[],
	confirmFirst: boolean,
	onDone: () => void,
	onEdit?: () => void,
	onToggleSelect?: () => void,
	onClear?: () => void,
	// Set when `file` is itself a recurring series' anchor -- adds "Skip
	// this occurrence" above the usual Delete, for the one case Delete
	// alone can't express: removing just the anchor's own date without
	// ending the whole series. See advanceRecurringOccurrence in data.ts
	// for why that's a date-advance rather than a real delete. Only shown
	// against a single item; a multi-selection stays delete-only.
	recur?: RecurKind,
	// Set only by the Task board -- adds "Move to <status>"/"Priority: …"
	// items once 2+ tasks are selected, so a batch of tasks can be re-
	// columned or re-prioritised in one action instead of one at a time
	// (Mo's own request: "a way to move all the items I selected"). Left
	// undefined by every other view's call site, since bulk status/priority
	// only means anything for a Task.
	bulkTaskActions?: {
		onSetStatus: (status: TaskStatus) => void;
		onSetPriority: (priority: TaskPriority | null) => void;
	}
): void {
	event.preventDefault();
	const inSelection = selectedFiles.some((f) => f.path === file.path);
	const targets = inSelection && selectedFiles.length > 1 ? selectedFiles : [file];

	const menu = new Menu();
	// Edit and Select/Deselect only make sense against a single item -- a
	// multi-selection right-click stays delete-only, same as it always has.
	if (onEdit && targets.length === 1) {
		menu.addItem((item) => item.setTitle("Edit").setIcon("pencil").onClick(onEdit));
	}
	if (onToggleSelect && targets.length === 1) {
		menu.addItem((item) =>
			item
				.setTitle(inSelection ? "Deselect" : "Select")
				.setIcon(inSelection ? "square" : "check-square")
				.onClick(onToggleSelect)
		);
	}
	if (onClear && selectedFiles.length > 1) {
		menu.addItem((item) => item.setTitle("Clear selection").setIcon("x").onClick(onClear));
	}
	if (recur && targets.length === 1) {
		menu.addItem((item) =>
			item
				.setTitle("Skip this occurrence")
				.setIcon("skip-forward")
				.onClick(() => {
					advanceRecurringOccurrence(app, file).then(onDone, (err: Error) => new Notice(err.message));
				})
		);
	}
	if (bulkTaskActions && targets.length > 1) {
		menu.addSeparator();
		for (const status of TASK_STATUSES) {
			menu.addItem((item) =>
				item
					.setTitle(`Move ${targets.length} to ${status}`)
					.setIcon("arrow-right-circle")
					.onClick(() => bulkTaskActions.onSetStatus(status))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(`Clear priority on ${targets.length}`)
				.setIcon("flag")
				.onClick(() => bulkTaskActions.onSetPriority(null))
		);
		for (const priority of TASK_PRIORITIES) {
			menu.addItem((item) =>
				item
					.setTitle(`Set ${priority} priority on ${targets.length}`)
					.setIcon("flag")
					.onClick(() => bulkTaskActions.onSetPriority(priority))
			);
		}
	}
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle(targets.length === 1 ? "Delete" : `Delete ${targets.length} selected`)
			.setIcon("trash")
			.onClick(() => confirmAndDelete(app, targets, confirmFirst, onDone))
	);
	menu.showAtMouseEvent(event);
}

/** The "N selected" bar shown above a view's list once Shift+click has
 * marked one or more items -- its own Delete goes through the same
 * confirmAndDelete path as the right-click menu. */
export function renderSelectionBar(
	parent: HTMLElement,
	count: number,
	onDelete: () => void,
	onClear: () => void
): void {
	if (count === 0) return;
	const bar = parent.createDiv({ cls: "companion-selection-bar" });
	bar.createSpan({ cls: "companion-selection-count", text: `${count} selected` });
	const del = bar.createEl("button", { cls: "mod-warning", text: "Delete" });
	del.onclick = onDelete;
	const clear = bar.createEl("button", { text: "Clear" });
	clear.onclick = onClear;
}
