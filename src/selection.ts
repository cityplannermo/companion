/**
 * Per-view multi-select state, tracked by file path so it survives a
 * refresh's file-object churn (Obsidian hands back new TFile instances on
 * rebuild; paths are the stable identity). Deliberately dumb -- a view owns
 * one Selection, mutates it from click handlers, and re-renders itself; this
 * class does no rendering and knows nothing about Obsidian's App.
 */
export class Selection {
	private paths: Set<string> = new Set();

	has(path: string): boolean {
		return this.paths.has(path);
	}

	toggle(path: string): void {
		if (this.paths.has(path)) this.paths.delete(path);
		else this.paths.add(path);
	}

	clear(): void {
		this.paths.clear();
	}

	get size(): number {
		return this.paths.size;
	}

	all(): string[] {
		return Array.from(this.paths);
	}
}
