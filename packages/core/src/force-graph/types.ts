import type { ConceptStatus } from "../model";

export interface ForceGraphNode {
	id: string;
	title: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Display radius in graph space (before camera zoom). */
	radius: number;
	color: string;
	cluster: string;
	status?: ConceptStatus;
	/** Ring-only node (not yet quizzed on the website). */
	open?: boolean;
	/** Goal-map semantics. */
	visual?: string;
	isTarget?: boolean;
	isBuiltTarget?: boolean;
	/** Shown when zoom is high enough. */
	label?: boolean;
	/** Pinned while dragging. */
	fixed?: boolean;
	/** Shaky, rusty, or not yet quizzed — draw a calm attention ring. */
	needsAttention?: boolean;
	/** Recommended next step on the goal map. */
	isNext?: boolean;
	/** Short line for hover tooltip (what clicking does). */
	actionHint?: string;
}

export interface ForceGraphLink {
	from: string;
	to: string;
	bridge?: boolean;
	kind?: string;
}

export interface ForceGraphLegendItem {
	key: string;
	label: string;
	color: string;
}

export interface ForceGraphData {
	nodes: ForceGraphNode[];
	links: ForceGraphLink[];
	legend: ForceGraphLegendItem[];
	/** Layered maps keep server-side positions; force maps run the sim. */
	layout?: "force" | "layered";
}

export interface ForceSimulationOptions {
	width: number;
	height: number;
	/** Stop iterating when alpha falls below this. */
	alphaMin?: number;
}
