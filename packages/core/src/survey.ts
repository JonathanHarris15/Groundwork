import { fileKind, listVaultFiles, loadVaultFile, type FileKind } from "./files";
import type { VaultIO } from "./io";

/** How much of the context folders a document survey may read. */
export const SURVEY_MAX_FILES = 12;
export const SURVEY_PER_FILE_CHARS = 4_000;
export const SURVEY_TOTAL_CHARS = 12_000;

export interface SurveyHit {
	path: string;
	kind: FileKind;
	/** Text that was read. Absent when the file was skipped or left unread. */
	text?: string;
	truncated: boolean;
	note?: string;
}

export interface SurveyLimits {
	maxFiles: number;
	perFileChars: number;
	totalChars: number;
}

const DEFAULT_LIMITS: SurveyLimits = {
	maxFiles: SURVEY_MAX_FILES,
	perFileChars: SURVEY_PER_FILE_CHARS,
	totalChars: SURVEY_TOTAL_CHARS,
};

/**
 * Read the learner's context files for a summary.
 * Text is capped per file and across the survey. Everything else is named, not dumped.
 */
export interface SurveyRead {
	hits: SurveyHit[];
	/** Text files left closed because the size budget was used. */
	unread: string[];
}

export async function surveyDocuments(io: VaultIO, readFolders: readonly string[], limits: SurveyLimits = DEFAULT_LIMITS): Promise<SurveyRead> {
	const paths: string[] = [];
	for (const folder of readFolders) {
		for (const file of await listVaultFiles(io, folder)) {
			if (!paths.includes(file)) paths.push(file);
		}
	}
	paths.sort();
	const hits: SurveyHit[] = [];
	let used = 0;
	let opened = 0;
	const unread: string[] = [];
	for (const path of paths) {
		const kind = fileKind(path).kind;
		if (kind !== "text") {
			hits.push({ path, kind, truncated: false, note: nonTextNote(kind) });
			continue;
		}
		if (opened >= limits.maxFiles || used >= limits.totalChars) {
			unread.push(path);
			continue;
		}
		const file = await loadVaultFile(io, path);
		if (file.skipped || !file.text?.trim()) {
			hits.push({ path, kind, truncated: false, note: file.skipped ?? "Empty." });
			continue;
		}
		const room = Math.min(limits.perFileChars, limits.totalChars - used);
		const text = file.text.slice(0, room);
		const truncated = text.length < file.text.length;
		used += text.length;
		opened += 1;
		hits.push({
			path,
			kind,
			text,
			truncated,
			note: truncated ? "Only the start of this file was read." : undefined,
		});
	}
	return { hits, unread };
}

function nonTextNote(kind: FileKind): string {
	if (kind === "pdf") return "PDF. Not extracted here. Open it with read_vault_file if the pages matter.";
	if (kind === "image") return "Image. Not read as text. Open it with read_vault_file if the picture matters.";
	return "This file type is not read as text.";
}

/** What the tutor model sees: excerpts, plus which files were left out. */
export function formatSurvey(read: SurveyRead, readFolders: readonly string[]): string {
	const { hits, unread } = read;
	if (!readFolders.length) return "No folders are open for reading. The learner picks them in Settings → Groundwork.";
	if (!hits.length && !unread.length) {
		const where = readFolders.map((folder) => `${folder}/`).join(", ");
		return `No files in ${where} yet. The learner can attach files in the chat or put them in a read folder.`;
	}
	const opened = hits.filter((hit) => hit.text).length;
	const where = readFolders.map((folder) => `\`${folder}/\``).join(", ");
	const lines = [
		`Survey of ${where}. ${opened} file${opened === 1 ? "" : "s"} read as text. Write the summary from this. A list of names is not the summary.`,
	];
	for (const hit of hits) {
		lines.push("", `## ${hit.path}`);
		if (hit.note) lines.push(hit.note);
		if (hit.text) lines.push(hit.text);
	}
	if (unread.length) {
		const shown = unread.slice(0, 8);
		const more = unread.length - shown.length;
		lines.push("", `Not opened (size budget): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
	}
	return lines.join("\n");
}
