import type { ConceptMapModel, ForceGraphData } from "@groundwork/core";
import { appendSvgFragment } from "./svg-fragment";
import { mountConceptMapGraph, mountInteractiveGraph } from "./force-graph-host";

const NS = "http://www.w3.org/2000/svg";
export interface MapPaneOptions {
	goalTitle?: string;
	emptyMessage?: string;
	onStart?: (title: string) => void;
	onStudy?: (title: string, action: "quiz" | "learn") => void;
	onOpenGoals?: () => void;
}

/** Concepts the learner has already begun — no working goal pinned. */
export function renderStartedVaultMap(parent: HTMLElement, data: ForceGraphData, options: MapPaneOptions): void {
	parent.replaceChildren();
	if (!data.nodes.length) {
		renderMapPane(parent, null, {
			...options,
			emptyMessage: "Start studying a concept in Learn, then it will show up here.",
		});
		return;
	}
	const row = el(parent, "div", "gw-map-row gw-map-row-started");
	const wrap = el(row, "div", "gw-mapwrap");
	const mapHost = el(wrap, "div", "gw-force-map");
	const slot = mapHost.createDiv({ cls: "gw-force-slot" });
	mountInteractiveGraph(slot, data, {
		onNodeClick: (_id, title) => options.onStudy?.(title, "learn"),
	});
	const bar = el(wrap, "div", "gw-map-toolbar");
	const hint = el(bar, "p", "gw-map-click-hint");
	hint.textContent = "Only concepts you have started appear here. Pin a goal in Learn to see the full path to that goal.";
	appendMapKey(wrap, parent.ownerDocument, { startedOnly: true });
}

function appendMapKey(parent: HTMLElement, doc: Document, opts: { startedOnly: boolean }): void {
	const key = el(parent, "div", "gw-map-key");
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
	if (!opts.startedOnly) {
		const solid = el(key, "span", "gw-key-edge is-solid");
		solid.append("Solid arrow — next step on the path up");
		const dashed = el(key, "span", "gw-key-edge is-dashed");
		dashed.append("Dashed arrow — groundwork outside this goal");
	}
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
		empty.append(options.emptyMessage ?? "Pin a goal to see your path from groundwork up to the goal.");
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
	const hint = el(bar, "p", "gw-map-click-hint");
	hint.textContent = "Foundations sit at the bottom; your working goal is the red node on top. Click a concept to study it.";
	const doc = parent.ownerDocument;
	appendMapKey(wrap, doc, { startedOnly: false });

	const side = el(row, "aside", "gw-side");
	const head = el(side, "div", "gw-side-head");
	head.append("Path to your goal");
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
	el(body, "p", "gw-path-why", "You build a pyramid: simple concepts are the groundwork; each arrow is a step toward the goal on top.");
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
