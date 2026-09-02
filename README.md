# Wiki Companion

A calendar, task board, reminders/finance view and time tracker for Obsidian, built to sit on top of frontmatter you already have rather than asking you to adopt a new one.

I built this for my own wiki-style vault — I'm a one-person consultancy and wanted a calendar, a task board, a reminders/finance view and a timer that all read straight from the notes I already keep, instead of learning a separate app's data model. It's grown from a read-only calendar into all four views plus editing and delete, entirely because I kept wanting the next thing for my own use. I'm sharing it as-is in case the same shape (plain tags and dates, no new format to adopt) is useful to someone else, but it isn't trying to be a general-purpose planner for every kind of vault.

Wiki Companion scans your vault for notes tagged `meeting`, `reminder`, `task`, `event`, `invoice` or `time` with a `date:` field in their frontmatter (a Date & time property, `YYYY-MM-DDTHH:MM` -- time entries use `start`/`end` instead), and shows them on a month grid with a per-day agenda panel, or an hourly Week/Day grid in 30-minute steps. Task-tagged notes also get a Kanban-style board and list view, grouped by their `status:` field; a Reminder can also carry a `cost:` (a Subscription, with `recur:`, or an Expense without) or an `income:` flag (money coming in rather than going out, with the same recur/one-off split) — these, plus every generated Invoice, live in the Finance tab (see **Finance** below), created and edited through the same shared "New item" dialog used everywhere else in the plugin -- though Finance's own version of that dialog only offers the three financial types, not the full list. A live timer creates and updates its own `time`-tagged notes, one per session, with a day-by-day log view of its own. Every edit Wiki Companion makes writes back exactly the fields one action changes on one note (or, for delete, moves exactly one note to Obsidian's own trash) — nothing else about the note, or any other note, is ever touched.

## Why

Most calendar and task plugins ask you to manage events or tasks inside the plugin itself, or to adopt a particular format. Wiki Companion is the opposite: it assumes your notes are already the source of truth, and just gives you views over them, with light editing where it's genuinely useful. It's kept deliberately small and open-sourced so anyone can install it cleanly and check exactly what it does. (Named "Wiki Companion" rather than plain "Companion" since that name was already taken in Obsidian's community directory.)

## What it reads

Any markdown note with:

- `tags:` including one of `meeting`, `reminder`, `task`, `event`, `invoice`, `time`
- `date:` as a Date & time property (`YYYY-MM-DD` also still parses, for compatibility) — a task note without a date still appears on the task board, just without one on its card
- `end:` (same Date & time shape), optional, on a Meeting/Reminder/Task/Event/Invoice — gives it a duration, shown as a sized block on the Week/Day calendar grid instead of a single pill
- `recur:` (`daily`/`weekly`/`monthly`/`yearly`/`biennial`), optional, on a Meeting/Reminder/Task/Event — makes it a repeating series, projected forward on the calendar from its one real note (see **Repeating events** below)
- `cost:` (a number, per period) on a Reminder — combined with `recur:` this is a Subscription; on its own, without `recur:`, it's a one-off Expense. Optional on a plain Reminder, but required once Subscription, Expense or Income is picked from the type dropdown — the shared editor won't let you save without one, since none of those three mean anything without a figure attached. Shows up in the Finance tab, not just the calendar.
- `currency:` (an ISO 4217 code, e.g. `USD`), optional, on a Reminder — alongside `cost:`, picks which currency that Subscription/Expense/Income figure is in, from the full list of world currencies. Omitted means GBP, so every note created before this field existed keeps working unchanged. Displayed as a bare `£`/`€`/`¥` for those three currencies, or as `CODE amount` (e.g. `USD 25.00`) for everything else, since a bare `$` alone is ambiguous across the many currencies that share it.
- `invoiceReminder: true`, optional, on a repeating Reminder — shows it with the same pill colour as an Invoice, as a nudge to go generate one that day; it doesn't create an invoice itself
- `income: true`, optional, on a Reminder — flips it from an outgoing cost to incoming money in the Finance tab. Combine with `recur:` for a recurring income source (a monthly payout, say); leave `recur:` unset for a one-off entry recording money already received. Uses the same `currency:` field as `cost:`, GBP by default.
- `remind:` (`9am`/`1d`/`1w`/`1m`), optional, on a Meeting/Reminder/Task/Event — an advance desktop notification (9am on the item's own date, or 1 day/week/month ahead of it), set per item via the shared editor's "Remind" field. Fires regardless of the "Notify when something starts" setting -- it's opted into per item, not gated by that toggle.
- Any note tagged `post` with a `published:` date — shown on the calendar as its own category, pinned to that date. Companion can create a new Post idea note (see **What it writes** below) but never edits or deletes an existing one -- clicking one just opens it, and the content workflow itself stays entirely outside the plugin. A Post without a `published:` date yet (an Idea or an in-progress draft) has nothing to plot, unless it also carries a `scheduled:` target date -- that earns a dashed, faded pin on that date instead (same look as a projected recurring occurrence), and a desktop notification on the day itself asking whether it's gone out. Fill in `published:` by hand once it has, and the provisional pin is simply replaced by a real one.
- For the client dropdown in the Start Timer prompt (and the Meeting/invoice client fields): any note tagged `client` — its filename is what shows up as an option. No `client`-tagged notes yet means an empty dropdown, not an error; you can still type a client name freely.

Optionally, a `status:` field is shown alongside the note's type in the calendar's agenda panel, and drives the task board's three columns.

Notes without one of those tags are ignored — Wiki Companion doesn't try to guess which of your other notes might be calendar- or task-worthy.

## What it writes

Each action below writes exactly the field(s) named, and nothing else in the note — its body, other frontmatter, its folder — is ever changed:

- **Drag an event** (in the grid or the agenda) onto a different day — sets its `date:` field. Desktop mouse drag only; the underlying HTML5 drag-and-drop API isn't reliable on mobile touch, so on mobile use the note itself, or the editor below, to change its date.
- **Click an item in the calendar grid, or the pencil next to an agenda/list item** — opens one editor for title, type (Meeting/Event/Reminder/Subscription/Expense/Invoice reminder/Income/Task), date, start/end time, an "All day" checkbox, repeat rule, an advance reminder lead time and (for a Meeting) client, all in one place, without opening the note itself. Cost only shows once Subscription, Expense, Invoice reminder or Income is picked, or when editing something that already has one set -- and is required, not just shown, for Subscription/Expense/Income specifically. Changing the title renames the file; changing the type updates its tag, status, client and folder together. Converting to or from a real Invoice isn't offered — editing an existing Invoice's own title or schedule still works, its type just shows as a locked label.
- **The "+" button** in the agenda panel, task board or reminders view — opens the same editor to create a new item, dated to the selected day (or today), with Post as an extra type available here only (see below). Finance's own "+" opens the same editor but narrowed to Subscription/Expense/Income only — see **Finance** below. **Double-clicking an empty day (Month view) or half-hour slot (Week/Day view)** opens the full editor too, pre-dated and pre-timed to where you clicked. Invoices aren't offered from any of these — they need the full invoicing workflow (below), which a quick form can't fill in responsibly.
- **Picking "Post"** in the "+ New item" dropdown — writes a minimal `Content/Posts/<title> - Post Idea.md` note (`status: [Idea]`, empty `platform:`/`published:`/`cancelled:`) and sets its `scheduled:` field to the date chosen in the dialog; the note's own `date:` is the day it was created, not the scheduled one. Post is create-only: once a Post note exists, editing it means opening the note itself, same as any other Post (see **What it reads** above) -- it isn't offered as a type when editing an existing item.
- **Drag a duration block's top or bottom edge** (Week/Day view) — adjusts its start or end time, snapped to the nearest half hour, similar to dragging an edge in Google Calendar.
- **‹ › on the task board, or dragging a card to another column** — sets a task's `status:` field. Drag-and-drop is desktop mouse only, same as the calendar; ‹ › covers the same move on mobile.
- **Right-click an item, in any view** — deletes it (moved to Obsidian's trash, never permanent). Shift+click one or more items first to select several, then right-click any selected item, or use the "Delete" button that appears in the selection bar. On a repeating item this menu also offers **Skip this occurrence** (rolls its own due date forward one period without deleting the series), and — on a not-yet-materialised future occurrence — **Edit this and following occurrences** / **Delete this and following occurrences**, which cap the original series and, for edit, start a new one from that date.
- **Renew** on a Subscription row in the Finance tab — the same "roll the due date forward one period" action as Skip this occurrence, exposed there since a subscription's next due date is the whole point of the row.
- **Starting/stopping a timer** — from the Time view's **Start/Stop timer** button, or the status bar item at any time from anywhere in the wiki — creates a new time entry against a client and description, or writes `end` and computes `duration` on the running one. Starting a new timer while one is already running stops the old one first — only one runs at a time. `duration` is rounded up per the "Round time entries" setting (off by default).
- **Add entry** (Time view, and the Daily Note dashboard's mini timer) — logs an already-finished session that was forgotten at the time, without touching the running timer: a small dialog for description, client, date and start/end time, written as a completed entry in one go.
- **Generate invoice** (command palette, or from a client's billing details) — walks through a currency picker (any ISO 4217 currency, GBP by default), then line items (pulled from tracked time, a saved package, or typed by hand), then writes a complete, sequentially-numbered invoice note under `Admin/Invoices/` and a "Chase Payment" reminder dated to its due date. Billed time entries are trashed once the invoice is created (reversible, like any Companion delete). This is the only way Wiki Companion creates an Invoice — the quick editors above never do.

## Repeating events

A repeating Meeting, Event, Reminder or Task has exactly one real note — its `recur:` field and `date:` together define the series, and the calendar projects future occurrences from it without creating a note per occurrence. Opening a not-yet-real occurrence offers **Edit this occurrence** (materialises just that one date into its own note) or **Edit this and following occurrences** (caps the original series and starts a fresh one from that date); deleting offers the equivalent **Skip this occurrence** and **Delete this and following occurrences**, without ever touching the notes of any other occurrence.

## Finance

The Finance tab has four sections, plus two summary lines. Subscriptions, Expenses and Income (the Reminder-based one) are the same underlying note shape with different fields set; only Invoiced is built from a different note type.

- **To date** — money actually in hand against money actually spent: paid invoices plus one-off Income entries, netted against one-off Expenses. Recurring Subscriptions and Income aren't counted here -- Companion only tracks a recurring item's *next* due date, not how many periods have actually elapsed and been paid, so a running total for those would be a guess dressed up as a fact. Hidden when there's nothing to report.
- **Recurring run-rate** — shown only when you have at least one Subscription or recurring Income entry: one in/out line per currency in use, netted to a single figure only when everything on both sides shares one currency (mixing currencies never gets silently combined into a false total). Hidden entirely otherwise.
- **Subscriptions** — a Reminder with both `recur:` and `cost:` set, and no `income:` flag: money going out on a repeat basis (software, a membership). Shows a monthly-equivalent running total and a **Renew** button per row.
- **Expenses** — a Reminder with `cost:` set, no `recur:`, and no `income:` flag: a one-off cost, with a running total.
- **Income** — a Reminder with `cost:` and `income: true` set. With `recur:` also set, it's a recurring source (a monthly payout); without it, a one-off entry for money already received. Any currency, via the same `currency:` field as Subscriptions and Expenses. The Paid toggle below doesn't apply here; there's no invoice behind these to be paid.
- **Invoiced** — every note under `Admin/Invoices/`, newest first, summed per currency (figures in different currencies are never merged into one total). The headline total is everything ever invoiced, not just paid; a circle button on each row toggles its own `paid:` flag, and a second line under the total shows how much of it has actually come in. Rows open the invoice note itself; creating or amending an invoice's own content always goes through **Generate invoice**, never this view -- Paid is the one thing this view itself writes.

Subscriptions, Expenses and Income are created and edited through the same **"+ New item"** dropdown the calendar uses, narrowed here to just those three -- Meeting/Event/Reminder/Invoice reminder/Task/Post aren't offered from Finance's own "+", since anything created from this tab is inherently one of the three by definition. Cost is required once one of them is picked; the dialog won't let you save without it. A `Subscription` note template is available under Templates for typing one in by hand, though the "+" button is quicker.

## Daily Note summary

A fenced ```` ```companion-dashboard``` ```` code block, placed anywhere in a note (typically a Daily Note template), renders a live timer, today's agenda, overdue items and items due soon — no separate tab, just an embed that updates itself as the underlying notes change. Every section (Today/Overdue/Due this week/Recent time entries) starts folded, so opening the note shows a compact summary; click a section's heading to expand it. The Time tracker heading has its own **+** button that quick-creates a Task/Reminder/Event/Meeting via the same editor the calendar uses; a "What are you working on?" field, client dropdown, a second **+** (list icon) for logging a finished session you forgot to time — opening a small dialog for description, client, date and start/end time — and a Start button track time inline without opening the Time tab, and recent past entries fold out below with a continue button per row.

## Usage

1. Install and enable Wiki Companion (see below).
2. Open the calendar (compass icon, or command palette: **Open calendar**). A **Month/Week/Day** dropdown switches views; the arrows and **Today** move by whatever unit is showing. In Month view, click a day to see its agenda — drag the thin handle between the calendar and the agenda to resize it, or use the panel icon to collapse it entirely. Week and Day views trade the agenda for an hourly grid with a red current-time line instead (set **Calendar timezone** in settings to see times in a zone other than the device's own) -- it already shows each day's items in full, so the agenda panel isn't offered alongside it.
3. Open the task board (checklist icon, or **Open task board**), reminders (bell icon, or **Open reminders**), Finance (wallet icon, or **Open finance**), or the time tracker (timer icon, or **Open time tracker**).
4. **New item** (command palette) opens the shared editor from anywhere, without opening a view first — handy on mobile.
5. Settings → Community plugins → Wiki Companion, grouped under **General** (confirming before delete, **Notify when something starts** -- an optional desktop notification when a timed item's start arrives; advance reminders are set per item instead, via the "Remind" field in the New/Edit item editor, and cover 9am the same day or 1 day/1 week/1 month before), **Time tracking** (a daily goal, rounding, which day the week starts on), **Calendar** (a timezone override) and **Invoicing** (your own business and payment details used when generating an invoice).

## Installation

**From within Obsidian**: Settings → Community plugins → Browse → search "Wiki Companion" → Install → Enable.

**Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) and place them in `<your vault>/.obsidian/plugins/wiki-companion/`, then enable the plugin under Settings → Community plugins.

## Bases (optional)

Wiki Companion's own views (calendar, task board, reminders, Finance, time log) work as soon as you enable the plugin — they read tags and frontmatter directly, and need no setup beyond that.

If you also use Obsidian's core **Bases** plugin, you may want native table views over the same tagged notes (sortable columns, filtering by client, and so on) alongside Wiki Companion's views. Wiki Companion doesn't ship any `.base` files — they're a separate, optional layer, and Bases' own format may change over time — but a simple one is quick to build yourself: **Create new Base**, then filter on `tags.contains("task")` (or `"reminder"`, `"meeting"`, `"event"`, `"invoice"`, `"time"`) and add whichever columns you want (`date`, `status`, `client`, `duration`, and so on).

## Roadmap

Wiki Companion is being developed incrementally. The calendar (Month/Week/Day, drag-to-reschedule, drag-to-resize, double-click-to-create, repeating events with per-occurrence edit/skip/delete), task board, reminders, Finance (Subscriptions/Expenses/Income), time tracker and a Daily Note summary embed are all built, with editing and delete throughout. On phone-sized screens, layouts that would otherwise sit side by side (the calendar's grid + agenda, the task board's Kanban columns) stack vertically, and list rows/buttons get more room rather than being squeezed onto one line. From here, the focus is on refining these existing views rather than adding new ones.

## License

MIT — see [LICENSE](LICENSE).
