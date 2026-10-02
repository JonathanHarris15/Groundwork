import { cleanFolderList, pathInsideAny } from "./access";
import type { ChatMessage, ContentBlock } from "./agent/types";
import type { VaultIO } from "./io";

/** Where attachments and the learner's reference material live. */
export const RESOURCES_DIR = "resources";

export type FileKind = "image" | "pdf" | "text" | "other";

/** Per-file limits of the Messages API: 5 MB per image, 32 MB per request. */
export const LIMITS = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, textChars: 150_000 };

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXTENSIONS = new Set(
	"md markdown txt text csv tsv json jsonl yaml yml toml xml html htm css tex bib rst org log ini cfg sql py ipynb r jl m js mjs cjs ts tsx jsx java kt c h cc cpp hpp cs go rs rb php swift scala hs ml lua sh bash zsh ps1 bat".split(" "),
);

export interface VaultFile {
	path: string;
	kind: FileKind;
	mediaType: string;
	size: number;
	/** Base64 contents of images and PDFs. */
	data?: string;
	text?: string;
	truncated?: boolean;
	/** Why the contents weren't loaded, e.g. too large or an unreadable type. */
	skipped?: string;
	tooLarge?: boolean;
}

export function extensionOf(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function fileKind(path: string): { kind: FileKind; mediaType: string } {
	const ext = extensionOf(path);
	if (IMAGE_TYPES[ext]) return { kind: "image", mediaType: IMAGE_TYPES[ext] };
	if (ext === "pdf") return { kind: "pdf", mediaType: "application/pdf" };
	if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", mediaType: ext === "md" ? "text/markdown" : "text/plain" };
	return { kind: "other", mediaType: "application/octet-stream" };
}

export async function loadVaultFile(io: VaultIO, path: string): Promise<VaultFile> {
	const { kind, mediaType } = fileKind(path);
	const base = { path, kind, mediaType };
	try {
		if (kind === "text") {
			const raw = await io.read(path);
			const truncated = raw.length > LIMITS.textChars;
			return { ...base, size: raw.length, text: truncated ? raw.slice(0, LIMITS.textChars) : raw, truncated };
		}
		if (kind === "other") {
			return { ...base, size: 0, skipped: `.${extensionOf(path) || "?"} files can't be read. Export it as PDF, an image, or text.` };
		}
		const bytes = await io.readBinary(path);
		const limit = kind === "image" ? LIMITS.image : LIMITS.pdf;
		if (bytes.byteLength > limit) {
			return { ...base, size: bytes.byteLength, skipped: `It is ${mb(bytes.byteLength)}, over the ${mb(limit)} limit for ${kind === "image" ? "images" : "PDFs"}.`, tooLarge: true };
		}
		return { ...base, size: bytes.byteLength, data: toBase64(bytes) };
	} catch (err) {
		return { ...base, size: 0, skipped: `Couldn't read it (${err instanceof Error ? err.message : String(err)}).` };
	}
}

/** Content blocks for the Messages API. */
export function fileBlocks(f: VaultFile): ContentBlock[] {
	if (f.skipped) return [{ type: "text", text: `File ${f.path} is not included: ${f.skipped}` }];
	if (f.kind === "text") return [{ type: "text", text: fileText(f) }];
	const label: ContentBlock = { type: "text", text: `File: ${f.path}` };
	if (f.kind === "image") return [label, { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } }];
	return [label, { type: "document", source: { type: "base64", media_type: f.mediaType, data: f.data }, title: basename(f.path) }];
}

export function fileText(f: VaultFile): string {
	return `<file path="${f.path}">\n${f.text ?? ""}\n</file>${f.truncated ? `\n(Only the first ${LIMITS.textChars.toLocaleString("en")} characters are shown.)` : ""}`;
}

/** A learner message: attached files first, then what they wrote. */
export function userContent(text: string, files: VaultFile[] = [], toBlocks: (f: VaultFile) => ContentBlock[] = fileBlocks): string | ContentBlock[] {
	if (!files.length) return text;
	const blocks = files.flatMap(toBlocks);
	if (text.trim()) blocks.push({ type: "text", text });
	return blocks;
}

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** MCP tool-result content; PDFs become embedded resources. `override` can replace how any file is sent. */
export function mcpContent(text: string, files: VaultFile[] = [], override?: (f: VaultFile) => McpContent[] | undefined): McpContent[] {
	const out: McpContent[] = [{ type: "text", text }];
	for (const f of files) {
		const custom = override?.(f);
		if (custom) out.push(...custom);
		else if (f.skipped) out.push({ type: "text", text: `File ${f.path} is not included: ${f.skipped}` });
		else if (f.kind === "text") out.push({ type: "text", text: fileText(f) });
		else if (f.kind === "image") out.push({ type: "text", text: `File: ${f.path}` }, { type: "image", data: f.data!, mimeType: f.mediaType });
		else out.push({ type: "resource", resource: { uri: `groundwork:///${encodeURI(f.path)}`, mimeType: f.mediaType, blob: f.data! } });
	}
	return out;
}

const OMITTED = "[A file was attached here. It isn't kept in saved history; open it again with read_vault_file if you need it.]";

/** Chat history without base64 file contents, so saved chats stay small in git. */
export function withoutFileData(messages: ChatMessage[]): ChatMessage[] {
	const strip = (blocks: ContentBlock[]): ContentBlock[] =>
		blocks.map((b) => {
			if ((b.type === "image" || b.type === "document") && b.source?.type === "base64") return { type: "text", text: OMITTED };
			if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: strip(b.content) };
			return b;
		});
	return messages.map((m) => (Array.isArray(m.content) ? { ...m, content: strip(m.content) } : m));
}

export async function listVaultFiles(io: VaultIO, folder: string, limit = 500): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (out.length >= limit) return;
		const { files, folders } = await io.list(dir);
		for (const f of files.sort()) {
			if (out.length >= limit) return;
			if (!isHidden(f)) out.push(f);
		}
		for (const d of folders.sort()) if (!isHidden(d)) await walk(d);
	};
	if (folder === "" || (await io.exists(folder))) await walk(folder);
	return out;
}

async function isFile(io: VaultIO, path: string): Promise<boolean> {
	const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (parent && !(await io.exists(parent))) return false;
	try {
		return (await io.list(parent)).files.includes(path);
	} catch {
		return false;
	}
}

function isHidden(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

/**
 * Resolves what the tutor or learner called a file.
 * With `within`, only those folders are searched. Without it, a bare name is tried in
 * resources/ and then anywhere in the vault (hidden paths still never match).
 */
export async function resolveVaultFile(io: VaultIO, ref: string, within?: readonly string[]): Promise<string | null> {
	const clean = ref.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0].replace(/^\/+/, "");
	if (!clean || clean.split("/").includes("..") || isHidden(clean)) return null;
	const allowed = (p: string) => (within ? pathInsideAny(p, within) : !isHidden(p));
	const candidates = [clean, ...(within ?? [RESOURCES_DIR]).map((folder) => `${folder}/${clean}`)];
	for (const candidate of candidates) {
		if (allowed(candidate) && (await isFile(io, candidate))) return candidate;
	}
	const name = basename(clean).toLowerCase();
	for (const root of within ?? [""]) {
		const all = await listVaultFiles(io, root, 20_000);
		const hit = all.find((p) => allowed(p) && basename(p).toLowerCase() === name) ?? all.find((p) => allowed(p) && basename(p).toLowerCase().startsWith(`${name}.`));
		if (hit) return hit;
	}
	return null;
}

/** A file the learner can hand in. A bare name lands in the first write folder. */
export function resolveSubmissionPath(raw: string, writeFolders: readonly string[]): { path: string } | { error: string } {
	const folders = cleanFolderList(writeFolders);
	const where = folders.length ? folders.map((folder) => `${folder}/`).join(" or ") : "a write folder";
	if (!folders.length) return { error: `No write folders are set. Pick one in Settings → Groundwork, then save the file in ${where}.` };
	const input = raw.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0].trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!input || input.split("/").includes("..") || input.split("/").some((part) => !part || part.startsWith("."))) {
		return { error: `"${raw}" isn't a path Groundwork can write. Put the file in ${where}.` };
	}
	const rooted = pathInsideAny(input, folders);
	if (!rooted && input.includes("/")) return { error: `Write that file inside ${where}.` };
	let path = rooted ? input.replace(/\/+$/, "") : `${folders[0]}/${input}`;
	if (folders.includes(path)) return { error: "Name the file to submit, not only the folder." };
	if (!extensionOf(path)) path = `${path}.md`;
	if (!pathInsideAny(path, folders) || fileKind(path).kind !== "text") {
		return { error: `Files to submit are text or markdown, inside ${where}.` };
	}
	return { path };
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const B = (globalThis as { Buffer?: { from(b: ArrayBuffer, o: number, l: number): { toString(enc: string): string } } }).Buffer;
	if (B) return B.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
