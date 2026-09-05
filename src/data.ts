import { App, TAbstractFile, TFile } from "obsidian";
import { formatDMY, formatDate, toMinuteIso } from "./dates";
import { DEFAULT_CURRENCY, invoicePrefix } from "./currencies";

// Companion's data layer: reads what's already in the vault via Obsidian's
// own metadata cache, and — for the task board only — writes a single
// frontmatter field (`status`) back via Obsidian's own processFrontMatter
// API. Never touches anything else in a note, never makes a network call.
// Adding a new date source is a deliberate edit here, not automatic —
// see the "Calendar-worthy is narrower than has a date field" note in
// System/Companion Plugin.md.

// The id Companion registers with Obsidian's core "Page preview" plugin,
// and the source tag on every hover-link trigger it fires. See
// openHandlers.ts.
export const HOVER_SOURCE = "wiki-companion";

/** Narrows the result of getAbstractFileByPath after a rename -- Obsidian's
 * own renameFile leaves the vault in a state where the new path always
 * resolves to the same file, so this only ever throws if something else
 * deleted it out from under us mid-edit. */
function expectFile(af: TAbstractFile | null, path: string): TFile {
	if (!(af instanceof TFile)) throw new Error(`Expected a file at "${path}" but found none.`);
	return af;
}

// "post" is a read-only calendar pin, not a Companion-managed type like the
// other five -- Companion never creates, edits or deletes a Post note (that's
// the content-drafting workflow's own job). See the second loop in
// buildIndex() below, and CalendarView's wireEventInteractions(), which
// opens a post note on click but skips drag/edit/delete entirely for it.
export type CompanionEventType = "meeting" | "reminder" | "task" | "invoice" | "event" | "post";

export interface CompanionEvent {
	file: TFile;
	type: CompanionEventType;
	title: string;
	date: string; // YYYY-MM-DD
	time: string; // HH:MM, "00:00" when no specific time was set
	endTime?: string; // HH:MM, only set when the note has its own `end` field -- a real duration, not just a point in time
	status?: string;
	priority?: TaskPriority; // set only when type === "task" -- lets the shared editor modal show/edit it without a separate lookup
	client?: string; // unwrapped from the [[wikilink]] -- set only on a Meeting, powers the calendar's edit modal
	recur?: RecurKind; // set when this note is itself a recurring series' anchor
	remind?: RemindLead; // set when this note wants an advance-notice desktop notification ahead of its own date
	cost?: number; // GBP, meaningful only when type === "reminder" -- what makes it a subscription
	currency?: string; // ISO 4217 code, meaningful only when type === "reminder"; absent means DEFAULT_CURRENCY
	invoiceReminder?: boolean; // meaningful only when type === "reminder" -- shows with the Invoice pill colour on the calendar (see CalendarView's visualType), without being a real Invoice
	income?: boolean; // meaningful only when type === "reminder" -- flips the calendar/Finance direction from an outgoing cost to incoming money (see visualType's "income" category and CompanionReminder.income below); a Reminder can carry both recur and income, e.g. a monthly payout
	// Set only on a *projected* occurrence (see getRecurringOccurrences below) --
	// `file` on one of these still points at the series note, since there's no
	// real note yet for a virtual date. Every caller that would otherwise act on
	// `file` directly (open, drag, edit, delete) must check this first and go
	// through materialiseOccurrence()/skipRecurringOccurrence() instead.
	virtualOf?: TFile;
	// Set only on a Post pin standing in for a `scheduled:` date that hasn't
	// been published yet (see the Posts pass in buildIndex() below) --
	// unlike virtualOf, `file` here IS the real Post note, just not live
	// yet. Rendered with the same dashed/faded treatment as a virtual
	// recurring occurrence (reusing .companion-pill-virtual), for the same
	// reason: it's a projection of something not fully real on this date
	// yet, not a confirmed fact.
	provisional?: boolean;
}

// One tag per type, matching System/Rules.md's standard tag set (singular).
const TYPE_BY_TAG: Record<string, CompanionEventType> = {
	meeting: "meeting",
	reminder: "reminder",
	task: "task",
	invoice: "invoice",
	event: "event",
};

function getTags(frontmatter: Record<string, unknown> | undefined): string[] {
	if (!frontmatter) return [];
	const raw = frontmatter["tags"];
	if (raw == null) return [];
	if (Array.isArray(raw)) return raw.map((t) => String(t));
	return [String(raw)];
}

// `date` is a wiki-wide Date & time property (`2026-08-30T00:00`) --
// Obsidian's frontmatter parser can hand that back as either a string or,
// depending on quoting, a Date. Either way this returns just the
// YYYY-MM-DD portion; every Companion view groups/sorts by day only, not
// yet by time of day.
function normaliseDate(value: unknown): string | null {
	if (typeof value === "string") {
		const match = value.match(/^\d{4}-\d{2}-\d{2}/);
		return match ? match[0] : null;
	}
	if (value instanceof Date && !isNaN(value.getTime())) {
		const y = value.getFullYear();
		const m = String(value.getMonth() + 1).padStart(2, "0");
		const d = String(value.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	return null;
}

// The HH:mm portion of a `date` value, defaulting to midnight when absent
// or unparseable -- used only to preserve an existing time of day when
// setEventDate() rewrites just the date part (a drag-to-reschedule never
// means "and also clear whatever time I'd set").
export function timeOfDay(value: unknown): string {
	if (typeof value === "string") {
		const match = value.match(/T(\d{2}:\d{2})/);
		if (match) return match[1];
	}
	if (value instanceof Date && !isNaN(value.getTime())) {
		const h = String(value.getHours()).padStart(2, "0");
		const min = String(value.getMinutes()).padStart(2, "0");
		return `${h}:${min}`;
	}
	return "00:00";
}

// HH:MM <-> minutes-since-midnight, used to preserve a note's duration
// (its `end` minus its `date`) when either end of a Week/Day hour-grid
// drag shifts the start time.
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

function firstEventType(tags: string[]): CompanionEventType | null {
	for (const tag of tags) {
		const type = TYPE_BY_TAG[tag];
		if (type) return type;
	}
	return null;
}

// Recurring events. Deliberately the simplest rule that's still useful:
// three fixed shapes, each entirely derived from the series note's own
// `date` field -- "weekly" always means "same weekday as the anchor",
// "monthly" always means "same day-of-month as the anchor" -- rather than
// a general RRULE-style engine with its own weekday/interval fields to
// configure. A series is projected forward (never before its own anchor)
// into virtual, unmaterialised occurrences by getRecurringOccurrences()
// below; touching one for real (open, edit, or explicitly skip) is what
// turns it into its own note, via materialiseOccurrence()/
// skipRecurringOccurrence(). See "Recurring events" in Companion.md's
// roadmap for the fuller reasoning.
export type RecurKind = "daily" | "weekly" | "monthly" | "yearly" | "biennial";

export function parseRecur(value: unknown): RecurKind | null {
	if (typeof value !== "string") return null;
	const raw = value.trim().toLowerCase();
	return raw === "daily" || raw === "weekly" || raw === "monthly" || raw === "yearly" || raw === "biennial"
		? raw
		: null;
}

export function recurLabel(kind: RecurKind): string {
	if (kind === "daily") return "Daily";
	if (kind === "weekly") return "Weekly";
	if (kind === "monthly") return "Monthly";
	if (kind === "yearly") return "Yearly";
	return "Every 2 years";
}

// A per-item advance-reminder lead time -- set on a Meeting/Event/Reminder/
// Task's own `remind` field via the shared editor modal, alongside `recur`.
// Unlike the exact-start "Notify when something starts" desktop
// notification (timed items only), this fires ahead of the item's own
// date regardless of whether it has a specific time set -- see
// checkLeadNotifications() in main.ts.
export type RemindLead = "9am" | "1d" | "1w" | "1m";

export function parseRemindLead(value: unknown): RemindLead | null {
	if (typeof value !== "string") return null;
	const raw = value.trim().toLowerCase();
	return raw === "9am" || raw === "1d" || raw === "1w" || raw === "1m" ? raw : null;
}

export function remindLeadLabel(lead: RemindLead): string {
	if (lead === "9am") return "On the day, 9am";
	if (lead === "1d") return "1 day before";
	if (lead === "1w") return "1 week before";
	return "1 month before";
}

// Strips the note-type suffix off a Post filename for a cleaner calendar
// pill -- "Grey Belt and GB7(g) - Blog Post" becomes just "Grey Belt and
// GB7(g)". Only strips the exact suffixes System/Rules.md's content
// workflow actually produces; anything else is left as-is rather than
// guessed at.
const POST_TITLE_SUFFIXES = [" - Blog Post", " - LinkedIn Post", " - Post Idea"];
function postTitle(basename: string): string {
	for (const suffix of POST_TITLE_SUFFIXES) {
		if (basename.endsWith(suffix)) return basename.slice(0, -suffix.length);
	}
	return basename;
}

/** Builds a date -> events index from every markdown file currently in the vault. */
export function buildIndex(app: App): Map<string, CompanionEvent[]> {
	const index = new Map<string, CompanionEvent[]>();

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;

		const type = firstEventType(getTags(frontmatter));
		if (!type) continue;

		const date = normaliseDate(frontmatter["date"]);
		if (!date) continue;

		const event: CompanionEvent = {
			file,
			type,
			title: file.basename,
			date,
			time: timeOfDay(frontmatter["date"]),
			endTime: frontmatter["end"] != null ? timeOfDay(frontmatter["end"]) : undefined,
			status: typeof frontmatter["status"] === "string" ? frontmatter["status"] : undefined,
			priority: type === "task" ? (toTaskPriority(frontmatter["priority"]) ?? undefined) : undefined,
			client: type === "meeting" ? (unwrapWikilink(frontmatter["client"]) ?? undefined) : undefined,
			recur: parseRecur(frontmatter["recur"]) ?? undefined,
			remind: parseRemindLead(frontmatter["remind"]) ?? undefined,
			cost: type === "reminder" && typeof frontmatter["cost"] === "number" ? frontmatter["cost"] : undefined,
			invoiceReminder: type === "reminder" && frontmatter["invoiceReminder"] === true ? true : undefined,
			income: type === "reminder" && frontmatter["income"] === true ? true : undefined,
			currency: type === "reminder" && typeof frontmatter["currency"] === "string" ? frontmatter["currency"] : undefined,
		};

		const bucket = index.get(date);
		if (bucket) bucket.push(event);
		else index.set(date, [event]);
	}

	// Posts -- a deliberately separate, narrower pass: only a `post`-tagged
	// note with an actual `published:` date, or a `scheduled:` target date
	// while it's still awaiting one, earns a calendar pin (an Idea or an
	// In-Progress draft with neither has nothing to plot yet). A real
	// `published:` date always wins over `scheduled:` once it's set -- at
	// that point the projection has become a fact, so the provisional pin
	// on the scheduled date simply stops appearing (see `provisional` on
	// CompanionEvent above). Everything else on a CompanionEvent that
	// implies Companion can edit it stays undefined, since it can't -- see
	// the CompanionEventType comment above.
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("post")) continue;

		const published = normaliseDate(frontmatter["published"]);
		const scheduled = published ? null : normaliseDate(frontmatter["scheduled"]);
		const pinDate = published ?? scheduled;
		if (!pinDate) continue;

		const event: CompanionEvent = {
			file,
			type: "post",
			title: postTitle(file.basename),
			date: pinDate,
			time: "00:00",
			provisional: !published,
		};

		const bucket = index.get(pinDate);
		if (bucket) bucket.push(event);
		else index.set(pinDate, [event]);
	}

	return index;
}


// The task board's three columns, in order. Matches System/Rules.md's
// Tasks section exactly — Companion doesn't invent its own lifecycle.
export const TASK_STATUSES = ["To Do", "Doing", "Done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface CompanionTask {
	file: TFile;
	title: string;
	date: string | null; // null when missing or unparseable — still shown, just sorts last
	status: TaskStatus;
	priority: TaskPriority | null; // null = no priority set, not a fourth level
	checklistDone: number; // markdown checkbox items in the note's own body, checked
	checklistTotal: number; // same, total -- 0 means the note has no checklist at all
	recur?: RecurKind; // set when this task is itself a recurring series' anchor
}

function toTaskStatus(value: unknown): TaskStatus {
	return (TASK_STATUSES as readonly string[]).includes(value as string)
		? (value as TaskStatus)
		: "To Do"; // a task note with a missing or unrecognised status still needs a column
}

function toTaskPriority(value: unknown): TaskPriority | null {
	return (TASK_PRIORITIES as readonly string[]).includes(value as string) ? (value as TaskPriority) : null;
}

/** Sub-items are ordinary markdown checkboxes in the task note's own body
 * -- no new format, matching the wiki's own convention. Counted straight
 * from Obsidian's metadata cache (listItems' `task` field) rather than
 * reading the file body, since the cache already tracks exactly this. */
function countChecklist(listItems: { task?: string }[] | undefined): { done: number; total: number } {
	if (!listItems) return { done: 0, total: 0 };
	const boxes = listItems.filter((i) => i.task !== undefined);
	const done = boxes.filter((i) => i.task !== " ").length;
	return { done, total: boxes.length };
}

/** Every note tagged `task`, regardless of date — the board needs undated tasks too. */
export function getTasks(app: App): CompanionTask[] {
	const tasks: CompanionTask[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("task")) continue;

		const { done, total } = countChecklist(cache?.listItems);
		tasks.push({
			file,
			title: file.basename,
			date: normaliseDate(frontmatter["date"]),
			status: toTaskStatus(frontmatter["status"]),
			priority: toTaskPriority(frontmatter["priority"]),
			checklistDone: done,
			checklistTotal: total,
			recur: parseRecur(frontmatter["recur"]) ?? undefined,
		});
	}

	return tasks;
}

/**
 * Moves a task to a new status by writing its frontmatter `status` field —
 * the one field the task board ever changes, via Obsidian's own
 * processFrontMatter (preserves every other field and the note's body
 * untouched). The task note stays the sole source of truth; nothing else
 * mirrors or reacts to this beyond re-reading the note next refresh.
 */
export async function setTaskStatus(app: App, file: TFile, status: TaskStatus): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["status"] = status;
	});
}

/** Sets or clears a task's priority field -- null removes it from
 * frontmatter entirely rather than writing an empty/placeholder value. */
export async function setTaskPriority(app: App, file: TFile, priority: TaskPriority | null): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (priority) fm["priority"] = priority;
		else delete fm["priority"];
	});
}

/**
 * Sets a note's `date` field, preserving whatever time of day was already
 * set — the month view's drag-to-reschedule path, where only the day is
 * changing. Nothing else in the note is touched.
 */
export async function setEventDate(app: App, file: TFile, dateStr: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["date"] = `${dateStr}T${timeOfDay(fm["date"])}`;
		if (fm["end"] != null) fm["end"] = `${dateStr}T${timeOfDay(fm["end"])}`;
	});
}

/**
 * Sets a note's `date` field to an explicit day *and* time — the Week/Day
 * hour grid's write path, used when an item is dropped onto an hour cell
 * or created directly in one. Unlike setEventDate(), the time is not
 * preserved from the old value; it's exactly what was dropped/clicked.
 */
export async function setEventDateTime(app: App, file: TFile, dateStr: string, timeStr: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (fm["end"] != null) {
			// Preserve however long the block already was, rather than letting a
			// reschedule silently collapse or stretch it.
			const durationMin = toMinutes(timeOfDay(fm["end"])) - toMinutes(timeOfDay(fm["date"]));
			fm["end"] = `${dateStr}T${minutesToHHMM(toMinutes(timeStr) + durationMin)}`;
		}
		fm["date"] = `${dateStr}T${timeStr}`;
	});
}

function sanitiseFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim();
}

/**
 * Renames a note's file to match a new title, keeping it in the same
 * folder. Uses Obsidian's own renameFile so links elsewhere update too.
 * A no-op if the title is empty or unchanged.
 */
export async function renameCompanionFile(app: App, file: TFile, newTitle: string): Promise<void> {
	const safe = sanitiseFilename(newTitle);
	if (!safe || safe === file.basename) return;
	const folder = file.parent ? file.parent.path : "";
	const newPath = folder ? `${folder}/${safe}.md` : `${safe}.md`;
	if (app.vault.getAbstractFileByPath(newPath)) {
		throw new Error(`A note already exists at "${newPath}".`);
	}
	await app.fileManager.renameFile(file, newPath);
}

// Quick-create/quick-edit covers every type except Invoice -- Invoices need
// the full Invoice Create Procedure (line items, banking details,
// sequential numbering), which a calendar form can't fill in responsibly.
// Meetings are included here (with a client field) since a client link is
// the only extra thing a Meeting note needs beyond what Reminders/Tasks/
// Events already have.
export type QuickCreateType = "reminder" | "task" | "event" | "meeting" | "post";

// Every type's folder, including Invoice -- used by applyEventEdit() below
// when moving a note between types, even though quickCreateFrontmatter()
// itself never produces an Invoice or a Post. "post" is only ever read by
// createQuickNote()'s own early Post branch below (see createPostIdea) --
// applyEventEdit() still never converts a note to or from "post", same as
// Invoice, since Companion only ever creates a Post, never edits one (see
// the CompanionEventType comment).
const QUICK_CREATE_FOLDER: Record<CompanionEventType, string> = {
	reminder: "Admin/Reminders",
	task: "Admin/Tasks",
	event: "Admin/Events",
	meeting: "Admin/Meetings",
	invoice: "Admin/Invoices",
	post: "Content/Posts",
};

function quickCreateFrontmatter(
	type: QuickCreateType,
	dateStr: string,
	timeStr: string,
	endTimeStr?: string,
	client?: string,
	recur?: RecurKind | null,
	cost?: number | null,
	invoiceReminder?: boolean,
	remind?: RemindLead | null,
	income?: boolean,
	currency?: string,
	status?: TaskStatus,
	priority?: TaskPriority | null
): string {
	const endLine = endTimeStr ? `end: ${dateStr}T${endTimeStr}\n` : "";
	const recurLine = recur ? `recur: ${recur}\n` : "";
	const remindLine = remind ? `remind: ${remind}\n` : "";
	if (type === "task") {
		const priorityLine = priority ? `priority: ${priority}\n` : "";
		return `---\ndate: ${dateStr}T${timeStr}\n${endLine}${recurLine}${remindLine}tags:\n  - task\nstatus: ${status ?? "To Do"}\n${priorityLine}---\n\n`;
	}
	if (type === "event") {
		return `---\ndate: ${dateStr}T${timeStr}\n${endLine}${recurLine}${remindLine}tags:\n  - event\n---\n\n`;
	}
	if (type === "meeting") {
		const clientLine = client?.trim() ? `client: [[${client.trim()}]]\n` : "client:\n";
		return `---\ndate: ${dateStr}T${timeStr}\n${endLine}${clientLine}${recurLine}${remindLine}tags:\n  - meeting\n---\n\n`;
	}
	// Reminder -- the only type `cost`/`invoiceReminder`/`income` are
	// meaningful on (see CompanionReminder / CompanionEvent). Subscription
	// and (ad hoc or recurring) Income aren't separate note types -- both
	// are a Reminder with `cost` set, `recur` optionally alongside it, and
	// (for Income) the `income` flag marking the direction as money coming
	// in rather than going out -- each gets its own extra tag alongside
	// `reminder` so it's still findable by tag or a Base filter on its own,
	// and the two can combine (a recurring Income, e.g. a monthly payout).
	const costLine = cost != null && cost > 0 ? `cost: ${cost}\n` : "";
	const invoiceReminderLine = invoiceReminder ? `invoiceReminder: true\n` : "";
	const incomeLine = income ? `income: true\n` : "";
	const currencyLine = cost != null && cost > 0 && currency && currency !== DEFAULT_CURRENCY ? `currency: ${currency}\n` : "";
	const isSubscription = !!recur && cost != null && cost > 0;
	const tags = ["reminder"];
	if (isSubscription) tags.push("subscription");
	if (income) tags.push("income");
	const tagsBlock = `tags:\n${tags.map((t) => `  - ${t}\n`).join("")}`;
	return `---\ndate: ${dateStr}T${timeStr}\n${endLine}${recurLine}${remindLine}${costLine}${currencyLine}${invoiceReminderLine}${incomeLine}${tagsBlock}---\n\n`;
}

/** A minimal "Post idea" capture -- reachable from the exact same shared
 * New Item dropdown as every other quick-create type (Mo's own request:
 * "add post as a type of event in the event creation dropdown"), via
 * createQuickNote()'s own early branch below. Deliberately the narrowest
 * possible write: a title, and the modal's own date field becomes this
 * post's `scheduled:` target date (see the `provisional` calendar pin from
 * `1.28.0`) -- not its `date:`, which stays the note's real creation date,
 * same convention as every other Post. Everything else defaults to
 * whatever the content-drafting workflow expects an Idea-stage post to
 * start as (`status: Idea`, no platform/verify_against yet). This is the
 * one place Companion creates a Post note -- from here on the
 * content-drafting workflow owns it, same as any other post; Companion
 * still never edits or deletes one (see the CompanionEventType comment
 * above buildIndex). */
async function createPostIdea(app: App, title: string, scheduledDateStr: string): Promise<TFile> {
	const safeTitle = title.trim();
	if (!safeTitle) throw new Error("A title is needed to create a post idea.");

	const filenameBase = sanitiseFilename(`${safeTitle} - Post Idea`);
	let path = `${QUICK_CREATE_FOLDER.post}/${filenameBase}.md`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${QUICK_CREATE_FOLDER.post}/${filenameBase} (${n}).md`;
		n++;
	}

	const todayStr = formatDate(new Date());
	return app.vault.create(
		path,
		`---\ndate: ${todayStr}T00:00\ntags:\n  - content\n  - post\nstatus:\n  - Idea\nplatform:\npublished:\ncancelled:\nscheduled: ${scheduledDateStr}\n---\n\n`
	);
}

/** Creates a new Reminder, Task, Event, Meeting or Post note. For the first
 * four, dated to `dateStr` and titled `title`; `timeStr` (default "00:00")
 * lets the Week/Day grid create a note already scheduled to the clicked
 * slot instead of always landing undated. `endTimeStr`, if given, adds an
 * `end` field so the note renders as a duration block rather than a point
 * in time. `client`, meaningful only for a Meeting, is wrapped into a
 * `[[wikilink]]`. `cost`, meaningful only for a Reminder, is what turns it
 * into a Subscription alongside `recur`, or an ad hoc/recurring Income
 * alongside `income`, in the Reminders/Finance views. `invoiceReminder`,
 * also Reminder-only, just borrows the Invoice pill colour on the calendar
 * -- see CompanionEvent.invoiceReminder. A Post is a different enough shape
 * (see CompanionEventType) that it's handled entirely separately, by
 * createPostIdea() above -- `dateStr` becomes its `scheduled:` field, and
 * every other parameter here is simply ignored for it. */
export async function createQuickNote(
	app: App,
	type: QuickCreateType,
	dateStr: string,
	title: string,
	timeStr = "00:00",
	endTimeStr?: string,
	client?: string,
	recur?: RecurKind | null,
	cost?: number | null,
	invoiceReminder?: boolean,
	remind?: RemindLead | null,
	income?: boolean,
	currency?: string,
	status?: TaskStatus,
	priority?: TaskPriority | null
): Promise<TFile> {
	if (type === "post") return createPostIdea(app, title, dateStr);

	const safe = sanitiseFilename(title);
	if (!safe) throw new Error("A title is needed to create a note.");

	const path = `${QUICK_CREATE_FOLDER[type]}/${safe}.md`;
	if (app.vault.getAbstractFileByPath(path)) {
		throw new Error(`A note already exists at "${path}".`);
	}
	return app.vault.create(
		path,
		quickCreateFrontmatter(type, dateStr, timeStr, endTimeStr, client, recur, cost, invoiceReminder, remind, income, currency, status, priority)
	);
}

function replaceTypeTag(fm: Record<string, unknown>, oldTag: string, newTag: string): void {
	const raw = fm["tags"];
	let tags: string[];
	if (Array.isArray(raw)) tags = raw.map((t) => String(t));
	else if (raw != null) tags = [String(raw)];
	else tags = [];
	const idx = tags.indexOf(oldTag);
	if (idx !== -1) tags[idx] = newTag;
	else tags.push(newTag);
	fm["tags"] = tags;
}

export interface EventEditFields {
	title: string;
	// CompanionEventType, not QuickCreateType: editing an *existing* Invoice
	// (date/end/title only, never its type -- see the guard below) still
	// needs to pass its own type through unchanged.
	type: CompanionEventType;
	dateStr: string;
	timeStr: string; // "00:00" for all-day
	endTimeStr?: string; // undefined removes any existing `end`
	client?: string; // meaningful only when type === "meeting"
	recur?: RecurKind | null; // null/undefined clears any existing recurrence (and its exceptions)
	remind?: RemindLead | null; // null/undefined clears any existing advance reminder
	cost?: number | null; // meaningful only when type === "reminder"; null/undefined clears it
	currency?: string | null; // meaningful only when type === "reminder"; null/undefined clears it
	invoiceReminder?: boolean; // meaningful only when type === "reminder"; falsy clears it
	income?: boolean; // meaningful only when type === "reminder"; falsy clears it
	status?: TaskStatus; // meaningful only when type === "task"; undefined leaves any existing status untouched (a caller with no status field, e.g. a virtual occurrence, shouldn't reset it)
	priority?: TaskPriority | null; // meaningful only when type === "task"; null clears it
}

/**
 * Applies every field the calendar's edit modal can change, in one call:
 * title (a same-folder rename), then type (which can move the note to a
 * different type's folder, swap its type tag, and add/drop `status`/
 * `client` as appropriate), then the schedule fields. Each step re-resolves
 * the file so a later step never writes through a path Obsidian has
 * already renamed out from under it. Refuses to convert a note to or from
 * Invoice -- those stay on their own workflow, per createQuickNote() above
 * -- but editing an existing Invoice's own title/date/end is still fine as
 * long as `fields.type` is left as "invoice" (i.e. no conversion asked for).
 */
export async function applyEventEdit(app: App, file: TFile, oldType: CompanionEventType, fields: EventEditFields): Promise<TFile> {
	if (oldType !== fields.type && (oldType === "invoice" || fields.type === "invoice")) {
		throw new Error("Invoices aren't converted to or from another type from here.");
	}

	let current = file;

	const safeTitle = sanitiseFilename(fields.title);
	if (safeTitle && safeTitle !== current.basename) {
		const folder = current.parent ? current.parent.path : "";
		const newPath = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;
		if (app.vault.getAbstractFileByPath(newPath)) {
			throw new Error(`A note already exists at "${newPath}".`);
		}
		await app.fileManager.renameFile(current, newPath);
		current = expectFile(app.vault.getAbstractFileByPath(newPath), newPath);
	}

	if (fields.type !== oldType) {
		await app.fileManager.processFrontMatter(current, (fm: Record<string, unknown>) => {
			replaceTypeTag(fm, oldType, fields.type);
			if (fields.type === "task") fm["status"] = fm["status"] ?? "To Do";
			else delete fm["status"];
			if (fields.type === "meeting") {
				fm["client"] = fields.client?.trim() ? `[[${fields.client.trim()}]]` : (fm["client"] ?? "");
			}
		});
		const targetFolder = QUICK_CREATE_FOLDER[fields.type];
		if (current.parent?.path !== targetFolder) {
			const targetPath = `${targetFolder}/${current.basename}.md`;
			if (app.vault.getAbstractFileByPath(targetPath)) {
				throw new Error(`A note already exists at "${targetPath}".`);
			}
			await app.fileManager.renameFile(current, targetPath);
			current = expectFile(app.vault.getAbstractFileByPath(targetPath), targetPath);
		}
	} else if (fields.type === "meeting") {
		await app.fileManager.processFrontMatter(current, (fm: Record<string, unknown>) => {
			fm["client"] = fields.client?.trim() ? `[[${fields.client.trim()}]]` : (fm["client"] ?? "");
		});
	}

	await app.fileManager.processFrontMatter(current, (fm: Record<string, unknown>) => {
		fm["date"] = `${fields.dateStr}T${fields.timeStr}`;
		if (fields.endTimeStr) fm["end"] = `${fields.dateStr}T${fields.endTimeStr}`;
		else delete fm["end"];
		if (fields.recur) {
			fm["recur"] = fields.recur;
		} else {
			delete fm["recur"];
			delete fm["recurExceptions"]; // orphaned once there's no rule left to except from
			delete fm["recurUntil"];
		}
		if (fields.remind) fm["remind"] = fields.remind;
		else delete fm["remind"];
		if (fields.type === "reminder" && fields.cost != null && fields.cost > 0) fm["cost"] = fields.cost;
		else delete fm["cost"];
		if (
			fields.type === "reminder" &&
			fields.cost != null &&
			fields.cost > 0 &&
			fields.currency &&
			fields.currency !== DEFAULT_CURRENCY
		)
			fm["currency"] = fields.currency;
		else delete fm["currency"];
		if (fields.type === "reminder" && fields.invoiceReminder) fm["invoiceReminder"] = true;
		else delete fm["invoiceReminder"];
		if (fields.type === "reminder" && fields.income) fm["income"] = true;
		else delete fm["income"];
		if (fields.type === "task" && fields.status) fm["status"] = fields.status;
		if (fields.type === "task" && fields.priority) fm["priority"] = fields.priority;
		else if (fields.type === "task") delete fm["priority"];

		// Keep the `subscription`/`income` tags in sync with what actually
		// makes a Reminder one -- added or dropped automatically, the same
		// way `status`/`client` above track the type, rather than something
		// to maintain by hand.
		const isSubscription = fields.type === "reminder" && !!fields.recur && fields.cost != null && fields.cost > 0;
		const isIncome = fields.type === "reminder" && !!fields.income;
		const tags = getTags(fm);
		const syncTag = (tag: string, present: boolean) => {
			const idx = tags.indexOf(tag);
			if (present && idx === -1) tags.push(tag);
			else if (!present && idx !== -1) tags.splice(idx, 1);
		};
		syncTag("subscription", isSubscription);
		syncTag("income", isIncome);
		fm["tags"] = tags;
	});

	return current;
}

/** Rewrites just an existing block event's start/end -- the drag-resize
 * handles' write path. Narrower than applyEventEdit() on purpose: a resize
 * never changes the title, type or day, only how long the block is. */
export async function resizeEventBlock(app: App, file: TFile, dateStr: string, timeStr: string, endTimeStr: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["date"] = `${dateStr}T${timeStr}`;
		fm["end"] = `${dateStr}T${endTimeStr}`;
	});
}

const RECUR_EXCEPTIONS_KEY = "recurExceptions";

function parseDateStr(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

function formatDateStr(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function addDaysLocal(d: Date, n: number): Date {
	const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	r.setDate(r.getDate() + n);
	return r;
}

function exceptionSet(fm: Record<string, unknown>): Set<string> {
	const raw = fm[RECUR_EXCEPTIONS_KEY];
	if (Array.isArray(raw)) return new Set(raw.map((v) => normaliseDate(v) ?? String(v)));
	return new Set();
}

/** Every date within [rangeStart, rangeEnd] (inclusive) that `kind`, anchored
 * on `anchor`, lands on -- never before the anchor itself. "weekly" repeats
 * on the anchor's own weekday; "monthly" repeats on the anchor's own
 * day-of-month, clamped to whatever a shorter month actually has (so a
 * 31st-anchored series still lands on 30 April, not skips it). */
function* stepOccurrences(anchor: Date, kind: RecurKind, rangeStart: Date, rangeEnd: Date): Generator<string> {
	if (kind === "daily") {
		for (let d = new Date(rangeStart); d <= rangeEnd; d = addDaysLocal(d, 1)) {
			if (d >= anchor) yield formatDateStr(d);
		}
		return;
	}
	if (kind === "weekly") {
		const weekday = anchor.getDay();
		for (let d = new Date(rangeStart); d <= rangeEnd; d = addDaysLocal(d, 1)) {
			if (d.getDay() === weekday && d >= anchor) yield formatDateStr(d);
		}
		return;
	}
	if (kind === "monthly") {
		const dayOfMonth = anchor.getDate();
		let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
		const stop = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
		while (cursor <= stop) {
			const lastDayOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
			const occDay = Math.min(dayOfMonth, lastDayOfMonth);
			const occ = new Date(cursor.getFullYear(), cursor.getMonth(), occDay);
			if (occ >= anchor && occ >= rangeStart && occ <= rangeEnd) yield formatDateStr(occ);
			cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
		}
		return;
	}
	// yearly/biennial -- same month and day-of-month as the anchor, clamped
	// for a 29 Feb anchor in a non-leap year; biennial additionally skips
	// every other year so it lands every 2 years from the anchor's own
	// year (e.g. a subscription renewing once every 2 years).
	const month = anchor.getMonth();
	const dayOfMonth = anchor.getDate();
	const anchorYear = anchor.getFullYear();
	const yearStep = kind === "biennial" ? 2 : 1;
	for (let year = rangeStart.getFullYear(); year <= rangeEnd.getFullYear(); year++) {
		if ((year - anchorYear) % yearStep !== 0) continue;
		const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
		const occ = new Date(year, month, Math.min(dayOfMonth, lastDayOfMonth));
		if (occ >= anchor && occ >= rangeStart && occ <= rangeEnd) yield formatDateStr(occ);
	}
}

/**
 * Every *virtual* occurrence a recurring series projects within
 * [rangeStart, rangeEnd] (YYYY-MM-DD, inclusive) -- the anchor date itself
 * excluded, since buildIndex() already surfaces the series note there like
 * any other note, and any date already in the series' `recurExceptions`
 * skipped. Deliberately range-bound rather than vault-wide: CalendarView
 * calls this fresh for whatever window it's currently showing, so this
 * stays cheap no matter how far back a series started or how far forward
 * Mo ever navigates.
 */
export function getRecurringOccurrences(app: App, rangeStart: string, rangeEnd: string): CompanionEvent[] {
	const occurrences: CompanionEvent[] = [];
	const start = parseDateStr(rangeStart);
	const end = parseDateStr(rangeEnd);

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) continue;

		const type = firstEventType(getTags(fm));
		if (!type) continue;
		const kind = parseRecur(fm["recur"]);
		if (!kind) continue;

		const anchorDateStr = normaliseDate(fm["date"]);
		if (!anchorDateStr) continue;
		const anchor = parseDateStr(anchorDateStr);
		const exceptions = exceptionSet(fm);
		const time = timeOfDay(fm["date"]);
		const endTime = fm["end"] != null ? timeOfDay(fm["end"]) : undefined;
		const status = typeof fm["status"] === "string" ? fm["status"] : undefined;
		const client = type === "meeting" ? (unwrapWikilink(fm["client"]) ?? undefined) : undefined;
		const remind = parseRemindLead(fm["remind"]) ?? undefined;
		const cost = type === "reminder" && typeof fm["cost"] === "number" ? fm["cost"] : undefined;
		const invoiceReminder = type === "reminder" && fm["invoiceReminder"] === true ? true : undefined;
		const income = type === "reminder" && fm["income"] === true ? true : undefined;

		// A series split via splitRecurringSeries() below caps the *original*
		// half at the day before the split -- it never projects the split
		// date or anything after, leaving that to the new series that took
		// over from there.
		const untilStr = normaliseDate(fm["recurUntil"]);
		const rangeEnd = untilStr && parseDateStr(untilStr) < end ? parseDateStr(untilStr) : end;

		for (const occDateStr of stepOccurrences(anchor, kind, start, rangeEnd)) {
			if (occDateStr === anchorDateStr) continue;
			if (exceptions.has(occDateStr)) continue;
			occurrences.push({
				file,
				type,
				title: file.basename,
				date: occDateStr,
				time,
				endTime,
				status,
				client,
				recur: kind,
				remind,
				cost,
				invoiceReminder,
				income,
				virtualOf: file,
			});
		}
	}

	return occurrences;
}

/**
 * Turns one projected occurrence into a real note -- a clone of the series'
 * own type/time/end/client/status, dated to `occurrenceDate`, filed
 * alongside the series note, linked back to it via `recurOf`. Also adds
 * `occurrenceDate` to the series' own `recurExceptions` so it stops being
 * projected once it has a real note of its own. The one write path behind
 * "open" or "edit" on a virtual pill in the calendar.
 */
export async function materialiseOccurrence(app: App, seriesFile: TFile, occurrenceDate: string): Promise<TFile> {
	const cache = app.metadataCache.getFileCache(seriesFile);
	const fm = cache?.frontmatter;
	if (!fm) throw new Error("The recurring series note has no frontmatter to read.");
	const type = firstEventType(getTags(fm));
	if (!type) throw new Error("The recurring series note has no recognised type.");

	const time = timeOfDay(fm["date"]);
	const endTime = fm["end"] != null ? timeOfDay(fm["end"]) : undefined;

	const folder = seriesFile.parent ? seriesFile.parent.path : QUICK_CREATE_FOLDER[type];
	const titleBase = sanitiseFilename(`${seriesFile.basename} - ${occurrenceDate}`);
	let path = `${folder}/${titleBase}.md`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${folder}/${titleBase} (${n}).md`;
		n++;
	}

	const endLine = endTime ? `end: ${occurrenceDate}T${endTime}\n` : "";
	const statusLine = type === "task" ? `status: ${typeof fm["status"] === "string" ? fm["status"] : "To Do"}\n` : "";
	const file = await app.vault.create(path, `---\ndate: ${occurrenceDate}T${time}\n${endLine}${statusLine}tags:\n  - ${type}\n---\n\n`);

	await app.fileManager.processFrontMatter(file, (nfm: Record<string, unknown>) => {
		if (type === "meeting" && typeof fm["client"] === "string" && fm["client"].trim()) {
			nfm["client"] = fm["client"];
		}
		nfm["recurOf"] = `[[${seriesFile.basename}]]`;
	});

	await app.fileManager.processFrontMatter(seriesFile, (sfm: Record<string, unknown>) => {
		const existing = Array.isArray(sfm[RECUR_EXCEPTIONS_KEY]) ? sfm[RECUR_EXCEPTIONS_KEY].map(String) : [];
		if (!existing.includes(occurrenceDate)) existing.push(occurrenceDate);
		sfm[RECUR_EXCEPTIONS_KEY] = existing;
	});

	return file;
}

/** Marks one projected occurrence as deliberately skipped, with no note ever
 * created for it -- the "Skip this occurrence" path, for a single date a
 * recurring series shouldn't happen on (a cancelled one-off) without
 * touching the series itself. */
export async function skipRecurringOccurrence(app: App, seriesFile: TFile, occurrenceDate: string): Promise<void> {
	await app.fileManager.processFrontMatter(seriesFile, (sfm: Record<string, unknown>) => {
		const existing = Array.isArray(sfm[RECUR_EXCEPTIONS_KEY]) ? sfm[RECUR_EXCEPTIONS_KEY].map(String) : [];
		if (!existing.includes(occurrenceDate)) existing.push(occurrenceDate);
		sfm[RECUR_EXCEPTIONS_KEY] = existing;
	});
}

/**
 * Splits a series at `fromDate`, for "Edit this and following occurrences":
 * the original series is capped with `recurUntil` (the day before
 * `fromDate`) so it never projects that date or anything after, and a new
 * series note is created anchored at `fromDate` -- same type/recur kind/
 * time/end/client/status as the original, ready to be edited on its own
 * from here. Everything before the split keeps behaving exactly as it did;
 * everything from here on projects from the new note instead.
 */
export async function splitRecurringSeries(app: App, seriesFile: TFile, fromDate: string): Promise<TFile> {
	const cache = app.metadataCache.getFileCache(seriesFile);
	const fm = cache?.frontmatter;
	if (!fm) throw new Error("The recurring series note has no frontmatter to read.");
	const type = firstEventType(getTags(fm));
	if (!type) throw new Error("The recurring series note has no recognised type.");
	const kind = parseRecur(fm["recur"]);
	if (!kind) throw new Error("This note isn't a recurring series.");

	const time = timeOfDay(fm["date"]);
	const endTime = fm["end"] != null ? timeOfDay(fm["end"]) : undefined;

	const folder = seriesFile.parent ? seriesFile.parent.path : QUICK_CREATE_FOLDER[type];
	const titleBase = sanitiseFilename(`${seriesFile.basename} - ${fromDate}`);
	let path = `${folder}/${titleBase}.md`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${folder}/${titleBase} (${n}).md`;
		n++;
	}

	const endLine = endTime ? `end: ${fromDate}T${endTime}\n` : "";
	const statusLine = type === "task" ? `status: ${typeof fm["status"] === "string" ? fm["status"] : "To Do"}\n` : "";
	const newFile = await app.vault.create(
		path,
		`---\ndate: ${fromDate}T${time}\n${endLine}${statusLine}recur: ${kind}\ntags:\n  - ${type}\n---\n\n`
	);

	await app.fileManager.processFrontMatter(newFile, (nfm: Record<string, unknown>) => {
		if (type === "meeting" && typeof fm["client"] === "string" && fm["client"].trim()) {
			nfm["client"] = fm["client"];
		}
	});

	await capRecurringSeries(app, seriesFile, fromDate);

	return newFile;
}

/** Caps a series so it never projects `fromDate` or anything after --
 * shared by splitRecurringSeries above (which also creates a new note to
 * carry on from `fromDate`) and deleteRecurringSeriesFrom below (which
 * doesn't: "delete this and following occurrences" on a projected date,
 * with nothing replacing them). */
async function capRecurringSeries(app: App, seriesFile: TFile, fromDate: string): Promise<void> {
	const dayBefore = formatDateStr(addDaysLocal(parseDateStr(fromDate), -1));
	await app.fileManager.processFrontMatter(seriesFile, (sfm: Record<string, unknown>) => {
		sfm["recurUntil"] = dayBefore;
	});
}

/** "Delete this and following occurrences" on a projected (not yet
 * materialised) date -- caps the series the same way splitRecurringSeries
 * does, but creates nothing new to carry on: everything from `fromDate`
 * onward simply stops being projected. Everything before it is untouched. */
export async function deleteRecurringSeriesFrom(app: App, seriesFile: TFile, fromDate: string): Promise<void> {
	await capRecurringSeries(app, seriesFile, fromDate);
}

// Every note tagged `reminder`, regardless of date -- mirrors getTasks()
// below it, one field simpler since reminders have no status lifecycle.
// `cost` + `recur` together are what make a reminder a *subscription* in
// the Reminders view -- not a separate note type, just these two optional
// fields on an ordinary Reminder. See advanceRecurringReminder() below.
export interface CompanionReminder {
	file: TFile;
	title: string;
	date: string | null;
	time: string; // HH:MM, "00:00" when no specific time was set
	recur?: RecurKind;
	remind?: RemindLead; // see CompanionEvent.remind -- carried here too so editing a reminder from the Reminders/Finance views doesn't silently clear it
	cost?: number; // GBP, only meaningful alongside recur
	currency?: string; // ISO 4217 code, only meaningful alongside cost; absent means DEFAULT_CURRENCY
	invoiceReminder?: boolean; // see CompanionEvent.invoiceReminder -- carried here too so editing a reminder from the Reminders/Finance views doesn't silently clear the flag
	income?: boolean; // see CompanionEvent.income -- same reason, carried through so an edit never silently clears it
}

export function getReminders(app: App): CompanionReminder[] {
	const reminders: CompanionReminder[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("reminder")) continue;

		reminders.push({
			file,
			title: file.basename,
			date: normaliseDate(frontmatter["date"]),
			time: timeOfDay(frontmatter["date"]),
			recur: parseRecur(frontmatter["recur"]) ?? undefined,
			remind: parseRemindLead(frontmatter["remind"]) ?? undefined,
			cost: typeof frontmatter["cost"] === "number" ? frontmatter["cost"] : undefined,
			invoiceReminder: frontmatter["invoiceReminder"] === true ? true : undefined,
			income: frontmatter["income"] === true ? true : undefined,
			currency: typeof frontmatter["currency"] === "string" ? frontmatter["currency"] : undefined,
		});
	}

	return reminders;
}

// Every note tagged `post`, for the Posts gallery tab -- a read-only list
// (see CompanionEventType's own comment: Companion only ever creates a Post,
// never edits or deletes one) plus the "+ New post" action that reuses
// createPostIdea() via createQuickNote(), same as every other "+ New item"
// entry point already does. `status` is read defensively as either a plain
// string or a YAML list (createPostIdea itself writes it as a one-item list,
// `status:\n  - Idea`, matching whatever shape the content-drafting workflow
// expects) -- the first value either way, or "" if neither shape is present.
export interface CompanionPost {
	file: TFile;
	title: string;
	status: string;
	platform: string;
	scheduled: string | null;
	published: string | null;
	cancelled: boolean;
	date: string | null; // the note's own creation date -- last-resort sort key when neither scheduled nor published is set yet
	coverImageUrl: string | null; // the first embedded image in the note's body, if any -- see firstCoverImage() below
}

function firstStatusValue(value: unknown): string {
	if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
	return typeof value === "string" ? value : "";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** The first embedded image in a note's body, as a displayable resource URL
 * -- the Posts gallery's cover image (Mo's own reference point: a Notion
 * gallery card's cover), read straight off the metadata cache's own
 * `embeds` list rather than re-parsing the body text by hand, so a wikilink
 * embed, a sized embed (`![[x.png|200]]`) and a plain markdown image all
 * resolve the same way. Only ever reads; never writes anything back to the
 * note, same as every other Post field. */
function firstCoverImage(app: App, file: TFile, embeds: { link: string }[] | undefined): string | null {
	for (const embed of embeds ?? []) {
		const dest = app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
		if (dest && IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())) {
			return app.vault.getResourcePath(dest);
		}
	}
	return null;
}

export function getPosts(app: App): CompanionPost[] {
	const posts: CompanionPost[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("post")) continue;

		posts.push({
			file,
			title: postTitle(file.basename),
			status: firstStatusValue(frontmatter["status"]),
			platform: typeof frontmatter["platform"] === "string" ? frontmatter["platform"] : "",
			scheduled: normaliseDate(frontmatter["scheduled"]),
			published: normaliseDate(frontmatter["published"]),
			cancelled: !!frontmatter["cancelled"],
			date: normaliseDate(frontmatter["date"]),
			coverImageUrl: firstCoverImage(app, file, cache.embeds),
		});
	}

	return posts;
}

/** How many of `kind` fit in a month, on average -- the constant behind
 * turning any subscription's cost into a monthly-equivalent figure for the
 * Reminders view's running total. Deliberately approximate (365.25/12 days
 * a month, so weekly/daily costs aren't exactly right in every specific
 * month) -- exactness here would be spurious precision on money that's
 * already an estimate the moment two subscriptions bill on different days. */
const OCCURRENCES_PER_MONTH: Record<RecurKind, number> = {
	daily: 365.25 / 12,
	weekly: 52 / 12,
	monthly: 1,
	yearly: 1 / 12,
	biennial: 1 / 24,
};

export function monthlyEquivalentCost(cost: number, kind: RecurKind): number {
	return cost * OCCURRENCES_PER_MONTH[kind];
}

/** The next date `kind`, stepped once from `current` -- unlike
 * stepOccurrences() above (which projects a *range* forward from a fixed
 * anchor for calendar display), this steps a single reminder's own `date`
 * forward in place. The mechanism behind "Renew" in the Reminders view: a
 * subscription doesn't need a note per past renewal, just its own due date
 * rolling forward each time it's dealt with. */
function nextOccurrenceDate(current: Date, kind: RecurKind): Date {
	if (kind === "daily") return addDaysLocal(current, 1);
	if (kind === "weekly") return addDaysLocal(current, 7);
	const day = current.getDate();
	if (kind === "monthly") {
		const next = new Date(current.getFullYear(), current.getMonth() + 1, 1);
		const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
		return new Date(next.getFullYear(), next.getMonth(), Math.min(day, lastDay));
	}
	const nextYear = current.getFullYear() + (kind === "biennial" ? 2 : 1);
	const lastDay = new Date(nextYear, current.getMonth() + 1, 0).getDate();
	return new Date(nextYear, current.getMonth(), Math.min(day, lastDay));
}

/** Rolls a recurring note's own `date` forward by one occurrence -- the
 * mechanism behind both "Renew" in the Finance tab (a subscription) and
 * "Skip this occurrence" on any other recurring Meeting/Event/Reminder/Task
 * anchor's own delete menu (see showDeleteMenu in deleteUI.ts). No note is
 * created or touched other than this one; it just becomes due again next
 * period, the same note throughout its life -- the anchor's own occurrence
 * can't be individually removed without ending the series (there'd be
 * nothing left to project future dates from), so "skipping" it means moving
 * straight to the next one instead, the same way a projected (not yet
 * materialised) occurrence is skipped via skipRecurringOccurrence above. */
export async function advanceRecurringOccurrence(app: App, file: TFile): Promise<void> {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	const kind = parseRecur(fm?.["recur"]);
	if (!kind) throw new Error("This item doesn't repeat.");
	const dateStr = normaliseDate(fm?.["date"]);
	if (!dateStr) throw new Error("This item has no date to advance from.");
	const time = timeOfDay(fm?.["date"]);
	const next = nextOccurrenceDate(parseDateStr(dateStr), kind);

	await app.fileManager.processFrontMatter(file, (rfm: Record<string, unknown>) => {
		rfm["date"] = `${formatDateStr(next)}T${time}`;
	});
}

/** Pushes a reminder's own due date+time forward by a fixed number of
 * minutes -- "Snooze" in the Reminders view, for a plain one-off reminder
 * rather than the repeat-driven Renew a subscription gets. Same
 * single-field rewrite pattern as advanceRecurringReminder: no new note,
 * the reminder just becomes due later. */
export async function snoozeReminder(app: App, file: TFile, minutes: number): Promise<void> {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	const dateStr = normaliseDate(fm?.["date"]);
	if (!dateStr) throw new Error("This reminder has no date to snooze from.");
	const time = timeOfDay(fm?.["date"]);
	const current = new Date(`${dateStr}T${time}`);
	current.setMinutes(current.getMinutes() + minutes);
	const y = current.getFullYear();
	const m = String(current.getMonth() + 1).padStart(2, "0");
	const d = String(current.getDate()).padStart(2, "0");
	const h = String(current.getHours()).padStart(2, "0");
	const min = String(current.getMinutes()).padStart(2, "0");

	await app.fileManager.processFrontMatter(file, (rfm: Record<string, unknown>) => {
		rfm["date"] = `${y}-${m}-${d}T${h}:${min}`;
	});
}

/**
 * Moves a note to Obsidian's trash (system or .trash, per the user's own
 * setting under Settings -> Files & Links) -- reversible, never a
 * permanent delete. The one deletion path every Companion view uses,
 * whether it's a single item or part of a multi-select batch.
 */
export async function deleteCompanionFile(app: App, file: TFile): Promise<void> {
	await app.fileManager.trashFile(file);
}

// Time tracking. A Time Entry is its own note type (Admin/Time/, tag
// `time`) rather than folded into Tasks -- Toggl entries are billable
// activity by client, not references to a to-do, and Mo confirmed that
// distinction should carry over rather than be flattened. Replaces Toggl
// entirely: this is the one write path Companion's live timer uses.

export interface TimeEntry {
	file: TFile;
	description: string;
	client: string | null; // unwrapped from the [[wikilink]] stored in frontmatter, e.g. "Acme Co"
	date: string | null;
	start: string | null; // ISO datetime
	end: string | null; // null while the timer is still running
	duration: number | null; // hours, to 2dp; null while running
}

const TIME_FOLDER = "Admin/Time";

function normaliseDateTime(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
	return null;
}

function unwrapWikilink(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const match = value.match(/^\[\[([^\]|]+)/);
	return match ? match[1].trim() : value.trim();
}

export function getTimeEntries(app: App): TimeEntry[] {
	const entries: TimeEntry[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("time")) continue;

		entries.push({
			file,
			description: typeof frontmatter["description"] === "string" ? frontmatter["description"] : file.basename,
			client: unwrapWikilink(frontmatter["client"]),
			date: normaliseDate(frontmatter["date"]),
			start: normaliseDateTime(frontmatter["start"]),
			end: normaliseDateTime(frontmatter["end"]),
			duration: typeof frontmatter["duration"] === "number" ? frontmatter["duration"] : null,
		});
	}

	return entries;
}

/** Every client *hub* note -- backs the Start Timer modal's client
 * autocomplete. The `client` tag lives only on a client's own hub note
 * (e.g. Acme Co); notes belonging to that client's project keep
 * a `client:` frontmatter field linking back to the hub but no longer
 * carry the tag themselves, so a plain tag match is enough. */
export function getClientNames(app: App): string[] {
	const names: string[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) continue;
		if (!getTags(frontmatter).includes("client")) continue;
		names.push(file.basename);
	}

	return names.sort((a, b) => a.localeCompare(b));
}

/** The single currently-running entry, if any (start set, end not). Derived
 * fresh from the vault every call -- there is no separate plugin-side
 * "is a timer running" state to drift out of sync with the note itself. */
export function getRunningTimeEntry(app: App): TimeEntry | null {
	const running = getTimeEntries(app).filter((t) => t.start && !t.end);
	if (running.length === 0) return null;
	// Defensive only -- normal use never produces more than one, since
	// startTimeEntry always stops an existing one first.
	running.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
	return running[0];
}

/**
 * Starts a new timer: creates a Time Entry note with `start` set and
 * `end`/`duration` blank. If another entry is already running, stops it
 * first -- only one timer runs at a time, same as Toggl.
 *
 * Description and client go through processFrontMatter (not the raw
 * template string used for date/tags/start below), since they're free
 * text Mo types in -- letting Obsidian's own YAML serialiser quote and
 * escape whatever he enters rather than hand-building YAML that could
 * break on a stray colon or quote.
 */
export async function startTimeEntry(app: App, description: string, client: string): Promise<TFile> {
	const safeDescription = description.trim();
	if (!safeDescription) throw new Error("A description is needed to start a timer.");

	const running = getRunningTimeEntry(app);
	if (running) {
		await stopTimeEntry(app, running.file);
	}

	const now = new Date();
	const dateStr = formatDate(now);
	const startIso = toMinuteIso(now);

	const titleBase = sanitiseFilename(`${safeDescription} - ${formatDMY(now)}`);
	let path = `${TIME_FOLDER}/${titleBase}.md`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${TIME_FOLDER}/${titleBase} (${n}).md`;
		n++;
	}

	const file = await app.vault.create(path, `---\ndate: ${dateStr}T00:00\ntags:\n  - time\nclient:\nstart:\nend:\nduration:\n---\n\n`);
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["description"] = safeDescription;
		fm["client"] = client.trim() ? `[[${client.trim()}]]` : "";
		fm["start"] = startIso;
	});
	return file;
}

/** Rounds a raw duration UP to the nearest `incrementMinutes` (0 = off,
 * exact to 2dp) -- matches the invoice procedure's own convention of
 * rounding up rather than to nearest, so a tracked session never reads
 * as less time than was actually spent. */
function roundDurationUp(hours: number, incrementMinutes: number): number {
	if (incrementMinutes <= 0) return Math.round(hours * 100) / 100;
	const incrementHours = incrementMinutes / 60;
	const rounded = Math.ceil(hours / incrementHours) * incrementHours;
	return Math.round(rounded * 100) / 100;
}

/**
 * Stops a running timer: sets `end` to now and computes `duration` in
 * hours (2dp) from `start`, rounded up per `roundingMinutes` (0 = off).
 * The one write path for finishing an entry -- mirrors
 * setTaskStatus()/setEventDate() in writing exactly the fields this one
 * action changes, nothing else in the note.
 */
export async function stopTimeEntry(app: App, file: TFile, roundingMinutes = 0): Promise<void> {
	const cache = app.metadataCache.getFileCache(file);
	const startIso = normaliseDateTime(cache?.frontmatter?.["start"]);
	if (!startIso) throw new Error("This time entry has no start time to stop from.");

	const end = new Date();
	const startMs = new Date(startIso).getTime();
	const rawHours = (end.getTime() - startMs) / 3600000;
	const durationHours = roundDurationUp(rawHours, roundingMinutes);

	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["end"] = toMinuteIso(end);
		fm["duration"] = durationHours;
	});
}

/**
 * Creates an already-completed time entry directly -- for logging a session
 * that was forgotten at the time, rather than started live. Same note shape
 * as a live-tracked entry (startTimeEntry/stopTimeEntry write the same
 * fields in two steps; this writes both `start` and `end` in one go), so it
 * shows up identically everywhere time entries are read from -- the Time
 * tab, Finance, the dashboard's Recent time entries, invoice generation.
 * `startTimeStr`/`endTimeStr` are both "HH:MM" on the same `dateStr` --
 * this doesn't support an entry spanning midnight.
 */
export async function createManualTimeEntry(
	app: App,
	description: string,
	client: string,
	dateStr: string,
	startTimeStr: string,
	endTimeStr: string,
	roundingMinutes = 0
): Promise<TFile> {
	const safeDescription = description.trim();
	if (!safeDescription) throw new Error("A description is needed to add a time entry.");
	if (!startTimeStr || !endTimeStr) throw new Error("Both a start and end time are needed.");

	const [sh, sm] = startTimeStr.split(":").map(Number);
	const start = parseDateStr(dateStr);
	start.setHours(sh, sm, 0, 0);

	const [eh, em] = endTimeStr.split(":").map(Number);
	const end = parseDateStr(dateStr);
	end.setHours(eh, em, 0, 0);

	if (end.getTime() <= start.getTime()) throw new Error("End time must be after start time.");

	const rawHours = (end.getTime() - start.getTime()) / 3600000;
	const durationHours = roundDurationUp(rawHours, roundingMinutes);

	const titleBase = sanitiseFilename(`${safeDescription} - ${formatDMY(start)}`);
	let path = `${TIME_FOLDER}/${titleBase}.md`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${TIME_FOLDER}/${titleBase} (${n}).md`;
		n++;
	}

	const file = await app.vault.create(path, `---\ndate: ${dateStr}T00:00\ntags:\n  - time\nclient:\nstart:\nend:\nduration:\n---\n\n`);
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["description"] = safeDescription;
		fm["client"] = client.trim() ? `[[${client.trim()}]]` : "";
		fm["start"] = toMinuteIso(start);
		fm["end"] = toMinuteIso(end);
		fm["duration"] = durationHours;
	});
	return file;
}

// Invoice generation. Turns a client's tracked time straight into an
// invoice note, matching [[Invoice Create Procedure]]'s own grouping,
// rounding and dating rules -- but reading Companion's own Time Entry
// notes directly instead of parsing a Toggl export, since Companion has
// owned every time entry since `1.5.0`. Mo's own business details and
// payment instructions live in plugin settings (constant across every
// invoice); a client's own billing details live as plain fields on their
// hub note, so the invoice generator's UI can populate them from a
// dropdown, or from a brand-new client note created on the spot, rather
// than needing a previous invoice to copy anything from.

const INVOICE_FOLDER = "Admin/Invoices";
const CLIENT_FOLDER_ROOT = "Clients";
const PACKAGE_FOLDER = "Admin/Packages";

export interface ClientBillingInfo {
	billingName: string; // the legal/trading name on the invoice, which may differ from the wiki note's own title
	address: string;
	email: string;
	phone: string;
}

function getClientFile(app: App, clientName: string): TFile | null {
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		if (!getTags(fm).includes("client")) continue;
		if (file.basename !== clientName) continue;
		return file;
	}
	return null;
}

function stringField(fm: Record<string, unknown> | undefined, key: string): string {
	const v = fm?.[key];
	return typeof v === "string" ? v : "";
}

/** A client hub note's own billing fields -- the source for a new
 * invoice's "To" block. The hub note's own `client` field holds the
 * client's actual billing/legal name (its title is just the link target
 * used everywhere else) -- there's no separate `billingName` field.
 * Missing fields come back as "", not undefined, so the invoice
 * generator's UI can render and edit them uniformly whether or not
 * they've ever been filled in. Null only if the client itself doesn't
 * exist. */
export function getClientBillingInfo(app: App, clientName: string): ClientBillingInfo | null {
	const file = getClientFile(app, clientName);
	if (!file) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return {
		billingName: stringField(fm, "client") || clientName,
		address: stringField(fm, "address"),
		email: stringField(fm, "email"),
		phone: stringField(fm, "phone"),
	};
}

/** Writes billing fields back onto a client hub note. Used by the invoice
 * generator right before creating an invoice, so filling a gap (or fixing
 * a stale address) doesn't need a separate trip to the note itself. Also
 * clears a stray `billingName` field left over from before that field was
 * folded into `client`, if one's still there. */
export async function setClientBillingInfo(app: App, clientName: string, billing: ClientBillingInfo): Promise<void> {
	const file = getClientFile(app, clientName);
	if (!file) throw new Error(`No client hub note found for "${clientName}".`);
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm["client"] = billing.billingName;
		fm["address"] = billing.address;
		fm["email"] = billing.email;
		fm["phone"] = billing.phone;
		delete fm["billingName"];
	});
}

/** Creates a brand-new client hub note -- the "+ New client" path in the
 * invoice generator, for billing someone who isn't in the wiki yet. Same
 * shape as an existing hub note (the `client` tag, a self-referencing
 * `client` field) plus the billing fields an invoice needs. `rate` is
 * left unset -- a genuinely new client may not even be billed hourly,
 * see Packages below. */
export async function createClientNote(app: App, name: string, billing: ClientBillingInfo): Promise<TFile> {
	const safe = sanitiseFilename(name);
	if (!safe) throw new Error("A client name is needed.");
	const path = `${CLIENT_FOLDER_ROOT}/${safe}/${safe}.md`;
	if (app.vault.getAbstractFileByPath(path)) throw new Error(`A note already exists at "${path}".`);

	const esc = (s: string) => s.replace(/"/g, '\\"');
	const frontmatter =
		`---
date: ${formatDate(new Date())}T00:00
tags:
  - client
client: "${esc(billing.billingName)}"
status:
  - Active
` +
		`address: "${esc(billing.address)}"
` +
		`email: "${esc(billing.email)}"
` +
		`phone: "${esc(billing.phone)}"
---

` +
		`Client index for the ${safe} engagement.
`;
	return app.vault.create(path, frontmatter);
}

export interface PackageDefinition {
	file: TFile;
	name: string; // the note's own title, shown in the picker
	amount: number; // GBP, the flat line-item total
	hours: number | null; // shown in Hours Worked if set; null renders as a dash
	description: string; // Task Description text written into the invoice row; defaults to the package name
}

/** Mo's fixed-price service packages (see [[Service Menu]]) -- tagged
 * notes under Admin/Packages/ so he can add, edit or retire one himself
 * without a code change. Selecting one in the invoice generator inserts
 * a single flat-fee line item. */
export function getPackages(app: App): PackageDefinition[] {
	const packages: PackageDefinition[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.parent?.path !== PACKAGE_FOLDER) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !getTags(fm).includes("package")) continue;
		const amount = typeof fm["amount"] === "number" ? fm["amount"] : 0;
		const hours = typeof fm["hours"] === "number" ? fm["hours"] : null;
		const description = stringField(fm, "description").trim() || file.basename;
		packages.push({ file, name: file.basename, amount, hours, description });
	}
	return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export interface InvoiceRow {
	description: string;
	hours: number; // already rounded up to the nearest half hour
	date: string; // YYYY-MM-DD, the group's latest entry
	entries: TimeEntry[]; // the raw Time Entry notes this row summarises
}

/**
 * A client's completed Time Entries within [startStr, endStr] (inclusive),
 * grouped by exact description, each group's hours summed and rounded up
 * to the nearest half hour, dated to the group's own latest entry. No
 * Toggl-style "(2)"/duplicate-prefix cleanup -- Companion's own time
 * entries never produce that artefact, so grouping by the description
 * exactly as typed is enough.
 */
export function groupTimeEntriesForInvoice(app: App, client: string, startStr: string, endStr: string): InvoiceRow[] {
	const entries = getTimeEntries(app).filter(
		(t) => t.client === client && t.end != null && t.duration != null && t.date != null && t.date >= startStr && t.date <= endStr
	);

	const byDescription = new Map<string, TimeEntry[]>();
	for (const entry of entries) {
		const key = entry.description.trim() || entry.file.basename;
		const bucket = byDescription.get(key);
		if (bucket) bucket.push(entry);
		else byDescription.set(key, [entry]);
	}

	const rows: InvoiceRow[] = [];
	for (const [description, group] of byDescription) {
		const rawHours = group.reduce((sum, e) => sum + (e.duration ?? 0), 0);
		const hours = Math.round(Math.ceil(rawHours / 0.5) * 0.5 * 100) / 100;
		const date = group.reduce((latest, e) => ((e.date ?? "") > latest ? (e.date ?? "") : latest), "");
		rows.push({ description, hours, date, entries: group });
	}

	rows.sort((a, b) => b.date.localeCompare(a.date));
	return rows;
}

/** The `rate` field on a client's own hub note (tag `client`), GBP/hour --
 * the source of truth for a new invoice's hourly rate. Null if unset,
 * which callers should treat as "ask Mo", not silently default. */
export function getClientRate(app: App, clientName: string): number | null {
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) continue;
		if (!getTags(fm).includes("client")) continue;
		if (file.basename !== clientName) continue;
		return typeof fm["rate"] === "number" ? fm["rate"] : null;
	}
	return null;
}

interface ParsedInvoiceFilename {
	number: number;
	client: string;
	dateStr: string; // YYYY-MM-DD
}

// Matches "013 - Acme Co - 25-08-2026" (basename, no extension) --
// [[Invoice Create Procedure]]'s own filename convention.
const INVOICE_FILENAME_RE = /^(\d{3}) - (.+) - (\d{2})-(\d{2})-(\d{4})$/;

function parseInvoiceFilename(basename: string): ParsedInvoiceFilename | null {
	const m = basename.match(INVOICE_FILENAME_RE);
	if (!m) return null;
	const [, num, client, dd, mm, yyyy] = m;
	return { number: parseInt(num, 10), client, dateStr: `${yyyy}-${mm}-${dd}` };
}

/** The highest invoice number in Admin/Invoices/, across every client --
 * numbering is one sequence for the whole business, not per client, per
 * the existing procedure. 0 if there are none yet. */
export function getLatestInvoiceNumber(app: App): number {
	let max = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.parent?.path !== INVOICE_FOLDER) continue;
		const parsed = parseInvoiceFilename(file.basename);
		if (parsed) max = Math.max(max, parsed.number);
	}
	return max;
}

export interface PreviousInvoiceInfo {
	file: TFile;
	number: number;
	dateStr: string; // YYYY-MM-DD, its own Invoice Date
}

/** The most recent invoice already sent to `clientName`, if any -- the
 * source Companion copies header/"To"/payment blocks from for a new one,
 * and a sensible default billing-period start (the day after). */
export function getLatestInvoiceForClient(app: App, clientName: string): PreviousInvoiceInfo | null {
	let latest: PreviousInvoiceInfo | null = null;
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.parent?.path !== INVOICE_FOLDER) continue;
		const parsed = parseInvoiceFilename(file.basename);
		if (!parsed || parsed.client !== clientName) continue;
		if (!latest || parsed.number > latest.number) latest = { file, number: parsed.number, dateStr: parsed.dateStr };
	}
	return latest;
}

export interface CompanionInvoice {
	file: TFile;
	number: number;
	client: string;
	date: string | null; // YYYY-MM-DD, the invoice's issue date
	amount: number | null; // null if a total couldn't be parsed from the body
	currencySymbol: string; // bare symbol ("£"/"€"/"¥") or "CODE " prefix for other currencies -- "" if amount is null
	paid: boolean; // `paid: true` in frontmatter -- see setInvoicePaid() below. Absent/false = not yet paid.
}

const TOTAL_DUE_RE = /\*\*Total Due:\*\*\s*(\S*?)\s*([\d,]+\.\d{2})/;

/** Every invoice ever generated, newest first -- backs the Finance tab's
 * Income section. Client and date come from frontmatter (falling back to
 * the filename, which encodes both -- see parseInvoiceFilename). The total
 * itself lives in a frontmatter `amount:` field (added alongside `currency:`
 * once Mo pointed out that parsing it back out of the body's "Total Due"
 * line was fragile) -- read straight from the metadata cache for any
 * invoice that has it. Invoices generated before this change have no
 * `amount:` field, so those still fall back to the old body-text parse,
 * which is why this stays an async per-file read rather than a pure
 * metadata-cache function. */
export async function getInvoices(app: App): Promise<CompanionInvoice[]> {
	const invoices: CompanionInvoice[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (file.parent?.path !== INVOICE_FOLDER) continue;
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const parsed = parseInvoiceFilename(file.basename);

		let amount: number | null = typeof frontmatter?.["amount"] === "number" ? frontmatter["amount"] : null;
		const currencyCode = typeof frontmatter?.["currency"] === "string" ? frontmatter["currency"] : DEFAULT_CURRENCY;
		let currencySymbol = amount != null ? invoicePrefix(currencyCode) : "";

		if (amount == null) {
			const content = await app.vault.cachedRead(file);
			const match = content.match(TOTAL_DUE_RE);
			amount = match ? parseFloat(match[2].replace(/,/g, "")) : null;
			currencySymbol = match ? match[1] : "";
		}

		invoices.push({
			file,
			number: parsed?.number ?? 0,
			client: unwrapWikilink(frontmatter?.["client"]) ?? parsed?.client ?? file.basename,
			date: normaliseDate(frontmatter?.["date"]) ?? parsed?.dateStr ?? null,
			amount,
			currencySymbol,
			paid: frontmatter?.["paid"] === true,
		});
	}

	return invoices.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** Sets or clears an invoice's own `paid:` flag -- the one write this whole
 * area of the plugin makes, and deliberately narrow: just this one field on
 * an existing Invoice note, never its client/date/line items/total, which
 * still only ever come from the Invoice Create Procedure. Lets the Finance
 * tab's Income section distinguish invoiced-but-unpaid from actually
 * collected, which it otherwise can't know (see getInvoices' own comment). */
export async function setInvoicePaid(app: App, file: TFile, paid: boolean): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (paid) fm["paid"] = true;
		else delete fm["paid"];
	});
}

// en-GB's Intl month abbreviation gives "Sept" for September (4 letters,
// every other month 3) -- a fixed table instead, matching the 3-letter
// convention every existing invoice already uses ("20 Aug, 2026").
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatInvoiceRowDate(dateStr: string): string {
	const d = parseDateStr(dateStr);
	return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
}

function formatSlashDMY(d: Date): string {
	const day = String(d.getDate()).padStart(2, "0");
	const month = String(d.getMonth() + 1).padStart(2, "0");
	return `${day}/${month}/${d.getFullYear()}`;
}

export interface InvoiceLineItem {
	date: string; // YYYY-MM-DD
	hours: number | null; // null for a non-hourly line (e.g. a flat package) -- renders as a dash
	description: string;
	rateLabel: string; // exactly what's written into the HOURLY RATE column -- "£10", "Fixed", or blank
	total: number; // GBP, this row's TOTAL COST
	entries?: TimeEntry[]; // backing Time Entry notes, if this row came from tracked time -- deleted once the invoice is created
}

export interface InvoiceHeaderInfo {
	name: string;
	address: string;
	email: string;
	phone: string;
}

export interface InvoicePaymentInfo {
	method: string;
	bankName: string;
	accountName: string;
	accountNumber: string;
	sortCode: string;
}

export interface GenerateInvoiceParams {
	client: string;
	lineItems: InvoiceLineItem[];
	billing: ClientBillingInfo;
	myDetails: InvoiceHeaderInfo;
	payment: InvoicePaymentInfo;
	currencySymbol: string; // bare symbol ("£"/"€"/"¥") or "CODE " prefix -- written into the body's rate/total columns
	currencyCode: string; // ISO 4217 code -- written to frontmatter `currency:` (omitted when it's DEFAULT_CURRENCY, same convention as a Reminder's)
}

/**
 * Builds a complete invoice note for `params.client`: works out the next
 * global invoice number, dates it today with a 7-day due date (matching
 * [[Invoice Create Procedure]]), and writes the Hours Breakdown table
 * straight from `params.lineItems` -- already fully formed by the invoice
 * generator's UI, whether pulled from tracked time, a saved package, or
 * typed by hand. The header comes from `params.myDetails` (Mo's own,
 * constant business details -- plugin settings) and the "To"/payment
 * blocks from `params.billing`/`params.payment`, rather than copying
 * either off a previous invoice. Also creates the same "Chase Payment"
 * reminder the procedure does, and -- since Mo confirmed billed time
 * entries don't need to stick around -- trashes every Time Entry note
 * that fed a tracked-time row (reversible, same as any other Companion
 * delete; rows added manually or from a package have no backing file).
 */
export async function generateInvoice(app: App, params: GenerateInvoiceParams): Promise<TFile> {
	if (!params.billing.billingName.trim()) {
		throw new Error(`"${params.client}" has no billing name set -- add one before generating an invoice.`);
	}
	if (params.lineItems.length === 0) {
		throw new Error("Add at least one line item before generating.");
	}

	const number = getLatestInvoiceNumber(app) + 1;
	const numberStr = String(number).padStart(3, "0");
	const now = new Date();
	const due = addDaysLocal(now, 7);
	const issueDateStr = formatDate(now);

	const totalHours = Math.round(params.lineItems.reduce((s, r) => s + (r.hours ?? 0), 0) * 100) / 100;
	const totalDue = Math.round(params.lineItems.reduce((s, r) => s + r.total, 0) * 100) / 100;

	const headerBlock = [params.myDetails.name, params.myDetails.address, params.myDetails.email, params.myDetails.phone]
		.filter((l) => l.trim())
		.join("\n");
	const toBlock = [params.billing.billingName, params.billing.address, params.billing.email, params.billing.phone]
		.filter((l) => l.trim())
		.join("\n");

	const tableRows = params.lineItems
		.map((r) => {
			const hoursCell = r.hours != null ? r.hours.toFixed(1) : "—";
			return `| ${formatInvoiceRowDate(r.date)} | ${hoursCell} | ${r.description} | Completed | ${r.rateLabel} | ${params.currencySymbol}${r.total.toFixed(2)} |`;
		})
		.join("\n");

	const paymentBlock =
		`### Payment \n\nPayment is due via **${params.payment.method}**. Please use the following details:\n\n` +
		`- **Bank Name:** ${params.payment.bankName}\n` +
		`- **Account Name:** ${params.payment.accountName}\n` +
		`- **Account Number**: ${params.payment.accountNumber}\n` +
		`- **Sort Code**: ${params.payment.sortCode}\n\n---\n\n**Thank you for your business!**  \n`;

	const body =
		`# Invoice\n\n${headerBlock}\n\n` +
		`**To:** \n${toBlock}\n\n` +
		`**Invoice #:** ${numberStr}\n**Invoice Date:** ${formatSlashDMY(now)}\n**Due Date:** ${formatSlashDMY(due)}\n\n` +
		`---\n### Hours Breakdown\n\nA breakdown of the hours worked for this billing period.\n\n` +
		`| **DATE** | **HOURS WORKED** | **TASK DESCRIPTION** | **STATUS** | **HOURLY RATE** | **TOTAL COST** |\n` +
		`| ------ | ------------ | ----------------- | -------- | --------------- | -------------- |\n` +
		`${tableRows}\n\n` +
		`**Total Hours:** ${totalHours}  \n**Total Due:** ${params.currencySymbol}${totalDue.toFixed(2)}\n\n` +
		`---\n${paymentBlock}`;

	const filename = sanitiseFilename(`${numberStr} - ${params.client} - ${formatDMY(now)}`);
	const path = `${INVOICE_FOLDER}/${filename}.md`;
	if (app.vault.getAbstractFileByPath(path)) throw new Error(`A note already exists at "${path}".`);

	const currencyLine = params.currencyCode !== DEFAULT_CURRENCY ? `currency: ${params.currencyCode}\n` : "";

	const file = await app.vault.create(
		path,
		`---\ndate: ${issueDateStr}T00:00\ntags:\n  - invoice\nclient: "[[${params.client}]]"\nstatus:\n  - Pending\namount: ${totalDue}\n${currencyLine}---\n\n${body}`
	);

	await createQuickNote(app, "reminder", formatDate(due), `Chase Payment - Invoice ${numberStr} - ${params.client}`);

	for (const row of params.lineItems) {
		if (!row.entries) continue;
		for (const entry of row.entries) {
			await deleteCompanionFile(app, entry.file);
		}
	}

	return file;
}
