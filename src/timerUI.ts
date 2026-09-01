import { App, Modal } from "obsidian";
import { getClientNames } from "./data";

/**
 * The "start a timer" prompt: description (required) and client
 * (optional, wrapped into a [[wikilink]] by startTimeEntry). Two fields,
 * so a small Modal rather than the single-title inline forms the other
 * quick-create flows use.
 */
export class StartTimerModal extends Modal {
	constructor(
		app: App,
		private onSubmit: (description: string, client: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Start timer" });

		// autocomplete="off" plus a distinct name each stops Chromium's own
		// remembered-values overlay (which otherwise pools with every other
		// unnamed text input in Obsidian) from mixing into the suggestions --
		// the client field's <datalist> below is unaffected either way, since
		// autocomplete only governs the browser's own autofill history.
		const descInput = contentEl.createEl("input", {
			cls: "companion-timer-input",
			attr: {
				type: "text",
				placeholder: "What are you working on?",
				name: "companion-timer-description",
				autocomplete: "off",
			},
		});
		const clientInput = contentEl.createEl("input", {
			cls: "companion-timer-input",
			attr: {
				type: "text",
				placeholder: "Client (optional)",
				name: "companion-timer-client",
				autocomplete: "off",
				list: "companion-client-list",
			},
		});
		const datalist = contentEl.createEl("datalist", { attr: { id: "companion-client-list" } });
		for (const name of getClientNames(this.app)) {
			datalist.createEl("option", { attr: { value: name } });
		}

		let submitted = false;
		const submit = () => {
			if (submitted) return;
			const description = descInput.value.trim();
			if (!description) {
				descInput.focus();
				return;
			}
			submitted = true;
			this.close();
			this.onSubmit(description, clientInput.value);
		};

		descInput.onkeydown = (e) => {
			if (e.key === "Enter") clientInput.focus();
		};
		clientInput.onkeydown = (e) => {
			if (e.key === "Enter") submit();
		};

		const controls = contentEl.createDiv({ cls: "companion-timer-controls" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const start = controls.createEl("button", { text: "Start", cls: "mod-cta" });
		start.onclick = submit;

		window.setTimeout(() => descInput.focus());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
