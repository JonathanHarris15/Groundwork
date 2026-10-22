import { mathSources, texQuote } from "@groundwork/core";

const MATH = ".math";
const DISPLAY_MATH = ".math-block, .is-display, .MathJax[display='true'], [jax][display='true']";

/**
 * Display math inside `<mark>` picks up the highlight fill. MathJax's assistive
 * MathML sits on top of that fill and glows. Tag both so the stylesheet can
 * clear them without `:has()` or a custom-element type selector.
 * MathJax inserts its nodes after markdown render, so callers also watch the live tree.
 */
export function tagMathChrome(root: ParentNode): void {
	for (const mark of root.querySelectorAll("mark")) {
		mark.classList.toggle("gw-mark-math", Boolean(mark.querySelector(DISPLAY_MATH)));
	}
	for (const jax of root.querySelectorAll(".MathJax, [jax]")) {
		for (const child of jax.children) {
			if (child.getAttribute("display") === "block" && child.getAttribute("unselectable") === "on") {
				child.classList.add("gw-math-assistive");
			}
		}
	}
}

const chromeStops = new WeakMap<HTMLElement, () => void>();

/** Stamp display-math chrome now, and again while MathJax inserts nodes. */
export function watchMathChrome(root: HTMLElement): void {
	tagMathChrome(root);
	chromeStops.get(root)?.();
	const view = root.ownerDocument?.defaultView;
	if (!view || typeof view.MutationObserver !== "function") return;
	let pending = false;
	const observer = new view.MutationObserver(() => {
		if (pending) return;
		pending = true;
		queueMicrotask(() => {
			pending = false;
			if (!root.isConnected) {
				stop();
				return;
			}
			tagMathChrome(root);
		});
	});
	let timer: ReturnType<typeof view.setTimeout> | undefined;
	function stop() {
		observer.disconnect();
		if (timer !== undefined) view.clearTimeout(timer);
		if (chromeStops.get(root) === stop) chromeStops.delete(root);
	}
	observer.observe(root, { childList: true, subtree: true });
	timer = view.setTimeout(stop, 4000);
	chromeStops.set(root, stop);
}

/** Records each rendered formula's TeX on its `.math` element; skipped if the counts disagree. */
export function tagMath(root: HTMLElement, markdown: string): void {
	tagMathChrome(root);
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
