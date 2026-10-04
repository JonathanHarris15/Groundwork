import { describe, expect, it } from "vitest";
import { MARK_SVG } from "../src/mark";
import { parseSvgMarkup, withSvgNamespace } from "../src/svg-fragment";

describe("svg markup", () => {
	it("gives the logo an SVG namespace so the XML parser accepts it", () => {
		expect(MARK_SVG.startsWith("<svg ")).toBe(true);
		expect(MARK_SVG.includes("xmlns=")).toBe(false);
		expect(withSvgNamespace(MARK_SVG)).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(withSvgNamespace(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBe(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
	});

	it("parses the logo into an SVG element instead of throwing", () => {
		const dom = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
		if (!dom) return;
		const before = new dom().parseFromString(MARK_SVG, "image/svg+xml").documentElement;
		expect(before instanceof SVGSVGElement).toBe(false);
		const svg = parseSvgMarkup(MARK_SVG);
		expect(svg.localName.toLowerCase()).toBe("svg");
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg.querySelectorAll("circle").length).toBe(5);
	});
});
