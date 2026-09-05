import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { CompanionPost, createQuickNote, getPosts } from "./data";
import { formatDate, formatDisplayShortDate } from "./dates";
import { EventEditorModal } from "./eventEditorUI";
import { makeOpenable } from "./openHandlers";
import type { CompanionSettings } from "./settings";

export const VIEW_TYPE_POSTS = "companion-posts-view";

/**
 * A gallery view over every `post`-tagged note (Mo's own request: "a gallery
 * view similar to the calendar but showing only posts and lets you only add
 * posts") -- one card per post, newest-first by whichever date it actually
 * has (published, then scheduled, then its own creation date). Deliberately
 * add-only, same as the calendar's own read-only Post pins: Companion
 * creates a Post idea note through the shared "+ New item" editor (narrowed
 * here to just that one type), but never edits or deletes an existing one --
 * see CompanionEventType's own comment in data.ts. A card just opens its
 * note; the content-drafting workflow owns everything from there.
 */
export class PostsView extends ItemView {
	private posts: CompanionPost[] = [];
	private filterText = "";
	private platformFilter = ""; // "" = every platform

	constructor(
		leaf: WorkspaceLeaf,
		private settings: CompanionSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_POSTS;
	}

	getDisplayText(): string {
		return "Posts";
	}

	getIcon(): string {
		return "newspaper";
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to tear down — no timers, no external connections
	}

	/** Re-reads the vault and redraws. Called on open and on relevant vault changes. */
	refresh(): void {
		this.posts = getPosts(this.app);
		this.render();
	}

	private visiblePosts(): CompanionPost[] {
		const q = this.filterText.trim().toLowerCase();
		return this.posts
			.filter((p) => !q || p.title.toLowerCase().includes(q))
			.filter((p) => !this.platformFilter || p.platform === this.platformFilter)
			.sort((a, b) => (sortDate(b) ?? "").localeCompare(sortDate(a) ?? ""));
	}

	private platforms(): string[] {
		const names = new Set<string>();
		for (const p of this.posts) if (p.platform) names.add(p.platform);
		return Array.from(names).sort();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("companion-posts-root");

		this.renderHeader(root);
		this.renderGallery(root);
	}

	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "companion-posts-header" });
		header.createEl("h2", { text: "Posts" });

		const controls = header.createDiv({ cls: "companion-posts-header-controls" });

		const filterInput = controls.createEl("input", {
			cls: "companion-filter-input",
			attr: { type: "text", placeholder: "Filter…" },
		});
		filterInput.value = this.filterText;
		filterInput.oninput = () => {
			this.filterText = filterInput.value;
			this.render();
			const restored = parent.querySelector<HTMLInputElement>(".companion-filter-input");
			restored?.focus();
			restored?.setSelectionRange(this.filterText.length, this.filterText.length);
		};

		const platforms = this.platforms();
		if (platforms.length > 0) {
			const platformSelect = controls.createEl("select", { cls: "companion-sort-select" });
			platformSelect.createEl("option", { text: "All platforms", value: "" });
			for (const name of platforms) platformSelect.createEl("option", { text: name, value: name });
			platformSelect.value = this.platformFilter;
			platformSelect.onchange = () => {
				this.platformFilter = platformSelect.value;
				this.render();
			};
		}

		const addBtn = controls.createEl("button", { cls: "mod-cta companion-btn-icon-text" });
		setIcon(addBtn, "plus");
		addBtn.createSpan({ text: "Post" });
		addBtn.onclick = () => this.openCreate();
	}

	/** Opens the same shared editor modal every other "+" uses, narrowed to
	 * just Post -- the only type this modal can create without a real
	 * content-drafting workflow behind it (see createPostIdea in data.ts).
	 * The modal's own date field becomes this post's `scheduled:` target,
	 * exactly as it already does from the Calendar's/Dashboard's "+ New
	 * item" dropdown. */
	private openCreate(): void {
		new EventEditorModal(
			this.app,
			"create",
			{ title: "", type: "post", date: formatDate(new Date()), timeStr: "00:00" },
			(result) => {
				createQuickNote(this.app, "post", result.date, result.title).then(
					() => this.refresh(),
					(err: Error) => new Notice(err.message)
				);
			},
			undefined,
			["post"]
		).open();
	}

	private renderGallery(parent: HTMLElement): void {
		const visible = this.visiblePosts();
		if (visible.length === 0) {
			parent.createDiv({
				cls: "companion-empty",
				text: this.posts.length === 0 ? "No posts yet." : "No matches.",
			});
			return;
		}

		const gallery = parent.createDiv({ cls: "companion-posts-gallery" });
		for (const post of visible) this.renderCard(gallery, post);
	}

	private renderCard(parent: HTMLElement, post: CompanionPost): void {
		const card = parent.createDiv({ cls: "companion-post-card" });
		if (post.cancelled) card.addClass("companion-post-card-cancelled");

		const title = card.createDiv({ cls: "companion-post-card-title", text: post.title });
		makeOpenable(this.app, title, post.file);

		const meta = card.createDiv({ cls: "companion-post-card-meta" });
		if (post.status) meta.createSpan({ cls: "companion-post-badge", text: post.status });
		if (post.platform) meta.createSpan({ cls: "companion-post-badge", text: post.platform });
		if (post.cancelled) meta.createSpan({ cls: "companion-post-badge companion-post-badge-cancelled", text: "Cancelled" });

		const dateLabel = post.published
			? `Published ${formatDisplayShortDate(post.published)}`
			: post.scheduled
				? `Scheduled ${formatDisplayShortDate(post.scheduled)}`
				: "No date set";
		card.createDiv({ cls: "companion-post-card-date", text: dateLabel });
	}
}

function sortDate(post: CompanionPost): string | null {
	return post.published ?? post.scheduled ?? post.date;
}
