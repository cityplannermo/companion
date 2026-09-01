import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { advanceRecurringReminder, applyEventEdit, CompanionReminder, createQuickNote, getReminders, monthlyEquivalentCost } from "./data";
import type { RecurKind } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { formatDate, formatDisplayShortDate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_FINANCE = "companion-finance-view";

/**
 * Companion's Finance tab. Subscriptions (a Reminder note with both a
 * repeat rule and a cost -- see CompanionReminder in data.ts) is the first
 * piece of it, moved here from the Reminders view so money-related things
 * have one home. Deliberately built as one section today with room to grow
 * -- Income and Expenses are meant to land here as further sections later,
 * each its own render method alongside renderSubscriptions, not a rewrite.
 */
export class FinanceView extends ItemView {
	private reminders: CompanionReminder[] = [];
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

	private subscriptions(): CompanionReminder[] {
		return this.reminders.filter((r) => !!r.recur && r.cost != null).sort(byDate);
	}

	private selectedFiles(): TFile[] {
		const selected = new Set(this.selection.all());
		return this.subscriptions().filter((r) => selected.has(r.file.path)).map((r) => r.file);
	}

	private afterDelete(): void {
		this.selection.clear();
		this.refresh();
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
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-finance-header" });
		header.createEl("h2", { text: "Finance" });

		const addBtn = header.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(addBtn, "plus");
		addBtn.createSpan({ text: "Subscription" });
		addBtn.onclick = () => this.openCreate();
	}

	/** Subscriptions -- reminders with both a repeat rule and a cost -- get
	 * a running monthly-equivalent total in the section header, and a Renew
	 * action per row that rolls the reminder's own due date forward one
	 * period in place (see advanceRecurringReminder in data.ts) rather than
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
				advanceRecurringReminder(this.app, sub.file).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			};
		}

		parent.createDiv({
			cls: "companion-note",
			text:
				"A subscription is a Reminder with both a repeat rule and a cost -- no separate note type. Renew " +
				"rolls the due date forward one period in place. Right-click (or press and hold on mobile) for " +
				"Edit/Select/Delete.",
		});
	}

	/** Opens the shared editor modal to create a new subscription -- type
	 * defaults to Reminder, but the modal's own type dropdown still lets it
	 * be changed, same as everywhere else this modal is used. */
	private openCreate(): void {
		new EventEditorModal(this.app, "create", { title: "", type: "reminder", timeStr: "00:00" }, (result) => {
			createQuickNote(
				this.app,
				result.type,
				formatDate(new Date()),
				result.title,
				result.allDay ? "00:00" : result.startTime,
				result.allDay ? undefined : result.endTime,
				result.client,
				result.recur,
				result.cost
			).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
	}

	/** Opens the shared editor modal (title, time, repeat, cost) on an
	 * existing subscription, the same modal the calendar and Reminders view
	 * use. */
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
