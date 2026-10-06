/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FigureCard, openFigureStage, type FigureCardModel } from "../src/figure-card";

vi.mock("obsidian", () => ({
	setIcon(el: HTMLElement, icon: string) {
		el.dataset.icon = icon;
	},
	Notice: class Notice {
		constructor(public message: string) {}
	},
}));

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, Function>;
	proto.empty = function empty(this: HTMLElement) {
		this.replaceChildren();
	};
	proto.setText = function setText(this: HTMLElement, text: string) {
		this.textContent = text;
	};
	proto.hasClass = function hasClass(this: HTMLElement, cls: string) {
		return this.classList.contains(cls);
	};
	proto.toggleClass = function toggleClass(this: HTMLElement, cls: string, force?: boolean) {
		this.classList.toggle(cls, force);
	};
	proto.setAttr = function setAttr(this: HTMLElement, key: string, value: string) {
		this.setAttribute(key, value);
	};
	proto.createEl = function createEl(this: HTMLElement, tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		const el = this.ownerDocument.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) {
			for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
		}
		this.append(el);
		return el;
	};
	proto.createDiv = function createDiv(this: HTMLElement, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		return this.createEl("div", opts);
	};
	proto.createSpan = function createSpan(this: HTMLElement, opts?: { cls?: string; text?: string }) {
		return this.createEl("span", opts);
	};
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="8" cy="8" r="4"/></svg>`;

function hostWithLesson(): { host: HTMLElement; lesson: HTMLElement } {
	document.body.innerHTML = "";
	const host = document.createElement("div");
	host.className = "gw-root";
	const lesson = document.createElement("div");
	lesson.textContent = "Second-order sufficient condition";
	host.append(lesson);
	document.body.append(host);
	return { host, lesson };
}

describe("full screen figure", () => {
	it("covers the tutor and restores it on close", () => {
		const { host, lesson } = hostWithLesson();
		const opener = document.createElement("button");
		host.append(opener);
		const close = openFigureStage(document, host, { id: "fig_1", title: "Hessian", svg, caption: "Positive definite" }, opener);
		const stage = host.querySelector(".gw-figure-stage") as HTMLElement;
		expect(stage.getAttribute("role")).toBe("dialog");
		expect(stage.getAttribute("aria-modal")).toBe("true");
		expect(stage.textContent).toContain("Hessian");
		expect(stage.textContent).toContain("Positive definite");
		expect(stage.querySelector("svg circle")).toBeTruthy();
		expect(lesson.hasAttribute("inert")).toBe(true);
		expect(document.activeElement).toBe(stage.querySelector("button"));
		close();
		expect(host.querySelector(".gw-figure-stage")).toBeNull();
		expect(lesson.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(opener);
	});

	it("closes from Escape even while the window is full screen", () => {
		const { host } = hostWithLesson();
		openFigureStage(document, host, { id: "fig_4", title: "Curve", svg });
		const stage = host.querySelector(".gw-figure-stage") as HTMLElement;
		Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => stage });
		try {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(host.querySelector(".gw-figure-stage")).toBeNull();
		} finally {
			delete (document as { fullscreenElement?: Element }).fullscreenElement;
		}
	});

	it("closes from Escape and from the backdrop", () => {
		const { host } = hostWithLesson();
		openFigureStage(document, host, { id: "fig_2", title: "Curve", svg });
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(host.querySelector(".gw-figure-stage")).toBeNull();

		openFigureStage(document, host, { id: "fig_3", title: "Curve", svg });
		const stage = host.querySelector(".gw-figure-stage") as HTMLElement;
		stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(host.querySelector(".gw-figure-stage")).toBeNull();
	});

	it("opens from the card button or the picture, and closing leaves the card", () => {
		const { host, card } = figureCard({ id: "fig_9", title: "Sufficient condition", kind: "plot", svg, caption: "A valley" });
		const full = card.el.querySelector(".gw-figure-full") as HTMLButtonElement;
		expect(full.hidden).toBe(false);
		expect(full.getAttribute("aria-label")).toBe("View this figure full screen");
		full.click();
		expect(host.querySelector(".gw-figure-stage")?.textContent).toContain("Sufficient condition");
		(host.querySelector(".gw-figure-stage-close") as HTMLButtonElement).click();
		expect(host.querySelector(".gw-figure-stage")).toBeNull();
		expect(host.querySelector(".gw-figure")).toBe(card.el);

		card.el.querySelector(".gw-figure-frame")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		const stage = host.querySelector(".gw-figure-stage");
		expect(stage).toBeTruthy();
		expect(document.activeElement).toBe(stage?.querySelector("button"));
	});

	it("hides full screen until a picture exists", () => {
		const pending = figureCard({ id: "fig_p", title: "Drawing", pending: true });
		expect(pending.card.el.querySelector(".gw-figure-full")).toBeNull();
		const failed = figureCard({ id: "fig_e", title: "Drawing", error: "Couldn’t draw that" });
		expect(failed.card.el.querySelector(".gw-figure-full")).toBeNull();
	});
});

function figureCard(model: FigureCardModel): { host: HTMLElement; card: FigureCard } {
	document.body.innerHTML = "";
	const host = document.createElement("div");
	host.className = "gw-root";
	const figures = document.createElement("div");
	figures.className = "gw-figures";
	host.append(figures);
	document.body.append(host);
	const card = new FigureCard(figures, model, {
		toggle() {},
		download() {},
		dismiss() {},
		hover() {},
	});
	return { host, card };
}
