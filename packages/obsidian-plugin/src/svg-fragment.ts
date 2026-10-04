const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An `<svg>` tag with no xmlns is not an SVG element under the XML parser.
 * `instanceof SVGSVGElement` is then false, and the panel's `onOpen` used to
 * throw on the logo before drawing anything else — a blank pane.
 */
export function withSvgNamespace(markup: string): string {
	if (/\sxmlns\s*=/.test(markup)) return markup;
	return markup.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`);
}

/** Append trusted SVG markup (paths, circles, …) without using innerHTML on a live node. */
export function appendSvgFragment(svg: SVGElement, fragment: string): void {
	const parsed = new DOMParser().parseFromString(withSvgNamespace(`<svg>${fragment}</svg>`), "image/svg+xml");
	const root = parsed.documentElement;
	if (root.localName?.toLowerCase() !== "svg") return;
	const imported = svg.ownerDocument.importNode(root, true);
	while (imported.firstChild) svg.appendChild(imported.firstChild);
}

export function parseSvgMarkup(markup: string, doc?: Document): SVGElement {
	const parsed = new DOMParser().parseFromString(withSvgNamespace(markup), "image/svg+xml");
	const el = parsed.documentElement;
	if (parsed.querySelector("parsererror") || el.localName?.toLowerCase() !== "svg") {
		throw new Error("Expected an SVG root element");
	}
	const node = doc ? doc.importNode(el, true) : el;
	return node as unknown as SVGElement;
}
