import { App, Modal } from "obsidian";
import { getClientNames, recurLabel, remindLeadLabel } from "./data";
import type { CompanionEventType, QuickCreateType, RecurKind, RemindLead } from "./data";

const RECUR_OPTIONS: { value: RecurKind | ""; label: string }[] = [
	{ value: "", label: "Never" },
	{ value: "daily", label: recurLabel("daily") },
	{ value: "weekly", label: recurLabel("weekly") },
	{ value: "monthly", label: recurLabel("monthly") },
	{ value: "yearly", label: recurLabel("yearly") },
	{ value: "biennial", label: recurLabel("biennial") },
];

const REMIND_OPTIONS: { value: RemindLead | ""; label: string }[] = [
	{ value: "", label: "None" },
	{ value: "9am", label: remindLeadLabel("9am") },
	{ value: "1d", label: remindLeadLabel("1d") },
	{ value: "1w", label: remindLeadLabel("1w") },
	{ value: "1m", label: remindLeadLabel("1m") },
];

// "Subscription" and "Invoice reminder" aren't real note types -- both are
// still written as an ordinary Reminder (see DropdownValue/resolveType
// below) -- they're here so the two most common *kinds* of Reminder are a
// direct dropdown choice instead of "pick Reminder, then remember to also
// set Repeat and Cost yourself". A Subscription is a Reminder with a cost;
// an Invoice reminder is a Reminder that just borrows the Invoice pill
// colour on the calendar, as a nudge to go generate the real invoice that
// day through the Invoice Create Procedure -- it never creates one itself.
type DropdownValue = QuickCreateType | "subscription" | "invoiceReminder" | "income";

const TYPE_OPTIONS: { value: DropdownValue; label: string }[] = [
	{ value: "meeting", label: "Meeting" },
	{ value: "event", label: "Event" },
	{ value: "reminder", label: "Reminder" },
	{ value: "subscription", label: "Subscription" },
	{ value: "invoiceReminder", label: "Invoice reminder" },
	{ value: "income", label: "Income" },
	{ value: "task", label: "Task" },
	{ value: "post", label: "Post" },
];

/** A Reminder written with a repeat rule and a cost is a subscription; one
 * written with a repeat rule and this flag just wants the Invoice pill
 * colour on the calendar -- see the DropdownValue comment above. */
function resolveType(value: DropdownValue): QuickCreateType {
	return value === "subscription" || value === "invoiceReminder" || value === "income" ? "reminder" : value;
}

/** The dropdown option that best represents an existing item's current
 * shape, for pre-selecting it when editing (or defaulting a new one). */
function dropdownValueFor(type: CompanionEventType, recur?: RecurKind, cost?: number, invoiceReminder?: boolean, income?: boolean): DropdownValue {
	if (type === "invoice" || type === "post") return "reminder"; // unreachable in practice -- this modal is never opened for an Invoice (see isInvoice above) or a Post (see CompanionEventType's comment)
	if (type !== "reminder") return type;
	if (invoiceReminder) return "invoiceReminder";
	if (income) return "income";
	if (recur && cost != null) return "subscription";
	return "reminder";
}

/** Everything the modal hands back on submit. `type` is always one of the
 * four convertible types -- an Invoice being edited keeps its own type
 * locked (see isInvoice below), so it never reaches this shape at all. */
export interface EventEditorResult {
	title: string;
	type: QuickCreateType;
	date: string; // "YYYY-MM-DD"
	allDay: boolean;
	startTime: string; // "HH:MM", meaningful only when !allDay
	endTime?: string; // "HH:MM", optional even when timed
	client: string; // only meaningful when type === "meeting"; "" otherwise
	recur: RecurKind | null; // null = doesn't repeat
	remind: RemindLead | null; // null = no advance reminder
	cost: number | null; // only meaningful when type === "reminder"; null = not a subscription
	invoiceReminder: boolean; // only meaningful when type === "reminder" -- see DropdownValue above
	income: boolean; // only meaningful when type === "reminder" -- flips the direction from an outgoing cost to incoming money
}

export interface EventEditorInitial {
	title: string;
	type: CompanionEventType; // may be "invoice" for an existing Invoice being edited
	date: string; // "YYYY-MM-DD" -- the day this item is (or will be) dated to
	timeStr: string; // "00:00" = all-day/no time
	endTimeStr?: string;
	client?: string;
	recur?: RecurKind; // absent/undefined = doesn't repeat
	remind?: RemindLead; // absent/undefined = no advance reminder
	cost?: number; // meaningful only when type === "reminder"
	invoiceReminder?: boolean; // meaningful only when type === "reminder"
	income?: boolean; // meaningful only when type === "reminder"
}

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

/**
 * One modal for both creating a new item and editing an existing one --
 * title, type (Meeting/Event/Reminder/Task), a client field shown only for
 * Meeting, a date field, start/end time, and an "All day" checkbox.
 * Replaces the old separate "+ Reminder"/"+ Task"/"+ Event" buttons and the
 * inline rename field: one place to set everything a quick-created note
 * needs, and one place to fix any of it afterwards without opening the
 * note itself. The date field matters even when a caller already knows a
 * day (e.g. the Calendar's own double-click-a-slot) since it's still the
 * one place to change it before creating -- callers with no day context of
 * their own (Finance's "+ Subscription", the "New item" command) default it
 * to today and let this field be the only way to pick a different one.
 *
 * Invoices are the one type this modal won't create or convert to/from --
 * they need the full Invoice Create Procedure (line items, banking
 * details, sequential numbering), which a form like this can't fill in
 * responsibly. Editing an *existing* Invoice's own title/date/end still
 * works; its type just shows as a locked label instead of a dropdown.
 */
export class EventEditorModal extends Modal {
	constructor(
		app: App,
		private mode: "create" | "edit",
		private initial: EventEditorInitial,
		private onSubmit: (result: EventEditorResult) => void,
		// Set when the caller already knows the type and it shouldn't be
		// changeable here -- e.g. the Finance tab's "+ Subscription", where
		// offering Meeting/Event/Task would just be a way to create the
		// wrong kind of note. Shows this text in place of the dropdown, the
		// same way an Invoice's type is locked below.
		private lockedTypeLabel?: string
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("companion-event-editor");
		contentEl.createEl("h3", { text: this.mode === "create" ? "New item" : "Edit item" });

		const titleInput = contentEl.createEl("input", {
			cls: "companion-event-editor-title",
			attr: { type: "text", placeholder: "Title…" },
		});
		titleInput.value = this.initial.title;

		const isInvoice = this.initial.type === "invoice";
		let typeSelect: HTMLSelectElement | null = null;
		if (isInvoice || this.lockedTypeLabel) {
			contentEl.createDiv({
				cls: "companion-event-editor-type-locked",
				text: isInvoice ? "Invoice — edited via the Invoice Create Procedure, not here." : this.lockedTypeLabel,
			});
		} else {
			const initialValue = dropdownValueFor(this.initial.type, this.initial.recur, this.initial.cost, this.initial.invoiceReminder, this.initial.income);
			typeSelect = contentEl.createEl("select", { cls: "companion-event-editor-type" });
			// Post is create-only -- offering it here would let switching an
			// existing Reminder/Event/Task/Meeting's dropdown to "Post" run it
			// through applyEventEdit() below, which retags and moves the note
			// into Content/Posts/ without ever writing the status/platform/
			// scheduled fields a real Post note needs (only createPostIdea in
			// data.ts does that). Excluded in edit mode for that reason.
			const options = this.mode === "edit" ? TYPE_OPTIONS.filter((opt) => opt.value !== "post") : TYPE_OPTIONS;
			for (const opt of options) {
				const el = typeSelect.createEl("option", { text: opt.label, value: opt.value });
				if (opt.value === initialValue) el.selected = true;
			}
		}

		const clientRow = contentEl.createDiv({ cls: "companion-event-editor-client-row" });
		const clientInput = clientRow.createEl("input", {
			attr: { type: "text", placeholder: "Client", list: "companion-event-editor-clients" },
		});
		clientInput.value = this.initial.client ?? "";
		const datalist = clientRow.createEl("datalist", { attr: { id: "companion-event-editor-clients" } });
		for (const name of getClientNames(this.app)) datalist.createEl("option", { attr: { value: name } });

		const syncClientVisibility = () => {
			const currentType = typeSelect?.value ?? this.initial.type;
			clientRow.toggleClass("companion-hidden", currentType !== "meeting");
		};
		syncClientVisibility();
		typeSelect?.addEventListener("change", syncClientVisibility);

		const recurRow = contentEl.createDiv({ cls: "companion-event-editor-recur-row" });
		recurRow.createSpan({ text: "Repeat: " });
		const recurSelect = recurRow.createEl("select");
		for (const opt of RECUR_OPTIONS) {
			const el = recurSelect.createEl("option", { text: opt.label, value: opt.value });
			if (opt.value === (this.initial.recur ?? "")) el.selected = true;
		}
		if (isInvoice) recurRow.addClass("companion-hidden");

		// Advance reminder -- an optional desktop notification ahead of this
		// item's own date, independent of "Notify when something starts"
		// (which only fires at the exact start time). Same visibility rule
		// as Repeat above: every real type gets one, an Invoice doesn't.
		const remindRow = contentEl.createDiv({ cls: "companion-event-editor-recur-row" });
		remindRow.createSpan({ text: "Remind: " });
		const remindSelect = remindRow.createEl("select");
		for (const opt of REMIND_OPTIONS) {
			const el = remindSelect.createEl("option", { text: opt.label, value: opt.value });
			if (opt.value === (this.initial.remind ?? "")) el.selected = true;
		}
		if (isInvoice) remindRow.addClass("companion-hidden");

		// Cost only means anything on a Reminder. Where the type dropdown is
		// genuinely a choice (the Calendar/Dashboard's own "New item"), it's
		// shown only for Subscription/Invoice reminder -- picking either of
		// those is already the signal that a cost is coming, so a plain
		// Reminder/Meeting/Event/Task keeps this dialog uncluttered. Where
		// there's no dropdown at all (Finance's own +Subscription/+Expense
		// buttons -- typeSelect is null, type locked to Reminder by design,
		// see openCreateCost() in FinanceView.ts), Cost is the whole point
		// of those buttons and always shows.
		const costRow = contentEl.createDiv({ cls: "companion-event-editor-recur-row" });
		costRow.createSpan({ text: "Cost (£/period): " });
		const costInput = costRow.createEl("input", { attr: { type: "number", min: "0", step: "0.01", placeholder: "Optional" } });
		costInput.value = this.initial.cost != null ? String(this.initial.cost) : "";
		const syncCostVisibility = () => {
			if (!typeSelect) {
				costRow.removeClass("companion-hidden");
				return;
			}
			// Also stays visible while editing an item that already has a cost
			// set (an existing Expense, say) even if its dropdown value reads
			// as plain "reminder" -- otherwise opening Edit on one through the
			// Calendar/agenda pencil (rather than Finance's own row) would hide
			// its cost from view entirely.
			const currentType = typeSelect.value;
			const relevant = currentType === "subscription" || currentType === "invoiceReminder" || currentType === "income" || costInput.value !== "";
			costRow.toggleClass("companion-hidden", !relevant);
		};
		syncCostVisibility();
		typeSelect?.addEventListener("change", syncCostVisibility);

		const dateInput = contentEl.createEl("input", {
			cls: "companion-event-editor-date",
			attr: { type: "date", "aria-label": "Date" },
		});
		dateInput.value = this.initial.date;

		const timesRow = contentEl.createDiv({ cls: "companion-event-editor-times" });
		const startInput = timesRow.createEl("input", { attr: { type: "time", "aria-label": "Starts at" } });
		timesRow.createSpan({ cls: "companion-quick-create-dash", text: "–" });
		const endInput = timesRow.createEl("input", { attr: { type: "time", "aria-label": "Ends at (optional)" } });
		startInput.value = this.initial.timeStr !== "00:00" ? this.initial.timeStr : "";
		endInput.value = this.initial.endTimeStr ?? "";

		// A brand-new item with a known start (from a double-clicked slot)
		// defaults to a 30-minute block straight away, rather than a
		// duration-less point nothing can be dragged to resize -- Mo's own
		// call once he found he couldn't resize or right-click-delete a
		// point event. Editing an *existing* item never does this
		// uninvited; its lack of an end stays respected until the user
		// adds one themselves.
		if (this.mode === "create" && startInput.value && !endInput.value) {
			endInput.value = minutesToHHMM(toMinutes(startInput.value) + 30);
		}

		// Once a start is set, suggest a 30-minute block as the end -- kept
		// in sync as the start changes, but only until the end field is
		// itself edited by hand, so a deliberately-chosen end never gets
		// silently overwritten. The create-mode default just set above
		// counts as not yet "touched" -- it should still track the start
		// field until the user deliberately changes the end themselves.
		let endTouched = this.mode === "edit" && endInput.value !== "";
		endInput.addEventListener("input", () => {
			endTouched = true;
		});
		startInput.addEventListener("input", () => {
			if (endTouched || !startInput.value) return;
			endInput.value = minutesToHHMM(toMinutes(startInput.value) + 30);
		});

		const allDayLabel = contentEl.createEl("label", { cls: "companion-quick-create-allday" });
		const allDayCheckbox = allDayLabel.createEl("input", { attr: { type: "checkbox" } });
		allDayCheckbox.checked = this.initial.timeStr === "00:00" && !this.initial.endTimeStr;
		allDayLabel.createSpan({ text: " All day" });
		const syncTimesDisabled = () => {
			startInput.disabled = allDayCheckbox.checked;
			endInput.disabled = allDayCheckbox.checked;
			timesRow.toggleClass("companion-disabled", allDayCheckbox.checked);
		};
		syncTimesDisabled();
		allDayCheckbox.onchange = syncTimesDisabled;

		// A Post note has none of Repeat/Remind/start-end times/All day -- its
		// only two dates are "date" (creation, set automatically) and this
		// modal's own date field, reused as the target "scheduled" date (see
		// createPostIdea in data.ts). Hide the fields that don't apply rather
		// than leave them showing and ignored.
		const syncPostVisibility = () => {
			if (isInvoice) return; // recur/remind are already permanently hidden above; no dropdown to change type anyway
			const isPost = typeSelect?.value === "post";
			recurRow.toggleClass("companion-hidden", isPost);
			remindRow.toggleClass("companion-hidden", isPost);
			timesRow.toggleClass("companion-hidden", isPost);
			allDayLabel.toggleClass("companion-hidden", isPost);
		};
		syncPostVisibility();
		typeSelect?.addEventListener("change", syncPostVisibility);

		let submitted = false;
		const submit = () => {
			if (submitted) return; // guards against Enter and the Save button both firing
			const title = titleInput.value.trim();
			if (!title) {
				titleInput.focus();
				return;
			}
			submitted = true;
			this.close();
			const allDay = allDayCheckbox.checked;
			const selected =
				(typeSelect?.value as DropdownValue | undefined) ??
				dropdownValueFor(this.initial.type, this.initial.recur, this.initial.cost, this.initial.invoiceReminder, this.initial.income);
			this.onSubmit({
				title,
				type: resolveType(selected),
				date: dateInput.value || this.initial.date,
				allDay,
				startTime: !allDay && startInput.value ? startInput.value : "00:00",
				endTime: !allDay && endInput.value ? endInput.value : undefined,
				client: clientInput.value,
				recur: (recurSelect.value || null) as RecurKind | null,
				remind: (remindSelect.value || null) as RemindLead | null,
				cost: costInput.value ? Number(costInput.value) : null,
				invoiceReminder: selected === "invoiceReminder",
				income: selected === "income",
			});
		};
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		for (const el of [titleInput, dateInput, startInput, endInput, clientInput, costInput]) {
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
				onEscape(e);
			});
		}

		const controls = contentEl.createDiv({ cls: "companion-event-editor-controls" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const save = controls.createEl("button", { text: this.mode === "create" ? "Create" : "Save", cls: "mod-cta" });
		save.onclick = submit;

		window.setTimeout(() => titleInput.focus());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
