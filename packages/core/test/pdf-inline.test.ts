import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { loadVaultFile } from "../src/files";
import { MemoryVaultIO } from "../src/io";
import { prepareInlinePdf } from "../src/pdf-inline";
import { makePdf } from "./fixtures/pdf";

describe("inline PDFs", () => {
	it("keeps a short PDF whole and trims a long one to the leading pages", async () => {
		const short = await makePdf(2);
		const kept = await prepareInlinePdf(short, "courses/short.pdf", short.byteLength);
		expect(kept.ok).toBe(true);
		if (!kept.ok) return;
		expect(kept.note).toBe("");
		expect(kept.bytes).toBe(short);

		const long = await makePdf(8);
		const cap = Math.floor(long.byteLength * 0.45);
		const trimmed = await prepareInlinePdf(long, "courses/Lecture 3 slides.pdf", cap);
		expect(trimmed.ok).toBe(true);
		if (!trimmed.ok) return;
		expect(trimmed.bytes.byteLength).toBeLessThanOrEqual(cap);
		expect(trimmed.note).toMatch(/courses\/Lecture 3 slides.pdf: pages 1-\d+ of 8 are attached/);
		expect((await PDFDocument.load(trimmed.bytes)).getPageCount()).toBeLessThan(8);
	});

	it("names the limit when a PDF cannot be split", async () => {
		const io = new MemoryVaultIO();
		io.writeBinary("courses/scan.pdf", new Uint8Array(7 * 1024 * 1024));
		const file = await loadVaultFile(io, "courses/scan.pdf");
		expect(file.tooLarge).toBe(true);
		expect(file.skipped).toMatch(/The limit is 6\.0 MB per PDF/);
		expect(file.data).toBeUndefined();
	});
});
