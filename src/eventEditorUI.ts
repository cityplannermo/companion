import { App, Modal } from "obsidian";
import { getClientNames, recurLabel } from "./data";
import type { CompanionEventType, QuickCreateType, RecurKind } from "./data";

const RECUR_OPTIONS: { value: RecurKind | ""; label: string }[] = [
	{ value: "", label: "Never" },
	{ value: "daily", label: recurLabel("daily") },
	{ value: "weekly", label: recurLabel("weekly") },
	{ value: "monthly", label: recurLabel("monthly") },
	{ value: "yearly", label: recurLabel("yearly") },
];

const TYPE_OPTIONS: { value: QuickCreateType; label: string }[] = [
	{ value: "meeting", label: "Meeting" },
	{ value: "event", label: "Event" },
	{ value: "reminder", label: "Reminder" },
	{ value: "task", label: "Task" },
];

/** Everything the modal hands back on submit. `type` is always one of the
 * four convertible types -- an Invoice being edited keeps its own type
 * locked (see isInvoice below), so it never reaches this shape at all. */
export interface EventEditorResult {
	title: string;
	type: QuickCreateType;
	allDay: boolean;
	startTime: string; // "HH:MM", meaningful only when !allDay
	endTime?: string; // "HH:MM", optional even when timed
	client: string; // only meaningful when type === "meeting"; "" otherwise
	recur: RecurKind | null; // null = doesn't repeat
	cost: number | null; // only meaningful when type === "reminder"; null = not a subscription
}

export interface EventEditorInitial {
	title: string;
	type: CompanionEventType; // may be "invoice" for an existing Invoice being edited
	timeStr: string; // "00:00" = all-day/no time
	endTimeStr?: string;
	client?: string;
	recur?: RecurKind; // absent/undefined = doesn't repeat
	cost?: number; // meaningful only when type === "reminder"
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
 * Meeting, start/end time, and an "All day" checkbox. Replaces the old
 * separate "+ Reminder"/"+ Task"/"+ Event" buttons and the inline rename
 * field: one place to set everything a quick-created note needs, and one
 * place to fix any of it afterwards without opening the note itself.
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
		private onSubmit: (result: EventEditorResult) => void
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
		if (isInvoice) {
			contentEl.createDiv({
				cls: "companion-event-editor-type-locked",
				text: "Invoice — edited via the Invoice Create Procedure, not here.",
			});
		} else {
			typeSelect = contentEl.createEl("select", { cls: "companion-event-editor-type" });
			for (const opt of TYPE_OPTIONS) {
				const el = typeSelect.createEl("option", { text: opt.label, value: opt.value });
				if (opt.value === this.initial.type) el.selected = true;
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

		// Cost only means anything on a Reminder -- what makes one a
		// subscription, alongside Repeat, in the Reminders view's own
		// running total. Shown/hidden the same way the client row is.
		const costRow = contentEl.createDiv({ cls: "companion-event-editor-recur-row" });
		costRow.createSpan({ text: "Cost (£/period): " });
		const costInput = costRow.createEl("input", { attr: { type: "number", min: "0", step: "0.01", placeholder: "Optional" } });
		costInput.value = this.initial.cost != null ? String(this.initial.cost) : "";
		const syncCostVisibility = () => {
			const currentType = typeSelect?.value ?? this.initial.type;
			costRow.toggleClass("companion-hidden", currentType !== "reminder");
		};
		syncCostVisibility();
		typeSelect?.addEventListener("change", syncCostVisibility);

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
			this.onSubmit({
				title,
				type: (typeSelect?.value as QuickCreateType | undefined) ?? (this.initial.type as QuickCreateType),
				allDay,
				startTime: !allDay && startInput.value ? startInput.value : "00:00",
				endTime: !allDay && endInput.value ? endInput.value : undefined,
				client: clientInput.value,
				recur: (recurSelect.value || null) as RecurKind | null,
				cost: costInput.value ? Number(costInput.value) : null,
			});
		};
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		for (const el of [titleInput, startInput, endInput, clientInput, costInput]) {
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
