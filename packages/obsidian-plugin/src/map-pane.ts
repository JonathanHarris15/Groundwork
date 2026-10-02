import type { ConceptMapModel } from "@groundwork/core";

const NS = "http://www.w3.org/2000/svg";
let mapSerial = 0;
const FILL: Record<string, string> = {
	known: "#3CC56F",
	learning: "#45A9F0",
	shaky: "#F7A93E",
	rusty: "#9d8cf0",
	goal: "#F0565B",
};

export interface MapPaneOptions {
	scope: "path" | "all";
	showGhosts: boolean;
	goalTitle?: string;
	onScope: (scope: "path" | "all") => void;
	onGhosts: (on: boolean) => void;
	onStart?: (title: string) => void;
}

export function renderMapPane(parent: HTMLElement, model: ConceptMapModel | null, options: MapPaneOptions): void {
	parent.replaceChildren();
	const row = el(parent, "div", "gw-map-row");
	const wrap = el(row, "div", "gw-mapwrap");
	if (!model || !model.nodes.length) {
		const empty = el(wrap, "div", "gw-map-empty");
		empty.append("Pin a goal to see the path toward it. Ghost concepts are what still has to be learned before that goal.");
		return;
	}
	wrap.append(drawMap(parent.ownerDocument, model));
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
	toggle.append("Show ghost concepts");
	toggle.addEventListener("click", () => options.onGhosts(!options.showGhosts));
	const key = el(wrap, "div", "gw-map-key");
	for (const [color, label] of [
		["#3CC56F", "Known"],
		["#45A9F0", "Learning"],
		["#F7A93E", "Shaky"],
	] as const) {
		const item = el(key, "span");
		const dot = el(item, "i", "gw-dot");
		dot.style.background = color;
		item.append(label);
	}
	key.append(keyLine("gw-key-ghost", "Ghost, not learned yet"), keyLine("gw-key-built", "Path you have built"), keyLine("gw-key-ahead", "Path still to build"));

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
	el(body, "p", "gw-path-why", "Ghost concepts are what Groundwork thinks you still need before the goal. They turn solid once a quiz shows you know them.");
}

function drawMap(doc: Document, model: ConceptMapModel): SVGSVGElement {
	const svg = doc.createElementNS(NS, "svg");
	svg.setAttribute("class", "gw-concept-map");
	svg.setAttribute("viewBox", model.viewBox);
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", "Concept map with the goal path and ghost concepts");
	const defs = doc.createElementNS(NS, "defs");
	const grad = doc.createElementNS(NS, "linearGradient");
	const gradId = `gw-path-${++mapSerial}`;
	grad.id = gradId;
	grad.setAttribute("x1", "0");
	grad.setAttribute("x2", "1");
	grad.innerHTML = `<stop offset="0" stop-color="#3CC56F"></stop><stop offset="1" stop-color="#45A9F0"></stop>`;
	defs.append(grad);
	svg.append(defs);
	const byId = new Map(model.nodes.map((node) => [node.id, node]));
	for (const edge of model.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) continue;
		const line = doc.createElementNS(NS, "line");
		line.setAttribute("x1", String(from.x));
		line.setAttribute("y1", String(from.y));
		line.setAttribute("x2", String(to.x));
		line.setAttribute("y2", String(to.y));
		line.setAttribute("class", `gw-edge is-${edge.kind}`);
		if (edge.kind === "built") line.setAttribute("stroke", `url(#${gradId})`);
		svg.append(line);
	}
	for (const node of model.nodes) svg.append(drawNode(doc, node));
	return svg;
}

function drawNode(doc: Document, node: ConceptMapModel["nodes"][number]): SVGGElement {
	const g = doc.createElementNS(NS, "g");
	g.setAttribute("class", `gw-node is-${node.visual}`);
	const add = (tag: string, attrs: Record<string, string>) => {
		const shape = doc.createElementNS(NS, tag);
		for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
		g.append(shape);
		return shape;
	};
	if (node.visual === "goal") add("circle", { cx: String(node.x), cy: String(node.y), r: "30", class: "gw-goal-ring" });
	if (node.next) add("circle", { cx: String(node.x), cy: String(node.y), r: "15", class: "gw-next-ring" });
	const fill = FILL[node.visual];
	if (fill && node.visual !== "goal") {
		add("circle", { cx: String(node.x), cy: String(node.y), r: String(node.r + 8), fill, opacity: "0.16" });
		add("circle", { cx: String(node.x), cy: String(node.y), r: String(node.r), fill });
	} else if (node.visual === "goal") {
		add("circle", {
			cx: String(node.x),
			cy: String(node.y),
			r: String(node.r),
			fill: "#1e1e1e",
			stroke: "#F0565B",
			"stroke-width": "2.5",
			"stroke-dasharray": "5 5",
		});
		const icon = doc.createElementNS(NS, "path");
		icon.setAttribute("transform", `translate(${node.x} ${node.y})`);
		icon.setAttribute("d", "M-6 9V-9M-6 -9h11l-2.5 4 2.5 4H-6");
		icon.setAttribute("stroke", "#F0565B");
		icon.setAttribute("stroke-width", "2");
		icon.setAttribute("fill", "none");
		icon.setAttribute("stroke-linecap", "round");
		icon.setAttribute("stroke-linejoin", "round");
		g.append(icon);
	} else if (node.visual === "ghost") {
		add("circle", {
			cx: String(node.x),
			cy: String(node.y),
			r: String(node.r),
			fill: "rgba(255,255,255,.03)",
			stroke: node.next ? "#45A9F0" : "#6b6f76",
			"stroke-width": "1.8",
			"stroke-dasharray": "4 4",
		});
		const num = add("text", { x: String(node.x), y: String(node.y + 4), "text-anchor": "middle", class: node.next ? "gw-num is-next" : "gw-num" });
		num.textContent = String(node.step ?? "");
	} else {
		add("circle", {
			cx: String(node.x),
			cy: String(node.y),
			r: String(node.r),
			fill: "none",
			stroke: "#3a3d42",
			"stroke-width": "1.5",
			"stroke-dasharray": "3 4",
		});
	}
	if (node.next) {
		const badge = add("text", { x: String(node.x), y: String(node.y - node.r - 12), "text-anchor": "middle", class: "gw-next-label" });
		badge.textContent = "Next up";
	}
	const label = add("text", {
		x: String(node.x),
		y: String(node.y + node.r + 20),
		"text-anchor": "middle",
		class: `gw-node-label${node.visual === "goal" ? " is-goal" : ""}${node.visual === "ghost" ? " is-ghost" : ""}${node.visual === "dim" || node.visual === "beyond" ? " is-dim" : ""}`,
	});
	label.textContent = node.title;
	if (node.subtitle) {
		const sub = add("text", { x: String(node.x), y: String(node.y + node.r + 38), "text-anchor": "middle", class: "gw-node-sub" });
		sub.textContent = node.subtitle;
	}
	if (node.caption) {
		const cap = add("text", { x: String(node.x), y: String(node.y + node.r + 36), "text-anchor": "middle", class: "gw-node-beyond" });
		cap.textContent = node.caption;
	}
	return g;
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

function keyLine(cls: string, label: string): HTMLElement {
	const item = document.createElement("span");
	const mark = document.createElement("i");
	mark.className = cls;
	item.append(mark, label);
	return item;
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
function icon(doc: Document, body: string): SVGElement {
	const svg = doc.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = body;
	return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = parent.ownerDocument.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	parent.append(node);
	return node;
}
