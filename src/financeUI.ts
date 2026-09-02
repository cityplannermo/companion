import { App, Modal } from "obsidian";
import { formatDate } from "./dates";

/**
 * The "+ Income" prompt in the Finance tab: source, amount, currency and
 * date for an ad hoc income note (see createOtherIncome in data.ts) --
 * deliberately no repeat/remind fields, unlike Subscriptions/Invoice
 * reminders. Both of those exist to give advance notice of something
 * still to come; an ad hoc income entry records money already received,
 * so there's nothing ahead of it to be reminded about, and a recurring
 * income source (say, a monthly platform payout) still gets logged one
 * entry at a time rather than auto-guessed -- the amount varies stream to
 * stream in a way a subscription's cost doesn't.
 */
export class AddIncomeModal extends Modal {
	constructor(
		app: App,
		private knownSources: string[],
		private onSubmit: (source: string, amount: number, currencySymbol: string, dateStr: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Add income" });

		const sourceInput = contentEl.createEl("input", {
			cls: "companion-timer-input",
			attr: {
				type: "text",
				placeholder: "Source (e.g. Twitch)",
				name: "companion-income-source",
				autocomplete: "off",
				list: "companion-income-source-list",
			},
		});
		const datalist = contentEl.createEl("datalist", { attr: { id: "companion-income-source-list" } });
		for (const name of this.knownSources) {
			datalist.createEl("option", { attr: { value: name } });
		}

		const amountRow = contentEl.createDiv({ cls: "companion-event-editor-recur-row" });
		amountRow.createSpan({ text: "Amount: " });
		const currencySelect = amountRow.createEl("select");
		for (const sym of ["£", "$"]) {
			currencySelect.createEl("option", { text: sym, value: sym });
		}
		const amountInput = amountRow.createEl("input", { attr: { type: "number", min: "0", step: "0.01", placeholder: "0.00" } });

		const dateInput = contentEl.createEl("input", {
			cls: "companion-event-editor-date",
			attr: { type: "date", "aria-label": "Date" },
		});
		dateInput.value = formatDate(new Date());

		let submitted = false;
		const submit = () => {
			if (submitted) return;
			const source = sourceInput.value.trim();
			const amount = Number(amountInput.value);
			if (!source || !(amount > 0) || !dateInput.value) return;
			submitted = true;
			this.close();
			this.onSubmit(source, amount, currencySelect.value, dateInput.value);
		};

		for (const el of [sourceInput, amountInput, dateInput]) {
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
			});
		}

		const controls = contentEl.createDiv({ cls: "companion-timer-controls" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const add = controls.createEl("button", { text: "Add", cls: "mod-cta" });
		add.onclick = submit;

		window.setTimeout(() => sourceInput.focus());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
