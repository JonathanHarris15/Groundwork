import type { FigureSpec } from "./figure";
import { drawFigure } from "./figure-draw";
import { geoPlate } from "./figure-geo";
import { bytesToBase64, fetchPublic, PUBLIC_IMAGE_BYTES, PUBLIC_TEXT_BYTES, sniffBytes, type PublicFetchDeps } from "./figure-net";
import { runPythonFigure, type FigureMedia, type PythonSpawn } from "./figure-python";
import { sanitizeSvg } from "./figure-svg";

export interface FigureDeps extends PublicFetchDeps {
	python?: PythonSpawn;
}

export interface RealizedFigure {
	spec: FigureSpec;
	svg: string;
	media?: FigureMedia;
	credit?: string;
}

/** Fetch, run, or draw whatever the tutor asked for, so the saved figure stands alone. */
export async function realizeFigure(spec: FigureSpec, deps: FigureDeps = {}): Promise<RealizedFigure> {
	switch (spec.kind) {
		case "image":
			return realizeImage(spec, deps);
		case "svg": {
			const markup = sanitizeSvg(spec.markup);
			const next = { ...spec, markup };
			return { spec: next, svg: markup };
		}
		case "geo":
			return realizeGeo(spec, deps);
		case "program":
			return realizeProgram(spec, deps);
		default:
			return { spec, svg: paint(spec) };
	}
}

async function realizeImage(spec: Extract<FigureSpec, { kind: "image" }>, deps: FigureDeps): Promise<RealizedFigure> {
	const body = await fetchPublic(spec.sourceUrl, { ...deps, maxBytes: PUBLIC_TEXT_BYTES });
	const credit = spec.credit ?? new URL(body.finalUrl).host;
	const sniffed = sniffBytes(body.bytes);
	if (sniffed.kind === "svg") {
		const markup = sanitizeSvg(new TextDecoder().decode(body.bytes));
		return { spec: { ...spec, credit, sourceUrl: body.finalUrl }, svg: markup, credit };
	}
	if (sniffed.kind !== "raster") throw new Error("That address is not an image.");
	if (body.bytes.byteLength > PUBLIC_IMAGE_BYTES) {
		throw new Error(`That image is ${body.bytes.byteLength} bytes. The margin can hold ${PUBLIC_IMAGE_BYTES}. Use a thumbnail URL.`);
	}
	const media: FigureMedia = { mime: sniffed.mime, base64: bytesToBase64(body.bytes), width: sniffed.width, height: sniffed.height };
	const next = { ...spec, credit, sourceUrl: body.finalUrl };
	return { spec: next, svg: paint(next), media, credit };
}

async function realizeGeo(spec: Extract<FigureSpec, { kind: "geo" }>, deps: FigureDeps): Promise<RealizedFigure> {
	let next = spec;
	if (spec.sourceUrl && !spec.polygons.length && !spec.lines.length) {
		const body = await fetchPublic(spec.sourceUrl, { ...deps, maxBytes: PUBLIC_TEXT_BYTES });
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body.bytes));
		} catch {
			throw new Error("That address did not return GeoJSON.");
		}
		const plate = geoPlate(parsed);
		next = { ...spec, polygons: plate.polygons, lines: plate.lines, sourceUrl: body.finalUrl };
	}
	if (!next.polygons.length && !next.lines.length && !next.markers.length) throw new Error("That map has nothing to draw.");
	return { spec: next, svg: paint(next), credit: hostOf(next.sourceUrl) };
}

async function realizeProgram(spec: Extract<FigureSpec, { kind: "program" }>, deps: FigureDeps): Promise<RealizedFigure> {
	if (!spec.source?.trim()) throw new Error("A Python figure needs source.");
	const produced = await runPythonFigure(spec.source, deps.python, deps.signal);
	if (produced.media) return { spec, svg: paint({ ...spec, source: undefined }), media: produced.media };
	return { spec, svg: produced.svg };
}

function paint(spec: FigureSpec): string {
	const svg = drawFigure(spec);
	if (svg.length > 300_000) throw new Error("That figure is too large.");
	if (svg.includes("<script") || svg.includes("<foreignObject")) throw new Error("The figure was not safe to draw.");
	return svg;
}

function hostOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}
