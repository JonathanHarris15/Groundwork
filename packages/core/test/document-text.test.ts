import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chunkLectureText, extractPdfDocument, extractPdfPages, extractPptxDocument, LECTURE_CHUNK_CHARS } from "../src/document-text";
import { loadVaultFile } from "../src/files";
import { MemoryVaultIO } from "../src/io";

describe("lecture text", () => {
	it("reads each page of a compressed PDF and each slide of a pptx", async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		const first = pdf.addPage();
		first.drawText("We always choose u by LIATE.", { x: 50, y: 700, size: 12, font });
		const second = pdf.addPage();
		second.drawText("Tabular integration is an alternate.", { x: 50, y: 700, size: 12, font });
		const bytes = new Uint8Array(await pdf.save());
		const pages = await extractPdfPages(bytes);
		expect(pages[0]).toContain("LIATE");
		expect(pages[1]).toContain("Tabular");
		const text = await extractPdfDocument(bytes);
		expect(text).toContain("--- page 1 ---");
		expect(text).toContain("--- page 2 ---");

		const zip = new JSZip();
		zip.file(
			"ppt/slides/slide1.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>We always choose u by LIATE.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
		);
		zip.file(
			"ppt/slides/slide2.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Tabular integration is an alternate.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
		);
		const pptx = await zip.generateAsync({ type: "uint8array" });
		const slides = await extractPptxDocument(pptx);
		expect(slides).toContain("--- slide 1 ---");
		expect(slides).toContain("We always choose u by LIATE.");
		expect(slides).toContain("--- slide 2 ---");
		expect(slides.indexOf("slide 1")).toBeLessThan(slides.indexOf("slide 2"));

		const io = new MemoryVaultIO();
		io.writeBinary("resources/Lecture 7.pptx", pptx);
		const loaded = await loadVaultFile(io, "resources/Lecture 7.pptx");
		expect(loaded.skipped).toBeUndefined();
		expect(loaded.text).toContain("LIATE");
		expect(loaded.text).toContain("slide 2");
	});

	it("keeps the end of a long lecture by splitting on page markers", () => {
		const pages = Array.from({ length: 30 }, (_, index) => `--- page ${index + 1} ---\n${"word ".repeat(400)}end${index + 1}`);
		const text = pages.join("\n\n");
		expect(text.length).toBeGreaterThan(LECTURE_CHUNK_CHARS);
		const chunks = chunkLectureText(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= LECTURE_CHUNK_CHARS)).toBe(true);
		expect(chunks.join("")).toBe(text);
		expect(chunks.at(-1)).toContain("end30");
	});
});
