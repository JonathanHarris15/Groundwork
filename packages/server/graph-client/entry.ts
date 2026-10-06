import type { ConceptStatus, ForceGraphHandle, GroundworkGraph } from "@groundwork/core";
import { buildFromGroundwork, buildSyntheticGraph, mountForceGraph } from "../../core/src/force-graph/index";

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

export function mountSyntheticHarness(host: HTMLElement, nodeCount = 320): ForceGraphHandle {
	const data = buildSyntheticGraph(nodeCount);
	return mountForceGraph(host, data, { className: "graph-canvas", fit: true });
}

declare global {
	interface Window {
		GroundworkGraph?: {
			mount: typeof mountSiteGraph;
			buildSyntheticGraph: typeof buildSyntheticGraph;
			mountSyntheticHarness: typeof mountSyntheticHarness;
		};
	}
}

if (typeof window !== "undefined") {
	window.GroundworkGraph = { mount: mountSiteGraph, buildSyntheticGraph, mountSyntheticHarness };
}
