import { insertLatex, segmentAnswer, type AnswerPiece } from "./math-input";

type RenderMd = (el: HTMLElement, markdown: string) => Promise<void>;

export interface SymbolItem {
	label: string;
	/** LaTeX inserted at the caret. `|` marks where the caret lands and is not inserted. */
	insert: string;
	title: string;
}

export const SYMBOL_GROUPS: { title: string; items: SymbolItem[] }[] = [
	{
		title: "Structures",
		items: [
			{ label: "a/b", insert: "\\frac{|}{}", title: "Fraction \\frac{}{}" },
			{ label: "√", insert: "\\sqrt{|}", title: "Square root \\sqrt{}" },
			{ label: "xⁿ", insert: "^{|}", title: "Superscript ^{}" },
			{ label: "xₙ", insert: "_{|}", title: "Subscript _{}" },
			{ label: "∑", insert: "\\sum_{|}^{}", title: "Sum \\sum_{}^{}" },
			{ label: "∏", insert: "\\prod_{|}^{}", title: "Product \\prod_{}^{}" },
			{ label: "∫", insert: "\\int_{|}^{}", title: "Integral \\int_{}^{}" },
			{ label: "lim", insert: "\\lim_{|}", title: "Limit \\lim_{}" },
			{ label: "∂", insert: "\\partial", title: "Partial derivative \\partial" },
			{ label: "∇", insert: "\\nabla", title: "Nabla \\nabla" },
			{ label: "x̄", insert: "\\bar{|}", title: "Bar \\bar{}" },
			{ label: "x̂", insert: "\\hat{|}", title: "Hat \\hat{}" },
			{ label: "vec", insert: "\\vec{|}", title: "Vector \\vec{}" },
		],
	},
	{
		title: "Operators",
		items: [
			["±", "\\pm"],
			["×", "\\times"],
			["·", "\\cdot"],
			["÷", "\\div"],
			["≠", "\\neq"],
			["≤", "\\leq"],
			["≥", "\\geq"],
			["≈", "\\approx"],
			["≡", "\\equiv"],
			["∞", "\\infty"],
			["°", "\\circ"],
			["′", "'"],
		].map(([label, insert]) => ({ label, insert, title: insert })),
	},
	{
		title: "Greek",
		items: [
			["α", "\\alpha"],
			["β", "\\beta"],
			["γ", "\\gamma"],
			["δ", "\\delta"],
			["ε", "\\epsilon"],
			["θ", "\\theta"],
			["λ", "\\lambda"],
			["μ", "\\mu"],
			["π", "\\pi"],
			["ρ", "\\rho"],
			["σ", "\\sigma"],
			["φ", "\\phi"],
			["ω", "\\omega"],
			["Δ", "\\Delta"],
			["Σ", "\\Sigma"],
			["Ω", "\\Omega"],
		].map(([label, insert]) => ({ label, insert, title: insert })),
	},
	{
		title: "Sets & arrows",
		items: [
			["∈", "\\in"],
			["∉", "\\notin"],
			["⊂", "\\subset"],
			["⊆", "\\subseteq"],
			["∪", "\\cup"],
			["∩", "\\cap"],
			["∅", "\\emptyset"],
			["∀", "\\forall"],
			["∃", "\\exists"],
			["→", "\\to"],
			["⇒", "\\Rightarrow"],
			["↔", "\\leftrightarrow"],
			["↦", "\\mapsto"],
		].map(([label, insert]) => ({ label, insert, title: insert })),
	},
];

export interface MathFieldOptions {
	placeholder: string;
	hint: string;
	onChange: () => void;
}

/**
 * One answer surface: prose and rendered formulas share the box. The formula
 * under the caret stays as source; clicking it, or a symbol in the drawer,
 * edits that same string.
 */
export class MathField {
	readonly editor: HTMLElement;
	private readonly doc: Document;
	private readonly box: HTMLElement;
	private readonly drawer: HTMLElement;
	private readonly tab: HTMLButtonElement;
	private paintKey = "";
	private painting = false;
	private composing = false;
	private disabled = false;
	private remembered = { start: 0, end: 0 };
	private readonly onSelection: () => void;

	constructor(
		parent: HTMLElement,
		private readonly renderMd: RenderMd,
		private readonly opts: MathFieldOptions,
	) {
		this.doc = parent.ownerDocument;
		this.box = this.doc.win.createDiv();
		this.box.className = "gw-free-box";
		this.editor = this.doc.win.createDiv();
		this.editor.className = "gw-free-editor";
		this.editor.contentEditable = "true";
		this.editor.spellcheck = false;
		this.editor.dataset.placeholder = opts.placeholder;
		this.editor.setAttribute("role", "textbox");
		this.editor.setAttribute("aria-multiline", "true");
		this.editor.setAttribute("aria-label", "Your answer");
		this.drawer = this.doc.win.createDiv();
		this.drawer.className = "gw-symbols-drawer";
		this.drawer.hidden = true;
		this.buildDrawer();
		this.tab = this.doc.win.createEl("button");
		this.tab.type = "button";
		this.tab.className = "gw-symbols-tab";
		this.tab.textContent = "∑";
		this.tab.title = "Math symbols";
		this.tab.setAttribute("aria-label", "Math symbols");
		this.tab.setAttribute("aria-expanded", "false");
		this.tab.addEventListener("mousedown", (e) => e.preventDefault());
		this.tab.addEventListener("click", () => this.toggleDrawer());
		this.box.append(this.editor, this.drawer, this.tab);
		parent.append(this.box);
		const hint = this.doc.win.createDiv();
		hint.className = "gw-free-hint";
		hint.textContent = opts.hint;
		parent.append(hint);

		this.editor.addEventListener("keydown", (e) => this.onKeyDown(e));
		this.editor.addEventListener("paste", (e) => {
			e.preventDefault();
			const text = e.clipboardData?.getData("text/plain") ?? "";
			if (text) this.insertRaw(text);
		});
		this.editor.addEventListener("input", () => {
			if (this.painting || this.composing) return;
			this.syncFromDom();
			this.opts.onChange();
		});
		this.editor.addEventListener("compositionstart", () => {
			this.composing = true;
		});
		this.editor.addEventListener("compositionend", () => {
			this.composing = false;
			this.syncFromDom();
			this.opts.onChange();
		});
		this.onSelection = () => {
			if (!this.editor.isConnected) {
				this.doc.removeEventListener("selectionchange", this.onSelection);
				return;
			}
			if (this.painting || this.disabled || this.composing) return;
			const sel = this.doc.getSelection();
			if (!sel?.anchorNode || !this.editor.contains(sel.anchorNode)) return;
			this.syncFromDom();
		};
		this.doc.addEventListener("selectionchange", this.onSelection);
		this.paint("", null);
	}

	get value(): string {
		return sourceOf(this.editor);
	}

	set value(next: string) {
		this.remembered = { start: next.length, end: next.length };
		this.paint(next, null, true);
	}

	focus(): void {
		this.editor.focus({ preventScroll: true });
	}

	disable(): void {
		this.disabled = true;
		this.editor.contentEditable = "false";
		this.tab.disabled = true;
		this.drawer.querySelectorAll("button").forEach((b) => {
			(b).disabled = true;
		});
	}

	destroy(): void {
		this.doc.removeEventListener("selectionchange", this.onSelection);
	}

	private buildDrawer(): void {
		const head = this.doc.win.createDiv();
		head.className = "gw-symbols-head";
		head.textContent = "Symbols";
		this.drawer.append(head);
		const note = this.doc.win.createDiv();
		note.className = "gw-symbols-note";
		note.textContent = "Inserted at the cursor.";
		this.drawer.append(note);
		for (const group of SYMBOL_GROUPS) {
			const label = this.doc.win.createDiv();
			label.className = "gw-symbol-group";
			label.textContent = group.title;
			const grid = this.doc.win.createDiv();
			grid.className = "gw-symbol-grid";
			for (const item of group.items) {
				const btn = this.doc.win.createEl("button");
				btn.type = "button";
				btn.className = "gw-symbol-btn";
				btn.textContent = item.label;
				btn.title = item.title;
				btn.setAttribute("aria-label", item.title);
				btn.addEventListener("mousedown", (e) => e.preventDefault());
				btn.addEventListener("click", () => this.insertSymbol(item.insert));
				grid.append(btn);
			}
			this.drawer.append(label, grid);
		}
	}

	private toggleDrawer(): void {
		const open = this.drawer.hidden;
		this.drawer.hidden = !open;
		this.box.classList.toggle("is-symbols-open", open);
		this.tab.setAttribute("aria-expanded", open ? "true" : "false");
		this.tab.title = open ? "Close math symbols" : "Math symbols";
		this.tab.setAttribute("aria-label", open ? "Close math symbols" : "Math symbols");
		if (!this.disabled && this.doc.activeElement !== this.editor) this.editor.focus({ preventScroll: true });
	}

	private insertSymbol(template: string): void {
		if (this.disabled) return;
		const { source, start, end } = this.capture();
		const next = insertLatex(source, start, end, template);
		this.remembered = { start: next.caret, end: next.caret };
		this.editor.focus({ preventScroll: true });
		this.paint(next.source, next.caret, true);
		this.opts.onChange();
	}

	private insertRaw(text: string): void {
		if (this.disabled || this.painting) return;
		const { source, start, end } = this.capture();
		const next = source.slice(0, start) + text + source.slice(end);
		const caret = start + text.length;
		this.remembered = { start: caret, end: caret };
		this.paint(next, caret, true);
		this.opts.onChange();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (this.disabled) return;
		if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.insertRaw("\n");
			return;
		}
		if (e.key !== "Backspace" && e.key !== "Delete" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const { source, start, end } = this.capture();
		if (start !== end) return;
		const boundary = boundaryMath(source, start, e.key);
		if (!boundary) return;
		e.preventDefault();
		this.remembered = { start: boundary, end: boundary };
		this.paint(source, boundary, true);
	}

	private syncFromDom(): void {
		if (this.painting || this.disabled) return;
		const { source, start, end } = this.capture();
		if (start !== end) return;
		const pieces = segmentAnswer(source, start);
		if (structureKey(pieces) === this.paintKey && isClean(this.editor)) return;
		this.paint(source, start);
	}

	private capture(): { source: string; start: number; end: number } {
		const source = sourceOf(this.editor);
		const sel = this.doc.getSelection();
		if (!sel?.rangeCount || !sel.anchorNode || !this.editor.contains(sel.anchorNode)) {
			const start = Math.min(this.remembered.start, source.length);
			const end = Math.min(this.remembered.end, source.length);
			return { source, start, end };
		}
		const anchor = offsetAt(this.editor, sel.anchorNode, sel.anchorOffset);
		const focus = sel.isCollapsed || !sel.focusNode ? anchor : offsetAt(this.editor, sel.focusNode, sel.focusOffset);
		const start = Math.min(anchor, focus);
		const end = Math.max(anchor, focus);
		this.remembered = { start, end };
		return { source, start, end };
	}

	private paint(source: string, caret: number | null, force = false): void {
		const pieces = segmentAnswer(source, caret);
		const key = structureKey(pieces);
		if (!force && key === this.paintKey && isClean(this.editor)) return;
		this.paintKey = key;
		this.painting = true;
		const reuse = new Map<string, HTMLElement[]>();
		for (const atom of [...this.editor.querySelectorAll<HTMLElement>(":scope > .gw-math-atom")]) {
			const list = reuse.get(atom.dataset.source ?? "") ?? [];
			list.push(atom);
			reuse.set(atom.dataset.source ?? "", list);
		}
		const frag = this.doc.win.createFragment();
		for (const piece of pieces) {
			if (piece.kind === "text") {
				if (piece.text) frag.append(this.doc.createTextNode(piece.text));
				continue;
			}
			if (piece.live) {
				const live = this.doc.win.createSpan();
				live.className = "gw-math-live";
				live.append(this.doc.createTextNode(piece.raw));
				frag.append(live);
				continue;
			}
			const pooled = reuse.get(piece.raw);
			const atom = pooled?.shift() ?? this.makeAtom(piece);
			frag.append(atom);
		}
		this.editor.replaceChildren(frag);
		if (caret !== null) this.placeCaret(caret);
		this.painting = false;
	}

	private makeAtom(piece: Extract<AnswerPiece, { kind: "math" }>): HTMLElement {
		const atom = this.doc.win.createSpan();
		atom.className = `gw-math-atom${piece.display ? " is-display" : ""}`;
		atom.contentEditable = "false";
		atom.dataset.source = piece.raw;
		atom.title = "Click to edit";
		atom.addEventListener("mousedown", (e) => this.editAtom(e, atom));
		void this.renderMd(atom, piece.display ? `$$\n${piece.tex}\n$$` : `$${piece.tex}$`);
		return atom;
	}

	private editAtom(e: MouseEvent, atom: HTMLElement): void {
		if (this.disabled) return;
		e.preventDefault();
		const source = sourceOf(this.editor);
		const start = offsetBefore(this.editor, atom);
		const raw = atom.dataset.source ?? "";
		const delim = raw.startsWith("$$") ? 2 : 1;
		const rect = atom.getBoundingClientRect();
		const atStart = e.clientX <= rect.left + Math.max(8, rect.width * 0.3);
		const caret = atStart ? Math.min(source.length, start + delim) : Math.max(start + delim, start + raw.length - delim);
		this.remembered = { start: caret, end: caret };
		this.editor.focus({ preventScroll: true });
		this.paint(source, caret, true);
	}

	private placeCaret(offset: number): void {
		const sel = this.doc.getSelection();
		if (!sel) return;
		const range = this.doc.createRange();
		let left = offset;
		for (const child of this.editor.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				const len = child.textContent?.length ?? 0;
				if (left <= len) {
					range.setStart(child, left);
					range.collapse(true);
					sel.removeAllRanges();
					sel.addRange(range);
					return;
				}
				left -= len;
				continue;
			}
			if (!(child.instanceOf(HTMLElement))) continue;
			if (child.classList.contains("gw-math-live")) {
				const text = child.firstChild ?? child.appendChild(this.doc.createTextNode(""));
				const len = text.textContent?.length ?? 0;
				if (left <= len) {
					range.setStart(text, left);
					range.collapse(true);
					sel.removeAllRanges();
					sel.addRange(range);
					return;
				}
				left -= len;
				continue;
			}
			if (child.classList.contains("gw-math-atom")) {
				const len = child.dataset.source?.length ?? 0;
				if (left <= 0) {
					range.setStartBefore(child);
					range.collapse(true);
					sel.removeAllRanges();
					sel.addRange(range);
					return;
				}
				left -= len;
				if (left <= 0) {
					range.setStartAfter(child);
					range.collapse(true);
					sel.removeAllRanges();
					sel.addRange(range);
					return;
				}
			}
		}
		range.selectNodeContents(this.editor);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	}
}

function structureKey(pieces: AnswerPiece[]): string {
	return pieces.map((p) => (p.kind === "math" ? (p.live ? "L" : `M${p.raw}`) : "T")).join("\u0001");
}

/** A rendered formula touching the caret opens for editing instead of being skipped or deleted. */
function boundaryMath(source: string, caret: number, key: string): number | null {
	for (const piece of segmentAnswer(source, null)) {
		if (piece.kind !== "math") continue;
		const delim = piece.display ? 2 : 1;
		if ((key === "Backspace" || key === "ArrowLeft") && piece.end === caret) return Math.max(piece.start + delim, piece.end - delim);
		if ((key === "Delete" || key === "ArrowRight") && piece.start === caret) return Math.min(piece.end - delim, piece.start + delim);
	}
	return null;
}

function isClean(root: HTMLElement): boolean {
	for (const child of root.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) continue;
		if (child.instanceOf(HTMLElement) && (child.classList.contains("gw-math-atom") || child.classList.contains("gw-math-live"))) continue;
		return false;
	}
	return true;
}

function sourceOf(root: HTMLElement): string {
	let out = "";
	walkEditable(root, {
		text: (text) => {
			out += text;
		},
		atom: (raw) => {
			out += raw;
		},
		nl: () => {
			out += "\n";
		},
	});
	return out;
}

function offsetBefore(root: HTMLElement, target: Node): number {
	return offsetAt(root, target, 0);
}

function offsetAt(root: HTMLElement, node: Node, nodeOffset: number): number {
	if (node === root) {
		const at = Math.max(0, Math.min(nodeOffset, root.childNodes.length));
		if (at === 0) return 0;
		const range = root.ownerDocument.createRange();
		range.setStart(root, 0);
		range.setEnd(root, at);
		const holder = root.ownerDocument.win.createDiv();
		holder.append(range.cloneContents());
		return sourceOf(holder).length;
	}
	let count = 0;
	let found = false;
	walkEditable(root, {
		text: (text, current) => {
			if (found) return;
			if (current === node) {
				count += Math.max(0, Math.min(nodeOffset, text.length));
				found = true;
				return;
			}
			count += text.length;
		},
		atom: (raw, current) => {
			if (found) return;
			if (current === node || current.contains(node)) {
				count += current === node && nodeOffset <= 0 ? 0 : raw.length;
				found = true;
				return;
			}
			count += raw.length;
		},
		nl: () => {
			if (!found) count += 1;
		},
	});
	return found ? count : sourceOf(root).length;
}

/** Depth-first, with a newline before each block element the browser inserted. */
function walkEditable(root: HTMLElement, hooks: { text: (text: string, node: Text) => void; atom: (raw: string, node: HTMLElement) => void; nl: () => void }): void {
	let lineStart = true;
	const visit = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? "";
			if (!text) return;
			hooks.text(text, node as Text);
			lineStart = text.endsWith("\n");
			return;
		}
		if (!(node.instanceOf(HTMLElement))) return;
		if (node.classList.contains("gw-math-atom")) {
			hooks.atom(node.dataset.source ?? "", node);
			lineStart = false;
			return;
		}
		if (node.tagName === "BR") {
			hooks.nl();
			lineStart = true;
			return;
		}
		const children = [...node.childNodes];
		children.forEach((child, i) => {
			const block = child.instanceOf(HTMLElement) && (child.tagName === "DIV" || child.tagName === "P");
			if (block && (!lineStart || i > 0)) {
				hooks.nl();
				lineStart = true;
			}
			visit(child);
		});
	};
	const children = [...root.childNodes];
	children.forEach((child, i) => {
		const block = child.instanceOf(HTMLElement) && (child.tagName === "DIV" || child.tagName === "P");
		if (block && (!lineStart || i > 0)) {
			hooks.nl();
			lineStart = true;
		}
		visit(child);
	});
}
