/**
 * Which vault folders the tutor may read, and which it may write a file into
 * for the learner to hand in. Concept notes, goals, and session notes stay in
 * Groundwork's own folders and are not these lists.
 */

/** Split PDFs the tutor already opened from a readable file. Not a folder the learner picks. */
export const PDF_PARTS_READ_DIR = ".groundwork/cache/pdf-parts";

export const DEFAULT_READ_FOLDERS = ["resources"];
export const DEFAULT_WRITE_FOLDERS = ["submissions"];

export interface FolderAccess {
	readFolders: string[];
	writeFolders: string[];
}

export function defaultFolderAccess(): FolderAccess {
	return { readFolders: [...DEFAULT_READ_FOLDERS], writeFolders: [...DEFAULT_WRITE_FOLDERS] };
}

/** Vault-relative path with no `..`, no hidden segment, and no absolute or empty parts. */
export function normalizeVaultPath(raw: string): string | null {
	let s = String(raw ?? "").trim().replace(/\\/g, "/");
	s = s.replace(/^\/+/, "");
	while (s.startsWith("./")) s = s.slice(2);
	s = s.replace(/\/+$/, "");
	if (!s || s.includes("\0")) return null;
	const parts = s.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part))) return null;
	return parts.join("/");
}

export function cleanFolderList(raw: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const item of raw ?? []) {
		const folder = normalizeVaultPath(item);
		if (folder && !out.includes(folder)) out.push(folder);
	}
	return out;
}

/** Defaults apply only when the caller did not pass a choice. An empty list is a real choice. */
export function accessFromContext(ctx: { access?: FolderAccess } | undefined): FolderAccess {
	if (!ctx?.access) return defaultFolderAccess();
	return {
		readFolders: cleanFolderList(ctx.access.readFolders),
		writeFolders: cleanFolderList(ctx.access.writeFolders),
	};
}

/** `resources-evil/secret` is not inside `resources`. */
export function pathInsideFolder(path: string, folder: string): boolean {
	const file = normalizeVaultPath(path);
	const root = normalizeVaultPath(folder);
	if (!file || !root) return false;
	return file === root || file.startsWith(`${root}/`);
}

export function pathInsideAny(path: string, folders: readonly string[]): boolean {
	return folders.some((folder) => pathInsideFolder(path, folder));
}

/**
 * True when the tutor may open this vault path: it sits in a read folder, or it is a
 * split-PDF part of a file that was already read from one.
 */
export function tutorMayReadPath(vaultPath: string, access: { readFolders: readonly string[] }): boolean {
	let raw = String(vaultPath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
	while (raw.startsWith("./")) raw = raw.slice(2);
	if (!raw || raw.split("/").includes("..")) return false;
	if (raw === PDF_PARTS_READ_DIR || raw.startsWith(`${PDF_PARTS_READ_DIR}/`)) return true;
	const path = normalizeVaultPath(raw);
	if (!path) return false;
	return pathInsideAny(path, access.readFolders);
}
