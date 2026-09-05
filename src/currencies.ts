// Every active ISO 4217 currency Companion lets a Subscription/Expense/
// Income entry or an Invoice be denominated in -- added 2 September 2026 at
// Mo's request ("this is a public tool that may be downloaded by people
// from all over the world"), after a currency-migration snag revealed cost
// was GBP-only with no way to say otherwise. Source: the active-currency
// table from Wikipedia's ISO 4217 article (see the 1.31.0 changelog entry
// in Companion.md for the exact source), plus BGN (Bulgarian Lev), which
// that table happened to omit. Deliberately excludes non-transactable
// codes like XDR (IMF Special Drawing Rights) and precious-metal codes
// (XAU/XAG/XPT/XPD) -- nobody invoices a client in those.
export interface Currency {
	code: string; // ISO 4217, e.g. "GBP"
	name: string;
}

export const DEFAULT_CURRENCY = "GBP";

export const CURRENCIES: Currency[] = [
	{ code: "AED", name: "UAE Dirham" },
	{ code: "AFN", name: "Afghani" },
	{ code: "ALL", name: "Lek" },
	{ code: "AMD", name: "Armenian Dram" },
	{ code: "AOA", name: "Kwanza" },
	{ code: "ARS", name: "Argentine Peso" },
	{ code: "AUD", name: "Australian Dollar" },
	{ code: "AWG", name: "Aruban Florin" },
	{ code: "AZN", name: "Azerbaijan Manat" },
	{ code: "BAM", name: "Convertible Mark" },
	{ code: "BBD", name: "Barbados Dollar" },
	{ code: "BDT", name: "Taka" },
	{ code: "BGN", name: "Bulgarian Lev" },
	{ code: "BHD", name: "Bahraini Dinar" },
	{ code: "BIF", name: "Burundi Franc" },
	{ code: "BMD", name: "Bermudian Dollar" },
	{ code: "BND", name: "Brunei Dollar" },
	{ code: "BOB", name: "Boliviano" },
	{ code: "BRL", name: "Brazilian Real" },
	{ code: "BSD", name: "Bahamian Dollar" },
	{ code: "BTN", name: "Ngultrum" },
	{ code: "BWP", name: "Pula" },
	{ code: "BYN", name: "Belarusian Ruble" },
	{ code: "BZD", name: "Belize Dollar" },
	{ code: "CAD", name: "Canadian Dollar" },
	{ code: "CDF", name: "Congolese Franc" },
	{ code: "CHF", name: "Swiss Franc" },
	{ code: "CLP", name: "Chilean Peso" },
	{ code: "CNY", name: "Yuan Renminbi" },
	{ code: "COP", name: "Colombian Peso" },
	{ code: "CRC", name: "Costa Rican Colon" },
	{ code: "CUP", name: "Cuban Peso" },
	{ code: "CZK", name: "Czech Koruna" },
	{ code: "DJF", name: "Djibouti Franc" },
	{ code: "DKK", name: "Danish Krone" },
	{ code: "DOP", name: "Dominican Peso" },
	{ code: "DZD", name: "Algerian Dinar" },
	{ code: "EGP", name: "Egyptian Pound" },
	{ code: "ERN", name: "Nakfa" },
	{ code: "ETB", name: "Ethiopian Birr" },
	{ code: "EUR", name: "Euro" },
	{ code: "FJD", name: "Fiji Dollar" },
	{ code: "FKP", name: "Falkland Islands Pound" },
	{ code: "GBP", name: "Pound Sterling" },
	{ code: "GEL", name: "Lari" },
	{ code: "GHS", name: "Ghana Cedi" },
	{ code: "GIP", name: "Gibraltar Pound" },
	{ code: "GMD", name: "Dalasi" },
	{ code: "GNF", name: "Guinean Franc" },
	{ code: "GTQ", name: "Quetzal" },
	{ code: "GYD", name: "Guyana Dollar" },
	{ code: "HKD", name: "Hong Kong Dollar" },
	{ code: "HNL", name: "Lempira" },
	{ code: "HTG", name: "Gourde" },
	{ code: "HUF", name: "Forint" },
	{ code: "IDR", name: "Rupiah" },
	{ code: "ILS", name: "New Israeli Sheqel" },
	{ code: "INR", name: "Indian Rupee" },
	{ code: "IQD", name: "Iraqi Dinar" },
	{ code: "IRR", name: "Iranian Rial" },
	{ code: "ISK", name: "Iceland Krona" },
	{ code: "JMD", name: "Jamaican Dollar" },
	{ code: "JOD", name: "Jordanian Dinar" },
	{ code: "JPY", name: "Yen" },
	{ code: "KES", name: "Kenyan Shilling" },
	{ code: "KGS", name: "Som" },
	{ code: "KHR", name: "Riel" },
	{ code: "KMF", name: "Comorian Franc" },
	{ code: "KPW", name: "North Korean Won" },
	{ code: "KRW", name: "Won" },
	{ code: "KWD", name: "Kuwaiti Dinar" },
	{ code: "KYD", name: "Cayman Islands Dollar" },
	{ code: "KZT", name: "Tenge" },
	{ code: "LAK", name: "Lao Kip" },
	{ code: "LBP", name: "Lebanese Pound" },
	{ code: "LKR", name: "Sri Lanka Rupee" },
	{ code: "LRD", name: "Liberian Dollar" },
	{ code: "LSL", name: "Loti" },
	{ code: "LYD", name: "Libyan Dinar" },
	{ code: "MAD", name: "Moroccan Dirham" },
	{ code: "MDL", name: "Moldovan Leu" },
	{ code: "MGA", name: "Malagasy Ariary" },
	{ code: "MKD", name: "Denar" },
	{ code: "MMK", name: "Kyat" },
	{ code: "MNT", name: "Tugrik" },
	{ code: "MOP", name: "Pataca" },
	{ code: "MRU", name: "Ouguiya" },
	{ code: "MUR", name: "Mauritius Rupee" },
	{ code: "MVR", name: "Rufiyaa" },
	{ code: "MWK", name: "Malawi Kwacha" },
	{ code: "MXN", name: "Mexican Peso" },
	{ code: "MYR", name: "Malaysian Ringgit" },
	{ code: "MZN", name: "Mozambique Metical" },
	{ code: "NAD", name: "Namibia Dollar" },
	{ code: "NGN", name: "Naira" },
	{ code: "NIO", name: "Cordoba Oro" },
	{ code: "NOK", name: "Norwegian Krone" },
	{ code: "NPR", name: "Nepalese Rupee" },
	{ code: "NZD", name: "New Zealand Dollar" },
	{ code: "OMR", name: "Rial Omani" },
	{ code: "PAB", name: "Balboa" },
	{ code: "PEN", name: "Sol" },
	{ code: "PGK", name: "Kina" },
	{ code: "PHP", name: "Philippine Peso" },
	{ code: "PKR", name: "Pakistan Rupee" },
	{ code: "PLN", name: "Zloty" },
	{ code: "PYG", name: "Guarani" },
	{ code: "QAR", name: "Qatari Rial" },
	{ code: "RON", name: "Romanian Leu" },
	{ code: "RSD", name: "Serbian Dinar" },
	{ code: "RUB", name: "Russian Ruble" },
	{ code: "RWF", name: "Rwanda Franc" },
	{ code: "SAR", name: "Saudi Riyal" },
	{ code: "SBD", name: "Solomon Islands Dollar" },
	{ code: "SCR", name: "Seychelles Rupee" },
	{ code: "SDG", name: "Sudanese Pound" },
	{ code: "SEK", name: "Swedish Krona" },
	{ code: "SGD", name: "Singapore Dollar" },
	{ code: "SHP", name: "Saint Helena Pound" },
	{ code: "SLE", name: "Leone" },
	{ code: "SOS", name: "Somali Shilling" },
	{ code: "SRD", name: "Surinam Dollar" },
	{ code: "SSP", name: "South Sudanese Pound" },
	{ code: "STN", name: "Dobra" },
	{ code: "SVC", name: "El Salvador Colon" },
	{ code: "SYP", name: "Syrian Pound" },
	{ code: "SZL", name: "Lilangeni" },
	{ code: "THB", name: "Baht" },
	{ code: "TJS", name: "Somoni" },
	{ code: "TMT", name: "Turkmenistan New Manat" },
	{ code: "TND", name: "Tunisian Dinar" },
	{ code: "TOP", name: "Pa'anga" },
	{ code: "TRY", name: "Turkish Lira" },
	{ code: "TTD", name: "Trinidad and Tobago Dollar" },
	{ code: "TWD", name: "New Taiwan Dollar" },
	{ code: "TZS", name: "Tanzanian Shilling" },
	{ code: "UAH", name: "Hryvnia" },
	{ code: "UGX", name: "Uganda Shilling" },
	{ code: "USD", name: "US Dollar" },
	{ code: "UYU", name: "Peso Uruguayo" },
	{ code: "UZS", name: "Uzbekistan Sum" },
	{ code: "VES", name: "Bolivar Soberano" },
	{ code: "VND", name: "Dong" },
	{ code: "VUV", name: "Vatu" },
	{ code: "WST", name: "Tala" },
	{ code: "XAF", name: "CFA Franc BEAC" },
	{ code: "XCD", name: "East Caribbean Dollar" },
	{ code: "XOF", name: "CFA Franc BCEAO" },
	{ code: "XPF", name: "CFP Franc" },
	{ code: "YER", name: "Yemeni Rial" },
	{ code: "ZAR", name: "Rand" },
	{ code: "ZMW", name: "Zambian Kwacha" },
	{ code: "ZWG", name: "Zimbabwe Gold" },
];

/** Cosmetic only -- decorates the currency picker's own label (e.g. "US
 * Dollar ($)") so a symbol Mo or a downstream user recognises is visible
 * while choosing. Never used to format a stored amount: most of these
 * symbols are shared by several currencies (every "$" below, for one), so
 * showing one next to a number the moment two currencies are in the same
 * list would be ambiguous -- see BARE_SYMBOL/formatMoney below, which
 * deliberately uses only three of these for actual amounts. */
const LABEL_SYMBOLS: Record<string, string> = {
	USD: "$", AUD: "$", CAD: "$", NZD: "$", HKD: "$", SGD: "$", BND: "$", BSD: "$", BBD: "$",
	BMD: "$", BZD: "$", FJD: "$", GYD: "$", JMD: "$", KYD: "$", LRD: "$", NAD: "$", SBD: "$",
	SRD: "$", TTD: "$", TWD: "$", XCD: "$", ZWG: "$",
	EUR: "€", GBP: "£", EGP: "£", FKP: "£", GIP: "£", SHP: "£", SSP: "£", SYP: "£", LBP: "£",
	JPY: "¥", CNY: "¥",
	INR: "₹", NPR: "₹", MUR: "₹", SCR: "₹", PKR: "₨", LKR: "₨",
	KRW: "₩", RUB: "₽", TRY: "₺", UAH: "₴", VND: "₫", PHP: "₱", NGN: "₦", THB: "฿",
	LAK: "₭", CRC: "₡", PYG: "₲", MNT: "₮", ILS: "₪", KZT: "₸", AZN: "₼", GEL: "₾",
	PLN: "zł", CZK: "Kč", HUF: "Ft", RON: "lei", BGN: "лв",
	SEK: "kr", NOK: "kr", DKK: "kr", ISK: "kr",
	ZAR: "R", BRL: "R$", MXN: "$",
	ARS: "$", CLP: "$", COP: "$", UYU: "$", CUP: "$",
	PEN: "S/", BOB: "Bs", PAB: "B/.", VES: "Bs", NIO: "C$", GTQ: "Q", HNL: "L", DOP: "RD$",
	IDR: "Rp", MYR: "RM", BDT: "৳", KHR: "៛", MMK: "K",
	SAR: "﷼", QAR: "﷼", OMR: "﷼", YER: "﷼",
	AED: "د.إ", KWD: "د.ك", BHD: ".د.ب", JOD: "د.ا", IQD: "ع.د",
	MAD: "د.م.", DZD: "د.ج", TND: "د.ت", LYD: "ل.د",
	ETB: "Br", KES: "KSh", TZS: "TSh", UGX: "USh", GHS: "₵",
	XOF: "CFA", XAF: "FCFA", XPF: "₣",
};

/** All currencies, sorted by ISO code -- how every currency dropdown in the
 * plugin lists them. Sorted by code rather than full name (as it was before
 * `1.33.2` shortened currencyLabel() below to just the code) since the name
 * isn't shown any more, so a name-ordered list would no longer read as
 * alphabetical to whoever's actually looking at it. */
export function sortedCurrencies(): Currency[] {
	return [...CURRENCIES].sort((a, b) => a.code.localeCompare(b.code));
}

/** A currency dropdown option's label -- just "GBP (£)", or the bare code
 * for a currency with no well-known symbol. Mo's own call, `1.33.2`: the
 * full currency name ("Pound Sterling (£) — GBP") made this select's
 * rendered width a big part of why the New/Edit item modal could overflow
 * a phone screen -- three letters and a symbol is enough to pick the right
 * one. */
export function currencyLabel(code: string): string {
	const symbol = LABEL_SYMBOLS[code];
	return symbol ? `${code} (${symbol})` : code;
}

// The only three currencies an amount is ever shown with a bare symbol --
// Mo's own currency plus the two others common and unambiguous enough to
// read alone. Every other currency (USD very much included -- the dollar
// sign alone can't tell it apart from two dozen others above) prefixes its
// ISO code instead, so a Finance total or an invoice can never quietly
// conflate two different currencies that happen to share a symbol.
const BARE_SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", JPY: "¥" };

/** Formats a stored amount for display -- "£45.00" for GBP/EUR/JPY,
 * "USD 45.00" for everything else. The one place Finance renders money. */
export function formatMoney(code: string, amount: number): string {
	const bare = BARE_SYMBOL[code];
	return bare ? `${bare}${amount.toFixed(2)}` : `${code} ${amount.toFixed(2)}`;
}

/** Same prefix, for writing straight into an invoice note's own body text
 * (the "TOTAL COST"/"Total Due" columns) -- kept as its own function
 * rather than reused from formatMoney since invoice amounts are written
 * once into markdown, not re-rendered from a stored number the way
 * Finance's totals are. */
export function invoicePrefix(code: string): string {
	return BARE_SYMBOL[code] ?? `${code} `;
}

// Reverses invoicePrefix() for invoices already on disk -- old ones from
// before this change only ever have a literal "£" or "$" written (the
// two options the invoice generator used to offer; "$" always meant USD),
// so those two need mapping by hand rather than a straight symbol lookup.
const REVERSE_BARE: Record<string, string> = { "£": "GBP", "€": "EUR", "¥": "JPY", $: "USD" };

/** Recovers a currency code from whatever marker is actually stored on a
 * CompanionInvoice (see data.ts) -- a bare symbol from before this change,
 * or an invoicePrefix() string ("USD ", "SEK ", ...) from after it. Used
 * to bucket invoice totals by currency without mistaking two differently-
 * written invoices in the same currency for two different ones. */
export function codeForInvoiceMarker(marker: string): string {
	const trimmed = marker.trim();
	if (REVERSE_BARE[trimmed]) return REVERSE_BARE[trimmed];
	if (CURRENCIES.some((c) => c.code === trimmed)) return trimmed;
	return trimmed || DEFAULT_CURRENCY;
}
