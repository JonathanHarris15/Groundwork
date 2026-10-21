import { PDFDocument } from "pdf-lib";

/** A lecture deck bigger than this is shortened to the leading pages that fit. */
export const PDF_INLINE_BYTES = 6 * 1024 * 1024;

export async function prepareInlinePdf(
	bytes: Uint8Array,
	path: string,
	maxBytes = PDF_INLINE_BYTES,
): Promise<{ ok: true; bytes: Uint8Array; note: string } | { ok: false; note: string }> {
	if (bytes.byteLength <= maxBytes) return { ok: true, bytes, note: "" };
	const trimmed = await trimPdf(bytes, maxBytes);
	if (!trimmed) {
		return { ok: false, note: `${path} is ${mb(bytes.byteLength)}. The limit is ${mb(maxBytes)} per PDF, and this file could not be split.` };
	}
	if (trimmed.kept >= trimmed.total) return { ok: true, bytes: trimmed.bytes, note: "" };
	return {
		ok: true,
		bytes: trimmed.bytes,
		note: `${path}: pages 1-${trimmed.kept} of ${trimmed.total} are attached. Later pages stay in the vault.`,
	};
}

async function trimPdf(bytes: Uint8Array, maxBytes: number): Promise<{ bytes: Uint8Array; kept: number; total: number } | null> {
	let doc: PDFDocument;
	try {
		doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
	} catch {
		return null;
	}
	if (doc.isEncrypted) return null;
	const total = doc.getPageCount();
	if (!total) return null;
	let best: { bytes: Uint8Array; kept: number } | null = null;
	let lo = 1;
	let hi = total;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const saved = await slicePdf(doc, mid);
		if (!saved) return best ? { ...best, total } : null;
		if (saved.byteLength <= maxBytes) {
			best = { bytes: saved, kept: mid };
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (!best) return null;
	return { bytes: best.bytes, kept: best.kept, total };
}

async function slicePdf(doc: PDFDocument, pages: number): Promise<Uint8Array | null> {
	try {
		const part = await PDFDocument.create({ updateMetadata: false });
		const copied = await part.copyPages(doc, Array.from({ length: pages }, (_, i) => i));
		for (const page of copied) part.addPage(page);
		return part.save();
	} catch {
		return null;
	}
}

function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
