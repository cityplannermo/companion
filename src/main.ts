import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import { DashboardEmbed, refreshAllDashboardEmbeds } from "./DashboardView";
import { FinanceView, VIEW_TYPE_FINANCE } from "./FinanceView";
import { PostsView, VIEW_TYPE_POSTS } from "./PostsView";
import { RemindersView, VIEW_TYPE_REMINDERS } from "./RemindersView";
import { TaskBoardView, VIEW_TYPE_TASKS } from "./TaskBoardView";
import { TimeView, VIEW_TYPE_TIME } from "./TimeView";
import {
	buildIndex,
	CompanionEventType,
	createQuickNote,
	getRecurringOccurrences,
	getRunningTimeEntry,
	HOVER_SOURCE,
	startTimeEntry,
	stopTimeEntry,
} from "./data";
import type { RemindLead } from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { InvoiceGeneratorModal } from "./invoiceUI";
import { openNote } from "./openHandlers";
import { addDays, formatDate, formatElapsedMs } from "./dates";
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

// One entry per optional tab (everything except the Calendar, which is
// always on -- see CompanionSettings.showTaskBoard's own comment). Declared
// once and driven by applyTabVisibility() below, rather than four/five
// near-identical blocks of "if enabled and not yet added, add; if disabled
// and still there, remove" -- adding a Posts row here later is a one-line
// change instead of a new block.
interface OptionalTab {
	settingKey: keyof CompanionSettings;
	viewType: string;
	ribbonIcon: string;
	ribbonLabel: string;
	commandId: string;
	commandName: string;
}

export default class CompanionPlugin extends Plugin {
	private timerStatusEl: HTMLElement;
	settings: CompanionSettings = { ...DEFAULT_SETTINGS };
	private optionalTabs: OptionalTab[] = [];
	private ribbonEls: Map<string, HTMLElement> = new Map(); // keyed by viewType
	// The end of the window checkDueNotifications last covered -- start of
	// each tick's window, not a per-item "already notified" set. Doubles as
	// the guard against a backlog firing all at once right after plugin load
	// or after the setting is switched on (see the 5-minute cap below).
	private lastNotifyCheckMs: number = Date.now();
	// Advance ("N days before") notifications fire once per item per day --
	// unlike the exact-start check above, an all-day item has no specific
	// clock moment to key off, so instead this tracks which items have
	// already been notified about *today*, keyed by "<lead>:<file path>",
	// and is emptied whenever the calendar date rolls over.
	private leadNotifiedToday: Set<string> = new Set();
	private leadNotifiedDateStr: string = "";

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<CompanionSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		this.addSettingTab(new CompanionSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskBoardView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_REMINDERS, (leaf) => new RemindersView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_FINANCE, (leaf) => new FinanceView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_TIME, (leaf) => new TimeView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(VIEW_TYPE_POSTS, (leaf) => new PostsView(leaf, this.settings, () => this.saveSettings()));

		// The Daily Note embeds a running-timer/today's-agenda/overdue/due-soon
		// summary directly via a fenced ```companion-dashboard``` code block
		// (see DashboardView.ts) -- there's no separate Dashboard tab; this
		// embed, added to the Daily Note template, is the whole feature.
		this.registerMarkdownCodeBlockProcessor("companion-dashboard", (_source, el, ctx) => {
			ctx.addChild(new DashboardEmbed(el, this.app, this.settings));
		});

		// Lets Ctrl/Cmd+hover on a Companion item trigger Obsidian's own
		// Page preview popup — see openHandlers.ts.
		this.registerHoverLinkSource(HOVER_SOURCE, {
			display: "Wiki Companion",
			defaultMod: true,
		});

		this.addRibbonIcon("compass", "Open calendar", () => {
			void this.activateView(VIEW_TYPE_CALENDAR);
		});
		this.addCommand({
			id: "open-companion-calendar",
			name: "Open calendar",
			callback: () => {
				void this.activateView(VIEW_TYPE_CALENDAR);
			},
		});

		this.optionalTabs = [
			{
				settingKey: "showTaskBoard",
				viewType: VIEW_TYPE_TASKS,
				ribbonIcon: "list-checks",
				ribbonLabel: "Open task board",
				commandId: "open-companion-tasks",
				commandName: "Open task board",
			},
			{
				settingKey: "showReminders",
				viewType: VIEW_TYPE_REMINDERS,
				ribbonIcon: "bell",
				ribbonLabel: "Open reminders",
				commandId: "open-companion-reminders",
				commandName: "Open reminders",
			},
			{
				settingKey: "showFinance",
				viewType: VIEW_TYPE_FINANCE,
				ribbonIcon: "wallet",
				ribbonLabel: "Open finance",
				commandId: "open-companion-finance",
				commandName: "Open finance",
			},
			{
				settingKey: "showTime",
				viewType: VIEW_TYPE_TIME,
				ribbonIcon: "timer",
				ribbonLabel: "Open time tracker",
				commandId: "open-companion-time",
				commandName: "Open time tracker",
			},
			{
				settingKey: "showPosts",
				viewType: VIEW_TYPE_POSTS,
				ribbonIcon: "newspaper",
				ribbonLabel: "Open posts",
				commandId: "open-companion-posts",
				commandName: "Open posts",
			},
		];
		this.applyTabVisibility();

		// Reachable from anywhere via the command palette (or a bound hotkey
		// / mobile toolbar button) without opening a view first -- handy on
		// mobile, where there's no status bar to click for the timer, and no
		// agenda "+" button unless the calendar's already open.
		this.addCommand({
			id: "companion-new-item",
			name: "New item",
			callback: () => {
				new EventEditorModal(this.app, "create", { title: "", type: "reminder", date: formatDate(new Date()), timeStr: "00:00" }, (result) => {
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
					openNote(this.app, file);
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

		// Desktop notifications: a timed Reminder/Task/Event/Meeting's exact
		// start (dueNotifications setting, off by default) and each item's
		// own advance "Remind" field (always active -- it's opted into per
		// item, not gated by a blanket setting). 30s cadence is frequent
		// enough that nothing due on the minute is missed by more than half a
		// minute, without re-reading the vault so often it's wasteful.
		this.registerInterval(window.setInterval(() => this.checkNotifications(), 30_000));
	}

	/** Tick handler for both notification mechanisms. The exact-start check
	 * is gated by `dueNotifications` (off by default); the per-item
	 * "Remind" check always runs -- each item opts in individually via its
	 * own `remind` field, so there's no separate blanket setting left to
	 * gate it on (see checkLeadNotifications). Both need the `Notification`
	 * API, absent on mobile. */
	private checkNotifications(): void {
		if (typeof Notification === "undefined") return;

		if (this.settings.dueNotifications) this.checkExactStartNotifications();
		this.checkLeadNotifications(formatDate(new Date()));
		this.checkPostScheduledNotifications(formatDate(new Date()));
	}

	/** Fires a desktop notification for anything timed that started since
	 * the last check. A stale `lastNotifyCheckMs` (plugin just loaded, or
	 * the setting was just switched on after being off a while) is capped
	 * to 5 minutes so it can't fire a whole day's backlog at once. */
	private checkExactStartNotifications(): void {
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

	/** Advance notice for items dated on the day itself (9am) or 1 day/1
	 * week/1 month ahead -- per whichever an individual item's own `remind`
	 * field asks for (set via the shared editor's "Remind" dropdown,
	 * alongside Repeat), not a blanket setting applied to everything.
	 * Unlike the exact-start check above, this covers all-day items too (a
	 * subscription renewal reminder is rarely given a specific time), so it
	 * can't key off a clock moment for most leads -- instead each item
	 * notifies at most once per lead per day, tracked in leadNotifiedToday
	 * and reset when the date rolls over. The "9am" lead is the one
	 * exception with a real clock moment: it's simply held back until the
	 * local hour reaches 9, then fires (and dedupes) the same way. */
	private checkLeadNotifications(todayStr: string): void {
		if (todayStr !== this.leadNotifiedDateStr) {
			this.leadNotifiedDateStr = todayStr;
			this.leadNotifiedToday.clear();
		}

		const leads: { key: RemindLead; days: number; label: string }[] = [
			{ key: "9am", days: 0, label: "Today" },
			{ key: "1d", days: 1, label: "Tomorrow" },
			{ key: "1w", days: 7, label: "In 1 week" },
			{ key: "1m", days: 30, label: "In 1 month" },
		];

		const index = buildIndex(this.app);
		for (const lead of leads) {
			if (lead.key === "9am" && new Date().getHours() < 9) continue; // not 9am yet -- try again next tick

			const targetDateStr = formatDate(addDays(new Date(), lead.days));
			const items = [
				...(index.get(targetDateStr) ?? []),
				...getRecurringOccurrences(this.app, targetDateStr, targetDateStr),
			];

			for (const item of items) {
				if (item.remind !== lead.key) continue; // only items that asked for this specific lead
				const label = NOTIFY_LABELS[item.type];
				if (!label) continue; // invoices don't notify
				if (item.status === "Done") continue;

				const dedupKey = `${lead.key}:${item.file.path}:${item.date}`;
				if (this.leadNotifiedToday.has(dedupKey)) continue;
				this.leadNotifiedToday.add(dedupKey);

				new Notification(`${label}: ${item.title}`, { body: `${lead.label} (${targetDateStr})` });
			}
		}
	}

	/** A Post's own advance notice -- distinct from checkLeadNotifications
	 * above, since a Post's `scheduled:` field is a plain target date, not
	 * one of the RemindLead options, and Posts don't set `remind` at all
	 * (see the `provisional` flag on CompanionEvent in data.ts). Fires once,
	 * on the scheduled date itself, for exactly as long as the post hasn't
	 * actually gone out yet -- once `published:` is set by hand, buildIndex()
	 * stops projecting a provisional pin for that note entirely, so it drops
	 * out of `items` below on its own, no extra check needed. Companion still
	 * never writes to the Post note itself here -- just a nudge to check and
	 * fill in `published:` once it's live. Shares leadNotifiedToday's
	 * same-day dedup and rollover with checkLeadNotifications, which always
	 * runs first each tick. */
	private checkPostScheduledNotifications(todayStr: string): void {
		const index = buildIndex(this.app);
		const items = (index.get(todayStr) ?? []).filter((ev) => ev.type === "post" && ev.provisional);

		for (const item of items) {
			const dedupKey = `post-scheduled:${item.file.path}:${item.date}`;
			if (this.leadNotifiedToday.has(dedupKey)) continue;
			this.leadNotifiedToday.add(dedupKey);

			new Notification(`Scheduled today: ${item.title}`, { body: "Has it gone out? Update published: once it has." });
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
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE)) {
			if (leaf.view instanceof FinanceView) void leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TIME)) {
			if (leaf.view instanceof TimeView) leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_POSTS)) {
			if (leaf.view instanceof PostsView) leaf.view.refresh();
		}
		refreshAllDashboardEmbeds();
	}

	/** Persists settings and immediately refreshes any open view, so e.g. a
	 * changed daily goal or week-start day shows up without reopening. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applyTabVisibility();
		this.refreshOpenViews();
	}

	/** Adds or removes each optional tab's ribbon icon and command to match
	 * its setting, live -- no restart needed either way. Idempotent (safe
	 * to call after every settings save, whether or not a tab toggle is
	 * what changed) rather than tracking which specific key changed. The
	 * view type itself stays registered either way -- see
	 * CompanionSettings.showTaskBoard's own comment -- so a workspace layout
	 * saved with a now-disabled tab open doesn't error out on restore; this
	 * only controls *reachability* (ribbon/command) and closes any leaf
	 * that's open right now. */
	private applyTabVisibility(): void {
		for (const tab of this.optionalTabs) {
			const enabled = Boolean(this.settings[tab.settingKey]);
			const hasRibbon = this.ribbonEls.has(tab.viewType);
			if (enabled && !hasRibbon) {
				this.ribbonEls.set(tab.viewType, this.addRibbonIcon(tab.ribbonIcon, tab.ribbonLabel, () => void this.activateView(tab.viewType)));
				this.addCommand({
					id: tab.commandId,
					name: tab.commandName,
					callback: () => void this.activateView(tab.viewType),
				});
			} else if (!enabled && hasRibbon) {
				this.ribbonEls.get(tab.viewType)?.remove();
				this.ribbonEls.delete(tab.viewType);
				this.removeCommand(tab.commandId);
				this.app.workspace.detachLeavesOfType(tab.viewType);
			}
		}
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
