import { App, MarkdownRenderChild, Notice, setIcon, TFile } from "obsidian";
import {
	CompanionEvent,
	buildIndex,
	createManualTimeEntry,
	createQuickNote,
	getClientNames,
	getRecurringOccurrences,
	getReminders,
	getRunningTimeEntry,
	getTasks,
	getTimeEntries,
	startTimeEntry,
	stopTimeEntry,
	TimeEntry,
} from "./data";
import { addDays, formatDate, formatElapsedMs, formatHours } from "./dates";
import { EventEditorModal } from "./eventEditorUI";
import { makeOpenable } from "./openHandlers";
import type { CompanionSettings } from "./settings";
import { ManualTimeEntryModal } from "./timerUI";

/** The sections a Daily Note dashboard embed can fold. "timeEntries" is the
 * recent-entries list under the timer, not the timer controls themselves --
 * those (running card, or the start row) stay visible whatever's folded,
 * since starting/stopping a timer is the whole point of having this here. */
type DashboardSection = "today" | "overdue" | "dueSoon" | "timeEntries";

function renderEventRow(app: App, parent: HTMLElement, item: CompanionEvent): void {
	const row = parent.createDiv({ cls: "companion-list-row" });
	row.createDiv({ cls: "companion-list-row-date", text: item.time === "00:00" ? "All day" : item.time });
	const title = row.createDiv({ cls: "companion-list-row-title", text: item.title });
	if (item.client) title.createSpan({ cls: "companion-dashboard-client", text: ` — ${item.client}` });
	row.createDiv({ cls: "companion-dashboard-type", text: item.type === "post" && item.provisional ? "Post · scheduled" : typeLabel(item.type) });
	// A virtual (not-yet-materialised) recurring occurrence has no real
	// note of its own yet -- opening it would open the series anchor
	// instead and be confusing, so it's shown but not clickable here.
	// Materialise it from the Calendar, same as everywhere else.
	if (!item.virtualOf) makeOpenable(app, title, item.file);
}

function renderPlainRow(app: App, parent: HTMLElement, title: string, date: string | null, kind: string, file: TFile): void {
	const row = parent.createDiv({ cls: "companion-list-row" });
	row.createDiv({ cls: "companion-list-row-date", text: date ?? "No date" });
	const titleEl = row.createDiv({ cls: "companion-list-row-title", text: title });
	makeOpenable(app, titleEl, file);
	row.createDiv({ cls: "companion-dashboard-type", text: kind });
}

function typeLabel(type: CompanionEvent["type"]): string {
	if (type === "meeting") return "Meeting";
	if (type === "event") return "Event";
	if (type === "invoice") return "Invoice";
	if (type === "reminder") return "Reminder";
	if (type === "post") return "Post";
	return "Task";
}

// -- Daily Note embed (`companion-dashboard` code block) --------------------

const activeEmbeds = new Set<DashboardEmbed>();

/** One instance per rendered `companion-dashboard` code block in an open
 * note -- Obsidian creates and tears these down automatically as a note is
 * opened, re-rendered or closed (see MarkdownRenderChild), so refreshing
 * everywhere the Dashboard is embedded only needs to track which are
 * currently alive. Registered in main.ts's registerMarkdownCodeBlockProcessor
 * and refreshed from the same hooks that refresh every other view.
 *
 * "One place to see the important stuff" (Mo's own words) -- a running
 * timer with a one-line way to start a new one, quick-create for a new
 * task/reminder/event, and Today/Overdue/Due-this-week, each foldable so
 * the embed doesn't have to take over the whole note just to be useful. */
export class DashboardEmbed extends MarkdownRenderChild {
	private running: TimeEntry | null = null;
	private elapsedEl: HTMLElement | null = null;
	// Every section starts folded -- opening the daily note should show a
	// compact dashboard (running timer aside), not a wall of everything at
	// once. Click a fold header to expand just that section.
	private collapsed: Set<DashboardSection> = new Set(["today", "overdue", "dueSoon", "timeEntries"]);

	constructor(
		containerEl: HTMLElement,
		private app: App,
		private settings: CompanionSettings
	) {
		super(containerEl);
	}

	onload(): void {
		activeEmbeds.add(this);
		this.registerInterval(window.setInterval(() => this.tick(), 1000));
		this.refresh();
	}

	onunload(): void {
		activeEmbeds.delete(this);
	}

	refresh(): void {
		this.running = getRunningTimeEntry(this.app);
		this.render();
	}

	private tick(): void {
		if (!this.running || !this.running.start || !this.elapsedEl) return;
		this.elapsedEl.setText(formatElapsedMs(Date.now() - new Date(this.running.start).getTime()));
	}

	private toggleSection(section: DashboardSection): void {
		if (this.collapsed.has(section)) this.collapsed.delete(section);
		else this.collapsed.add(section);
		this.render();
	}

	/** Rebuilds the whole embed from scratch -- always starts by emptying
	 * containerEl, since this is called not just from refresh() (a vault
	 * change) but from toggleSection() too (a fold header click), which
	 * doesn't re-read the vault but still needs a clean redraw rather than
	 * appending a second copy of everything on top of what's already there. */
	private render(): void {
		const root = this.containerEl;
		root.empty();
		root.addClass("companion-dashboard-root");
		root.addClass("companion-dashboard-embed");
		this.elapsedEl = null;

		this.renderTimeTracker(root);
		this.renderToday(root);
		this.renderOverdue(root);
		this.renderDueSoon(root);
	}

	private openQuickCreate(): void {
		const today = formatDate(new Date());
		new EventEditorModal(this.app, "create", { title: "", type: "reminder", date: today, timeStr: "00:00" }, (result) => {
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

	/** Fold header shared by every collapsible section below -- a chevron,
	 * a label with an item count, and a click anywhere on the row toggles
	 * it. Matches the same group-header look Task board/Finance/Reminders
	 * already use for their own collapsible groups. */
	private renderFoldHeader(parent: HTMLElement, key: DashboardSection, label: string, count: number): boolean {
		const isCollapsed = this.collapsed.has(key);
		const header = parent.createDiv({ cls: "companion-list-group-title" });
		const chevron = header.createSpan({ cls: "companion-list-group-chevron" });
		setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: count > 0 ? `${label} (${count})` : label });
		header.onclick = () => this.toggleSection(key);
		return isCollapsed;
	}

	/** Today's Meetings/Events/Invoices/Reminders -- real dated notes plus
	 * any recurring series' projected occurrence for today, the same two
	 * sources the calendar itself combines for a single day. Tasks are
	 * deliberately left to the Overdue/Due soon sections below instead --
	 * a task's date is a deadline, not a scheduled slot, so it reads
	 * better grouped by urgency than mixed into a time-of-day agenda. */
	private renderToday(root: HTMLElement): void {
		const section = root.createDiv({ cls: "companion-dashboard-section" });

		const todayStr = formatDate(new Date());
		const index = buildIndex(this.app);
		const items = [...(index.get(todayStr) ?? []), ...getRecurringOccurrences(this.app, todayStr, todayStr)]
			.filter((e) => e.type !== "task")
			.sort((a, b) => a.time.localeCompare(b.time));

		if (this.renderFoldHeader(section, "today", "Today", items.length)) return;

		if (items.length === 0) {
			section.createDiv({ cls: "companion-empty", text: "Nothing on today." });
			return;
		}
		for (const item of items) renderEventRow(this.app, section, item);
	}

	/** Overdue Tasks (not Done, date in the past) and overdue Reminders
	 * (date in the past) together -- the one list worth checking so
	 * nothing's slipped through, regardless of which view it actually
	 * lives in day to day. */
	private renderOverdue(root: HTMLElement): void {
		const section = root.createDiv({ cls: "companion-dashboard-section" });

		const todayStr = formatDate(new Date());
		const tasks = getTasks(this.app).filter((t) => t.status !== "Done" && t.date && t.date < todayStr);
		const reminders = getReminders(this.app).filter((r) => r.date && r.date < todayStr && !(r.recur && r.cost != null));

		if (this.renderFoldHeader(section, "overdue", "Overdue", tasks.length + reminders.length)) return;

		if (tasks.length === 0 && reminders.length === 0) {
			section.createDiv({ cls: "companion-empty", text: "Nothing overdue." });
			return;
		}
		for (const task of tasks.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
			renderPlainRow(this.app, section, task.title, task.date, "Task", task.file);
		}
		for (const reminder of reminders.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
			renderPlainRow(this.app, section, reminder.title, reminder.date, "Reminder", reminder.file);
		}
	}

	/** Tasks due in the next 7 days, not yet overdue -- a lighter-weight
	 * heads-up so a deadline doesn't arrive as a surprise the day it tips
	 * into Overdue above. */
	private renderDueSoon(root: HTMLElement): void {
		const section = root.createDiv({ cls: "companion-dashboard-section" });

		const todayStr = formatDate(new Date());
		const cutoff = formatDate(addDays(new Date(), 7));
		const tasks = getTasks(this.app)
			.filter((t) => t.status !== "Done" && t.date && t.date >= todayStr && t.date <= cutoff)
			.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

		if (this.renderFoldHeader(section, "dueSoon", "Due this week", tasks.length)) return;

		if (tasks.length === 0) {
			section.createDiv({ cls: "companion-empty", text: "Nothing due in the next 7 days." });
			return;
		}
		for (const task of tasks) renderPlainRow(this.app, section, task.title, task.date, "Task", task.file);
	}

	/** A running timer (with Stop), or a one-line "start one" row -- a
	 * description field, a client dropdown, and a Start button, so
	 * starting a timer doesn't need the full Start Timer modal from here.
	 * Recent past entries sit below, folded by default (see
	 * renderTimeEntryRow), each with the same continue/play button the
	 * Time tab's Log view has. */
	private renderTimeTracker(root: HTMLElement): void {
		const section = root.createDiv({ cls: "companion-dashboard-section" });

		const header = section.createDiv({ cls: "companion-dashboard-timer-header" });
		header.createEl("h3", { text: "Time tracker" });
		const addBtn = header.createEl("button", {
			cls: "companion-icon-btn companion-icon-btn-accent mod-cta",
			attr: { "aria-label": "New item" },
		});
		setIcon(addBtn, "plus");
		addBtn.onclick = () => this.openQuickCreate();

		if (this.running) {
			this.renderRunningCard(section);
		} else {
			this.renderStartRow(section);
		}

		const past = getTimeEntries(this.app)
			.filter((e) => e.end !== null)
			.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))
			.slice(0, 5);

		if (this.renderFoldHeader(section, "timeEntries", "Recent time entries", past.length)) return;

		if (past.length === 0) {
			section.createDiv({ cls: "companion-empty", text: "No time tracked yet." });
			return;
		}
		for (const entry of past) this.renderTimeEntryRow(section, entry);
	}

	private renderRunningCard(parent: HTMLElement): void {
		const running = this.running;
		if (!running) return;

		const card = parent.createDiv({ cls: "companion-dashboard-running" });
		const info = card.createDiv({ cls: "companion-time-running-info" });
		info.createDiv({ cls: "companion-time-running-desc", text: running.description });
		if (running.client) info.createDiv({ cls: "companion-time-running-client", text: running.client });

		this.elapsedEl = card.createDiv({ cls: "companion-time-running-elapsed" });
		this.elapsedEl.setText(running.start ? formatElapsedMs(Date.now() - new Date(running.start).getTime()) : "0:00");

		const stop = card.createEl("button", { cls: "mod-warning", text: "Stop" });
		stop.onclick = () => void this.stopRunning();
	}

	private async stopRunning(): Promise<void> {
		if (!this.running) return;
		try {
			await stopTimeEntry(this.app, this.running.file, Number(this.settings.roundingMinutes));
		} catch (err) {
			new Notice((err as Error).message);
			return;
		}
		this.refresh();
	}

	private renderStartRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: "companion-dashboard-timer-row" });

		const descInput = row.createEl("input", {
			cls: "companion-filter-input",
			attr: { type: "text", placeholder: "What are you working on?", autocomplete: "off" },
		});

		const clientSelect = row.createEl("select", { cls: "companion-mode-select" });
		clientSelect.createEl("option", { text: "No client", value: "" });
		for (const name of getClientNames(this.app)) clientSelect.createEl("option", { text: name, value: name });

		const addManual = row.createEl("button", {
			cls: "companion-icon-btn",
			attr: { "aria-label": "Add a time entry manually" },
		});
		setIcon(addManual, "list-plus");
		addManual.onclick = () => this.openManualEntry();

		const start = row.createEl("button", {
			cls: "companion-icon-btn",
			attr: { "aria-label": "Start timer" },
		});
		setIcon(start, "play");

		const submit = () => {
			const description = descInput.value.trim();
			if (!description) {
				descInput.focus();
				return;
			}
			startTimeEntry(this.app, description, clientSelect.value).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		};
		descInput.onkeydown = (e) => {
			if (e.key === "Enter") submit();
		};
		start.onclick = submit;
	}

	/** Opens the manual-entry modal for a session that was forgotten at the
	 * time -- unlike Start above, this doesn't touch the running timer at
	 * all, it just writes an already-finished entry directly. */
	private openManualEntry(): void {
		new ManualTimeEntryModal(this.app, (description, client, dateStr, startTimeStr, endTimeStr) => {
			createManualTimeEntry(this.app, description, client, dateStr, startTimeStr, endTimeStr, Number(this.settings.roundingMinutes)).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
	}

	/** Rolls a past entry into a new running one with the same description
	 * and client -- Toggl's "continue" -- the same shortcut the Time tab's
	 * own Log view offers per row. */
	private renderTimeEntryRow(parent: HTMLElement, entry: TimeEntry): void {
		const row = parent.createDiv({ cls: "companion-list-row" });
		row.createDiv({ cls: "companion-list-row-date", text: entry.date ?? "—" });

		const title = row.createDiv({ cls: "companion-list-row-title", text: entry.description });
		makeOpenable(this.app, title, entry.file);

		if (entry.client) row.createDiv({ cls: "companion-time-client", text: entry.client });
		row.createDiv({
			cls: "companion-time-duration",
			text: entry.duration !== null ? formatHours(entry.duration) : "—",
		});

		const btn = row.createEl("button", {
			cls: "companion-time-play",
			attr: { "aria-label": `Continue "${entry.description}"` },
		});
		setIcon(btn, "play");
		btn.onclick = (e) => {
			e.stopPropagation();
			startTimeEntry(this.app, entry.description, entry.client ?? "").then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		};
	}
}

/** Refreshes every `companion-dashboard` embed currently rendered in any
 * open note -- call this from wherever refreshOpenViews() is called in
 * main.ts. */
export function refreshAllDashboardEmbeds(): void {
	for (const embed of activeEmbeds) embed.refresh();
}
