import { PDFDocument, StandardFonts } from "pdf-lib";

export async function makePdf(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 1; i <= pages; i++) doc.addPage([300, 200]).drawText(`Page ${i}`, { x: 20, y: 100, size: 24, font });
	return doc.save();
}
