import { App, ItemView, TFile, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import { TimeEntry, createManualTimeEntry, getClientRate, getTimeEntries, getRunningTimeEntry, startTimeEntry, stopTimeEntry } from "./data";
import { addMonths, formatDate, formatElapsedMs, formatHours, formatTimeOfDay } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { addOverflowMenu } from "./overflowMenu";
import { Selection } from "./selection";
import { addStatTile } from "./statTiles";
import { ManualTimeEntryModal, StartTimerModal } from "./timerUI";
import { InvoiceGeneratorModal } from "./invoiceUI";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_TIME = "companion-time-view";

type Mode = "log" | "report" | "unbilled";

/** A grouping of same-day entries that share a description and client --
 * Toggl calls these "tasks"; folding repeat sessions of the same work
 * into one row is what makes a busy day's log readable. */
interface TaskGroup {
	key: string;
	description: string;
	client: string | null;
	entries: TimeEntry[];
}

/**
 * The Time view: a Log of recent entries (rolling 30 days) and a Report
 * mode for browsing and totalling any month, both built from the same
 * day-grouped, task-grouped rendering. Starting and stopping a timer only
 * happens here now -- the ribbon icon and status bar just open this view.
 */
export class TimeView extends ItemView {
	private running: TimeEntry | null = null;
	private past: TimeEntry[] = [];
	private selection = new Selection();
	private elapsedEl: HTMLElement | null = null;
	private mode: Mode = "log";
	private reportMonth: Date = new Date();
	// Overrides the month nav above with an arbitrary range once either is
	// set by hand -- cleared (falling back to reportMonth) whenever Prev/
	// Next/Today is clicked, so "browse by month" and "custom range" don't
	// fight over which one's in charge of what's shown.
	private reportFrom: string | null = null;
	private reportTo: string | null = null;
	private reportClient = ""; // "" = every client
	private expandedGroups: Set<string> = new Set();

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TIME;
	}

	getDisplayText(): string {
		return "Time";
	}

	getIcon(): string {
		return "timer";
	}

	async onOpen(): Promise<void> {
		this.refresh();
		// Ticks the running card's elapsed time only -- a full render()
		// every second (like main.ts's status bar) would also thrash the
		// list below it for no reason.
		this.registerInterval(window.setInterval(() => this.tick(), 1000));
	}

	async onClose(): Promise<void> {
		// nothing else to tear down -- registerInterval cleans itself up
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault changes. */
	refresh(): void {
		const entries = getTimeEntries(this.app);
		this.running = getRunningTimeEntry(this.app);
		this.past = entries.filter((e) => e.end !== null);
		this.render();
	}

	private tick(): void {
		if (!this.running || !this.running.start || !this.elapsedEl) return;
		this.elapsedEl.setText(formatElapsedMs(Date.now() - new Date(this.running.start).getTime()));
	}

	private selectedFiles(): TFile[] {
		const selected = new Set(this.selection.all());
		return this.past.filter((e) => selected.has(e.file.path)).map((e) => e.file);
	}

	private afterDelete(): void {
		this.selection.clear();
		this.refresh();
	}

	private promptStartTimer(): void {
		new StartTimerModal(this.app, (description, client) => {
			startTimeEntry(this.app, description, client).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
	}

	/** Opens the manual-entry modal for a session that was forgotten at the
	 * time -- same dialog and write path as the dashboard's own list-plus
	 * button (see ManualTimeEntryModal / createManualTimeEntry), offered
	 * here too since the Time tab is where Mo actually reviews his log. */
	private openManualEntry(): void {
		new ManualTimeEntryModal(this.app, (description, client, dateStr, startTimeStr, endTimeStr) => {
			createManualTimeEntry(this.app, description, client, dateStr, startTimeStr, endTimeStr, Number(this.settings.roundingMinutes)).then(
				() => this.refresh(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
	}

	private async stopRunning(): Promise<void> {
		if (!this.running) return;
		await stopTimeEntry(this.app, this.running.file, Number(this.settings.roundingMinutes));
		this.refresh();
	}

	/** Starts a new entry with the same description/client as an existing
	 * one -- Toggl's "continue" -- without reopening the Start Timer modal. */
	private continueEntry(description: string, client: string | null): void {
		startTimeEntry(this.app, description, client ?? "").then(
			() => this.refresh(),
			(err: Error) => new Notice(err.message)
		);
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-time-root");
		this.elapsedEl = null;

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

		if (this.mode === "log") {
			if (this.running) this.renderRunningCard(root);
			this.renderGoal(root);
			this.renderLog(root);
		} else if (this.mode === "report") {
			this.renderReport(root);
		} else {
			this.renderUnbilled(root);
		}
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-time-header" });
		header.createEl("h2", { text: "Time" });

		const controls = header.createDiv({ cls: "companion-time-header-controls" });

		const setMode = (mode: Mode) => {
			this.mode = mode;
			if (mode === "report") this.reportMonth = new Date();
			this.render();
		};

		const toggle = controls.createDiv({ cls: "companion-mode-toggle companion-mobile-hide" });
		const logBtn = toggle.createEl("button", { text: "Log" });
		const reportBtn = toggle.createEl("button", { text: "Report" });
		const unbilledBtn = toggle.createEl("button", { text: "Unbilled" });
		logBtn.toggleClass("is-active", this.mode === "log");
		reportBtn.toggleClass("is-active", this.mode === "report");
		unbilledBtn.toggleClass("is-active", this.mode === "unbilled");
		logBtn.onclick = () => setMode("log");
		reportBtn.onclick = () => setMode("report");
		unbilledBtn.onclick = () => setMode("unbilled");

		const manualBtn = controls.createEl("button", { cls: "companion-btn-icon-text companion-mobile-hide" });
		setIcon(manualBtn, "list-plus");
		manualBtn.createSpan({ text: "Add entry" });
		manualBtn.setAttribute("aria-label", "Log a time entry you forgot to track");
		manualBtn.onclick = () => this.openManualEntry();

		// Mobile equivalent of the Log/Report/Unbilled toggle and Add entry
		// button above -- see overflowMenu.ts. Start/Stop timer stays a
		// normal, always-visible button below (it's the tab's main action).
		addOverflowMenu(controls, [
			{ label: "Log", isActive: this.mode === "log", onClick: () => setMode("log") },
			{ label: "Report", isActive: this.mode === "report", onClick: () => setMode("report") },
			{ label: "Unbilled", isActive: this.mode === "unbilled", onClick: () => setMode("unbilled") },
			{ label: "Add entry", icon: "list-plus", onClick: () => this.openManualEntry() },
		]);

		const btn = controls.createEl("button", { cls: "mod-cta companion-btn-icon-text companion-create-pill" });
		if (this.running) {
			setIcon(btn, "square");
			btn.createSpan({ text: "Stop timer" });
			btn.onclick = () => void this.stopRunning();
		} else {
			setIcon(btn, "plus");
			btn.createSpan({ text: "Start timer" });
			btn.onclick = () => this.promptStartTimer();
		}
	}

	/** The daily-goal/streak line only -- the Today/This week/This month
	 * totals that used to sit alongside it moved to the Report page's stat
	 * tiles (Mo's own request), since a goal is inherently a "right now"
	 * thing that belongs on the live Log, not a browsed-period summary. */
	private renderGoal(parent: HTMLElement): void {
		const goal = this.settings.dailyGoalHours;
		if (goal <= 0) return;

		const todayHours = sumDuration(this.past.filter((e) => e.date === formatDate(new Date())));
		const pct = Math.min(100, Math.round((todayHours / goal) * 100));
		const streak = computeStreak(this.past, goal);
		const stats = parent.createDiv({ cls: "companion-time-stats" });
		const goalLine = stats.createDiv({ cls: "companion-time-goal" });
		goalLine.createSpan({ text: `Goal ${formatHours(goal)}/day · ${pct}% today` });
		if (streak > 0) {
			goalLine.createSpan({
				cls: "companion-time-streak",
				text: ` · 🔥 ${streak} day${streak === 1 ? "" : "s"}`,
			});
		}
	}

	private renderRunningCard(parent: HTMLElement): void {
		const running = this.running;
		if (!running) return;

		const card = parent.createDiv({ cls: "companion-time-running" });
		const info = card.createDiv({ cls: "companion-time-running-info" });
		info.createDiv({ cls: "companion-time-running-desc", text: running.description });
		if (running.client) {
			info.createDiv({ cls: "companion-time-running-client", text: running.client });
		}

		this.elapsedEl = card.createDiv({ cls: "companion-time-running-elapsed" });
		this.elapsedEl.setText(running.start ? formatElapsedMs(Date.now() - new Date(running.start).getTime()) : "0:00");

		const stop = card.createEl("button", { cls: "mod-warning", text: "Stop" });
		stop.onclick = () => void this.stopRunning();
	}

	/** Rolling 30 days -- older history lives in Report mode instead of
	 * growing this list forever. */
	private renderLog(parent: HTMLElement): void {
		const cutoff = formatDate(daysAgo(29));
		const recent = this.past.filter((e) => e.date && e.date >= cutoff);
		this.renderEntryGroups(parent, recent, recent.length === 0 ? "No time tracked in the last 30 days." : "");

		if (recent.length < this.past.length) {
			const note = parent.createDiv({ cls: "companion-note" });
			const link = note.createEl("button", {
				cls: "companion-time-report-link",
				text: "View full history in reports",
			});
			link.onclick = () => {
				this.mode = "report";
				this.reportMonth = new Date();
				this.render();
			};
		}
	}

	private renderReport(parent: HTMLElement): void {
		const nav = parent.createDiv({ cls: "companion-time-month-nav" });
		const prev = nav.createEl("button", { attr: { "aria-label": "Previous month" } });
		setIcon(prev, "chevron-left");
		prev.onclick = () => {
			this.reportMonth = addMonths(this.reportMonth, -1);
			this.reportFrom = null;
			this.reportTo = null;
			this.render();
		};
		nav.createSpan({ text: this.reportMonth.toLocaleDateString("default", { month: "long", year: "numeric" }) });
		const next = nav.createEl("button", { attr: { "aria-label": "Next month" } });
		setIcon(next, "chevron-right");
		next.disabled = monthStartStr(this.reportMonth) >= monthStartStr(new Date());
		next.onclick = () => {
			this.reportMonth = addMonths(this.reportMonth, 1);
			this.reportFrom = null;
			this.reportTo = null;
			this.render();
		};

		// Client + an optional custom date range, on top of the month nav
		// above -- setting either date by hand overrides which period the
		// stats and list below cover, until it's cleared again. Mo's own
		// request: "let me filter by client and by date range and tell me
		// time tracked in that range."
		const filterRow = parent.createDiv({ cls: "companion-time-report-filters" });
		const clientSelect = filterRow.createEl("select");
		clientSelect.createEl("option", { text: "All clients", value: "" });
		for (const name of distinctClients(this.past)) {
			clientSelect.createEl("option", { text: name, value: name });
		}
		clientSelect.value = this.reportClient;
		clientSelect.onchange = () => {
			this.reportClient = clientSelect.value;
			this.render();
		};

		const fromInput = filterRow.createEl("input", { attr: { type: "date", "aria-label": "From date" } });
		fromInput.value = this.reportFrom ?? "";
		fromInput.onchange = () => {
			this.reportFrom = fromInput.value || null;
			this.render();
		};
		filterRow.createSpan({ cls: "companion-quick-create-dash", text: "–" });
		const toInput = filterRow.createEl("input", { attr: { type: "date", "aria-label": "To date" } });
		toInput.value = this.reportTo ?? "";
		toInput.onchange = () => {
			this.reportTo = toInput.value || null;
			this.render();
		};
		if (this.reportFrom || this.reportTo) {
			const clear = filterRow.createEl("button", { cls: "companion-icon-btn", attr: { "aria-label": "Clear date range" } });
			setIcon(clear, "x");
			clear.onclick = () => {
				this.reportFrom = null;
				this.reportTo = null;
				this.render();
			};
		}

		const rangeFrom = this.reportFrom ?? monthStartStr(this.reportMonth);
		const rangeTo = this.reportTo ?? monthEndStr(this.reportMonth);
		let periodEntries = this.past.filter((e) => e.date && e.date >= rangeFrom && e.date <= rangeTo);
		if (this.reportClient) periodEntries = periodEntries.filter((e) => e.client === this.reportClient);

		this.renderReportStats(parent, periodEntries);

		if (periodEntries.length > 0) {
			const table = parent.createDiv({ cls: "companion-time-client-table" });
			for (const { client, hours } of breakdownByClient(periodEntries)) {
				const row = table.createDiv({ cls: "companion-time-client-row" });
				row.createSpan({ cls: "companion-time-client-name", text: client });
				row.createSpan({ cls: "companion-time-client-hours", text: formatHours(hours) });
			}
		}

		this.renderEntryGroups(parent, periodEntries, "Nothing tracked in this period.");
	}

	/** Six stat tiles, the same "at a glance" pattern as Finance's own
	 * overview row (Mo's own request, once the Log page's plain Today/This
	 * week/This month line moved here): three fixed "right now" windows
	 * that don't depend on what's being browsed, the browsed/filtered
	 * period's own total and billable hours (entries with a client
	 * attached -- the only ones that could ever become an invoice line),
	 * and the overall unbilled total, a fixed fact rather than something
	 * scoped to the period, same as the Unbilled tab's own definition. */
	private renderReportStats(parent: HTMLElement, periodEntries: TimeEntry[]): void {
		const todayStr = formatDate(new Date());
		const weekStart = startOfWeekStr(new Date(), this.settings.weekStartsOn);
		const monthStart = monthStartStr(new Date());

		const grid = parent.createDiv({ cls: "companion-stat-tiles" });
		addStatTile(grid, "Today", formatHours(sumDuration(this.past.filter((e) => e.date === todayStr))));
		addStatTile(grid, "This week", formatHours(sumDuration(this.past.filter((e) => e.date && e.date >= weekStart))));
		addStatTile(grid, "This month", formatHours(sumDuration(this.past.filter((e) => e.date && e.date >= monthStart))));
		addStatTile(grid, "This period", formatHours(sumDuration(periodEntries)));
		addStatTile(grid, "Billable hours", formatHours(sumDuration(periodEntries.filter((e) => !!e.client))));
		const unbilledTotal = unbilledRows(this.app, this.past).reduce((sum, r) => sum + Math.max(0, r.value), 0);
		addStatTile(grid, "Unbilled total", `£${unbilledTotal.toFixed(2)}`);
	}

	/** Everything currently tracked for a client is, by definition,
	 * unbilled -- billed entries are deleted the moment an invoice note is
	 * generated (see groupTimeEntriesForInvoice in data.ts), so whatever's
	 * still here across every month is exactly what hasn't been invoiced
	 * yet. Valued at the client's own `rate` where one's set, sorted
	 * highest-value first so the answer to "who do I need to invoice" is
	 * the first row. "Generate invoice" jumps straight into the same modal
	 * the header's own button opens, pre-selected to that client. */
	private renderUnbilled(parent: HTMLElement): void {
		const rows = unbilledRows(this.app, this.past).sort((a, b) => b.value - a.value);
		const totalValue = rows.reduce((sum, r) => sum + Math.max(0, r.value), 0);
		parent.createDiv({
			cls: "companion-time-report-summary",
			text: rows.length > 0 ? `Unbilled total: £${totalValue.toFixed(2)} across ${rows.length} client${rows.length === 1 ? "" : "s"}` : "Nothing unbilled.",
		});

		if (rows.length === 0) return;

		// A companion-note (its own border-top) follows directly below --
		// this table's usual border-bottom would double it up into two
		// adjacent lines, so it's suppressed here specifically (Report
		// mode's own table, with no note straight after, keeps its border).
		const table = parent.createDiv({ cls: "companion-time-client-table companion-time-client-table-flush" });
		for (const { client, hours, rate } of rows) {
			const row = table.createDiv({ cls: "companion-time-client-row" });
			row.createSpan({ cls: "companion-time-client-name", text: client });
			row.createSpan({
				cls: "companion-time-client-hours",
				text: rate != null ? `${formatHours(hours)} · £${(hours * rate).toFixed(2)}` : `${formatHours(hours)} · no rate set`,
			});
			const invoiceBtn = row.createEl("button", { cls: "companion-btn-icon-text" });
			setIcon(invoiceBtn, "receipt");
			invoiceBtn.createSpan({ text: "Invoice" });
			invoiceBtn.onclick = () => {
				new InvoiceGeneratorModal(
					this.app,
					this.settings,
					() => this.refresh(),
					client
				).open();
			};
		}

		parent.createDiv({
			cls: "companion-note",
			text: "Every currently tracked entry is unbilled by definition -- generating an invoice is what removes it from here.",
		});
	}

	/** Shared by Log and Report: day-grouped, then task-grouped (same
	 * description + client folded into one foldable row with a combined
	 * duration), each with its own continue button. */
	private renderEntryGroups(parent: HTMLElement, entries: TimeEntry[], emptyText: string): void {
		const list = parent.createDiv({ cls: "companion-list" });

		if (entries.length === 0) {
			list.createDiv({ cls: "companion-empty", text: emptyText });
			return;
		}

		for (const [dateKey, dayEntries] of groupByDay(entries)) {
			const groupTitle = list.createDiv({ cls: "companion-list-group-title" });
			groupTitle.createSpan({ text: `${formatDayLabel(dateKey)} — ${formatHours(sumDuration(dayEntries))}` });

			for (const group of groupByTask(dayEntries)) {
				this.renderTaskGroup(list, dateKey, group);
			}
		}
	}

	private renderTaskGroup(parent: HTMLElement, dateKey: string, group: TaskGroup): void {
		if (group.entries.length === 1) {
			this.renderEntryRow(parent, group.entries[0], false);
			return;
		}

		const groupKey = `${dateKey}::${group.key}`;
		const isExpanded = this.expandedGroups.has(groupKey);
		const toggle = () => {
			if (this.expandedGroups.has(groupKey)) this.expandedGroups.delete(groupKey);
			else this.expandedGroups.add(groupKey);
			this.render();
		};

		const row = parent.createDiv({ cls: "companion-list-row companion-time-group-row" });
		const chevron = row.createDiv({ cls: "companion-time-chevron" });
		setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
		row.createDiv({ cls: "companion-time-group-count", text: `${group.entries.length}×` });

		const title = row.createDiv({ cls: "companion-list-row-title", text: group.description });
		title.onclick = toggle;
		chevron.onclick = toggle;

		if (group.client) row.createDiv({ cls: "companion-time-client", text: group.client });
		row.createDiv({ cls: "companion-time-duration", text: formatHours(sumDuration(group.entries)) });
		this.renderPlayButton(row, group.description, group.client);

		if (isExpanded) {
			for (const entry of group.entries) {
				this.renderEntryRow(parent, entry, true);
			}
		}
	}

	private renderEntryRow(parent: HTMLElement, entry: TimeEntry, indented: boolean): void {
		const row = parent.createDiv({ cls: "companion-list-row" });
		if (indented) row.addClass("companion-time-subrow");
		row.toggleClass("is-selected", this.selection.has(entry.file.path));
		row.oncontextmenu = (e) =>
			showDeleteMenu(
				this.app,
				e,
				entry.file,
				this.selectedFiles(),
				this.settings.confirmBeforeDelete,
				() => this.afterDelete(),
				undefined,
				() => {
					this.selection.toggle(entry.file.path);
					this.render();
				},
				() => {
					this.selection.clear();
					this.render();
				}
			);

		row.createDiv({
			cls: "companion-list-row-date",
			text: entry.start && entry.end ? `${formatTimeOfDay(entry.start)}–${formatTimeOfDay(entry.end)}` : "—",
		});

		const title = row.createDiv({ cls: "companion-list-row-title", text: entry.description });
		makeOpenable(this.app, title, entry.file, {
			onToggleSelect: () => {
				this.selection.toggle(entry.file.path);
				this.render();
			},
			isSelecting: () => this.selection.size > 0,
		});

		if (entry.client) row.createDiv({ cls: "companion-time-client", text: entry.client });
		row.createDiv({
			cls: "companion-time-duration",
			text: entry.duration !== null ? formatHours(entry.duration) : "—",
		});
		this.renderPlayButton(row, entry.description, entry.client);
	}

	private renderPlayButton(parent: HTMLElement, description: string, client: string | null): void {
		const btn = parent.createEl("button", {
			cls: "companion-time-play",
			attr: { "aria-label": `Continue "${description}"` },
		});
		setIcon(btn, "play");
		btn.onclick = (e) => {
			e.stopPropagation();
			this.continueEntry(description, client);
		};
	}
}

function sumDuration(entries: TimeEntry[]): number {
	return entries.reduce((total, e) => total + (e.duration ?? 0), 0);
}

function daysAgo(n: number): Date {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d;
}

/** The first day of the week containing `d` (Monday or Sunday, per the
 * "Week starts on" setting), as a YYYY-MM-DD string. */
function startOfWeekStr(d: Date, weekStartsOn: "monday" | "sunday"): string {
	const day = d.getDay(); // 0 (Sun) .. 6 (Sat)
	const diff = weekStartsOn === "sunday" ? -day : (day === 0 ? -6 : 1) - day;
	const start = new Date(d);
	start.setDate(d.getDate() + diff);
	return formatDate(start);
}

function monthStartStr(d: Date): string {
	return formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

function monthEndStr(d: Date): string {
	return formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** Consecutive days (today backward) whose tracked hours meet `goalHours`.
 * Stops at the first day that doesn't -- including today, if today hasn't
 * hit the goal yet, which reads as 0 until it does. */
function computeStreak(entries: TimeEntry[], goalHours: number): number {
	if (goalHours <= 0) return 0;
	const totalsByDay = new Map<string, number>();
	for (const e of entries) {
		if (!e.date) continue;
		totalsByDay.set(e.date, (totalsByDay.get(e.date) ?? 0) + (e.duration ?? 0));
	}
	let streak = 0;
	const cursor = new Date();
	for (;;) {
		const total = totalsByDay.get(formatDate(cursor)) ?? 0;
		if (total < goalHours) break;
		streak++;
		cursor.setDate(cursor.getDate() - 1);
	}
	return streak;
}

/** Every distinct client name actually appearing in `entries`, sorted --
 * backs the Report page's client filter dropdown with only clients that
 * have tracked time, rather than every hub note tagged `client` (some of
 * which may never have been timed at all). */
function distinctClients(entries: TimeEntry[]): string[] {
	const names = new Set<string>();
	for (const e of entries) if (e.client) names.add(e.client);
	return Array.from(names).sort();
}

/** Groups every entry with a client and a duration by that client, valued
 * at the client's own `rate` where one's set (`value: -1` marks "no rate",
 * kept out of any total via `Math.max(0, ...)` rather than dropped, so a
 * client with no rate still shows up in the Unbilled tab's own list).
 * Shared by the Unbilled tab's rows and the Report page's "Unbilled total"
 * tile, so the two numbers can never drift apart. */
function unbilledRows(app: App, entries: TimeEntry[]): { client: string; hours: number; rate: number | null; value: number }[] {
	const byClient = new Map<string, number>();
	for (const entry of entries) {
		if (!entry.client || entry.duration == null) continue;
		byClient.set(entry.client, (byClient.get(entry.client) ?? 0) + entry.duration);
	}
	return Array.from(byClient.entries()).map(([client, hours]) => {
		const rate = getClientRate(app, client);
		return { client, hours, rate, value: rate != null ? hours * rate : -1 };
	});
}

function breakdownByClient(entries: TimeEntry[]): { client: string; hours: number }[] {
	const totals = new Map<string, number>();
	for (const e of entries) {
		const key = e.client ?? "No client";
		totals.set(key, (totals.get(key) ?? 0) + (e.duration ?? 0));
	}
	return Array.from(totals.entries())
		.map(([client, hours]) => ({ client, hours }))
		.sort((a, b) => b.hours - a.hours);
}

/** Groups entries by their `date` field (falling back to "No date"),
 * newest day first, each day's entries newest-start first. */
function groupByDay(entries: TimeEntry[]): [string, TimeEntry[]][] {
	const groups = new Map<string, TimeEntry[]>();
	for (const entry of entries) {
		const key = entry.date ?? "No date";
		const bucket = groups.get(key);
		if (bucket) bucket.push(entry);
		else groups.set(key, [entry]);
	}
	for (const bucket of groups.values()) {
		bucket.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
	}
	return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

/** Folds a day's entries sharing a description + client into one group,
 * in the order each was first encountered (already newest-start-first). */
function groupByTask(entries: TimeEntry[]): TaskGroup[] {
	const groups: TaskGroup[] = [];
	const index = new Map<string, number>();
	for (const entry of entries) {
		const key = `${entry.description} ${entry.client ?? ""}`;
		const existing = index.get(key);
		if (existing !== undefined) {
			groups[existing].entries.push(entry);
		} else {
			index.set(key, groups.length);
			groups.push({ key, description: entry.description, client: entry.client, entries: [entry] });
		}
	}
	return groups;
}

function formatDayLabel(dateStr: string): string {
	if (dateStr === "No date") return dateStr;
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("default", { weekday: "short", day: "numeric", month: "short" });
}
