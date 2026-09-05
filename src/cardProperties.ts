import type { CompanionSettings } from "./settings";
import type { OverflowItem } from "./overflowMenu";

/** Every boolean setting a view can offer as a "Show X" toggle in its own
 * overflow menu -- Mo's own reference point, Notion's per-view "choose
 * which properties are shown." A display preference, never vault content,
 * so it lives in settings rather than on any note (see settings.ts's own
 * comment above these fields). Posts got the first version of this by hand
 * (1.33.2); every key below generalises the same idea to the rest of the
 * views (1.33.3, at Mo's own request: "should be available in all views
 * since every note has properties"). */
export type CardPropertyKey =
	| "postsShowCover"
	| "postsShowStatus"
	| "postsShowPlatform"
	| "postsShowDate"
	| "calendarShowClient"
	| "calendarShowCost"
	| "taskShowDate"
	| "taskShowPriority"
	| "taskShowChecklist"
	| "remindersShowCost"
	| "financeShowRowDate"
	| "timeShowClient"
	| "timeShowRepeatBadge";

export interface PropertyToggle {
	key: CardPropertyKey;
	label: string;
}

/** Flips one property-visibility setting, persists it, and re-renders --
 * the one action every "Show X" overflow-menu item performs. */
export function toggleCardProperty(
	settings: CompanionSettings,
	key: CardPropertyKey,
	persistSettings: () => Promise<void>,
	render: () => void
): void {
	settings[key] = !settings[key];
	void persistSettings();
	render();
}

/** Builds the overflow-menu items for a view's declared property toggles --
 * append these to whatever else that view already collapses into its own
 * "⋮" menu (see overflowMenu.ts). Each item's checkmark reflects the
 * current setting; clicking it calls toggleCardProperty() above. */
export function propertyVisibilityItems(
	settings: CompanionSettings,
	toggles: PropertyToggle[],
	persistSettings: () => Promise<void>,
	render: () => void
): OverflowItem[] {
	return toggles.map((t) => ({
		label: t.label,
		isActive: settings[t.key],
		onClick: () => toggleCardProperty(settings, t.key, persistSettings, render),
	}));
}
