import type { ConceptMapModel } from "@groundwork/core";
import { appendSvgFragment } from "./svg-fragment";
import { mountConceptMapGraph } from "./force-graph-host";

const NS = "http://www.w3.org/2000/svg";
export interface MapPaneOptions {
	scope: "path" | "all";
	showGhosts: boolean;
	goalTitle?: string;
	onScope: (scope: "path" | "all") => void;
	onGhosts: (on: boolean) => void;
	onStart?: (title: string) => void;
	onStudy?: (title: string, action: "quiz" | "learn") => void;
	onOpenGoals?: () => void;
}

function obsidianColor(doc: Document, cssVar: string, fallback: string): string {
	const raw = doc.defaultView?.getComputedStyle(doc.body).getPropertyValue(cssVar).trim();
	return raw || fallback;
}

export function renderMapPane(parent: HTMLElement, model: ConceptMapModel | null, options: MapPaneOptions): void {
	parent.replaceChildren();
	const row = el(parent, "div", "gw-map-row");
	const wrap = el(row, "div", "gw-mapwrap");
	if (!model || !model.nodes.length) {
		const empty = el(wrap, "div", "gw-map-empty");
		empty.append("Pin a goal to see which concepts lead to it. Dashed nodes are still ahead on the path.");
		const cta = el(empty, "button", "gw-next-btn");
		cta.type = "button";
		cta.textContent = "Open goals";
		cta.setAttribute("title", "Choose or create a goal");
		cta.addEventListener("click", () => options.onOpenGoals?.());
		return;
	}
	const mapSlot = el(wrap, "div", "gw-force-map");
	mapSlot.createDiv({ cls: "gw-force-slot" });
	mountConceptMapGraph(wrap, model, { onStart: options.onStart, onStudy: options.onStudy });
	const bar = el(wrap, "div", "gw-map-toolbar");
	const seg = el(bar, "div", "gw-seg");
	seg.append(
		segBtn("All concepts", options.scope === "all", () => options.onScope("all")),
		segBtn("Goal path", options.scope === "path", () => options.onScope("path")),
	);
	const toggle = el(bar, "button", "gw-toggle");
	toggle.type = "button";
	toggle.setAttribute("aria-pressed", options.showGhosts ? "true" : "false");
	const sw = el(toggle, "span", `gw-switch-ui${options.showGhosts ? " is-on" : ""}`);
	sw.setAttribute("aria-hidden", "true");
	toggle.append("Show concepts still ahead");
	toggle.addEventListener("click", () => options.onGhosts(!options.showGhosts));
	const hint = el(bar, "p", "gw-map-click-hint");
	hint.textContent = "Click a node to study or quiz it in chat.";
	const doc = parent.ownerDocument;
	const key = el(wrap, "div", "gw-map-key");
	for (const [cssVar, fallback, label] of [
		["--color-green", "#3CC56F", "Solid"],
		["--color-blue", "#45A9F0", "Learning"],
		["--color-orange", "#F7A93E", "Needs work"],
	] as const) {
		const item = el(key, "span");
		const dot = el(item, "i", "gw-dot");
		dot.style.background = obsidianColor(doc, cssVar, fallback);
		item.append(label);
	}
	const ahead = el(key, "span");
	el(ahead, "i", "gw-key-ghost");
	ahead.append("Not started");

	const side = el(row, "aside", "gw-side");
	const head = el(side, "div", "gw-side-head");
	head.append("Goal path");
	const body = el(side, "div", "gw-path");
	const goal = model.nodes.find((node) => node.id === model.goalNodeId);
	const kicker = el(body, "div", "gw-kicker");
	kicker.textContent = "Working toward";
	el(body, "div", "gw-path-title", goal?.title ?? options.goalTitle ?? "Goal");
	if (goal?.subtitle) {
		const sub = el(body, "div", "gw-path-sub");
		sub.append(flagIcon(sub.ownerDocument), document.createTextNode(goal.subtitle.replace(/^Goal · /, "")));
	}
	const prog = el(body, "div", "gw-prog");
	const filled = Math.round(model.total ? (model.inPlace / model.total) * 6 : 0);
	for (let i = 0; i < 6; i++) el(prog, "i", i < filled ? "is-done" : i === filled ? "is-partial" : "");
	const labels = el(body, "div", "gw-prog-label");
	el(labels, "span", "", `${model.inPlace} of ${model.total} concepts in place`);
	const steps = el(body, "div", "gw-steps");
	for (const step of model.steps) {
		const rowEl = el(steps, "div", `gw-step${step.visual === "ghost" ? " is-ghost" : ""}${step.meta === "next" ? " is-next" : ""}`);
		rowEl.append(stepMark(parent.ownerDocument, step.visual, step.step, step.meta === "next"));
		el(rowEl, "span", "gw-step-name", step.title);
		el(rowEl, "span", "gw-step-meta", step.meta);
	}
	const next = model.steps.find((step) => step.meta === "next") ?? model.steps.find((step) => step.visual === "ghost");
	if (next && options.onStart) {
		const button = el(body, "button", "gw-next-btn");
		button.type = "button";
		button.append(`Start: ${next.title}`, arrowIcon(parent.ownerDocument));
		button.addEventListener("click", () => options.onStart?.(next.title));
	}
	el(body, "p", "gw-path-why", "Solid nodes mean a quiz showed you know them. Start with the highlighted next step.");
}

function stepMark(doc: Document, visual: string, step: number | undefined, next: boolean): HTMLElement {
	const span = doc.createElement("span");
	span.className = `gw-step-n is-${next ? "next" : visual === "known" ? "known" : visual === "shaky" || visual === "rusty" ? "shaky" : visual === "goal" ? "goal" : "ghost"}`;
	if (visual === "known") span.append(checkIcon(doc));
	else if (visual === "goal") span.append(flagIcon(doc));
	else if (visual === "shaky" || visual === "rusty") span.textContent = "!";
	else span.textContent = String(step ?? "");
	return span;
}

function segBtn(label: string, on: boolean, click: () => void): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = on ? "is-on" : "";
	button.textContent = label;
	button.addEventListener("click", click);
	return button;
}

function flagIcon(doc: Document): SVGElement {
	return icon(doc, `<path d="M5 21V4M5 4h11l-2 4 2 4H5"></path>`);
}
function checkIcon(doc: Document): SVGElement {
	return icon(doc, `<path d="M5 12l5 5 9-10"></path>`);
}
function arrowIcon(doc: Document): SVGElement {
	return icon(doc, `<path d="M5 12h14M13 6l6 6-6 6"></path>`);
}
function icon(doc: Document, fragment: string): SVGElement {
	const svg = doc.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	appendSvgFragment(svg, fragment);
	return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = parent.ownerDocument.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	parent.append(node);
	return node;
}
