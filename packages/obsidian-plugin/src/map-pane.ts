import { describeConceptProgress, masteryTone, MASTERY_HINT, MASTERY_TONES, STUDY_MOVE_HINT, studyMove, type ConceptMapModel, type ForceGraphData, type MasteryTone, type PathStep, type StudyMove } from "@groundwork/core";
import { masteryDot, setTone, toneLabel } from "./mastery-ui";
import { appendSvgFragment } from "./svg-fragment";
import { mountConceptMapGraph, mountInteractiveGraph } from "./force-graph-host";

const NS = "http://www.w3.org/2000/svg";
export interface MapPaneOptions {
	goalTitle?: string;
	emptyMessage?: string;
	onStudy?: (title: string, move: StudyMove) => void;
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
	const slot = el(mapHost, "div", "gw-force-slot");
	const statusOf = new Map(data.nodes.map((node) => [node.id, node.status ?? "unassessed"] as const));
	mountInteractiveGraph(slot, data, {
		onNodeClick: (id, title) => options.onStudy?.(title, studyMove(masteryTone(statusOf.get(id) ?? "unassessed"))),
	});
	const bar = el(wrap, "div", "gw-map-toolbar");
	const hint = el(bar, "p", "gw-map-click-hint");
	hint.textContent = "Concepts you have started. Pin a goal in Working on to see the path to it. Click a concept to study it.";
	appendMapKey(wrap, { tones: MASTERY_TONES.filter((tone) => tone !== "unstarted"), pinned: false });
}

/** The legend draws the same marks the graph and the path panel do. */
export function appendMapKey(parent: HTMLElement, opts: { tones?: readonly MasteryTone[]; pinned: boolean }): HTMLElement {
	const key = el(parent, "div", "gw-map-key");
	key.setAttribute("aria-label", "Map key");
	for (const tone of opts.tones ?? MASTERY_TONES) {
		const item = el(key, "span", "gw-key-item");
		item.title = MASTERY_HINT[tone];
		masteryDot(item, tone);
		item.append(toneLabel(tone));
	}
	if (!opts.pinned) return key;
	const goal = el(key, "span", "gw-key-item");
	masteryDot(goal, "goal");
	goal.append("Goal");
	const next = el(key, "span", "gw-key-item");
	el(next, "i", "gw-key-next");
	next.append("Next");
	const off = el(key, "span", "gw-key-item");
	off.title = "In this goal, but not on the chain up to its target";
	const faded = masteryDot(off, "learning");
	faded.classList.add("is-faded");
	off.append("Off the path");
	el(key, "span", "gw-key-edge", "Prerequisite → concept");
	el(key, "span", "gw-key-edge is-dashed", "Outside the path");
	return key;
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
	el(mapSlot, "div", "gw-force-slot");
	mountConceptMapGraph(wrap, model, { onStudy: options.onStudy });
	const bar = el(wrap, "div", "gw-map-toolbar");
	const hint = el(bar, "p", "gw-map-click-hint");
	hint.textContent = "Foundations at the bottom, your goal on top. Click a concept to study it.";
	appendMapKey(wrap, { pinned: true });

	const doc = parent.ownerDocument;
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
		sub.append(flagIcon(doc), doc.createTextNode(goal.subtitle.replace(/^Goal · /, "")));
	}
	const prog = el(body, "div", "gw-prog");
	const filled = Math.round(model.total ? (model.inPlace / model.total) * 6 : 0);
	for (let i = 0; i < 6; i++) el(prog, "i", i < filled ? "is-done" : i === filled ? "is-partial" : "");
	const labels = el(body, "div", "gw-prog-label");
	el(labels, "span", "", describeConceptProgress(model.inPlace, model.total));
	const steps = el(body, "div", "gw-steps");
	for (const step of model.steps) drawStep(steps, step, options);
	const next = model.steps.find((step) => step.label === "Next") ?? model.steps.find((step) => step.tone === "unstarted");
	if (next && options.onStudy) {
		const button = el(body, "button", "gw-next-btn");
		button.type = "button";
		button.append(`Start: ${next.title}`, arrowIcon(doc));
		button.addEventListener("click", () => options.onStudy?.(next.title, "start"));
	}
}

function drawStep(parent: HTMLElement, step: PathStep, options: MapPaneOptions): void {
	const isNext = step.label === "Next";
	const move = studyMove(step.tone, isNext);
	const row = el(parent, "button", `gw-step${isNext ? " is-next" : ""}${step.offPath ? " is-off" : ""}`);
	row.type = "button";
	row.dataset.tone = step.tone;
	row.title = `${step.label}${step.offPath ? " · off the path to the goal" : ""} — ${STUDY_MOVE_HINT[move]}`;
	row.append(stepMark(parent.ownerDocument, step, isNext));
	el(row, "span", "gw-step-name", step.title);
	el(row, "span", "gw-step-meta", step.label);
	row.addEventListener("click", () => options.onStudy?.(step.title, move));
}

/** The node's own mark: a filled disc in its tone, a dashed ring when not started, the red goal with a flag, and the next ring. */
function stepMark(doc: Document, step: PathStep, next: boolean): HTMLElement {
	const span = doc.createElement("span");
	span.className = `gw-step-n${next ? " is-next" : ""}`;
	setTone(span, step.tone);
	if (step.tone === "goal") span.append(flagIcon(doc));
	else if (step.tone === "solid") span.append(checkIcon(doc));
	else if (step.tone === "unstarted" && step.step) span.textContent = String(step.step);
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
