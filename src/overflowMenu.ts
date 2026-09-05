import { Menu, setIcon } from "obsidian";

/** One row in a header's mobile overflow menu -- see addOverflowMenu below. */
export interface OverflowItem {
	label: string;
	icon?: string;
	isActive?: boolean; // shows a checkmark, for a "which mode/sort is active" style item
	onClick: () => void;
}

/**
 * Appends a "⋮ more options" button to a header's controls row, wired to an
 * Obsidian Menu built from `items` -- the mobile fix for a header with too
 * many controls to fit one line (Mo's own request, 3 September 2026: round
 * icon buttons "sit awkwardly" and wrap onto extra lines on a phone).
 *
 * The button itself is hidden on desktop by CSS (`.companion-overflow-btn`
 * only shows under the mobile media query) -- it's additive, not a
 * replacement: each view still renders its normal controls, and hides just
 * the ones this menu duplicates on mobile via `.companion-mobile-hide`
 * (added by the caller to each control that has a menu-item equivalent
 * here). Call this even when `items` is empty; it simply renders nothing,
 * so a view with nothing worth collapsing (Finance's single "+") doesn't
 * need its own conditional.
 */
export function addOverflowMenu(container: HTMLElement, items: OverflowItem[]): void {
	if (items.length === 0) return;
	const btn = container.createEl("button", { cls: "companion-icon-btn companion-overflow-btn", attr: { "aria-label": "More options" } });
	setIcon(btn, "more-vertical");
	btn.onclick = (e) => {
		const menu = new Menu();
		for (const item of items) {
			menu.addItem((mi) => {
				mi.setTitle(item.label);
				if (item.icon) mi.setIcon(item.icon);
				if (item.isActive) mi.setChecked(true);
				mi.onClick(item.onClick);
			});
		}
		menu.showAtMouseEvent(e);
	};
}
