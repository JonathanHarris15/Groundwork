import {
	buildFromConceptMap,
	buildFromGroundwork,
	forceGraphFromGoalMermaid,
	mountForceGraph,
	type ForceGraphData,
	type ForceGraphHandle,
} from "@groundwork/core";
import type { ConceptMapModel } from "@groundwork/core";
import type { ConceptStatus } from "@groundwork/core";
import type { GroundworkGraph } from "@groundwork/core";
import { setIcon } from "obsidian";

export interface ForceGraphHostOptions {
	title?: string;
	tall?: boolean;
	onNodeClick?: (nodeId: string, title: string) => void;
}

const handles = new WeakMap<HTMLElement, ForceGraphHandle>();

/** Mount or refresh an interactive force graph inside a `.gw-graph-view` host. */
export function mountInteractiveGraph(host: HTMLElement, data: ForceGraphData, options: ForceGraphHostOptions = {}): ForceGraphHandle {
	const existing = handles.get(host);
	existing?.dispose();
	const titleById = new Map(data.nodes.map((n) => [n.id, n.title]));
	const handle = mountForceGraph(host, data, {
		className: "gw-force-canvas",
		fit: true,
		onNodeClick: (id) => options.onNodeClick?.(id, titleById.get(id) ?? id),
	});
	handles.set(host, handle);
	return handle;
}

export function mountGoalMermaidGraph(
	pane: HTMLElement,
	source: string,
	options: ForceGraphHostOptions = {},
): boolean {
	const data = forceGraphFromGoalMermaid(source);
	if (!data) return false;
	const view = pane.querySelector(".gw-graph-view") as HTMLElement | null;
	if (!view) return false;
	mountInteractiveGraph(view, data, options);
	return true;
}

export function mountConceptMapGraph(
	wrap: HTMLElement,
	model: ConceptMapModel,
	options: ForceGraphHostOptions & { onStart?: (title: string) => void; onStudy?: (title: string, action: "quiz" | "learn") => void } = {},
): void {
	const slot = wrap.querySelector(".gw-force-slot") as HTMLElement | null;
	if (!slot) return;
	const data = buildFromConceptMap(model);
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	mountInteractiveGraph(slot, data, {
		...options,
		onNodeClick: (id) => {
			const node = byId.get(id);
			if (!node) return;
			if ((node.next || node.visual === "ghost" || node.visual === "target") && options.onStart) options.onStart(node.title);
			else if ((node.visual === "shaky" || node.visual === "rusty") && options.onStudy) options.onStudy(node.title, "quiz");
			else if (options.onStudy) options.onStudy(node.title, "learn");
			options.onNodeClick?.(id, node.title);
		},
	});
}

export function mountDashboardGraph(
	host: HTMLElement,
	concepts: Array<{ id: string; title: string; status: ConceptStatus }>,
	graph: GroundworkGraph,
	options: ForceGraphHostOptions = {},
): void {
	mountInteractiveGraph(host, buildFromGroundwork(concepts, graph), options);
}

/** Build the standard graph chrome (bar + view) used in chat maps. */
export function createGraphPane(parent: HTMLElement, title = "Map"): { pane: HTMLElement; view: HTMLElement } {
	const pane = parent.createDiv({ cls: "gw-graph" });
	const bar = pane.createDiv({ cls: "gw-graph-bar" });
	bar.createSpan({ cls: "gw-graph-title", text: title });
	bar.createSpan({ cls: "gw-graph-caption", text: "Arrows: prerequisite → concept · size: connections" });
	const pctEl = bar.createSpan({ cls: "gw-graph-pct", text: "Fit" });
	const tools = bar.createDiv({ cls: "gw-graph-tools" });
	const view = pane.createDiv({ cls: "gw-graph-view gw-force-host" });
	view.createDiv({ cls: "gw-force-slot" });

	const btn = (icon: string, label: string, fn: () => void) => {
		const b = tools.createEl("button", { cls: "clickable-icon gw-graph-btn", attr: { "aria-label": label, type: "button" } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			fn();
		});
		return b;
	};

	const slot = () => view.querySelector(".gw-force-slot") as HTMLElement;
	const handle = () => handles.get(slot());

	btn("zoom-out", "Zoom out", () => {
		const h = handle();
		const r = view.getBoundingClientRect();
		h?.zoomBy(1 / 1.25, r.width / 2, r.height / 2);
	});
	btn("zoom-in", "Zoom in", () => {
		const h = handle();
		const r = view.getBoundingClientRect();
		h?.zoomBy(1.25, r.width / 2, r.height / 2);
	});
	btn("maximize-2", "Fit in window", () => handle()?.fit());
	const expand = btn("expand", "Taller map", () => {
		pane.toggleClass("is-tall", !pane.hasClass("is-tall"));
		setIcon(expand, pane.hasClass("is-tall") ? "shrink" : "expand");
		expand.setAttribute("aria-label", pane.hasClass("is-tall") ? "Shorter map" : "Taller map");
		window.requestAnimationFrame(() => handle()?.fit());
	});

	view.addEventListener(
		"wheel",
		(e) => {
			if ((e.target as HTMLElement).closest(".gw-force-canvas")) return;
			e.preventDefault();
		},
		{ passive: false },
	);

	const observer = new MutationObserver(() => {
		const scale = Math.round((view.querySelector("canvas") ? 100 : 100));
		pctEl.setText(scale ? `${scale}%` : "Fit");
	});
	observer.observe(view, { childList: true });

	return { pane, view: slot() };
}
