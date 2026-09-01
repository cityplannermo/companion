import { App, Modal, Notice, TFile } from "obsidian";
import {
	ClientBillingInfo,
	InvoiceLineItem,
	PackageDefinition,
	createClientNote,
	generateInvoice,
	getClientBillingInfo,
	getClientNames,
	getClientRate,
	getLatestInvoiceForClient,
	getPackages,
	groupTimeEntriesForInvoice,
	setClientBillingInfo,
} from "./data";
import type { CompanionSettings } from "./settings";
import { addDays, formatDate, parseDate } from "./dates";

const NEW_CLIENT_VALUE = "__new__";

/**
 * "Generate Invoice" -- two steps in one modal, re-rendered in place
 * rather than as two separate modals so Back doesn't lose anything typed.
 *
 * Step 1 (recipient): pick an existing client, or add a brand-new one on
 * the spot (creates its hub note from here) -- either way, the "To" block
 * comes from that client's own billing fields, editable right here rather
 * than requiring a trip to the note itself. A billing period also pulls
 * that client's tracked time in range, grouped and rounded exactly as
 * [[Invoice Create Procedure]] does by hand.
 *
 * Step 2 (line items): every row -- from tracked time, from a saved
 * package (see Admin/Packages/), or typed in manually -- is fully
 * editable and removable. Confirming creates the invoice note (Mo's own
 * header and payment details come from plugin settings, constant across
 * every invoice), a Chase Payment reminder, and trashes whichever Time
 * Entry notes fed a tracked-time row -- Mo confirmed billed entries don't
 * need to stick around.
 */
export class InvoiceGeneratorModal extends Modal {
	private step: "recipient" | "items" = "recipient";
	private client = "";
	private isNewClient = false;
	private billing: ClientBillingInfo = { billingName: "", address: "", email: "", phone: "" };
	private startStr = "";
	private endStr = "";
	private rate: number | null = null;
	private lineItems: InvoiceLineItem[] = [];
	private packages: PackageDefinition[] = [];
	private currencySymbol = "£";

	constructor(
		app: App,
		private settings: CompanionSettings,
		private onDone: (file: TFile) => void,
		initialClient?: string
	) {
		super(app);
		// Lets a caller that already knows the client (the Time view's
		// Unbilled report, in particular) land straight on it pre-selected
		// -- renderRecipientStep's own syncMode() picks up rate/billing/last
		// invoice from here exactly as if it had been chosen by hand.
		if (initialClient) this.client = initialClient;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("companion-invoice-modal");

		if (this.step === "recipient") {
			this.renderRecipientStep(contentEl);
		} else {
			this.renderItemsStep(contentEl);
		}
	}

	private fieldRow(parent: HTMLElement, label: string, placeholder = ""): HTMLInputElement {
		const row = parent.createDiv({ cls: "companion-invoice-field-row" });
		row.createEl("label", { text: label });
		return row.createEl("input", { attr: { type: "text", placeholder } });
	}

	private renderRecipientStep(contentEl: HTMLElement): void {
		contentEl.createEl("h3", { text: "Generate invoice" });

		const clientRow = contentEl.createDiv({ cls: "companion-event-editor-client-row" });
		clientRow.createEl("label", { text: "Client" });
		const clientSelect = clientRow.createEl("select");
		clientSelect.createEl("option", { text: "Choose a client…", value: "" });
		for (const name of getClientNames(this.app)) {
			const opt = clientSelect.createEl("option", { text: name, value: name });
			if (name === this.client && !this.isNewClient) opt.selected = true;
		}
		clientSelect.createEl("option", { text: "+ New client / recipient…", value: NEW_CLIENT_VALUE });
		if (this.isNewClient) clientSelect.value = NEW_CLIENT_VALUE;

		// -- existing-client billing fields (prefilled, editable) --
		const billingFieldset = contentEl.createDiv({ cls: "companion-invoice-fieldset" });
		const billingNameInput = this.fieldRow(billingFieldset, "Billing name");
		const addressInput = this.fieldRow(billingFieldset, "Address");
		const emailInput = this.fieldRow(billingFieldset, "Email");
		const phoneInput = this.fieldRow(billingFieldset, "Phone");

		// -- new-client fields --
		const newClientFieldset = contentEl.createDiv({ cls: "companion-invoice-fieldset" });
		const newNameInput = this.fieldRow(newClientFieldset, "Name", "As it should appear in the wiki");
		const newBillingNameInput = this.fieldRow(newClientFieldset, "Billing name", "Defaults to Name if left blank");
		const newAddressInput = this.fieldRow(newClientFieldset, "Address");
		const newEmailInput = this.fieldRow(newClientFieldset, "Email");
		const newPhoneInput = this.fieldRow(newClientFieldset, "Phone");

		const datesRow = contentEl.createDiv({ cls: "companion-event-editor-times" });
		const startInput = datesRow.createEl("input", { attr: { type: "date", "aria-label": "Period start" } });
		startInput.value = this.startStr;
		datesRow.createSpan({ cls: "companion-quick-create-dash", text: "–" });
		const endInput = datesRow.createEl("input", { attr: { type: "date", "aria-label": "Period end" } });
		endInput.value = this.endStr || formatDate(new Date());

		const currencyRow = contentEl.createDiv({ cls: "companion-invoice-field-row" });
		currencyRow.createEl("label", { text: "Currency" });
		const currencySelect = currencyRow.createEl("select");
		currencySelect.createEl("option", { text: "£ (GBP)", value: "£" });
		currencySelect.createEl("option", { text: "$ (USD)", value: "$" });
		currencySelect.value = this.currencySymbol;

		const note = contentEl.createDiv({ cls: "companion-event-editor-type-locked" });

		const syncMode = () => {
			this.isNewClient = clientSelect.value === NEW_CLIENT_VALUE;
			newClientFieldset.toggleClass("companion-hidden", !this.isNewClient);
			billingFieldset.toggleClass("companion-hidden", this.isNewClient || !clientSelect.value);

			if (this.isNewClient) {
				note.setText("Fill in the new client's details below -- a hub note is created for them when you continue.");
				return;
			}
			if (!clientSelect.value) {
				note.setText("");
				return;
			}
			this.client = clientSelect.value;
			const info = getClientBillingInfo(this.app, this.client) ?? { billingName: "", address: "", email: "", phone: "" };
			billingNameInput.value = info.billingName;
			addressInput.value = info.address;
			emailInput.value = info.email;
			phoneInput.value = info.phone;

			this.rate = getClientRate(this.app, this.client);
			const previous = getLatestInvoiceForClient(this.app, this.client);
			if (previous && !startInput.value) {
				startInput.value = formatDate(addDays(parseDate(previous.dateStr), 1));
			}
			const rateNote = this.rate == null ? "No hourly rate set -- tracked-time rows will need a rate typed in per line." : `Rate: ${currencySelect.value}${this.rate}/hr.`;
			const prevNote = previous ? ` Last invoice: #${String(previous.number).padStart(3, "0")}, ${previous.dateStr}.` : "";
			note.setText(rateNote + prevNote);
		};
		clientSelect.onchange = syncMode;
		currencySelect.onchange = syncMode;
		syncMode();

		const controls = contentEl.createDiv({ cls: "companion-event-editor-controls" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const next = controls.createEl("button", { text: "Next", cls: "mod-cta" });
		next.onclick = () => {
			this.startStr = startInput.value;
			this.endStr = endInput.value || formatDate(new Date());
			this.currencySymbol = currencySelect.value;
			if (this.startStr && this.startStr > this.endStr) {
				new Notice("The period start is after its end.");
				return;
			}

			const proceed = (client: string, billing: ClientBillingInfo) => {
				this.client = client;
				this.billing = billing;
				this.packages = getPackages(this.app);
				const rows = this.startStr ? groupTimeEntriesForInvoice(this.app, client, this.startStr, this.endStr) : [];
				this.lineItems = rows.map((r) => ({
					date: r.date,
					hours: r.hours,
					description: r.description,
					rateLabel: this.rate != null ? `${this.currencySymbol}${this.rate}` : "",
					total: this.rate != null ? Math.round(r.hours * this.rate * 100) / 100 : 0,
					entries: r.entries,
				}));
				this.step = "items";
				this.render();
			};

			if (this.isNewClient) {
				const name = newNameInput.value.trim();
				if (!name) {
					new Notice("Enter the new client's name.");
					return;
				}
				const billing: ClientBillingInfo = {
					billingName: newBillingNameInput.value.trim() || name,
					address: newAddressInput.value.trim(),
					email: newEmailInput.value.trim(),
					phone: newPhoneInput.value.trim(),
				};
				next.disabled = true;
				createClientNote(this.app, name, billing).then(
					(file) => {
						this.rate = null;
						proceed(file.basename, billing);
					},
					(err: Error) => {
						new Notice(err.message);
						next.disabled = false;
					}
				);
				return;
			}

			if (!this.client) {
				new Notice("Choose a client, or add a new one.");
				return;
			}
			const billing: ClientBillingInfo = {
				billingName: billingNameInput.value.trim(),
				address: addressInput.value.trim(),
				email: emailInput.value.trim(),
				phone: phoneInput.value.trim(),
			};
			next.disabled = true;
			setClientBillingInfo(this.app, this.client, billing).then(
				() => proceed(this.client, billing),
				(err: Error) => {
					new Notice(err.message);
					next.disabled = false;
				}
			);
		};
	}

	private renderItemsStep(contentEl: HTMLElement): void {
		contentEl.createEl("h3", { text: `Generate invoice — ${this.client}` });
		const periodLabel = this.startStr ? `${this.startStr} to ${this.endStr}` : "no billing period set";
		contentEl.createDiv({
			cls: "companion-event-editor-type-locked",
			text: `${periodLabel}. Edit any row, or add a package or a manual line, before generating.`,
		});

		const table = contentEl.createDiv({ cls: "companion-invoice-review-table" });
		this.renderRows(table);
		if (this.lineItems.length === 0) {
			table.createDiv({ cls: "companion-empty", text: "No line items yet -- add a package or a manual line below." });
		}

		const addRow = contentEl.createDiv({ cls: "companion-invoice-add-row" });
		const pkgSelect = addRow.createEl("select");
		pkgSelect.createEl("option", { text: "Choose a package…", value: "" });
		for (const pkg of this.packages) {
			pkgSelect.createEl("option", { text: `${pkg.name} — ${this.currencySymbol}${pkg.amount}`, value: pkg.file.path });
		}
		const addPkgBtn = addRow.createEl("button", { text: "+ Add package" });
		addPkgBtn.onclick = () => {
			const pkg = this.packages.find((p) => p.file.path === pkgSelect.value);
			if (!pkg) {
				new Notice("Choose a package first.");
				return;
			}
			this.lineItems.push({
				date: formatDate(new Date()),
				hours: pkg.hours,
				description: pkg.description,
				rateLabel: "Fixed",
				total: pkg.amount,
			});
			this.render();
		};
		const addLineBtn = addRow.createEl("button", { text: "+ Add line" });
		addLineBtn.onclick = () => {
			this.lineItems.push({
				date: formatDate(new Date()),
				hours: null,
				description: "",
				rateLabel: this.rate != null ? `${this.currencySymbol}${this.rate}` : "",
				total: 0,
			});
			this.render();
		};

		const totalEl = contentEl.createDiv({ cls: "companion-invoice-review-total" });
		this.updateTotal(totalEl);

		const controls = contentEl.createDiv({ cls: "companion-event-editor-controls" });
		const back = controls.createEl("button", { text: "Back" });
		back.onclick = () => {
			this.step = "recipient";
			this.render();
		};
		const create = controls.createEl("button", { text: "Generate", cls: "mod-cta" });
		create.onclick = () => {
			if (this.lineItems.length === 0) {
				new Notice("Add at least one line item.");
				return;
			}
			create.disabled = true;
			generateInvoice(this.app, {
				client: this.client,
				lineItems: this.lineItems,
				billing: this.billing,
				currencySymbol: this.currencySymbol,
				myDetails: {
					name: this.settings.myName,
					address: this.settings.myAddress,
					email: this.settings.myEmail,
					phone: this.settings.myPhone,
				},
				payment: {
					method: this.settings.paymentMethod,
					bankName: this.settings.bankName,
					accountName: this.settings.bankAccountName,
					accountNumber: this.settings.bankAccountNumber,
					sortCode: this.settings.bankSortCode,
				},
			}).then(
				(file) => {
					this.close();
					this.onDone(file);
				},
				(err: Error) => {
					new Notice(err.message);
					create.disabled = false;
				}
			);
		};
	}

	private renderRows(table: HTMLElement): void {
		table.empty();
		this.lineItems.forEach((item, idx) => {
			const rowEl = table.createDiv({ cls: "companion-invoice-edit-row" });

			const dateInput = rowEl.createEl("input", {
				attr: { type: "date" },
				cls: "companion-invoice-cell-date",
			});
			dateInput.value = item.date;
			dateInput.onchange = () => {
				item.date = dateInput.value;
			};

			const hoursInput = rowEl.createEl("input", {
				attr: { type: "number", step: "0.5", placeholder: "—" },
				cls: "companion-invoice-cell-hours",
			});
			hoursInput.value = item.hours != null ? String(item.hours) : "";

			const descInput = rowEl.createEl("input", {
				attr: { type: "text", placeholder: "Description" },
				cls: "companion-invoice-cell-desc",
			});
			descInput.value = item.description;
			descInput.oninput = () => {
				item.description = descInput.value;
			};

			const rateInput = rowEl.createEl("input", {
				attr: { type: "text", placeholder: `${this.currencySymbol}/hr or Fixed` },
				cls: "companion-invoice-cell-rate",
			});
			rateInput.value = item.rateLabel;

			const totalInput = rowEl.createEl("input", {
				attr: { type: "number", step: "0.01" },
				cls: "companion-invoice-cell-total",
			});
			totalInput.value = item.total.toFixed(2);
			totalInput.oninput = () => {
				item.total = Number(totalInput.value) || 0;
				this.updateTotal();
			};

			// Editing hours or the rate label recomputes the total automatically
			// when the rate label carries a plain number (e.g. "£10") -- a
			// package's "Fixed" label, or free text, is left for Mo to total
			// himself via the Total field directly.
			const recompute = () => {
				if (item.hours == null) return;
				const m = item.rateLabel.match(/[\d.]+/);
				if (!m) return;
				const rate = parseFloat(m[0]);
				if (isNaN(rate)) return;
				item.total = Math.round(item.hours * rate * 100) / 100;
				totalInput.value = item.total.toFixed(2);
				this.updateTotal();
			};
			hoursInput.oninput = () => {
				item.hours = hoursInput.value ? Number(hoursInput.value) : null;
				recompute();
			};
			rateInput.oninput = () => {
				item.rateLabel = rateInput.value;
				recompute();
			};

			const removeBtn = rowEl.createEl("button", { text: "✕", cls: "companion-icon-btn" });
			removeBtn.onclick = () => {
				this.lineItems.splice(idx, 1);
				this.render();
			};
		});
	}

	private updateTotal(totalEl?: HTMLElement): void {
		const el = totalEl ?? this.contentEl.querySelector<HTMLElement>(".companion-invoice-review-total");
		if (!el) return;
		const hours = this.lineItems.reduce((s, r) => s + (r.hours ?? 0), 0);
		const total = this.lineItems.reduce((s, r) => s + r.total, 0);
		el.setText(`Total: ${hours.toFixed(1)}h — ${this.currencySymbol}${total.toFixed(2)}`);
	}
}
