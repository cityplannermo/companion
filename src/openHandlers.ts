import { App, TFile } from "obsidian";
import { HOVER_SOURCE } from "./data";

export interface OpenableOptions {
	/** Called instead of opening the note when Shift+click fires, or when a
	 * plain click/tap fires while isSelecting() is true. Lets a view
	 * repurpose a click as "toggle this item's selection" (see selection.ts
	 * / deleteUI.ts) without colliding with Ctrl/Cmd+hover, which still
	 * means preview either way, since hover and click are different
	 * events. */
	onToggleSelect?: () => void;
	/** Reports whether this view currently has an active multi-selection
	 * (Selection.size > 0). While true, a plain click/tap toggles this
	 * item's selection instead of opening it -- so once selection has
	 * started (via Shift+click, or "Select" in the right-click/press-and-
	 * hold menu -- see showDeleteMenu), adding more items is a single tap,
	 * with no modifier key or long-press needed. */
	isSelecting?: () => boolean;
}

/**
 * Wires an element that represents a note (an agenda item's title, a task
 * card or list row's title) with two ways to reach it, kept deliberately
 * simple:
 *
 * - Click (or tap) opens the note in a new tab, leaving this view in place
 *   -- unless a multi-selection is already under way (isSelecting), in
 *   which case it toggles this item's selection instead.
 * - Ctrl/Cmd+hover triggers Obsidian's own Page preview popup (if the
 *   core "Page preview" plugin is enabled), which supports reading and
 *   light editing without leaving this view.
 *
 * Both reuse Obsidian's own UI rather than Companion building its own.
 *
 * A view that supports multi-select passes both onToggleSelect and
 * isSelecting; Shift+click always toggles selection regardless of mode.
 * There used to be a separate press-and-hold-to-select gesture here for
 * touch, but it fired at the same ~500ms mark as the browser's own
 * long-press-to-contextmenu gesture, so a press-and-hold ended up doing
 * both at once -- selecting the item *and* popping the delete menu over
 * it. Touch now starts a selection the same way desktop does: through
 * "Select" in that same context menu (see showDeleteMenu), which is
 * already where press-and-hold naturally lands. Selecting subsequent
 * items is then just a plain tap, via isSelecting above.
 */
export function makeOpenable(app: App, el: HTMLElement, file: TFile, opts: OpenableOptions = {}): void {
	el.onclick = (e) => {
		e.stopPropagation();
		if (opts.onToggleSelect && (e.shiftKey || opts.isSelecting?.())) {
			opts.onToggleSelect();
			return;
		}
		void app.workspace.getLeaf("tab").openFile(file);
	};

	el.addEventListener("mouseover", (e) => {
		if (!(e.ctrlKey || e.metaKey)) return;
		app.workspace.trigger("hover-link", {
			event: e,
			source: HOVER_SOURCE,
			hoverParent: el,
			targetEl: el,
			linktext: file.path,
		});
	});
}
