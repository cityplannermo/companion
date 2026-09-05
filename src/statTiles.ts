/** Shared "at a glance" stat tile row -- first built for Finance's own
 * overview grid, now reused by the Time tab's Report page (Mo's own request:
 * the same pattern should apply wherever a handful of headline numbers need
 * to sit above a list). One tile is a label over a value, optionally
 * coloured green/red when the sign is meaningful (a net figure) -- never for
 * a plain total, where colour would just be noise. */
export type StatTileTone = "positive" | "negative" | "neutral";

export function toneFor(net: number): StatTileTone {
	if (net > 0) return "positive";
	if (net < 0) return "negative";
	return "neutral";
}

export function addStatTile(grid: HTMLElement, label: string, value: string, tone: StatTileTone = "neutral"): void {
	const tile = grid.createDiv({ cls: "companion-stat-tile" });
	tile.createDiv({ cls: "companion-stat-tile-label", text: label });
	const valueEl = tile.createDiv({ cls: "companion-stat-tile-value", text: value });
	if (tone === "positive") valueEl.addClass("companion-stat-tile-positive");
	if (tone === "negative") valueEl.addClass("companion-stat-tile-negative");
}
