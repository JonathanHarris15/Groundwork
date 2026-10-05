import { parseSvgMarkup } from "./svg-fragment";

/** The Groundwork mark: a W of five status dots. Matches the website and the Obsidian mockups. */
export const MARK_SVG = `<svg viewBox="-4 0 128 110" aria-hidden="true"><polyline points="10,14 36,98 60,38 84,98 110,14" fill="none" stroke="currentColor" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"></polyline><circle cx="10" cy="14" r="12" fill="#F0565B"></circle><circle cx="60" cy="38" r="12" fill="#F7A93E"></circle><circle cx="110" cy="14" r="12" fill="#45A9F0"></circle><circle cx="36" cy="98" r="12" fill="#3CC56F"></circle><circle cx="84" cy="98" r="12" fill="#3CC56F"></circle></svg>`;

export function mountMark(parent: HTMLElement, cls = "gw-mark"): HTMLElement {
	const hold = parent.ownerDocument.createElement("span");
	hold.className = cls;
	try {
		hold.appendChild(parseSvgMarkup(MARK_SVG, parent.ownerDocument));
	} catch {
		// The mark is decorative; a bad SVG should not spam the console.
	}
	parent.appendChild(hold);
	return hold;
}
