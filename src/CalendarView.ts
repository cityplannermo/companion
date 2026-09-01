import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	applyEventEdit,
	buildIndex,
	CompanionEvent,
	CompanionEventType,
	createQuickNote,
	getRecurringOccurrences,
	materialiseOccurrence,
	resizeEventBlock,
	setEventDate,
	setEventDateTime,
	skipRecurringOccurrence,
	splitRecurringSeries,
} from "./data";
import { EventEditorModal } from "./eventEditorUI";
import { recurLabel } from "./data";
import { addDays, formatDate, parseDate, addMonths, startOfWeek, truncate } from "./dates";
import { confirmAndDelete, renderSelectionBar, showDeleteMenu } from "./deleteUI";
import { makeOpenable } from "./openHandlers";
import { Selection } from "./selection";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_CALENDAR = "companion-calendar-view";

const TYPE_LABELS: Record<CompanionEventType, string> = {
	meeting: "Meeting",
	reminder: "Reminder",
	task: "Task",
	invoice: "Invoice",
	event: "Event",
};

const TYPE_ORDER: CompanionEventType[] = ["meeting", "event", "reminder", "task", "invoice"];

type CalendarMode = "month" | "week" | "day";

// The custom drag MIME type used to carry a dragged event's file path from
// its source (a grid pill or an agenda row) to whichever day/hour cell it's
// dropped on. Kept separate from "text/plain" so a drag from outside
// Companion is never mistaken for a reschedule.
const DRAG_MIME = "application/x-companion-event-path";

// Fixed row height for the Week/Day hourly grid -- needed so the
// current-time indicator (a straight pixel offset down the grid) lines up
// with the row it should sit next to. See renderTimeGrid(). Each hour row
// splits into two HALF_ROW_PX-tall drop targets/half-hours -- the grid's
// snap granularity for both dropping and resizing an event.
const HOUR_ROW_PX = 44;
const HALF_ROW_PX = HOUR_ROW_PX / 2;
const MIN_BLOCK_MINUTES = 30;

function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

function minutesToHHMM(minutes: number): string {
	const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
	const h = String(Math.floor(clamped / 60)).padStart(2, "0");
	const m = String(clamped % 60).padStart(2, "0");
	return `${h}:${m}`;
}

export class CalendarView extends ItemView {
	private index: Map<string, CompanionEvent[]> = new Map();
	// Rebuilt fresh on every render() (not just refresh()) from `index` plus
	// whatever recurring series project into the currently-visible date
	// range -- navigating months/weeks/days never re-reads the vault, but it
	// does need a fresh set of projected occurrences each time, since the
	// visible range itself just changed. See buildDisplayIndex().
	private displayIndex: Map<string, CompanionEvent[]> = new Map();
	private cursor: Date;
	private selected: string;
	private mode: CalendarMode = "month";
	private selection = new Selection();

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings,
		private persistSettings: () => Promise<void> = async () => {}
	) {
		super(leaf);
		const today = new Date();
		this.cursor = new Date(today.getFullYear(), today.getMonth(), 1);
		this.selected = formatDate(today);
	}

	getViewType(): string {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText(): string {
		return "Calendar";
	}

	getIcon(): string {
		return "compass";
	}

	async onOpen(): Promise<void> {
		this.refresh();
		// Keeps the current-time line in Week/Day view honest without a
		// full vault re-read -- registerInterval cleans this up on close.
		this.registerInterval(
			window.setInterval(() => {
				if (this.mode !== "month") this.render();
			}, 60_000)
		);
	}

	async onClose(): Promise<void> {
		// nothing else to tear down — no external connections
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault changes. */
	refresh(): void {
		this.index = buildIndex(this.app);
		this.render();
	}

	/** Every currently-selected file, resolved fresh against the vault --
	 * selection tracks paths, not file objects, so this always reflects
	 * whatever's actually on disk right now. */
	private selectedFiles(): TFile[] {
		const files: TFile[] = [];
		for (const path of this.selection.all()) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) files.push(f);
		}
		return files;
	}

	private afterDelete(): void {
		this.selection.clear();
		this.refresh();
	}

	private render(): void {
		const root = this.contentEl;
		// render() fully rebuilds the DOM below, including the Week/Day
		// hourly grid's own scroll container -- a fresh element always
		// starts at scrollTop 0, so without this, any re-render triggered
		// while Mo's mid-scroll (the current-time-line's own 60s tick, or
		// any vault change elsewhere that fires refreshOpenViews) visibly
		// snaps the view back to the top. Restored after rebuilding below.
		const savedScrollTop = root.querySelector<HTMLElement>(".companion-timegrid-body")?.scrollTop;
		this.displayIndex = this.buildDisplayIndex();
		root.empty();
		root.addClass("companion-calendar-root");

		const layout = root.createDiv({ cls: "companion-layout" });
		layout.toggleClass("companion-agenda-collapsed", this.settings.agendaCollapsed);
		const calArea = layout.createDiv({ cls: "companion-cal-area" });

		this.renderHeader(calArea);

		if (!this.settings.agendaCollapsed) {
			const resizeHandle = layout.createDiv({ cls: "companion-agenda-resize-handle" });
			const agenda = layout.createDiv({ cls: "companion-agenda" });
			agenda.style.setProperty("--companion-agenda-width", `${this.settings.agendaWidthPx}px`);
			this.wireAgendaResize(resizeHandle, agenda);

			renderSelectionBar(
				agenda,
				this.selection.size,
				() => confirmAndDelete(this.app, this.selectedFiles(), this.settings.confirmBeforeDelete, () => this.afterDelete()),
				() => {
					this.selection.clear();
					this.render();
				}
			);
			this.renderAgenda(agenda);
		}

		this.renderLegend(calArea);
		if (this.mode === "month") {
			this.renderGrid(calArea);
		} else {
			const days = this.mode === "day" ? [this.selected] : this.weekDays();
			this.renderTimeGrid(calArea, days);
			if (savedScrollTop !== undefined) {
				const body = root.querySelector<HTMLElement>(".companion-timegrid-body");
				if (body) body.scrollTop = savedScrollTop;
			}
		}
	}

	/** The 7 dates (Mon-first or Sun-first, per settings) of the week containing this.cursor. */
	private weekDays(): string[] {
		const start = startOfWeek(this.cursor, this.settings.weekStartsOn);
		return Array.from({ length: 7 }, (_, i) => formatDate(addDays(start, i)));
	}

	/** The first/last date (inclusive) actually drawn in the current mode --
	 * the full 6-week grid in Month view (including the leading/trailing
	 * days from neighbouring months it shows), or just the visible days in
	 * Week/Day. Bounds how far getRecurringOccurrences() ever needs to
	 * project on any one render. */
	private visibleRange(): [string, string] {
		if (this.mode === "month") {
			const year = this.cursor.getFullYear();
			const month = this.cursor.getMonth();
			const firstOfMonth = new Date(year, month, 1);
			const leading = (firstOfMonth.getDay() + 6) % 7;
			const daysInMonth = new Date(year, month + 1, 0).getDate();
			const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
			const gridStart = addDays(firstOfMonth, -leading);
			const gridEnd = addDays(gridStart, totalCells - 1);
			return [formatDate(gridStart), formatDate(gridEnd)];
		}
		const days = this.mode === "day" ? [this.selected] : this.weekDays();
		return [days[0], days[days.length - 1]];
	}

	/** `index` (real notes) plus every recurring series' virtual occurrences
	 * for whatever's currently visible, merged into one per-date map -- the
	 * one thing every render*() method below reads from. A fresh copy each
	 * call, never written back into `index` itself, so navigating away and
	 * back never accumulates duplicate virtual entries. */
	private buildDisplayIndex(): Map<string, CompanionEvent[]> {
		const merged = new Map<string, CompanionEvent[]>();
		for (const [date, events] of this.index) merged.set(date, [...events]);
		const [start, end] = this.visibleRange();
		for (const occ of getRecurringOccurrences(this.app, start, end)) {
			const bucket = merged.get(occ.date);
			if (bucket) bucket.push(occ);
			else merged.set(occ.date, [occ]);
		}
		return merged;
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-header" });
		header.createEl("h2", { text: this.headerTitle() });

		const nav = header.createDiv({ cls: "companion-nav" });
		const prev = nav.createEl("button", { attr: { "aria-label": "Previous" } });
		setIcon(prev, "chevron-left");
		const todayBtn = nav.createEl("button", { text: "Today", cls: "companion-today-btn" });
		const next = nav.createEl("button", { attr: { "aria-label": "Next" } });
		setIcon(next, "chevron-right");

		// A native date input rather than a custom picker -- Chromium's own
		// calendar popup, no extra UI to build or maintain, and it already
		// matches the OS/locale date format.
		const jumpInput = nav.createEl("input", { cls: "companion-jump-date", attr: { type: "date", "aria-label": "Jump to date" } });
		jumpInput.value = formatDate(this.cursor);
		jumpInput.onchange = () => {
			if (!jumpInput.value) return;
			const d = parseDate(jumpInput.value);
			this.cursor = d;
			if (this.mode === "day") this.selected = formatDate(d);
			this.render();
		};

		const modeSelect = nav.createEl("select", { cls: "companion-mode-select" });
		for (const m of ["month", "week", "day"] as const) {
			const opt = modeSelect.createEl("option", { text: m.charAt(0).toUpperCase() + m.slice(1), value: m });
			if (m === this.mode) opt.selected = true;
		}
		modeSelect.onchange = () => {
			this.mode = modeSelect.value as CalendarMode;
			this.cursor = parseDate(this.selected);
			this.render();
		};

		const toggleAgenda = nav.createEl("button", {
			cls: "companion-icon-btn",
			attr: { "aria-label": this.settings.agendaCollapsed ? "Show agenda" : "Hide agenda" },
		});
		setIcon(toggleAgenda, this.settings.agendaCollapsed ? "panel-right-open" : "panel-right-close");
		toggleAgenda.onclick = () => {
			this.settings.agendaCollapsed = !this.settings.agendaCollapsed;
			void this.persistSettings();
			this.render();
		};

		prev.onclick = () => {
			this.step(-1);
			this.render();
		};
		next.onclick = () => {
			this.step(1);
			this.render();
		};
		todayBtn.onclick = () => {
			const today = new Date();
			this.cursor = today;
			this.selected = formatDate(today);
			this.render();
		};
	}

	/** Moves the cursor (and, in Day view, the selected day) by one unit in the current mode. */
	private step(dir: number): void {
		if (this.mode === "month") {
			this.cursor = addMonths(this.cursor, dir);
			return;
		}
		if (this.mode === "week") {
			this.cursor = addDays(this.cursor, dir * 7);
			return;
		}
		this.cursor = addDays(this.cursor, dir);
		this.selected = formatDate(this.cursor);
	}

	private headerTitle(): string {
		if (this.mode === "month") {
			return this.cursor.toLocaleString("default", { month: "long", year: "numeric" });
		}
		if (this.mode === "day") {
			return this.cursor.toLocaleDateString("default", {
				weekday: "long",
				day: "numeric",
				month: "long",
				year: "numeric",
			});
		}
		const start = startOfWeek(this.cursor, this.settings.weekStartsOn);
		const end = addDays(start, 6);
		const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
		const startStr = start.toLocaleDateString("default", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
		const endStr = end.toLocaleDateString("default", { day: "numeric", month: "short", year: "numeric" });
		return `${startStr} – ${endStr}`;
	}

	private renderLegend(parent: HTMLElement): void {
		const legend = parent.createDiv({ cls: "companion-legend" });
		for (const type of TYPE_ORDER) {
			const item = legend.createSpan({ cls: "companion-legend-item" });
			item.createSpan({ cls: `companion-dot companion-dot-${type}` });
			item.createSpan({ text: TYPE_LABELS[type] });
		}
	}

	/** The active UTC offset as "GMT+3" (or "GMT+5:30" for a half-hour
	 * offset) -- shown in the Week/Day gutter's top corner so a wrong system
	 * clock or timezone shows up as an obviously-wrong label here rather than
	 * only as a mysteriously-misplaced current-time line. Honours Settings >
	 * Calendar timezone when set (see zoneNow()); otherwise this device's own. */
	private gmtLabel(): string {
		const tz = this.settings.calendarTimezone.trim() || undefined;
		try {
			const label = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" })
				.formatToParts(new Date())
				.find((p) => p.type === "timeZoneName")?.value;
			if (label) return label;
		} catch {
			// An invalid IANA zone name in the setting -- fall through to the
			// device's own offset below rather than breaking the whole render.
		}
		const offsetMin = -new Date().getTimezoneOffset();
		const sign = offsetMin >= 0 ? "+" : "-";
		const abs = Math.abs(offsetMin);
		const h = Math.floor(abs / 60);
		const m = abs % 60;
		return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${String(m).padStart(2, "0")}`;
	}

	/** Current hour/minute in the Settings > Calendar timezone override if one
	 * is set, otherwise this device's own -- lets the now-line read correctly
	 * while travelling without changing the device's actual clock. Only the
	 * time of day is zone-aware; which day counts as "today" still follows
	 * the device's own calendar date, which covers the ordinary travel case
	 * without rippling into every date calculation elsewhere in the view. */
	private zoneNow(): { hours: number; minutes: number } {
		const tz = this.settings.calendarTimezone.trim();
		const now = new Date();
		if (!tz) return { hours: now.getHours(), minutes: now.getMinutes() };
		try {
			const parts = new Intl.DateTimeFormat("en-GB", {
				timeZone: tz,
				hourCycle: "h23",
				hour: "numeric",
				minute: "numeric",
			}).formatToParts(now);
			const hours = Number(parts.find((p) => p.type === "hour")?.value ?? now.getHours());
			const minutes = Number(parts.find((p) => p.type === "minute")?.value ?? now.getMinutes());
			return { hours, minutes };
		} catch {
			// An invalid IANA zone name in the setting -- fall back rather
			// than breaking the whole render.
			return { hours: now.getHours(), minutes: now.getMinutes() };
		}
	}

	/** Left/width, as CSS calc() strings, of the dayIndex-th of totalDays
	 * equal columns after the gutter -- shared by the current-time line and
	 * duration-block events so both position themselves identically. */
	private colRect(dayIndex: number, totalDays: number): { left: string; width: string } {
		return {
			left: `calc(var(--companion-gutter-w) + (100% - var(--companion-gutter-w)) * ${dayIndex} / ${totalDays})`,
			width: `calc((100% - var(--companion-gutter-w)) / ${totalDays})`,
		};
	}

	private renderGrid(parent: HTMLElement): void {
		const grid = parent.createDiv({ cls: "companion-grid" });

		for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
			grid.createDiv({ cls: "companion-dow", text: label });
		}

		const year = this.cursor.getFullYear();
		const month = this.cursor.getMonth();
		const firstOfMonth = new Date(year, month, 1);
		const leading = (firstOfMonth.getDay() + 6) % 7; // Monday-first
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
		const todayStr = formatDate(new Date());

		for (let i = 0; i < totalCells; i++) {
			const dayNum = i - leading + 1;
			const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
			const cell = grid.createDiv({ cls: "companion-day" });

			if (!inMonth) {
				cell.addClass("companion-day-other");
				continue;
			}

			const dateStr = formatDate(new Date(year, month, dayNum));
			if (dateStr === todayStr) cell.addClass("companion-day-today");
			if (dateStr === this.selected) cell.addClass("companion-day-selected");

			cell.createDiv({ cls: "companion-day-num", text: String(dayNum) });

			const events = this.displayIndex.get(dateStr) ?? [];
			for (const ev of events.slice(0, 2)) {
				const pill = cell.createDiv({
					cls: `companion-pill companion-pill-${ev.type}`,
					text: truncate(ev.title, 22),
				});
				this.wireEventInteractions(pill, ev);
			}
			if (events.length > 2) {
				cell.createDiv({ cls: "companion-more", text: `+${events.length - 2} more` });
			}

			cell.onclick = () => {
				this.selected = dateStr;
				this.render();
			};
			cell.ondblclick = () => this.openCreateAt(dateStr, null);
			this.makeGenericDropTarget(cell, (file) => void setEventDate(this.app, file, dateStr).then(() => this.refresh()));
		}
	}

	/**
	 * Week/Day mode: a day-header row, an all-day row (events whose date
	 * has no specific time -- "00:00", per the wiki-wide convention), and
	 * a scrollable hourly grid below (each hour split into two half-hour
	 * drop targets, so a drag or double-click lands on :00 or :30) with a
	 * red current-time line on today's column when it's in view.
	 */
	private renderTimeGrid(parent: HTMLElement, days: string[]): void {
		const wrap = parent.createDiv({ cls: "companion-timegrid-wrap" });
		const todayStr = formatDate(new Date());

		const headerRow = wrap.createDiv({ cls: "companion-timegrid-header" });
		headerRow.createDiv({ cls: "companion-timegrid-gutter", text: this.gmtLabel() });
		for (const dateStr of days) {
			const d = parseDate(dateStr);
			const col = headerRow.createDiv({ cls: "companion-timegrid-daycol-header" });
			if (dateStr === todayStr) col.addClass("companion-day-today");
			if (dateStr === this.selected) col.addClass("companion-day-selected");
			col.createDiv({ cls: "companion-timegrid-dow", text: d.toLocaleDateString("default", { weekday: "short" }) });
			col.createDiv({ cls: "companion-timegrid-daynum", text: String(d.getDate()) });
			col.onclick = () => {
				this.selected = dateStr;
				this.render();
			};
			this.makeGenericDropTarget(col, (file) => void setEventDate(this.app, file, dateStr).then(() => this.refresh()));
		}

		const allDayRow = wrap.createDiv({ cls: "companion-timegrid-allday-row" });
		allDayRow.createDiv({ cls: "companion-timegrid-gutter", text: "All-day" });
		for (const dateStr of days) {
			const cell = allDayRow.createDiv({ cls: "companion-timegrid-allday-cell" });
			const events = (this.displayIndex.get(dateStr) ?? []).filter((ev) => ev.time === "00:00");
			for (const ev of events) {
				const pill = cell.createDiv({ cls: `companion-pill companion-pill-${ev.type}`, text: truncate(ev.title, 18) });
				this.wireEventInteractions(pill, ev);
			}
			cell.onclick = () => {
				this.selected = dateStr;
				this.render();
			};
			cell.ondblclick = () => this.openCreateAt(dateStr, null);
			this.makeGenericDropTarget(cell, (file) => void setEventDateTime(this.app, file, dateStr, "00:00").then(() => this.refresh()));
		}

		const body = wrap.createDiv({ cls: "companion-timegrid-body" });
		body.style.height = `${HOUR_ROW_PX * 24}px`;

		for (let hour = 0; hour < 24; hour++) {
			const row = body.createDiv({ cls: "companion-timegrid-row" });
			row.style.height = `${HOUR_ROW_PX}px`;
			row.createDiv({ cls: "companion-timegrid-gutter", text: `${String(hour).padStart(2, "0")}:00` });

			for (const dateStr of days) {
				const dayCol = row.createDiv({ cls: "companion-timegrid-hourcell" });
				if (dateStr === todayStr) dayCol.addClass("companion-day-today");

				for (const half of [0, 1] as const) {
					const timeStr = `${String(hour).padStart(2, "0")}:${half === 0 ? "00" : "30"}`;
					const halfCell = dayCol.createDiv({ cls: "companion-timegrid-halfcell" });
					if (half === 1) halfCell.addClass("companion-timegrid-halfcell-lower");

					const events = (this.displayIndex.get(dateStr) ?? []).filter((ev) => {
						if (ev.time === "00:00" || ev.endTime) return false;
						const [h, m] = ev.time.split(":").map(Number);
						return h === hour && Math.floor(m / 30) === half;
					});
					for (const ev of events) {
						const pill = halfCell.createDiv({
							cls: `companion-pill companion-pill-${ev.type} companion-pill-timed`,
							text: truncate(`${ev.time} ${ev.title}`, 24),
						});
						this.wireEventInteractions(pill, ev);
					}

					halfCell.onclick = () => {
						this.selected = dateStr;
						this.render();
					};
					halfCell.ondblclick = (e) => {
						e.stopPropagation();
						this.openCreateAt(dateStr, timeStr);
					};
					this.makeGenericDropTarget(halfCell, (file) => {
						void setEventDateTime(this.app, file, dateStr, timeStr).then(() => this.refresh());
					});
				}
			}
		}

		// Duration blocks -- events with an `end` field, drawn as absolutely-
		// positioned overlays spanning their start-to-end rather than confined
		// to one hour row like a point event's pill.
		days.forEach((dateStr, dayIndex) => {
			const rect = this.colRect(dayIndex, days.length);
			const blockEvents = (this.displayIndex.get(dateStr) ?? []).filter((ev) => ev.time !== "00:00" && ev.endTime);
			for (const ev of blockEvents) {
				const startMin = toMinutes(ev.time);
				const endMin = Math.max(toMinutes(ev.endTime as string), startMin + 15);
				const block = body.createDiv({ cls: `companion-block-event companion-pill-${ev.type}` });
				// Pixel-based, not percentage-based: .companion-timegrid-body is a
				// flex-shrinkable scroll container (flex: 1; min-height: 0) whose
				// rendered height can be smaller than its 24*HOUR_ROW_PX scrollable
				// content height, so a percentage here would resolve against the
				// wrong box and misplace the block.
				block.style.top = `${(startMin / 60) * HOUR_ROW_PX}px`;
				block.style.height = `${((endMin - startMin) / 60) * HOUR_ROW_PX}px`;
				block.style.left = rect.left;
				block.style.width = rect.width;
				block.setText(`${ev.time}–${ev.endTime} ${truncate(ev.title, 20)}`);
				this.wireEventInteractions(block, ev);
				if (!ev.virtualOf) this.wireBlockResize(block, ev, dateStr);
			}
		});

		const todayIndex = days.indexOf(todayStr);
		if (todayIndex !== -1) {
			const { hours, minutes } = this.zoneNow();
			const nowMinutes = hours * 60 + minutes;
			const rect = this.colRect(todayIndex, days.length);
			const line = body.createDiv({ cls: "companion-now-line" });
			line.style.top = `${(nowMinutes / 60) * HOUR_ROW_PX}px`; // pixel-based -- see note above
			line.style.left = rect.left;
			line.style.width = rect.width;
		}
	}

	/** Lets an event pill or agenda row be dragged onto a day/hour cell to reschedule it. */
	private makeDraggable(el: HTMLElement, file: TFile): void {
		el.draggable = true;
		el.ondragstart = (e) => {
			if (!e.dataTransfer) return;
			e.dataTransfer.setData(DRAG_MIME, file.path);
			e.dataTransfer.effectAllowed = "move";
		};
	}

	/** Accepts a dragged event onto any drop target; onDrop decides what to write
	 * (a bare date preserving time, or an explicit date+time). */
	private makeGenericDropTarget(cell: HTMLElement, onDrop: (file: TFile) => void): void {
		cell.ondragover = (e) => {
			if (e.dataTransfer?.types.includes(DRAG_MIME)) {
				e.preventDefault();
				cell.addClass("companion-day-dragover");
			}
		};
		cell.ondragleave = () => cell.removeClass("companion-day-dragover");
		cell.ondrop = (e) => {
			e.preventDefault();
			cell.removeClass("companion-day-dragover");
			const path = e.dataTransfer?.getData(DRAG_MIME);
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) onDrop(file);
		};
	}

	/** Lets the drag handle between the calendar and the Agenda sidebar resize
	 * the sidebar by dragging left/right -- the new width is persisted to
	 * settings on mouseup so it's remembered next time Companion opens, not
	 * just for this session. Clamped to a sane range either side. */
	private wireAgendaResize(handle: HTMLElement, agenda: HTMLElement): void {
		const MIN_WIDTH = 180;
		const MAX_WIDTH = 480;
		handle.onmousedown = (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = agenda.getBoundingClientRect().width;
			handle.addClass("companion-resizing");
			const onMouseMove = (ev: MouseEvent) => {
				// The agenda sits to the right of the handle, so dragging left
				// (a negative clientX delta) should widen it.
				const delta = startX - ev.clientX;
				const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
				agenda.style.setProperty("--companion-agenda-width", `${next}px`);
			};
			const onMouseUp = () => {
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				handle.removeClass("companion-resizing");
				this.settings.agendaWidthPx = Math.round(agenda.getBoundingClientRect().width);
				void this.persistSettings();
			};
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		};
	}

	/** Lets a duration block's top/bottom edge be dragged to change its start
	 * or end time, snapped to 30-minute steps -- mirrors Google Calendar's
	 * resize handles. A plain mousedown/mousemove/mouseup drag, not HTML5
	 * DnD (which the block already uses for whole-block reschedule via
	 * makeDraggable), so each handle calls preventDefault()/stopPropagation()
	 * on mousedown to stop the browser starting the block's own native drag
	 * instead of this custom resize.
	 *
	 * A mousedown+mouseup pair on (or bubbling up through) the same element
	 * always synthesises a trailing "click" afterwards, regardless of
	 * anything done during mousedown -- so without help, releasing a resize
	 * drag also fired the block's own makeOpenable click handler and opened
	 * the note. A one-shot capturing listener registered on mousedown
	 * swallows exactly that next click, wherever it lands, before it can
	 * reach anything -- click to open the note keeps working normally the
	 * rest of the time, since this only exists for the duration of a drag. */
	private wireBlockResize(block: HTMLElement, ev: CompanionEvent, dateStr: string): void {
		const startMin = toMinutes(ev.time);
		const endMin = toMinutes(ev.endTime as string);

		const wire = (edge: "top" | "bottom") => {
			const handle = block.createDiv({ cls: `companion-block-resize-handle companion-block-resize-${edge}` });
			handle.onmousedown = (e) => {
				e.preventDefault();
				e.stopPropagation();
				document.addEventListener(
					"click",
					(ce) => {
						ce.stopPropagation();
						ce.preventDefault();
					},
					{ capture: true, once: true }
				);
				const startY = e.clientY;
				let liveStart = startMin;
				let liveEnd = endMin;
				const onMouseMove = (mv: MouseEvent) => {
					const deltaPx = mv.clientY - startY;
					const deltaMin = Math.round(deltaPx / HALF_ROW_PX) * 30;
					if (edge === "top") {
						liveStart = Math.min(endMin - MIN_BLOCK_MINUTES, Math.max(0, startMin + deltaMin));
						block.style.top = `${(liveStart / 60) * HOUR_ROW_PX}px`;
						block.style.height = `${((liveEnd - liveStart) / 60) * HOUR_ROW_PX}px`;
					} else {
						liveEnd = Math.max(startMin + MIN_BLOCK_MINUTES, Math.min(24 * 60, endMin + deltaMin));
						block.style.height = `${((liveEnd - liveStart) / 60) * HOUR_ROW_PX}px`;
					}
				};
				const onMouseUp = () => {
					document.removeEventListener("mousemove", onMouseMove);
					document.removeEventListener("mouseup", onMouseUp);
					if (liveStart !== startMin || liveEnd !== endMin) {
						resizeEventBlock(this.app, ev.file, dateStr, minutesToHHMM(liveStart), minutesToHHMM(liveEnd)).then(
							() => this.refresh(),
							(err: Error) => new Notice(err.message)
						);
					}
				};
				document.addEventListener("mousemove", onMouseMove);
				document.addEventListener("mouseup", onMouseUp);
			};
		};
		wire("top");
		wire("bottom");
	}

	/** Opens the shared editor modal to create a new item. `dateStr` is
	 * where it lands; `timeStr` (null from Month view, or a day click with
	 * no hour) leaves it All day by default -- a specific "HH:MM" (from a
	 * double-clicked half-hour cell) pre-fills that start instead. */
	private openCreateAt(dateStr: string, timeStr: string | null): void {
		new EventEditorModal(this.app, "create", { title: "", type: "reminder", timeStr: timeStr ?? "00:00" }, (result) => {
			createQuickNote(
				this.app,
				result.type,
				dateStr,
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

	/** Opens the shared editor modal on an existing item -- title, type,
	 * schedule, (for a Meeting) client and repeat rule all editable in one
	 * place, without opening the note itself. Never called with a virtual
	 * occurrence directly -- see materialiseAndEdit() below, which
	 * materialises one first and opens this on the resulting real note. */
	private openEditor(ev: CompanionEvent): void {
		new EventEditorModal(
			this.app,
			"edit",
			{ title: ev.title, type: ev.type, timeStr: ev.time, endTimeStr: ev.endTime, client: ev.client, recur: ev.recur, cost: ev.cost },
			(result) => {
				applyEventEdit(this.app, ev.file, ev.type, {
					title: result.title,
					type: result.type,
					dateStr: ev.date,
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

	/** Shared click/right-click/drag wiring for every place an event is
	 * rendered (month grid, all-day row, hour cells, duration blocks). A
	 * projected recurring occurrence (ev.virtualOf set) gets a deliberately
	 * narrower interaction -- no drag, no multi-select, and a two-item menu
	 * (materialise-and-edit, or skip) instead of the usual Edit/Select/
	 * Delete -- there's no real file yet for those to act on, and clicking
	 * through must create one first. */
	private wireEventInteractions(el: HTMLElement, ev: CompanionEvent): void {
		if (ev.virtualOf) {
			el.addClass("companion-pill-virtual");
			el.onclick = (e) => {
				e.stopPropagation();
				this.materialiseAndOpen(ev);
			};
			el.oncontextmenu = (e) => this.showVirtualMenu(e, ev);
			return;
		}

		this.makeDraggable(el, ev.file);
		el.toggleClass("is-selected", this.selection.has(ev.file.path));
		el.oncontextmenu = (e) =>
			showDeleteMenu(
				this.app,
				e,
				ev.file,
				this.selectedFiles(),
				this.settings.confirmBeforeDelete,
				() => this.afterDelete(),
				() => this.openEditor(ev),
				() => {
					this.selection.toggle(ev.file.path);
					this.render();
				},
				() => {
					this.selection.clear();
					this.render();
				}
			);
		makeOpenable(this.app, el, ev.file, {
			onToggleSelect: () => {
				this.selection.toggle(ev.file.path);
				this.render();
			},
			isSelecting: () => this.selection.size > 0,
		});
	}

	/** The right-click/press-and-hold menu for a virtual occurrence: turn
	 * just this one date into a real note (for editing), split the series
	 * here so a change applies from this date onward, or mark this date
	 * deliberately skipped -- none of which touch dates before it. */
	private showVirtualMenu(e: MouseEvent, ev: CompanionEvent): void {
		e.preventDefault();
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Edit this occurrence").setIcon("pencil").onClick(() => this.materialiseAndEdit(ev)));
		menu.addItem((item) =>
			item.setTitle("Edit this and following occurrences").setIcon("pencil-line").onClick(() => this.splitAndEdit(ev))
		);
		menu.addItem((item) => item.setTitle("Skip this occurrence").setIcon("x").onClick(() => this.skipOccurrence(ev)));
		menu.showAtMouseEvent(e);
	}

	private materialiseAndOpen(ev: CompanionEvent): void {
		if (!ev.virtualOf) return;
		materialiseOccurrence(this.app, ev.virtualOf, ev.date).then(
			(file) => {
				this.refresh();
				void this.app.workspace.getLeaf("tab").openFile(file);
			},
			(err: Error) => new Notice(err.message)
		);
	}

	private materialiseAndEdit(ev: CompanionEvent): void {
		if (!ev.virtualOf) return;
		materialiseOccurrence(this.app, ev.virtualOf, ev.date).then(
			(file) => {
				this.refresh();
				this.openEditor({ ...ev, file, virtualOf: undefined });
			},
			(err: Error) => new Notice(err.message)
		);
	}

	/** Splits the series at this occurrence's date and opens the new,
	 * from-here-on note in the usual editor -- whatever's changed there
	 * (title, time, client, or the repeat rule itself) applies from this
	 * date forward only; everything before it keeps its old shape. */
	private splitAndEdit(ev: CompanionEvent): void {
		if (!ev.virtualOf) return;
		splitRecurringSeries(this.app, ev.virtualOf, ev.date).then(
			(file) => {
				this.refresh();
				this.openEditor({ ...ev, file, virtualOf: undefined });
			},
			(err: Error) => new Notice(err.message)
		);
	}

	private skipOccurrence(ev: CompanionEvent): void {
		if (!ev.virtualOf) return;
		skipRecurringOccurrence(this.app, ev.virtualOf, ev.date).then(
			() => this.refresh(),
			(err: Error) => new Notice(err.message)
		);
	}

	private renderAgenda(parent: HTMLElement): void {
		const titleRow = parent.createDiv({ cls: "companion-agenda-header" });
		titleRow.createEl("h3", { text: "Agenda", cls: "companion-agenda-title" });
		const addBtn = titleRow.createEl("button", { cls: "companion-icon-btn companion-icon-btn-accent", attr: { "aria-label": "New item" } });
		setIcon(addBtn, "plus");
		addBtn.onclick = () => this.openCreateAt(this.selected, null);

		parent.createDiv({
			cls: "companion-agenda-date",
			text: parseDate(this.selected).toLocaleDateString("default", {
				day: "numeric",
				month: "long",
				year: "numeric",
			}),
		});

		const events = this.displayIndex.get(this.selected) ?? [];
		if (events.length === 0) {
			parent.createDiv({ cls: "companion-empty", text: "Nothing on this day." });
		} else {
			// A dedicated list container keeps `.companion-item:last-child` scoped to
			// the items themselves — without it, the trailing `.companion-note` div
			// below is the real last child, so no item ever matches `:last-child`
			// and the last item keeps a border that duplicates the note's own.
			const list = parent.createDiv({ cls: "companion-item-list" });
			for (const ev of events) {
				this.renderAgendaItem(list, ev);
			}
		}

		parent.createDiv({
			cls: "companion-note",
			text:
				"Drag an item onto a day (or, in Week/Day view, onto a half-hour) to reschedule it; drag a block's top " +
				"or bottom edge to resize it. Double-click an empty slot to create something there. Click an item, or " +
				"use the pencil, to edit its title, type, time, repeat rule and (for a Meeting) client -- no need to " +
				"open the note. Right-click (or press and hold on mobile) for Edit/Select/Delete; Shift+click also " +
				"selects on desktop. Once selecting, tap or click other items to add them, then Clear to finish. " +
				"A repeating item shows its projected dates faded/dashed until one's opened or edited, which creates " +
				"its own real note for that date -- right-click a projected date to skip it instead. " +
				"Invoices still go through their usual flow.",
		});
	}

	private renderAgendaItem(parent: HTMLElement, ev: CompanionEvent): void {
		const row = parent.createDiv({ cls: "companion-item" });
		if (ev.virtualOf) {
			row.addClass("companion-pill-virtual");
			row.oncontextmenu = (e) => this.showVirtualMenu(e, ev);
		} else {
			row.toggleClass("is-selected", this.selection.has(ev.file.path));
			row.oncontextmenu = (e) =>
				showDeleteMenu(
					this.app,
					e,
					ev.file,
					this.selectedFiles(),
					this.settings.confirmBeforeDelete,
					() => this.afterDelete(),
					undefined,
					() => {
						this.selection.toggle(ev.file.path);
						this.render();
					},
					() => {
						this.selection.clear();
						this.render();
					}
				);
			this.makeDraggable(row, ev.file);
		}
		row.createSpan({ cls: `companion-dot companion-dot-${ev.type}` });

		const txt = row.createDiv({ cls: "companion-item-txt" });
		const title = txt.createDiv({ cls: "companion-item-title", text: ev.title });
		if (ev.virtualOf) {
			title.onclick = (e) => {
				e.stopPropagation();
				this.materialiseAndOpen(ev);
			};
		} else {
			makeOpenable(this.app, title, ev.file, {
				onToggleSelect: () => {
					this.selection.toggle(ev.file.path);
					this.render();
				},
				isSelecting: () => this.selection.size > 0,
			});
		}

		const subText = ev.status ? `${TYPE_LABELS[ev.type]} · ${ev.status}` : TYPE_LABELS[ev.type];
		const repeatText = ev.virtualOf ? " · repeats" : ev.recur ? ` · ${recurLabel(ev.recur)}` : "";
		const timeText = ev.time === "00:00" ? "" : ev.endTime ? ` · ${ev.time}–${ev.endTime}` : ` · ${ev.time}`;
		txt.createDiv({
			cls: "companion-item-sub",
			text: `${subText}${repeatText}${timeText}`,
		});

		const edit = row.createSpan({ cls: "companion-item-rename-btn", attr: { "aria-label": "Edit" } });
		setIcon(edit, "pencil");
		edit.onclick = (e) => {
			e.stopPropagation();
			if (ev.virtualOf) this.materialiseAndEdit(ev);
			else this.openEditor(ev);
		};
	}
}
