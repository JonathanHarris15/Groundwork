import { conceptLayerRanks, placePyramidLayout } from "./force-graph/pyramid-layout";

/** A concept the graph can place. Mastery and note text stay out. */
export interface GraphConcept {
	id: string;
	title: string;
	prerequisites: string[];
	domain?: string;
}

/** Brand colors, in the order the dashboard legend uses them. */
export const GROUNDWORK_COLORS = ["#2db560", "#2e9be6", "#f59e2b", "#e5484d"] as const;

export interface GroundworkGraphNode {
	id: string;
	title: string;
	x: number;
	y: number;
	domain: string;
	color: string;
	label: boolean;
	/** Where the name is drawn, when `label` is set. */
	labelX?: number;
	labelY?: number;
	labelAnchor?: "start" | "middle" | "end";
}

export interface GroundworkGraphEdge {
	from: string;
	to: string;
	/** A prerequisite that crosses subjects. Drawn dashed. */
	bridge: boolean;
}

export interface GroundworkGraph {
	width: number;
	height: number;
	nodes: GroundworkGraphNode[];
	edges: GroundworkGraphEdge[];
	legend: Array<{ domain: string; color: string }>;
}

export const EMPTY_GROUNDWORK_GRAPH: GroundworkGraph = { width: 0, height: 0, nodes: [], edges: [], legend: [] };

/**
 * Place every concept in one stacked pyramid: foundations at the bottom,
 * complex ideas above. Solid links stay inside a subject; dashed links cross subjects.
 */
export function layoutGroundworkGraph(concepts: GraphConcept[], pinTopId?: string): GroundworkGraph {
	if (!concepts.length) return EMPTY_GROUNDWORK_GRAPH;
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const domainOf = assignDomains(concepts);
	const domains = [...new Set(concepts.map((c) => domainOf.get(c.id) ?? c.title))].sort((a, b) => {
		const countA = concepts.filter((c) => (domainOf.get(c.id) ?? c.title) === a).length;
		const countB = concepts.filter((c) => (domainOf.get(c.id) ?? c.title) === b).length;
		return countB - countA || a.localeCompare(b);
	});
	const colorOf = new Map(domains.map((domain, i) => [domain, GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length]]));
	const legend = domains.filter((domain) => domain !== "Concepts").map((domain) => ({ domain, color: colorOf.get(domain) ?? GROUNDWORK_COLORS[0] }));

	const edges: GroundworkGraphEdge[] = [];
	for (const c of concepts) {
		for (const p of c.prerequisites) {
			if (!byId.has(p) || p === c.id) continue;
			edges.push({
				from: p,
				to: c.id,
				bridge: domainOf.get(p) !== domainOf.get(c.id),
			});
		}
	}
	edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

	const ranks = conceptLayerRanks(
		concepts.map((c) => ({ id: c.id, title: c.title, prerequisites: c.prerequisites })),
		pinTopId,
	);
	const maxLayer = Math.max(0, ...ranks.values());
	const perLayer = new Map<number, number>();
	for (const layer of ranks.values()) perLayer.set(layer, (perLayer.get(layer) ?? 0) + 1);
	const widest = Math.max(1, ...perLayer.values());
	const width = Math.max(480, 112 + widest * 88);
	const height = Math.max(320, 96 + maxLayer * 92);
	const placed = placePyramidLayout(
		concepts.map((c) => ({ id: c.id, title: c.title })),
		ranks,
		{ width, height, rowGap: 88 },
	);

	const labeled = labelIds(concepts, edges, domainOf);
	const nodes: GroundworkGraphNode[] = concepts.map((c) => {
		const domain = domainOf.get(c.id) ?? c.title;
		const p = placed.get(c.id) ?? { x: width / 2, y: height - 48 };
		return {
			id: c.id,
			title: c.title,
			x: round1(p.x),
			y: round1(p.y),
			domain,
			color: colorOf.get(domain) ?? GROUNDWORK_COLORS[0],
			label: false,
		};
	});
	dropOverlappingLabels(nodes, labeled);
	return { width: round1(width), height: round1(height), nodes, edges, legend };
}

function dropOverlappingLabels(nodes: GroundworkGraphNode[], priority: string[]): void {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
	const spots: Array<{ dx: number; dy: number; anchor: "start" | "middle" | "end" }> = [
		{ dx: 0, dy: 20, anchor: "middle" },
		{ dx: 0, dy: -8, anchor: "middle" },
		{ dx: 12, dy: 4, anchor: "start" },
		{ dx: -12, dy: 4, anchor: "end" },
	];
	for (const id of priority) {
		const node = byId.get(id);
		if (!node) continue;
		const text = node.title.length > 28 ? node.title.slice(0, 27) : node.title;
		const w = Math.max(28, text.length * 6.6);
		const h = 14;
		let placed = false;
		for (const spot of spots) {
			const x = spot.anchor === "start" ? node.x + spot.dx : spot.anchor === "end" ? node.x + spot.dx - w : node.x - w / 2;
			const y = spot.anchor === "middle" && spot.dy < 0 ? node.y + spot.dy - h : node.y + spot.dy;
			const box = { x, y, w, h };
			if (boxes.some((b) => overlaps(box, b))) continue;
			if (nodes.some((other) => other !== node && circleHitsBox(other.x, other.y, 9, box))) continue;
			boxes.push(box);
			node.label = true;
			node.labelX = round1(spot.anchor === "middle" ? node.x : spot.anchor === "start" ? node.x + spot.dx : node.x + spot.dx);
			node.labelY = round1(box.y + 11);
			node.labelAnchor = spot.anchor;
			placed = true;
			break;
		}
		if (!placed) node.label = false;
	}
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
	return a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y;
}

function circleHitsBox(cx: number, cy: number, r: number, box: { x: number; y: number; w: number; h: number }): boolean {
	const x = Math.max(box.x, Math.min(cx, box.x + box.w));
	const y = Math.max(box.y, Math.min(cy, box.y + box.h));
	return Math.hypot(cx - x, cy - y) < r;
}

/** Subject on each concept. A concept with no subject inherits a neighbor's, then its own connected group. */
function assignDomains(concepts: GraphConcept[]): Map<string, string> {
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const domain = new Map<string, string>();
	const neighbors = new Map<string, string[]>();
	const link = (a: string, b: string) => {
		const row = neighbors.get(a) ?? [];
		row.push(b);
		neighbors.set(a, row);
	};
	for (const c of concepts) {
		if (c.domain?.trim()) domain.set(c.id, c.domain.trim());
		for (const p of c.prerequisites) {
			if (!byId.has(p) || p === c.id) continue;
			link(c.id, p);
			link(p, c.id);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const c of concepts) {
			if (domain.has(c.id)) continue;
			const counts = new Map<string, number>();
			for (const n of neighbors.get(c.id) ?? []) {
				const d = domain.get(n);
				if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
			}
			const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
			if (best) {
				domain.set(c.id, best[0]);
				changed = true;
			}
		}
	}
	const seen = new Set<string>();
	const isolates: string[] = [];
	for (const c of concepts) {
		if (domain.has(c.id) || seen.has(c.id)) continue;
		const comp: string[] = [];
		const stack = [c.id];
		while (stack.length) {
			const id = stack.pop()!;
			if (seen.has(id) || domain.has(id)) continue;
			seen.add(id);
			comp.push(id);
			for (const n of neighbors.get(id) ?? []) if (!domain.has(n) && !seen.has(n)) stack.push(n);
		}
		if (comp.length === 1) {
			isolates.push(comp[0]);
			continue;
		}
		const name = componentName(comp, byId, neighbors);
		for (const id of comp) domain.set(id, name);
	}
	if (isolates.length) {
		const name = domain.size > 0 ? "Other" : "Concepts";
		for (const id of isolates) domain.set(id, name);
	}
	return domain;
}

function componentName(ids: string[], byId: Map<string, GraphConcept>, neighbors: Map<string, string[]>): string {
	const ranked = ids
		.map((id) => byId.get(id))
		.filter((c): c is GraphConcept => !!c)
		.sort((a, b) => (neighbors.get(b.id)?.length ?? 0) - (neighbors.get(a.id)?.length ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	return ranked[0]?.title ?? ids[0] ?? "Concepts";
}

/** Every concept, busiest first. Overlapping names are dropped later so the dots stay readable. */
function labelIds(concepts: GraphConcept[], edges: GroundworkGraphEdge[], domainOf: Map<string, string>): string[] {
	const degree = new Map<string, number>();
	for (const c of concepts) degree.set(c.id, 0);
	for (const e of edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	return concepts
		.slice()
		.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (domainOf.get(a.id) ?? "").localeCompare(domainOf.get(b.id) ?? "") || a.title.localeCompare(b.title))
		.map((concept) => concept.id);
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}
