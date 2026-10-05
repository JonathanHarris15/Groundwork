import { buildFromGroundwork, buildSyntheticGraph, mountForceGraph, type ConceptStatus, type GroundworkGraph } from "@groundwork/core";

export interface SiteGraphPayload {
	concepts: Array<{ id: string; title: string; status: ConceptStatus }>;
	graph: GroundworkGraph;
}

export function mountSiteGraph(
	host: HTMLElement,
	payload: SiteGraphPayload,
	options: { onSelect?: (id: string) => void } = {},
) {
	const data = buildFromGroundwork(payload.concepts, payload.graph);
	return mountForceGraph(host, data, {
		className: "graph-canvas",
		onNodeClick: (id) => options.onSelect?.(id),
	});
}

declare global {
	interface Window {
		GroundworkGraph?: { mount: typeof mountSiteGraph };
	}
}

if (typeof window !== "undefined") {
	window.GroundworkGraph = { mount: mountSiteGraph, buildSyntheticGraph };
}
