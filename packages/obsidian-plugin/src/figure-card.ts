import { setIcon } from "obsidian";
import type { FigureKind } from "@groundwork/core";
import { parseSvgMarkup } from "./svg-fragment";

export interface FigureCardModel {
	id: string;
	title: string;
	caption?: string;
	kind?: FigureKind;
	quote?: string;
	svg?: string;
	collapsed?: boolean;
	pending?: boolean;
	error?: string;
}

export interface FigureCardCallbacks {
	toggle(collapsed: boolean): void;
	download(model: FigureCardModel): void;
	dismiss(): void;
	hover(on: boolean): void;
}

const KIND_LABEL: Record<FigureKind, string> = {
	plot: "Plot",
	plot3d: "3D plot",
	story: "Story",
	map: "Map",
	conjugation: "Conjugation",
	sentence: "Sentence",
};

/** A figure in the left margin: the picture, a caption, and download. */
export class FigureCard {
	readonly el: HTMLElement;
	private bodyEl: HTMLElement;
	private titleEl: HTMLElement;
	private kindEl: HTMLElement;

	constructor(
		parent: HTMLElement,
		private model: FigureCardModel,
		private readonly cb: FigureCardCallbacks,
	) {
		this.el = parent.createDiv({ cls: "gw-figure" });
		this.el.dataset.figure = model.id;
		this.el.addEventListener("mouseenter", () => cb.hover(true));
		this.el.addEventListener("mouseleave", () => cb.hover(false));

		const head = this.el.createDiv({ cls: "gw-figure-head" });
		setIcon(head.createSpan({ cls: "gw-figure-icon" }), "image");
		const titles = head.createDiv({ cls: "gw-figure-titles" });
		this.kindEl = titles.createDiv({ cls: "gw-figure-kind" });
		this.titleEl = titles.createDiv({ cls: "gw-figure-title" });
		const download = head.createEl("button", {
			cls: "clickable-icon gw-figure-btn",
			attr: { type: "button", "aria-label": "Download this figure" },
		});
		setIcon(download, "download");
		download.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.model.svg) cb.download(this.model);
		});
		const collapse = head.createEl("button", {
			cls: "clickable-icon gw-figure-btn gw-figure-collapse",
			attr: { type: "button", "aria-label": "Minimize figure" },
		});
		setIcon(collapse, "chevron-up");
		collapse.addEventListener("click", (e) => {
			e.stopPropagation();
			this.setCollapsed(!this.el.hasClass("is-collapsed"));
			cb.toggle(this.el.hasClass("is-collapsed"));
		});
		const dismiss = head.createEl("button", {
			cls: "clickable-icon gw-figure-btn gw-figure-dismiss",
			attr: { type: "button", "aria-label": "Dismiss figure" },
		});
		setIcon(dismiss, "x");
		dismiss.addEventListener("click", (e) => {
			e.stopPropagation();
			cb.dismiss();
		});

		this.bodyEl = this.el.createDiv({ cls: "gw-figure-body" });
		this.el.addEventListener("click", () => {
			if (this.el.hasClass("is-collapsed")) {
				this.setCollapsed(false);
				cb.toggle(false);
			}
		});
		this.paint();
	}

	update(model: FigureCardModel): void {
		this.model = model;
		this.el.dataset.figure = model.id;
		this.paint();
	}

	setActive(on: boolean): void {
		this.el.toggleClass("is-active", on);
	}

	private paint(): void {
		if (this.model.quote) this.el.dataset.quote = this.model.quote;
		else delete this.el.dataset.quote;
		const kind = this.model.kind ? KIND_LABEL[this.model.kind] : "Figure";
		this.kindEl.setText(kind);
		this.titleEl.setText(this.model.title);
		this.bodyEl.empty();
		this.el.toggleClass("is-pending", !!this.model.pending);
		this.el.toggleClass("is-error", !!this.model.error);
		this.el.querySelector(".gw-figure-dismiss")?.toggleAttribute("hidden", !this.model.error);
		const download = this.el.querySelector<HTMLButtonElement>(".gw-figure-btn:not(.gw-figure-collapse):not(.gw-figure-dismiss)");
		if (download) download.disabled = !this.model.svg;
		if (this.model.error) {
			this.bodyEl.createDiv({ cls: "gw-figure-error", text: this.model.error });
			this.setCollapsed(false);
			return;
		}
		if (this.model.pending || !this.model.svg) {
			const pending = this.bodyEl.createDiv({ cls: "gw-figure-pending", text: "Drawing a figure…" });
			pending.setAttr("role", "status");
			this.setCollapsed(false);
			return;
		}
		const frame = this.bodyEl.createDiv({ cls: "gw-figure-frame" });
		const svg = parseSvgMarkup(this.model.svg, this.el.ownerDocument);
		svg.classList.add("gw-figure-svg");
		frame.appendChild(svg);
		if (this.model.caption) this.bodyEl.createDiv({ cls: "gw-figure-caption", text: this.model.caption });
		this.setCollapsed(!!this.model.collapsed);
	}

	private setCollapsed(on: boolean): void {
		if (this.model.pending || this.model.error) on = false;
		this.el.toggleClass("is-collapsed", on);
		const btn = this.el.querySelector<HTMLButtonElement>(".gw-figure-collapse");
		btn?.setAttr("aria-label", on ? "Expand figure" : "Minimize figure");
		btn?.setAttr("aria-expanded", on ? "false" : "true");
	}
}

export function downloadFigure(doc: Document, title: string, svg: string): void {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "figure";
	const blob = new Blob([svg], { type: "image/svg+xml" });
	const url = URL.createObjectURL(blob);
	const a = doc.createElement("a");
	a.href = url;
	a.download = `${slug}.svg`;
	a.rel = "noopener";
	doc.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
