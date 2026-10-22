import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";

/** Whole-lecture cap. A typical lecture is far under this. */
export const DOCUMENT_TEXT_MAX = 400_000;
/** One bulk-import part. Longer lectures are split on page or slide boundaries and every part is sent. */
export const LECTURE_CHUNK_CHARS = 48_000;

/**
 * Per-page text. pdf.js reads compressed streams. A tiny uncompressed PDF that
 * pdf.js cannot open falls back to the literal-string scan.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
	try {
		// pdf.js may detach the buffer it is given. Copy so the bytes used to inline the PDF stay intact.
		const pdf = await getDocumentProxy(Uint8Array.from(bytes));
		const extracted = await extractText(pdf, { mergePages: false });
		const pages = Array.isArray(extracted.text) ? extracted.text : [];
		if (pages.some((page) => page.trim())) return pages.map((page) => page.trim());
	} catch {
		// The literal-string scan below covers the tiny fixtures pdf.js skips.
	}
	const plain = extractPdfText(bytes);
	return plain ? [plain] : [];
}

export async function extractPdfDocument(bytes: Uint8Array): Promise<string> {
	return capDocument(formatPagedText(await extractPdfPages(bytes), "page"));
}

/** Slide text in slide order. Each slide is marked so a quote can name its slide. */
export async function extractPptxDocument(bytes: Uint8Array): Promise<string> {
	const zip = await JSZip.loadAsync(bytes);
	const names = Object.keys(zip.files)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
		.sort((a, b) => slideNumber(a) - slideNumber(b));
	const slides: string[] = [];
	for (const name of names) {
		const file = zip.files[name];
		if (!file) continue;
		slides.push(slideText(await file.async("string")));
	}
	return capDocument(formatPagedText(slides, "slide"));
}

export function formatPagedText(pages: readonly string[], kind: "page" | "slide"): string {
	const chunks: string[] = [];
	pages.forEach((page, index) => {
		const text = page.trim();
		if (!text) return;
		chunks.push(`--- ${kind} ${index + 1} ---\n${text}`);
	});
	return chunks.join("\n\n");
}

/** Split on page or slide markers so a lecture is not cut off mid-file. */
export function chunkLectureText(text: string, maxChars = LECTURE_CHUNK_CHARS): string[] {
	const capped = text.length > DOCUMENT_TEXT_MAX ? text.slice(0, DOCUMENT_TEXT_MAX) : text;
	if (!capped.trim()) return [];
	if (capped.length <= maxChars) return [capped];
	const parts = capped.split(/(?=--- (?:page|slide) \d+ ---)/);
	const chunks: string[] = [];
	let buf = "";
	const push = (piece: string) => {
		if (!piece) return;
		if (piece.length <= maxChars) {
			if (buf && buf.length + piece.length > maxChars) {
				chunks.push(buf);
				buf = piece;
			} else buf += piece;
			return;
		}
		if (buf) {
			chunks.push(buf);
			buf = "";
		}
		for (let i = 0; i < piece.length; i += maxChars) chunks.push(piece.slice(i, i + maxChars));
	};
	for (const part of parts) push(part);
	if (buf.trim()) chunks.push(buf);
	return chunks.filter((chunk) => chunk.trim());
}

/** Literal strings in an uncompressed PDF. Compressed streams need extractPdfPages. */
export function extractPdfText(bytes: Uint8Array): string {
	let raw = "";
	for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]!);
	const chunks: string[] = [];
	const re = /\((?:\\.|[^\\)])*\)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw))) {
		const text = unescapePdfString(match[0].slice(1, -1));
		if (/[A-Za-z]{2,}/.test(text)) chunks.push(text);
	}
	return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function unescapePdfString(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
		.replace(/\\(\d{1,3})/g, (_match: string, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function capDocument(text: string): string {
	return text.length > DOCUMENT_TEXT_MAX ? text.slice(0, DOCUMENT_TEXT_MAX) : text;
}

function slideNumber(path: string): number {
	const n = /slide(\d+)\.xml$/i.exec(path);
	return n ? Number(n[1]) : 0;
}

function slideText(xml: string): string {
	const bits: string[] = [];
	const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml))) {
		const text = decodeXml(match[1] ?? "").replace(/\s+/g, " ").trim();
		if (text) bits.push(text);
	}
	return bits.join("\n");
}

function decodeXml(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
