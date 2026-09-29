import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { PDF_PARTS_DIR, pdfLayout } from "../src/node/pdf-parts";
import { makePdf } from "./fixtures/pdf";

function vaultWith(name: string, bytes: Uint8Array): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gw-pdf-parts-"));
	mkdirSync(path.join(dir, "resources"));
	writeFileSync(path.join(dir, "resources", name), bytes);
	return dir;
}

describe("pdfLayout", () => {
	it("opens a short PDF whole, without writing parts", async () => {
		const vault = vaultWith("Short.pdf", await makePdf(4));
		expect(await pdfLayout(vault, "resources/Short.pdf")).toEqual({ pages: 4, parts: [{ path: "resources/Short.pdf", first: 1, last: 4 }] });
		expect(existsSync(path.join(vault, PDF_PARTS_DIR))).toBe(false);
	});

	it("splits a long PDF into parts of at most 10 pages that ignore themselves in git and are reused", async () => {
		const vault = vaultWith("Lecture 2 optimization.pdf", await makePdf(23));
		const layout = (await pdfLayout(vault, "resources/Lecture 2 optimization.pdf"))!;
		expect(layout.pages).toBe(23);
		expect(layout.parts.map((p) => [p.first, p.last])).toEqual([
			[1, 10],
			[11, 20],
			[21, 23],
		]);
		for (const p of layout.parts) {
			expect(p.path.startsWith(`${PDF_PARTS_DIR}/Lecture 2 optimization-`)).toBe(true);
			const part = await PDFDocument.load(readFileSync(path.join(vault, p.path)));
			expect(part.getPageCount()).toBe(p.last - p.first + 1);
		}
		expect(readFileSync(path.join(vault, PDF_PARTS_DIR, ".gitignore"), "utf8")).toBe("*\n");
		expect(await pdfLayout(vault, "resources/Lecture 2 optimization.pdf")).toEqual(layout);
	});

	it("halves a part until it fits under the byte limit", async () => {
		const bytes = await makePdf(8);
		const vault = vaultWith("Scans.pdf", bytes);
		const layout = (await pdfLayout(vault, "resources/Scans.pdf", { pages: 10, bytes: bytes.byteLength / 3 }))!;
		expect(layout.parts.length).toBeGreaterThan(1);
		expect(layout.parts[0].first).toBe(1);
		expect(layout.parts.at(-1)!.last).toBe(8);
		expect(layout.parts.every((p) => p.bytes === undefined)).toBe(true);
	});

	it("returns null for files pdf-lib can't read", async () => {
		const vault = vaultWith("Broken.pdf", new TextEncoder().encode("not a pdf"));
		expect(await pdfLayout(vault, "resources/Broken.pdf")).toBeNull();
	});
});
