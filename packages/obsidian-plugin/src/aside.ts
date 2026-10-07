import { finishRenderMath, renderMath, setIcon } from "obsidian";
import type { AsideThread } from "@groundwork/core";
import { mathQuote } from "./math-source";

export type RenderInto = (el: HTMLElement, markdown: string) => Promise<void>;

export interface AsideCallbacks {
	send(text: string): void;
	resolve(): void;
	hover(on: boolean): void;
}

/** A margin comment thread: the highlighted quote, the Q&A, and a reply box. */
export class AsideCard {
	readonly el: HTMLElement;
	private listEl: HTMLElement;
	private inputEl: HTMLTextAreaElement;
	private sendEl: HTMLButtonElement;
	private busy = false;

	constructor(
		parent: HTMLElement,
		readonly thread: AsideThread,
		private readonly render: RenderInto,
		private readonly cb: AsideCallbacks,
	) {
		const hint = thread.kind === "hint";
		this.el = parent.createDiv({ cls: `gw-aside${hint ? " is-hint" : ""}` });
		this.el.dataset.thread = thread.id;
		this.el.addEventListener("mouseenter", () => cb.hover(true));
		this.el.addEventListener("mouseleave", () => cb.hover(false));

		const head = this.el.createDiv({ cls: "gw-aside-head" });
		setIcon(head.createSpan({ cls: "gw-aside-icon" }), hint ? "lightbulb" : "message-square-quote");
		renderQuote(head.createDiv({ cls: "gw-aside-quote" }), thread.quote.replace(/\s+/g, " ").trim());
		const collapse = head.createEl("button", { cls: "clickable-icon gw-aside-btn", attr: { "aria-label": "Collapse", type: "button" } });
		setIcon(collapse, "chevron-up");
		collapse.addEventListener("click", (e) => {
			e.stopPropagation();
			this.setCollapsed(!this.el.hasClass("is-collapsed"));
		});
		const done = head.createEl("button", { cls: "clickable-icon gw-aside-btn", attr: { "aria-label": "Resolve (keeps it in the session)", type: "button" } });
		setIcon(done, "check");
		done.addEventListener("click", (e) => {
			e.stopPropagation();
			cb.resolve();
		});

		this.listEl = this.el.createDiv({ cls: "gw-aside-list" });
		for (const m of thread.messages) void this.renderMessage(m.role, m.text);

		const composer = this.el.createDiv({ cls: "gw-aside-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "gw-aside-input",
			attr: { rows: "1", placeholder: this.composerPlaceholder() },
		});
		this.sendEl = composer.createEl("button", { cls: "clickable-icon gw-aside-send", attr: { "aria-label": "Ask", type: "button" } });
		setIcon(this.sendEl, "arrow-up");
		this.sendEl.addEventListener("click", () => this.submit());
		this.inputEl.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			} else if (e.key === "Escape") {
				this.inputEl.blur();
			}
		});
		this.inputEl.addEventListener("input", () => this.grow());
		this.el.addEventListener("click", () => {
			if (this.el.hasClass("is-collapsed")) this.setCollapsed(false);
		});
		if (thread.messages.length) this.setCollapsed(true);
	}

	focus(): void {
		this.setCollapsed(false);
		this.inputEl.focus({ preventScroll: true });
	}

	setActive(on: boolean): void {
		this.el.toggleClass("is-active", on);
	}

	private setCollapsed(on: boolean): void {
		this.el.toggleClass("is-collapsed", on);
		const n = this.thread.messages.filter((m) => m.role === "user").length;
		const noun = this.thread.kind === "hint" ? "hint" : "question";
		this.el.dataset.count = n ? `${n} ${noun}${n === 1 ? "" : "s"}` : "";
	}

	private composerPlaceholder(): string {
		if (this.thread.kind === "hint") return "Ask for a stronger nudge…";
		return this.thread.messages.length ? "Reply…" : "Ask about this passage…";
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (!text || this.busy) return;
		this.inputEl.value = "";
		this.grow();
		this.inputEl.placeholder = this.composerPlaceholder();
		this.cb.send(text);
	}

	private grow(): void {
		this.inputEl.setCssStyles({ height: "auto" });
		this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 160)}px` });
	}

	async renderMessage(role: "user" | "assistant", text: string): Promise<HTMLElement> {
		const el = this.listEl.createDiv({ cls: `gw-aside-msg is-${role}` });
		if (role === "user") el.setText(text);
		else {
			el.addClass("markdown-rendered");
			await this.render(el, text);
		}
		return el;
	}

	/** Streams a reply into a new bubble; returns handlers the caller feeds. */
	startReply(): { append(delta: string): void; finish(error?: string): string } {
		this.setBusy(true);
		const el = this.listEl.createDiv({ cls: "gw-aside-msg is-assistant markdown-rendered is-pending" });
		const dots = el.createDiv({ cls: "gw-thinking" });
		for (let i = 0; i < 3; i++) dots.createSpan({ cls: "gw-dot" });
		let text = "";
		let timer: number | null = null;
		let version = 0;
		const paint = async () => {
			const v = ++version;
			const next = createDiv();
			await this.render(next, text);
			if (v !== version) return;
			el.empty();
			while (next.firstChild) el.appendChild(next.firstChild);
		};
		return {
			append: (delta) => {
				text += delta;
				if (timer === null) {
					timer = window.setTimeout(() => {
						timer = null;
						void paint();
					}, 80);
				}
			},
			finish: (error) => {
				if (timer !== null) window.clearTimeout(timer);
				timer = null;
				el.removeClass("is-pending");
				this.setBusy(false);
				if (error && !text.trim()) {
					el.empty();
					el.addClass("is-error");
					el.setText(error);
					return "";
				}
				void paint();
				return text.trim();
			},
		};
	}

	private setBusy(on: boolean): void {
		this.busy = on;
		this.sendEl.disabled = on;
		this.el.toggleClass("is-busy", on);
	}
}

/** Plain text with its `$TeX$` spans typeset inline. */
function renderQuote(el: HTMLElement, quote: string): void {
	const parts = quote.split(/(\$\$[^$]+\$\$|\$[^$\s][^$]*\$)/);
	if (parts.length === 1) return el.setText(quote);
	parts.forEach((part, i) => {
		if (i % 2) el.appendChild(renderMath(part.replace(/^\$+|\$+$/g, "").trim(), false));
		else if (part) el.appendText(part);
	});
	void finishRenderMath();
}

/** Finds `quote` inside `root`'s text, ignoring whitespace differences, and returns it as a Range. */
export function findQuoteRange(root: HTMLElement, quote: string): Range | null {
	const needle = quote.replace(/\s+/g, "");
	if (!needle) return null;
	const skip = ".gw-aside, .gw-asides, .gw-figure, .gw-figures, mjx-container, .math, svg";
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode: (n) => {
			if (n.parentElement?.closest(skip)) return NodeFilter.FILTER_REJECT;
			if (n.instanceOf(Text)) return NodeFilter.FILTER_ACCEPT;
			const el = n as HTMLElement;
			if (el.matches(".math[data-tex]")) return NodeFilter.FILTER_ACCEPT;
			return el.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
		},
	});
	// A formula is one unit, matched by its TeX; offset -1 marks it.
	const nodes: Node[] = [];
	const offsets: number[] = [];
	let hay = "";
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const math = n.instanceOf(Text) ? null : (n as HTMLElement);
		const s = math ? mathQuote(math) : (n as Text).data;
		for (let i = 0; i < s.length; i++) {
			if (/\s/.test(s[i])) continue;
			hay += s[i];
			nodes.push(n);
			offsets.push(math ? -1 : i);
		}
	}
	let at = hay.indexOf(needle);
	let len = needle.length;
	if (at < 0) {
		// Math renders to glyphs, so a quote spanning a formula won't match verbatim; anchor on its opening words.
		const head = needle.slice(0, Math.min(needle.length, 40));
		at = head.length >= 6 ? hay.indexOf(head) : -1;
		len = head.length;
	}
	if (at < 0) return null;
	const range = document.createRange();
	const last = at + len - 1;
	if (offsets[at] < 0) range.setStartBefore(nodes[at]);
	else range.setStart(nodes[at], offsets[at]);
	if (offsets[last] < 0) range.setEndAfter(nodes[last]);
	else range.setEnd(nodes[last], offsets[last] + 1);
	return range;
}
