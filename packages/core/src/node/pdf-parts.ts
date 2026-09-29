import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";
import { basename } from "../files";

/**
 * Claude Code's Read opens a PDF whole only up to 20 MB, and (when poppler's pdfinfo is
 * installed) up to 10 pages; page ranges need poppler's pdftoppm. Parts within both limits
 * open whole on any machine, with or without poppler.
 */
export const PDF_PART_LIMITS = { pages: 10, bytes: 16 * 1024 * 1024 };

/** Vault-relative folder for split PDFs. It ignores itself in git: parts are rebuilt from the original. */
export const PDF_PARTS_DIR = ".groundwork/cache/pdf-parts";

export interface PdfPart {
	/** Vault-relative path of the part (or of the original, when it fits whole). */
	path: string;
	first: number;
	last: number;
	/** Set when a single page is still over the byte limit, so Read can't open it. */
	bytes?: number;
}

export interface PdfLayout {
	pages: number;
	parts: PdfPart[];
}

/**
 * How to open a vault PDF with Read: the file itself when it fits, otherwise parts split
 * into PDF_PARTS_DIR (cached by the original's size and modification time). Returns null
 * for PDFs pdf-lib can't split, such as encrypted ones.
 */
export async function pdfLayout(vaultDir: string, relPath: string, limits = PDF_PART_LIMITS): Promise<PdfLayout | null> {
	const abs = path.join(vaultDir, ...relPath.split("/"));
	const info = await stat(abs);
	const key = createHash("sha1").update(`${relPath}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 10);
	const stem = basename(relPath).replace(/\.pdf$/i, "");
	const dir = `${PDF_PARTS_DIR}/${safeName(stem)}-${key}`;
	const absDir = path.join(vaultDir, ...dir.split("/"));
	const manifest = path.join(absDir, "parts.json");
	try {
		return JSON.parse(await readFile(manifest, "utf8")) as PdfLayout;
	} catch {
		// not split yet
	}

	let doc: PDFDocument;
	try {
		doc = await PDFDocument.load(await readFile(abs), { ignoreEncryption: true, updateMetadata: false });
	} catch {
		return null;
	}
	if (doc.isEncrypted) return null;
	const pages = doc.getPageCount();
	if (pages <= limits.pages && info.size <= limits.bytes) return { pages, parts: [{ path: relPath, first: 1, last: pages }] };

	await mkdir(absDir, { recursive: true });
	await writeFile(path.join(vaultDir, ...PDF_PARTS_DIR.split("/"), ".gitignore"), "*\n");
	const parts: PdfPart[] = [];
	const emit = async (first: number, last: number): Promise<void> => {
		const part = await PDFDocument.create({ updateMetadata: false });
		for (const page of await part.copyPages(doc, range(first - 1, last - 1))) part.addPage(page);
		const bytes = await part.save();
		if (bytes.byteLength > limits.bytes && last > first) {
			const mid = Math.floor((first + last) / 2);
			await emit(first, mid);
			await emit(mid + 1, last);
			return;
		}
		const name = `${dir}/${first === last ? `p${first}` : `p${first}-${last}`}.pdf`;
		await writeFile(path.join(vaultDir, ...name.split("/")), bytes);
		parts.push(bytes.byteLength > limits.bytes ? { path: name, first, last, bytes: bytes.byteLength } : { path: name, first, last });
	};
	for (let first = 1; first <= pages; first += limits.pages) await emit(first, Math.min(pages, first + limits.pages - 1));

	const layout: PdfLayout = { pages, parts };
	await writeFile(manifest, JSON.stringify(layout));
	return layout;
}

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function safeName(s: string): string {
	return s.replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 60) || "pdf";
}
