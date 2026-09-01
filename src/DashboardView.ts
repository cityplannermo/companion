import { App, ItemView, MarkdownRenderChild, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	CompanionEvent,
	buildIndex,
	getRecurringOccurrences,
	getReminders,
	getRunningTimeEntry,
	getTasks,
	TimeEntry,
} from "./data";
import { getTodaysDailyNoteInfo, openTodaysDailyNote } from "./dailyNote";
import { addDays, formatDate, formatElapsedMs } from "./dates";
import { makeOpenable } from "./openHandlers";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_DASHBOARD = "companion-dashboard-view";

/**
 * "One place to see the important stuff" (Mo's own words) rather than a
 * per-client rollup -- a running timer, today's agenda, and what's overdue
 * or due soon, in one screen instead of checking Calendar/Tasks/Time/
 * Reminders separately every morning. Available two ways: this standalone
 * tab, and embedded directly in the Daily Note via a `companion-dashboard`
 * code block (see DashboardEmbed below) -- both call the same render
 * functions further down this file so they never drift apart. A per-client
 * view is still open as a later, different idea (see Companion.md's
 * roadmap) if this shape turns out not to be what's actually wanted.
 */
export class DashboardView extends ItemView {
	private running: TimeEntry | null = null;
	private elapsedEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText(): string {
		return "Dashboard";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.registerInterval(window.setInterval(() => this.tick(), 1000));
		this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to tear down beyond the interval, which registerInterval already handles
	}

	private tick(): void {
		if (!this.running || !this.running.start || !this.elapsedEl) return;
		this.elapsedEl.setText(formatElapsedMs(Date.now() - new Date(this.running.start).getTime()));
	}

	refresh(): void {
		this.running = getRunningTimeEntry(this.app);
		void this.render();
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-dashboard-root");
		this.elapsedEl = null;

		root.createEl("h2", { text: "Dashboard" });
		await this.renderTodayNoteCard(root);
		this.elapsedEl = renderDashboardBody(this.app, root, this.running);
	}

	/** A one-click link to today's actual Daily Note. Kept even though the
	 * Dashboard can also be embedded directly inside that note (see
	 * DashboardEmbed below) -- this standalone tab is still worth having on
	 * its own (a leaf pinned open all day, or checking a day that isn't
	 * today from elsewhere), and this is the fastest way from it back to
	 * today's freeform notes. Creates the note from the configured template
	 * first if it doesn't exist yet. */
	private async renderTodayNoteCard(parent: HTMLElement): Promise<void> {
		const info = await getTodaysDailyNoteInfo(this.app);
		const card = parent.createDiv({ cls: "companion-dashboard-daily-link" });
		const btn = card.createEl("button", { cls: "companion-btn-icon-text" });
		setIcon(btn, "calendar-days");
		btn.createSpan({ text: info.exists ? `Today's note — ${info.label}` : `Create today's note — ${info.label}` });
		btn.onclick = () => openTodaysDailyNote(this.app);
	}
}

/** Renders the timer/agenda/overdue/due-soon body shared by the standalone
 * tab above and the Daily Note embed below. Returns the elapsed-time
 * element so the caller can tick it every second; null when nothing's
 * running. */
function renderDashboardBody(app: App, root: HTMLElement, running: TimeEntry | null): HTMLElement | null {
	const elapsedEl = running ? renderRunningCard(root, running) : null;
	renderToday(app, root);
	renderOverdue(app, root);
	renderDueSoon(app, root);
	return elapsedEl;
}

function renderRunningCard(parent: HTMLElement, running: TimeEntry): HTMLElement {
	const card = parent.createDiv({ cls: "companion-dashboard-running" });
	const info = card.createDiv({ cls: "companion-time-running-info" });
	info.createDiv({ cls: "companion-time-running-desc", text: running.description });
	if (running.client) info.createDiv({ cls: "companion-time-running-client", text: running.client });

	const elapsedEl = card.createDiv({ cls: "companion-time-running-elapsed" });
	elapsedEl.setText(running.start ? formatElapsedMs(Date.now() - new Date(running.start).getTime()) : "0:00");
	return elapsedEl;
}

/** Today's Meetings/Events/Invoices/Reminders -- real dated notes plus
 * any recurring series' projected occurrence for today, the same two
 * sources the calendar itself combines for a single day. Tasks are
 * deliberately left to the Overdue/Due soon sections below instead --
 * a task's date is a deadline, not a scheduled slot, so it reads
 * better grouped by urgency than mixed into a time-of-day agenda. */
function renderToday(app: App, parent: HTMLElement): void {
	const section = parent.createDiv({ cls: "companion-dashboard-section" });
	section.createEl("h3", { text: "Today" });

	const todayStr = formatDate(new Date());
	const index = buildIndex(app);
	const items = [...(index.get(todayStr) ?? []), ...getRecurringOccurrences(app, todayStr, todayStr)]
		.filter((e) => e.type !== "task")
		.sort((a, b) => a.time.localeCompare(b.time));

	if (items.length === 0) {
		section.createDiv({ cls: "companion-empty", text: "Nothing on today." });
		return;
	}

	for (const item of items) renderEventRow(app, section, item);
}

/** Overdue Tasks (not Done, date in the past) and overdue Reminders
 * (date in the past) together -- the one list worth checking so
 * nothing's slipped through, regardless of which view it actually
 * lives in day to day. */
function renderOverdue(app: App, parent: HTMLElement): void {
	const section = parent.createDiv({ cls: "companion-dashboard-section" });
	section.createEl("h3", { text: "Overdue" });

	const todayStr = formatDate(new Date());
	const tasks = getTasks(app).filter((t) => t.status !== "Done" && t.date && t.date < todayStr);
	const reminders = getReminders(app).filter((r) => r.date && r.date < todayStr && !(r.recur && r.cost != null));

	if (tasks.length === 0 && reminders.length === 0) {
		section.createDiv({ cls: "companion-empty", text: "Nothing overdue." });
		return;
	}

	for (const task of tasks.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
		renderPlainRow(app, section, task.title, task.date, "Task", task.file);
	}
	for (const reminder of reminders.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
		renderPlainRow(app, section, reminder.title, reminder.date, "Reminder", reminder.file);
	}
}

/** Tasks due in the next 7 days, not yet overdue -- a lighter-weight
 * heads-up so a deadline doesn't arrive as a surprise the day it tips
 * into Overdue above. */
function renderDueSoon(app: App, parent: HTMLElement): void {
	const section = parent.createDiv({ cls: "companion-dashboard-section" });
	section.createEl("h3", { text: "Due this week" });

	const todayStr = formatDate(new Date());
	const cutoff = formatDate(addDays(new Date(), 7));
	const tasks = getTasks(app)
		.filter((t) => t.status !== "Done" && t.date && t.date >= todayStr && t.date <= cutoff)
		.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

	if (tasks.length === 0) {
		section.createDiv({ cls: "companion-empty", text: "Nothing due in the next 7 days." });
		return;
	}

	for (const task of tasks) renderPlainRow(app, section, task.title, task.date, "Task", task.file);
}

function renderEventRow(app: App, parent: HTMLElement, item: CompanionEvent): void {
	const row = parent.createDiv({ cls: "companion-list-row" });
	row.createDiv({ cls: "companion-list-row-date", text: item.time === "00:00" ? "All day" : item.time });
	const title = row.createDiv({ cls: "companion-list-row-title", text: item.title });
	if (item.client) title.createSpan({ cls: "companion-dashboard-client", text: ` — ${item.client}` });
	row.createDiv({ cls: "companion-dashboard-type", text: typeLabel(item.type) });
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
	return "Task";
}

// -- Daily Note embed (`companion-dashboard` code block) --------------------

const activeEmbeds = new Set<DashboardEmbed>();

/** One instance per rendered `companion-dashboard` code block in an open
 * note -- Obsidian creates and tears these down automatically as a note is
 * opened, re-rendered or closed (see MarkdownRenderChild), so refreshing
 * everywhere the Dashboard is embedded only needs to track which are
 * currently alive. Registered in main.ts's registerMarkdownCodeBlockProcessor
 * and refreshed from the same hooks that refresh the standalone tab. */
export class DashboardEmbed extends MarkdownRenderChild {
	private running: TimeEntry | null = null;
	private elapsedEl: HTMLElement | null = null;

	constructor(
		containerEl: HTMLElement,
		private app: App
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
		this.containerEl.empty();
		this.containerEl.addClass("companion-dashboard-root");
		this.containerEl.addClass("companion-dashboard-embed");
		this.elapsedEl = renderDashboardBody(this.app, this.containerEl, this.running);
	}

	private tick(): void {
		if (!this.running || !this.running.start || !this.elapsedEl) return;
		this.elapsedEl.setText(formatElapsedMs(Date.now() - new Date(this.running.start).getTime()));
	}
}

/** Refreshes every `companion-dashboard` embed currently rendered in any
 * open note, alongside the standalone tab -- call this from wherever
 * refreshOpenViews() is called in main.ts. */
export function refreshAllDashboardEmbeds(): void {
	for (const embed of activeEmbeds) embed.refresh();
}
