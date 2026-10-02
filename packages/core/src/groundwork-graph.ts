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

interface Point {
	x: number;
	y: number;
}

/**
 * Place learned concepts as one connected graph: a cluster per subject,
 * solid links inside a subject, dashed links across subjects.
 */
export function layoutGroundworkGraph(concepts: GraphConcept[]): GroundworkGraph {
	if (!concepts.length) return EMPTY_GROUNDWORK_GRAPH;
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const domainOf = assignDomains(concepts);
	const groups = new Map<string, GraphConcept[]>();
	for (const c of concepts) {
		const domain = domainOf.get(c.id) ?? c.title;
		const row = groups.get(domain) ?? [];
		row.push(c);
		groups.set(domain, row);
	}
	const domains = [...groups.keys()].sort((a, b) => {
		const size = (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0);
		return size || a.localeCompare(b);
	});
	const colorOf = new Map(domains.map((domain, i) => [domain, GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length]!]));
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

	const placed = new Map<string, Point>();
	let cursor = 36;
	let height = 180;
	for (const domain of domains) {
		const members = groups.get(domain) ?? [];
		const localEdges = edges.filter((e) => !e.bridge && members.some((m) => m.id === e.from) && members.some((m) => m.id === e.to));
		const local = layoutCluster(members, localEdges);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of local.values()) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
		if (!Number.isFinite(minX)) {
			minX = 0;
			minY = 0;
			maxX = 0;
			maxY = 0;
		}
		const padX = 70;
		const padTop = 24;
		const padBottom = 48;
		for (const [id, p] of local) {
			placed.set(id, { x: cursor + (p.x - minX) + padX, y: padTop + (p.y - minY) });
		}
		cursor += maxX - minX + padX * 2 + 36;
		height = Math.max(height, padTop + (maxY - minY) + padBottom);
	}

	const labeled = labelIds(concepts, edges, domainOf);
	const nodes: GroundworkGraphNode[] = concepts.map((c) => {
		const domain = domainOf.get(c.id) ?? c.title;
		const p = placed.get(c.id) ?? { x: 36, y: height / 2 };
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
	return { width: round1(Math.max(cursor, 280)), height: round1(height), nodes, edges, legend };
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
			isolates.push(comp[0]!);
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

function layoutCluster(members: GraphConcept[], edges: GroundworkGraphEdge[]): Map<string, Point> {
	const pos = new Map<string, Point>();
	const n = members.length;
	members.forEach((c, i) => {
		if (n === 1) {
			pos.set(c.id, { x: 0, y: 0 });
			return;
		}
		const turn = ((hash(c.id) % 100) / 100) * 0.55;
		const angle = (i / n) * Math.PI * 2 + turn;
		const ring = 28 + 15 * Math.sqrt(n);
		pos.set(c.id, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring });
	});
	const ids = members.map((c) => c.id);
	const attract = new Set(edges.map((e) => `${e.from}\0${e.to}`));
	for (let iter = 0; iter < 140; iter++) {
		const force = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = pos.get(ids[i]!)!;
				const b = pos.get(ids[j]!)!;
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				dx /= dist;
				dy /= dist;
				const push = 520 / (dist * dist);
				const fa = force.get(ids[i]!)!;
				const fb = force.get(ids[j]!)!;
				fa.x += dx * push;
				fa.y += dy * push;
				fb.x -= dx * push;
				fb.y -= dy * push;
				if (attract.has(`${ids[i]}\0${ids[j]}`) || attract.has(`${ids[j]}\0${ids[i]}`)) {
					const pull = (dist - 46) * 0.045;
					fa.x += dx * pull * -1;
					fa.y += dy * pull * -1;
					fb.x += dx * pull;
					fb.y += dy * pull;
				}
			}
		}
		for (const id of ids) {
			const p = pos.get(id)!;
			const f = force.get(id)!;
			f.x += -p.x * 0.012;
			f.y += -p.y * 0.012;
			p.x += f.x * 0.18;
			p.y += f.y * 0.18;
		}
	}
	separate(pos, 30);
	return pos;
}

function separate(pos: Map<string, Point>, minDist: number): void {
	const ids = [...pos.keys()];
	for (let pass = 0; pass < 50; pass++) {
		let moved = false;
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = pos.get(ids[i]!)!;
				const b = pos.get(ids[j]!)!;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				if (dist >= minDist) continue;
				dx /= dist;
				dy /= dist;
				const shift = (minDist - dist) / 2;
				a.x -= dx * shift;
				a.y -= dy * shift;
				b.x += dx * shift;
				b.y += dy * shift;
				moved = true;
			}
		}
		if (!moved) break;
	}
}

/** A few names per subject, the ones with the most links first. Small subjects name every concept. */
function labelIds(concepts: GraphConcept[], edges: GroundworkGraphEdge[], domainOf: Map<string, string>): string[] {
	const degree = new Map<string, number>();
	for (const c of concepts) degree.set(c.id, 0);
	for (const e of edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	const byDomain = new Map<string, GraphConcept[]>();
	for (const c of concepts) {
		const domain = domainOf.get(c.id) ?? c.title;
		const row = byDomain.get(domain) ?? [];
		row.push(c);
		byDomain.set(domain, row);
	}
	const labeled: string[] = [];
	for (const members of byDomain.values()) {
		const ranked = members.slice().sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.title.localeCompare(b.title));
		const keep = members.length <= 3 ? members.length : 2;
		for (const c of ranked.slice(0, keep)) labeled.push(c.id);
	}
	return labeled;
}

function hash(value: string): number {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
	return h >>> 0;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}
