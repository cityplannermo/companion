import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type CompanionPlugin from "./main";

/** Companion's plugin-level settings -- personal preferences about how Mo
 * wants the views to behave, as opposed to vault content (which always
 * lives in notes, never here). Stored through Obsidian's own plugin data
 * file (loadData/saveData), not a vault note. */
export interface CompanionSettings {
	dailyGoalHours: number; // 0 -- no goal set, goal/streak UI stays hidden
	roundingMinutes: "0" | "15" | "30" | "60"; // rounds a stopped entry's duration UP to this increment; "0" = off
	confirmBeforeDelete: boolean; // ask before moving a note to trash; off keeps the immediate-delete behaviour
	weekStartsOn: "monday" | "sunday"; // which day starts the Time view's weekly total
	agendaWidthPx: number; // drag-resized width of the calendar's agenda sidebar -- not surfaced in this tab, just persisted
	agendaCollapsed: boolean; // calendar's agenda sidebar hidden via its own collapse button -- not surfaced in this tab, just persisted
	calendarTimezone: string; // IANA zone name (e.g. "Europe/London"); blank = use this device's own timezone
	dueNotifications: boolean; // fire a desktop notification when a timed Reminder/Task/Event/Meeting starts; off by default
	notifyDayBefore: boolean; // also notify 1 day ahead of a dated Reminder/Task/Event/Meeting -- off by default
	notifyWeekBefore: boolean; // also notify 1 week ahead -- off by default
	notifyMonthBefore: boolean; // also notify 1 month (30 days) ahead -- off by default

	// Invoicing -- Mo's own details are constant across every invoice, so
	// they live here rather than being retyped (or copied off a previous
	// invoice) each time. A client's own billing details live on their
	// hub note instead, since those genuinely vary per client.
	myName: string;
	myAddress: string;
	myEmail: string;
	myPhone: string;
	paymentMethod: string;
	bankName: string;
	bankAccountName: string;
	bankAccountNumber: string; // may deliberately be a placeholder ("see banking details in Pass") rather than the real number
	bankSortCode: string;
}

export const DEFAULT_SETTINGS: CompanionSettings = {
	dailyGoalHours: 0,
	roundingMinutes: "0",
	confirmBeforeDelete: false,
	weekStartsOn: "monday",
	agendaWidthPx: 230,
	agendaCollapsed: false,
	calendarTimezone: "",
	dueNotifications: false,
	notifyDayBefore: false,
	notifyWeekBefore: false,
	notifyMonthBefore: false,

	myName: "",
	myAddress: "",
	myEmail: "",
	myPhone: "",
	paymentMethod: "",
	bankName: "",
	bankAccountName: "",
	bankAccountNumber: "",
	bankSortCode: "",
};

// A dropdown of every IANA zone name, built from the runtime's own
// Intl.supportedValuesOf -- Chromium/Electron has shipped it since 2022,
// comfortably within what Obsidian's minAppVersion here needs, but the
// feature-check still falls back to a free-text field on an older runtime
// rather than throwing. Computed once at module load, not per render --
// the list can't change while the plugin is running.
function timezoneOptions(): Record<string, string> | null {
	const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
	if (typeof supportedValuesOf !== "function") return null;
	try {
		const zones = [...supportedValuesOf("timeZone")].sort((a, b) => a.localeCompare(b));
		const options: Record<string, string> = { "": "Device's own timezone" };
		for (const zone of zones) options[zone] = zone;
		return options;
	} catch {
		return null;
	}
}

const TIMEZONE_OPTIONS = timezoneOptions();

const ROUNDING_OPTIONS: Record<string, string> = {
	"0": "Off",
	"15": "Round up to 15 minutes",
	"30": "Round up to 30 minutes",
	"60": "Round up to the hour",
};

const WEEK_START_OPTIONS: Record<string, string> = {
	monday: "Monday",
	sunday: "Sunday",
};

export class CompanionSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: CompanionPlugin
	) {
		super(app, plugin);
	}

	/** Declarative settings API (Obsidian 1.13.0+) -- makes these settings
	 * render natively and show up in the main Settings window's search.
	 * display() below is kept only as a fallback for the pre-1.13.0
	 * versions minAppVersion still supports; Obsidian skips it entirely
	 * once this returns a non-empty array. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Daily time goal (hours)",
				desc: "Shows today's progress and a day-streak in the Time view once tracked hours reach this most days. Leave at 0 to turn it off.",
				control: {
					type: "number",
					key: "dailyGoalHours",
					placeholder: "e.g. 5",
					min: 0,
				},
			},
			{
				name: "Round time entries",
				desc: "Rounds each tracked entry's duration up to the chosen increment when you stop the timer.",
				control: {
					type: "dropdown",
					key: "roundingMinutes",
					options: ROUNDING_OPTIONS,
				},
			},
			{
				name: "Week starts on",
				desc: "Which day starts the Time view's weekly total.",
				control: {
					type: "dropdown",
					key: "weekStartsOn",
					options: WEEK_START_OPTIONS,
				},
			},
			{
				name: "Confirm before deleting",
				desc: "Ask before moving a note to trash from the calendar, tasks, reminders or time views. Off by default -- delete happens immediately.",
				control: {
					type: "toggle",
					key: "confirmBeforeDelete",
				},
			},
			{
				name: "Notify when something starts",
				desc: "Fires a desktop notification when a timed Reminder, Task, Event or Meeting's start time arrives. Off by default. All-day items (no specific time set) never notify.",
				control: {
					type: "toggle",
					key: "dueNotifications",
				},
			},
			{
				type: "group",
				heading: "Advance reminders",
				items: [
					{
						name: "Remind 1 day before",
						desc: "Also notify a day ahead of a dated Reminder, Task, Event or Meeting -- unlike \"Notify when something starts\" above, this works for all-day items too.",
						control: {
							type: "toggle",
							key: "notifyDayBefore",
						},
					},
					{
						name: "Remind 1 week before",
						desc: "Also notify a week ahead.",
						control: {
							type: "toggle",
							key: "notifyWeekBefore",
						},
					},
					{
						name: "Remind 1 month before",
						desc: "Also notify a month (30 days) ahead -- handy for a yearly or biennial subscription renewal.",
						control: {
							type: "toggle",
							key: "notifyMonthBefore",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Calendar",
				items: [
					TIMEZONE_OPTIONS
						? {
								name: "Calendar timezone",
								desc: "The calendar's current-time line and GMT label use this zone instead of the device's own -- handy while travelling without changing the device's actual clock. \"Device's own timezone\" (the default) always follows wherever the device itself is set.",
								control: {
									type: "dropdown",
									key: "calendarTimezone",
									options: TIMEZONE_OPTIONS,
								},
							}
						: {
								name: "Calendar timezone",
								desc: "An IANA zone name (e.g. Europe/London) the calendar's current-time line and GMT label use instead of this device's own timezone -- handy while travelling without changing the device's actual clock. Leave blank to use the device's timezone.",
								control: {
									type: "text",
									key: "calendarTimezone",
									placeholder: "e.g. Europe/London",
								},
							},
				],
			},
			{
				type: "group",
				heading: "Invoicing",
				items: [
					{
						name: "My name (invoices)",
						desc: "Written into the header of every invoice Companion generates.",
						control: { type: "text", key: "myName", placeholder: "Your name" },
					},
					{
						name: "My address (invoices)",
						desc: "One line, as it should appear under your name on an invoice.",
						control: { type: "text", key: "myAddress", placeholder: "Your business address" },
					},
					{
						name: "My email (invoices)",
						desc: "",
						control: { type: "text", key: "myEmail", placeholder: "you@example.com" },
					},
					{
						name: "My phone (invoices)",
						desc: "",
						control: { type: "text", key: "myPhone", placeholder: "Your phone number" },
					},
					{
						name: "Payment method",
						desc: "Shown as \"Payment is due via **<this>**\" on every invoice.",
						control: { type: "text", key: "paymentMethod", placeholder: "e.g. Bank Transfer" },
					},
					{
						name: "Bank name",
						desc: "",
						control: { type: "text", key: "bankName", placeholder: "Your bank" },
					},
					{
						name: "Bank account name",
						desc: "",
						control: { type: "text", key: "bankAccountName", placeholder: "Name on the account" },
					},
					{
						name: "Bank account number",
						desc: "Shown verbatim on every invoice -- leave as a placeholder (e.g. \"see banking details in Pass\") if you'd rather not store the real number here.",
						control: { type: "text", key: "bankAccountNumber", placeholder: "Account number" },
					},
					{
						name: "Bank sort code",
						desc: "Same placeholder note as above applies.",
						control: { type: "text", key: "bankSortCode", placeholder: "Sort code" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		return this.plugin.saveSettings();
	}

	/**
	 * @deprecated Since Obsidian 1.13.0. Kept as a fallback so the tab
	 * still renders on the older Obsidian versions minAppVersion supports
	 * -- ignored automatically once getSettingDefinitions() is picked up.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Daily time goal (hours)")
			.setDesc(
				"Shows today's progress and a day-streak in the Time view once tracked hours reach this most days. Leave at 0 to turn it off."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. 5")
					.setValue(this.plugin.settings.dailyGoalHours ? String(this.plugin.settings.dailyGoalHours) : "")
					.onChange((value) => {
						const hours = parseFloat(value);
						this.plugin.settings.dailyGoalHours = isNaN(hours) || hours < 0 ? 0 : hours;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Round time entries")
			.setDesc("Rounds each tracked entry's duration up to the chosen increment when you stop the timer.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(ROUNDING_OPTIONS)
					.setValue(this.plugin.settings.roundingMinutes)
					.onChange((value) => {
						this.plugin.settings.roundingMinutes = value as CompanionSettings["roundingMinutes"];
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Confirm before deleting")
			.setDesc(
				"Ask before moving a note to trash from the calendar, tasks, reminders or time views. Off by default -- delete happens immediately."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmBeforeDelete).onChange((value) => {
					this.plugin.settings.confirmBeforeDelete = value;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Week starts on")
			.setDesc("Which day starts the Time view's weekly total.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(WEEK_START_OPTIONS)
					.setValue(this.plugin.settings.weekStartsOn)
					.onChange((value) => {
						this.plugin.settings.weekStartsOn = value as CompanionSettings["weekStartsOn"];
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Notify when something starts")
			.setDesc(
				"Fires a desktop notification when a timed Reminder, Task, Event or Meeting's start time arrives. Off by default. All-day items (no specific time set) never notify."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.dueNotifications).onChange((value) => {
					this.plugin.settings.dueNotifications = value;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Advance reminders").setHeading();

		new Setting(containerEl)
			.setName("Remind 1 day before")
			.setDesc(
				'Also notify a day ahead of a dated Reminder, Task, Event or Meeting -- unlike "Notify when something starts" above, this works for all-day items too.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.notifyDayBefore).onChange((value) => {
					this.plugin.settings.notifyDayBefore = value;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Remind 1 week before")
			.setDesc("Also notify a week ahead.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.notifyWeekBefore).onChange((value) => {
					this.plugin.settings.notifyWeekBefore = value;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Remind 1 month before")
			.setDesc("Also notify a month (30 days) ahead -- handy for a yearly or biennial subscription renewal.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.notifyMonthBefore).onChange((value) => {
					this.plugin.settings.notifyMonthBefore = value;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Calendar").setHeading();

		if (TIMEZONE_OPTIONS) {
			new Setting(containerEl)
				.setName("Calendar timezone")
				.setDesc(
					"The calendar's current-time line and GMT label use this zone instead of the device's own -- handy while travelling without changing the device's actual clock."
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOptions(TIMEZONE_OPTIONS)
						.setValue(this.plugin.settings.calendarTimezone)
						.onChange((value) => {
							this.plugin.settings.calendarTimezone = value;
							void this.plugin.saveSettings();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Calendar timezone")
				.setDesc(
					"An IANA zone name (e.g. Europe/London) the calendar's current-time line and GMT label use instead of this device's own timezone -- handy while travelling without changing the device's actual clock. Leave blank to use the device's timezone."
				)
				.addText((text) =>
					text
						.setPlaceholder("e.g. Europe/London")
						.setValue(this.plugin.settings.calendarTimezone)
						.onChange((value) => {
							this.plugin.settings.calendarTimezone = value.trim();
							void this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl).setName("Invoicing").setHeading();

		const invoiceField = (key: keyof CompanionSettings, name: string, desc: string, placeholder: string) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(String(this.plugin.settings[key]))
						.onChange((value) => {
							(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
							void this.plugin.saveSettings();
						})
				);
		};
		invoiceField("myName", "My name (invoices)", "Written into the header of every invoice Companion generates.", "Your name");
		invoiceField("myAddress", "My address (invoices)", "One line, as it should appear under your name on an invoice.", "Your business address");
		invoiceField("myEmail", "My email (invoices)", "", "you@example.com");
		invoiceField("myPhone", "My phone (invoices)", "", "Your phone number");
		invoiceField("paymentMethod", "Payment method", "Shown as \"Payment is due via **<this>**\" on every invoice.", "e.g. Bank Transfer");
		invoiceField("bankName", "Bank name", "", "Your bank");
		invoiceField("bankAccountName", "Bank account name", "", "Name on the account");
		invoiceField(
			"bankAccountNumber",
			"Bank account number",
			"Shown verbatim on every invoice -- leave as a placeholder if you'd rather not store the real number here.",
			"Account number"
		);
		invoiceField("bankSortCode", "Bank sort code", "Same placeholder note as above applies.", "Sort code");
	}
}
