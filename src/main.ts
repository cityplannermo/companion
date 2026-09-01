import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import { RemindersView, VIEW_TYPE_REMINDERS } from "./RemindersView";
import { TaskBoardView, VIEW_TYPE_TASKS } from "./TaskBoardView";
import { TimeView, VIEW_TYPE_TIME } from "./TimeView";
import { buildIndex, CompanionEventType, createQuickNote, getRunningTimeEntry, HOVER_SOURCE, startTimeEntry, stopTimeEntry } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { InvoiceGeneratorModal } from "./invoiceUI";
import { formatDate, formatElapsedMs } from "./dates";
import { CompanionSettings, CompanionSettingTab, DEFAULT_SETTINGS } from "./settings";
import { StartTimerModal } from "./timerUI";

// Desktop-notification labels -- deliberately excludes "invoice" per the
// dueNotifications setting's own description (Reminder/Task/Event/Meeting only).
const NOTIFY_LABELS: Partial<Record<CompanionEventType, string>> = {
	meeting: "Meeting",
	reminder: "Reminder",
	task: "Task",
	event: "Event",
};

export default class CompanionPlugin extends Plugin {
	private timerStatusEl: HTMLElement;
	settings: CompanionSettings = { ...DEFAULT_SETTINGS };
	// The end of the window checkDueNotifications last covered -- start of
	// each tick's window, not a per-item "already notified" set. Doubles as
	// the guard against a backlog firing all at once right after plugin load
	// or after the setting is switched on (see the 5-minute cap below).
	private lastNotifyCheckMs: number = Date.now();

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<CompanionSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		this.addSettingTab(new CompanionSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskBoardView(leaf, this.settings));
		this.registerView(VIEW_TYPE_REMINDERS, (leaf) => new RemindersView(leaf, this.settings));
		this.registerView(VIEW_TYPE_TIME, (leaf) => new TimeView(leaf, this.settings));

		// Lets Ctrl/Cmd+hover on a Companion item trigger Obsidian's own
		// Page preview popup — see openHandlers.ts.
		this.registerHoverLinkSource(HOVER_SOURCE, {
			display: "Wiki Companion",
			defaultMod: true,
		});

		this.addRibbonIcon("compass", "Open calendar", () => {
			void this.activateView(VIEW_TYPE_CALENDAR);
		});
		this.addRibbonIcon("list-checks", "Open task board", () => {
			void this.activateView(VIEW_TYPE_TASKS);
		});
		this.addRibbonIcon("bell", "Open reminders", () => {
			void this.activateView(VIEW_TYPE_REMINDERS);
		});
		this.addRibbonIcon("timer", "Open time tracker", () => {
			void this.activateView(VIEW_TYPE_TIME);
		});

		this.addCommand({
			id: "open-companion-calendar",
			name: "Open calendar",
			callback: () => {
				void this.activateView(VIEW_TYPE_CALENDAR);
			},
		});
		this.addCommand({
			id: "open-companion-tasks",
			name: "Open task board",
			callback: () => {
				void this.activateView(VIEW_TYPE_TASKS);
			},
		});
		this.addCommand({
			id: "open-companion-reminders",
			name: "Open reminders",
			callback: () => {
				void this.activateView(VIEW_TYPE_REMINDERS);
			},
		});
		this.addCommand({
			id: "open-companion-time",
			name: "Open time tracker",
			callback: () => {
				void this.activateView(VIEW_TYPE_TIME);
			},
		});

		// Reachable from anywhere via the command palette (or a bound hotkey
		// / mobile toolbar button) without opening a view first -- handy on
		// mobile, where there's no status bar to click for the timer, and no
		// agenda "+" button unless the calendar's already open.
		this.addCommand({
			id: "companion-new-item",
			name: "New item",
			callback: () => {
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
						() => this.refreshOpenViews(),
						(err: Error) => new Notice(err.message)
					);
				}).open();
			},
		});
		this.addCommand({
			id: "companion-toggle-timer",
			name: "Toggle timer",
			callback: () => this.toggleTimerFromStatusBar(),
		});
		this.addCommand({
			id: "companion-generate-invoice",
			name: "Generate invoice",
			callback: () => {
				new InvoiceGeneratorModal(this.app, this.settings, (file) => {
					this.refreshOpenViews();
					new Notice(`Invoice created: ${file.basename}`);
					void this.app.workspace.getLeaf("tab").openFile(file);
				}).open();
			},
		});

		// The calendar never writes back. The task board writes exactly one
		// field (status) and only when Mo clicks a move control — never on
		// its own. Either way, refresh any open view whenever metadata
		// changes, or a note is deleted/renamed, so both stay live.
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshOpenViews()));
		this.registerEvent(this.app.vault.on("delete", () => this.refreshOpenViews()));
		this.registerEvent(this.app.vault.on("rename", () => this.refreshOpenViews()));

		// Time tracking: a status bar item is the timer's home rather than a
		// fourth tab -- it wants to stay visible while Mo works in his notes,
		// not compete for space with the calendar/tasks/reminders views.
		// Clicking it starts or stops a timer directly, through the same
		// modal the Time view's own "+ Start timer" button opens -- so a
		// timer can be started from anywhere in the wiki, not only from the
		// Time view itself (that view is still reachable via the ribbon
		// icon and command above for browsing logs/reports). No separate
		// "is a timer running" state is kept here; every tick just
		// re-derives it from the vault (see getRunningTimeEntry).
		this.timerStatusEl = this.addStatusBarItem();
		this.timerStatusEl.addClass("companion-timer-status");
		this.timerStatusEl.onclick = () => this.toggleTimerFromStatusBar();
		this.updateTimerStatus();
		this.registerInterval(window.setInterval(() => this.updateTimerStatus(), 1000));

		// Desktop notifications for a timed Reminder/Task/Event/Meeting's start
		// -- off by default (dueNotifications setting). 30s cadence is frequent
		// enough that nothing due on the minute is missed by more than half a
		// minute, without re-reading the vault so often it's wasteful.
		this.registerInterval(window.setInterval(() => this.checkDueNotifications(), 30_000));
	}

	/** Fires a desktop notification for anything timed that started since the
	 * last check. Guarded on both sides: `dueNotifications` off, or no
	 * `Notification` API (mobile, where isDesktopOnly is false but this API
	 * doesn't exist) skip entirely; a stale `lastNotifyCheckMs` (plugin just
	 * loaded, or the setting was just switched on after being off a while)
	 * is capped to 5 minutes so it can't fire a whole day's backlog at once. */
	private checkDueNotifications(): void {
		if (!this.settings.dueNotifications) return;
		if (typeof Notification === "undefined") return;

		const now = Date.now();
		const windowStart = this.lastNotifyCheckMs;
		this.lastNotifyCheckMs = now;

		const index = buildIndex(this.app);
		const todayStr = formatDate(new Date());
		const events = index.get(todayStr) ?? [];
		for (const ev of events) {
			const label = NOTIFY_LABELS[ev.type];
			if (!label) continue; // invoices don't notify
			if (ev.time === "00:00") continue; // all-day / undated -- nothing to notify at a specific moment
			if (ev.status === "Done") continue;

			const [h, m] = ev.time.split(":").map(Number);
			const scheduled = new Date();
			scheduled.setHours(h, m, 0, 0);
			const scheduledMs = scheduled.getTime();
			const justStarted = scheduledMs > windowStart && scheduledMs <= now;
			const withinBacklogCap = now - scheduledMs < 5 * 60_000;
			if (justStarted && withinBacklogCap) {
				new Notification(`${label}: ${ev.title}`, { body: `Starting now (${ev.time})` });
			}
		}
	}

	private toggleTimerFromStatusBar(): void {
		const running = getRunningTimeEntry(this.app);
		if (running) {
			stopTimeEntry(this.app, running.file, Number(this.settings.roundingMinutes)).then(
				() => this.refreshOpenViews(),
				(err: Error) => new Notice(err.message)
			);
			return;
		}
		new StartTimerModal(this.app, (description, client) => {
			startTimeEntry(this.app, description, client).then(
				() => this.refreshOpenViews(),
				(err: Error) => new Notice(err.message)
			);
		}).open();
	}

	private updateTimerStatus(): void {
		const running = getRunningTimeEntry(this.app);
		this.timerStatusEl.empty();
		this.timerStatusEl.toggleClass("companion-timer-idle", !running);
		this.timerStatusEl.toggleClass("companion-timer-running", !!running);

		if (!running || !running.start) {
			this.timerStatusEl.createSpan({ text: "⏱ Start timer" });
			this.timerStatusEl.setAttribute("aria-label", "Start a timer");
			return;
		}

		const elapsed = formatElapsedMs(Date.now() - new Date(running.start).getTime());
		this.timerStatusEl.createSpan({ text: `⏱ ${elapsed} · ${running.description}` });
		this.timerStatusEl.setAttribute("aria-label", "Stop timer");
	}

	private refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			if (leaf.view instanceof CalendarView) leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)) {
			if (leaf.view instanceof TaskBoardView) leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REMINDERS)) {
			if (leaf.view instanceof RemindersView) leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TIME)) {
			if (leaf.view instanceof TimeView) leaf.view.refresh();
		}
	}

	/** Persists settings and immediately refreshes any open view, so e.g. a
	 * changed daily goal or week-start day shows up without reopening. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshOpenViews();
	}

	async activateView(viewType: string): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(viewType);

		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: viewType, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}
