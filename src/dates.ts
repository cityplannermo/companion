// Small date helpers shared by the calendar view. Kept separate from
// data.ts (vault reading) and CalendarView.ts (rendering) on purpose —
// pure functions, easy to reuse once the agenda view is built.

export function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function parseDate(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function addMonths(d: Date, n: number): Date {
	return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function addDays(d: Date, n: number): Date {
	const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	r.setDate(r.getDate() + n);
	return r;
}

/** The Monday (or Sunday, per weekStartsOn) that starts d's week. */
export function startOfWeek(d: Date, weekStartsOn: "monday" | "sunday"): Date {
	const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
	const diff = weekStartsOn === "sunday" ? -day : (day === 0 ? -6 : 1) - day;
	return addDays(d, diff);
}

/** "4 Sep" -- short display form for a list row's date column, shared by
 * every list-style view (Reminders, Finance, ...). */
export function formatDisplayShortDate(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("default", { day: "numeric", month: "short" });
}

export function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** DD-MM-YYYY, matching the wiki's own filename convention (e.g. "Meeting
 * With Paul - 04-09-2025") -- used to disambiguate Time Entry filenames. */
export function formatDMY(d: Date): string {
	const day = String(d.getDate()).padStart(2, "0");
	const m = String(d.getMonth() + 1).padStart(2, "0");
	return `${day}-${m}-${d.getFullYear()}`;
}

/** Milliseconds since a timer started, as H:MM:SS (or MM:SS under an hour) -- the status bar's live tick. */
export function formatElapsedMs(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}


/** Truncates a Date to whole-minute ISO 8601 (no seconds/milliseconds) --
 * friendlier in a note's raw frontmatter than the default full-precision
 * toISOString(), and all a timer needs. */
export function toMinuteIso(d: Date): string {
	return `${d.toISOString().slice(0, 16)}Z`;
}

/** An ISO datetime (minute-precision or full) as a local "HH:MM" -- for
 * display only, e.g. in the Time view's entry list. */
export function formatTimeOfDay(iso: string): string {
	const d = new Date(iso);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

/** Hours (e.g. 1.5) as "1h 30m" -- friendlier than a raw decimal, used
 * wherever a Time Entry's duration is shown. */
export function formatHours(hours: number): string {
	const totalMinutes = Math.round(hours * 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}
