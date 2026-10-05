import type { ForceGraphLink, ForceGraphNode, ForceSimulationOptions } from "./types";

const hash = (value: string): number => {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
	return h >>> 0;
};

/** Place each cluster on its own island before the sim runs. */
export function seedPositions(nodes: ForceGraphNode[], width: number, height: number): void {
	const clusters = [...new Set(nodes.map((n) => n.cluster))].sort();
	const cx = width / 2;
	const cy = height / 2;
	const orbit = Math.min(width, height) * (0.22 + Math.min(0.1, clusters.length * 0.02)) * (width < 420 ? 0.82 : 1);
	const centers = new Map<string, { x: number; y: number }>();
	clusters.forEach((cluster, i) => {
		const turn = ((hash(cluster) % 100) / 100) * 0.5;
		const angle = (i / Math.max(1, clusters.length)) * Math.PI * 2 + turn;
		centers.set(cluster, { x: cx + Math.cos(angle) * orbit, y: cy + Math.sin(angle) * orbit });
	});
	for (const node of nodes) {
		const center = centers.get(node.cluster) ?? { x: cx, y: cy };
		const members = nodes.filter((n) => n.cluster === node.cluster).length;
		const spread = (28 + Math.sqrt(members) * 14) * (width < 420 ? 1.15 : 1);
		const angle = ((hash(node.id) % 1000) / 1000) * Math.PI * 2;
		const dist = spread * (0.35 + ((hash(node.title) % 100) / 100) * 0.65);
		node.x = center.x + Math.cos(angle) * dist;
		node.y = center.y + Math.sin(angle) * dist;
		node.vx = 0;
		node.vy = 0;
	}
}

export function clusterCentroids(nodes: ForceGraphNode[]): Map<string, { x: number; y: number; n: number }> {
	const out = new Map<string, { x: number; y: number; n: number }>();
	for (const node of nodes) {
		const row = out.get(node.cluster) ?? { x: 0, y: 0, n: 0 };
		row.x += node.x;
		row.y += node.y;
		row.n += 1;
		out.set(node.cluster, row);
	}
	for (const [key, row] of out) {
		if (row.n > 0) out.set(key, { x: row.x / row.n, y: row.y / row.n, n: row.n });
	}
	return out;
}

export interface SimulationState {
	alpha: number;
	tick: number;
}

export function createSimulationState(): SimulationState {
	return { alpha: 1, tick: 0 };
}

export interface SimulationTickOptions extends ForceSimulationOptions {
	/** When set, linked nodes are gently pulled toward this point (drag). */
	dragId?: string | null;
}

/**
 * One force-directed step: repulsion, link springs, cluster islands, center gravity.
 * Pure — safe to unit test without a DOM.
 */
export function simulationTick(
	nodes: ForceGraphNode[],
	links: ForceGraphLink[],
	state: SimulationState,
	opts: SimulationTickOptions,
): boolean {
	const { width, height } = opts;
	const alphaMin = opts.alphaMin ?? 0.008;
	if (state.alpha < alphaMin) return false;

	const n = nodes.length;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const centroids = clusterCentroids(nodes);
	const cx = width / 2;
	const cy = height / 2;
	const narrow = width < 420;
	const sizeScale = Math.min(1.15, Math.max(0.72, Math.min(width, height) / 520));
	const charge = (720 + Math.sqrt(n) * 40) * sizeScale * (narrow ? 1.45 : 1);
	const stride = n > 160 ? 3 : n > 90 ? 2 : 1;

	for (const node of nodes) {
		node.vx = 0;
		node.vy = 0;
	}

	for (let i = 0; i < n; i += stride) {
		const a = nodes[i]!;
		for (let j = i + 1; j < n; j += stride) {
			const b = nodes[j]!;
			let dx = a.x - b.x;
			let dy = a.y - b.y;
			const dist2 = dx * dx + dy * dy || 0.01;
			const dist = Math.sqrt(dist2);
			dx /= dist;
			dy /= dist;
			const sameCluster = a.cluster === b.cluster;
			const repulse = (charge * state.alpha) / dist2 / (sameCluster ? 1.15 : 0.85);
			if (!a.fixed) {
				a.vx += dx * repulse;
				a.vy += dy * repulse;
			}
			if (!b.fixed) {
				b.vx -= dx * repulse;
				b.vy -= dy * repulse;
			}
		}
	}

	for (const link of links) {
		const a = byId.get(link.from);
		const b = byId.get(link.to);
		if (!a || !b) continue;
		let dx = b.x - a.x;
		let dy = b.y - a.y;
		const dist = Math.hypot(dx, dy) || 0.01;
		dx /= dist;
		dy /= dist;
		const bridge = link.bridge || a.cluster !== b.cluster;
		const want = (bridge ? 110 : 42 + (a.radius + b.radius)) * (narrow ? 1.22 : 1);
		const strength = (bridge ? 0.018 : 0.065) * state.alpha;
		const pull = (dist - want) * strength;
		if (!a.fixed) {
			a.vx += dx * pull;
			a.vy += dy * pull;
		}
		if (!b.fixed) {
			b.vx -= dx * pull;
			b.vy -= dy * pull;
		}
	}

	const dragId = opts.dragId;
	if (dragId) {
		const dragged = byId.get(dragId);
		if (dragged) {
			for (const link of links) {
				if (link.from !== dragId && link.to !== dragId) continue;
				const otherId = link.from === dragId ? link.to : link.from;
				const other = byId.get(otherId);
				if (!other || other.fixed) continue;
				let dx = dragged.x - other.x;
				let dy = dragged.y - other.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				dx /= dist;
				dy /= dist;
				const pull = Math.min(2.2, dist / 80) * 0.35 * state.alpha;
				other.vx += dx * pull;
				other.vy += dy * pull;
			}
		}
	}

	for (const node of nodes) {
		if (node.fixed) continue;
		const c = centroids.get(node.cluster);
		if (c && c.n > 1) {
			node.vx += (c.x - node.x) * 0.028 * state.alpha;
			node.vy += (c.y - node.y) * 0.028 * state.alpha;
		}
		const members = nodes.filter((m) => m.cluster === node.cluster).length;
		const clusterRepel = members > 1 ? 0.006 : 0.0012;
		node.vx += (cx - node.x) * clusterRepel * state.alpha;
		node.vy += (cy - node.y) * clusterRepel * state.alpha;
	}

	for (const node of nodes) {
		if (node.fixed) continue;
		node.vx *= 0.58;
		node.vy *= 0.58;
		node.x += node.vx * 0.24;
		node.y += node.vy * 0.24;
	}

	separate(nodes, (narrow ? 26 : 20) + state.alpha * (narrow ? 10 : 8));
	state.tick += 1;
	state.alpha *= 0.988;
	return state.alpha >= alphaMin;
}

function separate(nodes: ForceGraphNode[], minDist: number): void {
	for (let pass = 0; pass < 3; pass++) {
		let moved = false;
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i]!;
				const b = nodes[j]!;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				const need = minDist + a.radius + b.radius - 6;
				if (dist >= need) continue;
				dx /= dist;
				dy /= dist;
				const shift = (need - dist) / 2;
				if (!a.fixed) {
					a.x -= dx * shift;
					a.y -= dy * shift;
				}
				if (!b.fixed) {
					b.x += dx * shift;
					b.y += dy * shift;
				}
				moved = true;
			}
		}
		if (!moved) break;
	}
}

/** Run until settled or maxTicks. Returns final tick count. */
export function runSimulation(
	nodes: ForceGraphNode[],
	links: ForceGraphLink[],
	opts: ForceSimulationOptions,
	maxTicks = 320,
): number {
	const state = createSimulationState();
	seedPositions(nodes, opts.width, opts.height);
	let ticks = 0;
	while (ticks < maxTicks && simulationTick(nodes, links, state, opts)) ticks += 1;
	return ticks;
}
