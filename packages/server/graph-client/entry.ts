import type { ConceptStatus, ForceGraphHandle, GroundworkGraph } from "@groundwork/core";
import { buildConceptMap } from "../../core/src/goal-plan";
import { buildFromConceptMap, buildFromGroundwork, buildSyntheticGraph, mountForceGraph } from "../../core/src/force-graph/index";

export interface SiteGraphPayload {
	concepts: Array<{ id: string; title: string; status: ConceptStatus }>;
	graph: GroundworkGraph;
}

export function mountSiteGraph(
	host: HTMLElement,
	payload: SiteGraphPayload,
	options: { onSelect?: (id: string) => void } = {},
): ForceGraphHandle {
	const data = buildFromGroundwork(payload.concepts, payload.graph, { attentionRings: false });
	return mountForceGraph(host, data, {
		className: "graph-canvas",
		onNodeClick: (id) => options.onSelect?.(id),
	});
}

/** Demo concept map for the marketing pages: real pyramid layout, not a drawing. */
export function mountMarketingMap(host: HTMLElement): ForceGraphHandle {
	const model = buildConceptMap({
		goalTitle: "Derivative exam",
		dueLabel: "due Oct 30",
		builtIds: ["limit", "continuity"],
		weights: { related: 4, chain: 2, product: 1 },
		nodes: [
			{ id: "limit", title: "Limit", prerequisites: [], status: "solid", current: 0.9, inGoal: true, role: "built" },
			{ id: "continuity", title: "Continuity", prerequisites: ["limit"], status: "solid", current: 0.88, inGoal: true, role: "built" },
			{ id: "derivative", title: "Derivative", prerequisites: ["continuity"], status: "learning", current: 0.55, inGoal: true, role: "path" },
			{ id: "product", title: "Product rule", prerequisites: ["derivative"], status: "rusty", current: 0.45, inGoal: true, role: "target" },
			{ id: "chain", title: "Chain rule", prerequisites: ["derivative"], status: "shaky", current: 0.66, inGoal: true, role: "target" },
			{ id: "related", title: "Related rates", prerequisites: ["chain"], status: "unassessed", current: 0.5, inGoal: true, role: "target" },
			{ id: "series", title: "Series", prerequisites: ["limit"], status: "learning", current: 0.4, inGoal: false },
		],
	});
	return mountForceGraph(host, buildFromConceptMap(model), { className: "graph-canvas", fit: true });
}

export function mountSyntheticHarness(host: HTMLElement, nodeCount = 320): ForceGraphHandle {
	const data = buildSyntheticGraph(nodeCount);
	return mountForceGraph(host, data, { className: "graph-canvas", fit: true });
}

declare global {
	interface Window {
		GroundworkGraph?: {
			mount: typeof mountSiteGraph;
			mountMarketing?: typeof mountMarketingMap;
			buildSyntheticGraph: typeof buildSyntheticGraph;
			mountSyntheticHarness: typeof mountSyntheticHarness;
		};
	}
}

if (typeof window !== "undefined") {
	window.GroundworkGraph = { mount: mountSiteGraph, mountMarketing: mountMarketingMap, buildSyntheticGraph, mountSyntheticHarness };
}
