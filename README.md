# Wiki Companion

A calendar, task board, reminders list and time tracker for Obsidian, built to sit on top of frontmatter you already have rather than asking you to adopt a new one.

I built this for my own wiki-style vault — I'm a one-person consultancy and wanted a calendar, a task board, a reminders list and a timer that all read straight from the notes I already keep, instead of learning a separate app's data model. It's grown from a read-only calendar into all four views plus editing and delete, entirely because I kept wanting the next thing for my own use. I'm sharing it as-is in case the same shape (plain tags and dates, no new format to adopt) is useful to someone else, but it isn't trying to be a general-purpose planner for every kind of vault.

Wiki Companion scans your vault for notes tagged `meeting`, `reminder`, `task`, `event`, `invoice` or `time` with a `date:` field in their frontmatter (a Date & time property, `YYYY-MM-DDTHH:MM` -- time entries use `start`/`end` instead), and shows them on a month grid with a per-day agenda panel, or an hourly Week/Day grid in 30-minute steps. Task-tagged notes also get a Kanban-style board and list view, grouped by their `status:` field; reminder-tagged notes get their own list, grouped by due status; and a live timer creates and updates its own `time`-tagged notes, one per session, with a day-by-day log view of its own. Every edit Wiki Companion makes writes back exactly the fields one action changes on one note (or, for delete, moves exactly one note to Obsidian's own trash) — nothing else about the note, or any other note, is ever touched.

## Why

Most calendar and task plugins ask you to manage events or tasks inside the plugin itself, or to adopt a particular format. Wiki Companion is the opposite: it assumes your notes are already the source of truth, and just gives you views over them, with light editing where it's genuinely useful. It's kept deliberately small and open-sourced so anyone can install it cleanly and check exactly what it does. (Named "Wiki Companion" rather than plain "Companion" since that name was already taken in Obsidian's community directory.)

## What it reads

Any markdown note with:

- `tags:` including one of `meeting`, `reminder`, `task`, `event`, `invoice`, `time`
- `date:` as a Date & time property (`YYYY-MM-DD` also still parses, for compatibility) — a task note without a date still appears on the task board, just without one on its card
- `end:` (same Date & time shape), optional, on a Meeting/Reminder/Task/Event/Invoice — gives it a duration, shown as a sized block on the Week/Day calendar grid instead of a single pill
- For the client dropdown in the Start Timer prompt: any note tagged `client` — its filename is what shows up as an option. No `client`-tagged notes yet means an empty dropdown, not an error; you can still type a client name freely.

Optionally, a `status:` field is shown alongside the note's type in the calendar's agenda panel, and drives the task board's three columns.

Notes without one of those tags are ignored — Wiki Companion doesn't try to guess which of your other notes might be calendar- or task-worthy.

## What it writes

Each action below writes exactly the one field named, and nothing else in the note — its body, other frontmatter, its folder — is ever changed:

- **Drag an event** (in the grid or the agenda) onto a different day — sets its `date:` field. Desktop mouse drag only; the underlying HTML5 drag-and-drop API isn't reliable on mobile touch, so on mobile use the note itself to change its date.
- **Click an item in the calendar grid, or the pencil next to an agenda item** — opens an editor for title, type (Meeting/Event/Reminder/Task), start/end time, an "All day" checkbox, and (for a Meeting) client, all in one place, without opening the note itself. Changing the title renames the file; changing the type updates its tag, status, client and folder together; times write `date`/`end`. Converting to or from Invoice isn't offered — editing an existing Invoice's own title or schedule still works, its type just shows as a locked label. Works the same on desktop and mobile, except the type dropdown, which needs a pointer.
- **The "+" button** in the agenda panel — opens the same editor to create a new Meeting, Event, Reminder or Task dated to the selected day, in `Admin/Meetings/`, `Admin/Events/`, `Admin/Reminders/` or `Admin/Tasks/` depending on the type chosen. **Double-clicking an empty day (Month view) or half-hour slot (Week/Day view)** opens it too, pre-dated (and, in Week/Day view, pre-timed) to where you clicked. Either way: an optional start and end time (30 minutes by default once a start is set) plus an "All day" checkbox, so a quickly-created note can be a timed block, a point in time, or undated. Invoices aren't offered here — they need the full invoicing workflow, which a quick form can't fill in responsibly. Creating or editing an item never leaves the calendar view.
- **Drag a duration block's top or bottom edge** (Week/Day view) — adjusts its start or end time, snapped to the nearest half hour, similar to dragging an edge in Google Calendar.
- **"+ Task"** in the task board header, or **+ Reminder** in the reminders view — creates a new, minimally-tagged note (dated to today) in `Admin/Tasks/` or `Admin/Reminders/`, without leaving that view. Same optional start/end time and "All day" checkbox as above.
- **‹ › on the task board, or dragging a card to another column** — sets a task's `status:` field. Drag-and-drop is desktop mouse only, same as the calendar; ‹ › covers the same move on mobile.
- **Right-click an item, in any view** — deletes it (moved to Obsidian's trash, never permanent). Shift+click one or more items first to select several, then right-click any selected item, or use the "Delete" button that appears in the selection bar.
- **Starting/stopping a timer** — from the Time view's **Start/Stop timer** button, or the status bar item at any time from anywhere in the wiki — creates a new time entry against a client and description, or writes `end` and computes `duration` on the running one. Starting a new timer while one is already running stops the old one first — only one runs at a time. Creates a new note in `Admin/Time/`; nothing is ever created by editing an existing note. `duration` is rounded up per the "Round time entries" setting (off by default).

## Usage

1. Install and enable Wiki Companion (see below).
2. Open the calendar from the compass icon in the left ribbon, or via the command palette: **Open calendar**. A **Month/Week/Day** dropdown switches views; the arrows and **Today** move by whatever unit is showing. Click a day to see its agenda — drag the thin handle between the calendar and the agenda to resize it, or use the panel icon next to the mode dropdown to collapse it entirely (handy when you've sized the Obsidian window down to a narrow strip); either way it's remembered next time you open the calendar. Week and Day views add an hourly grid, split into 30-minute slots, below an all-day row (for events with no specific time set) and a red line marking the current time (with the UTC offset shown above the hour labels — a wrong system clock or timezone shows up here first; set **Calendar timezone** in settings, now a dropdown of every IANA zone, while travelling to see times in a zone other than the device's own, without touching the device's actual clock). Double-click an empty day or half-hour slot to create a new item there; click an existing item, in the grid or the agenda, to open the same editor and change its title, type, time or all-day status. Drag an item onto a day or half-hour slot to reschedule it (a block's length is preserved when it's moved), or drag a duration block's top or bottom edge to resize it, snapped to the half hour.
3. Open the task board from the checklist icon in the left ribbon, or via the command palette: **Open task board**. Toggle between **Board** (columns by status) and **List** (grouped by status, click a status heading to fold/unfold it). A sort dropdown orders cards by due date (default) or title, with a second button flipping ascending/descending. Drag a card to another column, or use ‹ ›, to move it between statuses; **+ Task** adds a new one.
4. Open reminders from the bell icon in the left ribbon, or via the command palette: **Open reminders**. Reminders are grouped into **Due** (date today or earlier — the same threshold `due_reminders.py` uses), **Upcoming**, and **No date** — each sortable by due date (default) or title, ascending or descending. Use **+ Reminder** to add one.
5. Opening a note (a calendar agenda item, a task's title, or a reminder's title): click opens it in a new tab, leaving the current view where it is. Ctrl/Cmd+hover shows Obsidian's own Page preview popup instead (if that core plugin is enabled) — read or lightly edit without leaving Companion at all.
6. Deleting: right-click any item to delete just that one, or Shift+click to select several first (a "N selected" bar appears with its own Delete). Deletes immediately by default — turn on "Confirm before deleting" in settings if you'd rather be asked first. Either way, only ever moves notes to Obsidian's trash, never a permanent delete.
7. Open the time tracker from the timer icon in the left ribbon or the command palette (**Open time tracker**) to browse logs and reports. To just start or stop a timer without leaving whatever note you're in, use the status bar item at the bottom of the window (shows what's running, if anything) — it opens the same Start timer prompt, or stops the running entry directly, from anywhere in the wiki.
8. The Time view has two modes. **Log** (the default) shows the running entry (if any, with a live elapsed time and its own Stop button), today/this-week/this-month totals, and the last 30 days of entries grouped by day — repeat sessions of the same description and client fold into one row with a count, expandable to see each session; a ▶ next to any row starts a new timer with that same description/client. **Report** browses any month (‹ › to navigate) with its total and a per-client breakdown. Same open/Shift-select/delete gestures as every other view in both modes.
9. Settings → Community plugins → Wiki Companion has a few options: a daily time goal (hours, drives the Log view's progress/streak line), rounding time entries up to the nearest 15/30/60 minutes when a timer stops, confirming before delete, which day the Time view's weekly total starts on, a **Calendar timezone** override for the current-time line and GMT label while travelling (blank uses the device's own), and **Notify when something starts** — an optional desktop notification when a timed Reminder, Task, Event or Meeting's start time arrives (off by default; all-day items never notify).

## Installation

**From within Obsidian**: Settings → Community plugins → Browse → search "Wiki Companion" → Install → Enable.

**Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) and place them in `<your vault>/.obsidian/plugins/wiki-companion/`, then enable the plugin under Settings → Community plugins.

## Bases (optional)

Wiki Companion's own views (calendar, task board, reminders, time log) work as soon as you enable the plugin — they read tags and frontmatter directly, and need no setup beyond that.

If you also use Obsidian's core **Bases** plugin, you may want native table views over the same tagged notes (sortable columns, filtering by client, and so on) alongside Wiki Companion's views. Wiki Companion doesn't ship any `.base` files — they're a separate, optional layer, and Bases' own format may change over time — but a simple one is quick to build yourself: **Create new Base**, then filter on `tags.contains("task")` (or `"reminder"`, `"meeting"`, `"event"`, `"invoice"`, `"time"`) and add whichever columns you want (`date`, `status`, `client`, `duration`, and so on).

## Roadmap

Wiki Companion is being developed incrementally. The calendar (Month/Week/Day, the latter two on a 30-minute grid with drag-to-reschedule, drag-to-resize duration blocks, double-click-to-create, a resizable and collapsible agenda, a full IANA timezone override and optional due-time notifications), task board, reminders list, time tracker (with its own log/report view) and their editing features (a single title/type/time/all-day/client editor, and delete) are built. On phone-sized screens the calendar's day grid + agenda and the task board's Kanban columns stack vertically rather than squeezing side by side; list views were already narrow enough. Repeating events aren't built yet — the wiki's one-canonical-note-per-item model raises a real design question (what does completing or rescheduling one occurrence mean?) that's worth settling deliberately rather than guessing at.

## License

MIT — see [LICENSE](LICENSE).
