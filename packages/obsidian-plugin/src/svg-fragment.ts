const SVG_NS = "http://www.w3.org/2000/svg";

/** Append trusted SVG markup (paths, circles, …) without using innerHTML on a live node. */
export function appendSvgFragment(svg: SVGElement, fragment: string): void {
	const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${fragment}</svg>`, "image/svg+xml");
	const root = parsed.documentElement;
	while (root.firstChild) svg.appendChild(root.firstChild);
}

export function parseSvgMarkup(markup: string): SVGSVGElement {
	const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
	const el = parsed.documentElement;
	if (!(el instanceof SVGSVGElement)) throw new Error("Expected an SVG root element");
	return el;
}
