import { mathSources, texQuote } from "@groundwork/core";

const MATH = ".math";

/** Records each rendered formula's TeX on its `.math` element; skipped if the counts disagree. */
export function tagMath(root: HTMLElement, markdown: string): void {
	const els = [...root.querySelectorAll(MATH)].filter((el) => !el.parentElement?.closest(`${MATH}, svg`)) as HTMLElement[];
	if (!els.length) return;
	const sources = mathSources(markdown);
	if (sources.length !== els.length) return;
	els.forEach((el, i) => {
		el.dataset.tex = sources[i].tex;
		el.toggleClass("is-display", sources[i].display);
	});
}

export function mathOf(node: Node | null): HTMLElement | null {
	const el = node instanceof Element ? node : node?.parentElement;
	return (el?.closest(`${MATH}[data-tex]`) as HTMLElement | null) ?? null;
}

export function mathQuote(el: HTMLElement): string {
	return texQuote({ tex: el.dataset.tex ?? "", display: el.hasClass("is-display") });
}

/** Grows the range so it never ends partway through a formula. */
export function expandToMath(range: Range): void {
	const start = mathOf(range.startContainer);
	const end = mathOf(range.endContainer);
	if (start) range.setStartBefore(start);
	if (end) range.setEndAfter(end);
}

/** The range's text, with each formula written back as `$TeX$`. */
export function rangeText(range: Range): string {
	const frag = range.cloneContents();
	frag.querySelectorAll(`${MATH}[data-tex]`).forEach((el) => {
		const m = el as HTMLElement;
		m.replaceWith(m.hasClass("is-display") ? `\n${mathQuote(m)}\n` : mathQuote(m));
	});
	return frag.textContent ?? "";
}

export function mathIn(root: HTMLElement, range: Range): HTMLElement[] {
	return ([...root.querySelectorAll(`${MATH}[data-tex]`)] as HTMLElement[]).filter((el) => range.intersectsNode(el));
}
