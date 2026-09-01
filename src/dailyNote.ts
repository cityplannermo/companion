import { App, moment, normalizePath } from "obsidian";

interface DailyNoteConfig {
	folder: string;
	format: string;
	template: string;
}

/** Reads Obsidian's own core "Daily notes" plugin config directly
 * (`.obsidian/daily-notes.json`) rather than via the undocumented
 * internalPlugins API -- this file is exactly what that plugin itself
 * reads, and `Vault.adapter.read` is a public, documented way to read it. */
async function readConfig(app: App): Promise<DailyNoteConfig> {
	try {
		const raw = await app.vault.adapter.read(".obsidian/daily-notes.json");
		const parsed = JSON.parse(raw) as Partial<DailyNoteConfig>;
		return {
			folder: typeof parsed.folder === "string" ? parsed.folder : "",
			format: typeof parsed.format === "string" ? parsed.format : "YYYY-MM-DD",
			template: typeof parsed.template === "string" ? parsed.template : "",
		};
	} catch {
		return { folder: "", format: "YYYY-MM-DD", template: "" };
	}
}

export interface DailyNoteInfo {
	/** Today's note name per the configured date format, e.g. "1 September 2026". */
	label: string;
	path: string;
	exists: boolean;
}

export async function getTodaysDailyNoteInfo(app: App): Promise<DailyNoteInfo> {
	const { folder, format } = await readConfig(app);
	const label = moment().format(format);
	const path = normalizePath(folder ? `${folder}/${label}.md` : `${label}.md`);
	return { label, path, exists: !!app.vault.getAbstractFileByPath(path) };
}

/** Opens today's daily note, creating it from the configured template first
 * if it doesn't exist yet -- delegates entirely to Obsidian's own core
 * "Open today's daily note" command (id `daily-notes`) rather than
 * reimplementing template substitution and note creation here. */
export function openTodaysDailyNote(app: App): void {
	(app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById("daily-notes");
}
