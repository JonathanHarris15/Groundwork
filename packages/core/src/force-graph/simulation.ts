import type { ForceGraphLink, ForceGraphNode, ForceSimulationOptions } from "./types";

const hash = (value: string): number => {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
	return h >>> 0;
};

/** Seed positions in a loose ring so the first tick is not a pile at 0,0. */
export function seedPositions(nodes: ForceGraphNode[], width: number, height: number): void {
	const cx = width / 2;
	const cy = height / 2;
	const ring = Math.min(width, height) * 0.32;
	nodes.forEach((node, i) => {
		const turn = ((hash(node.id) % 100) / 100) * 0.6;
		const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 + turn;
		node.x = cx + Math.cos(angle) * ring * (0.65 + (hash(node.title) % 17) / 40);
		node.y = cy + Math.sin(angle) * ring * (0.65 + (hash(node.cluster) % 13) / 40);
		node.vx = 0;
		node.vy = 0;
	});
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

/**
 * One force-directed step: repulsion, link springs, weak cluster pull, center gravity.
 * Pure — safe to unit test without a DOM.
 */
export function simulationTick(
	nodes: ForceGraphNode[],
	links: ForceGraphLink[],
	state: SimulationState,
	opts: ForceSimulationOptions,
): boolean {
	const { width, height } = opts;
	const alphaMin = opts.alphaMin ?? 0.02;
	if (state.alpha < alphaMin) return false;

	const n = nodes.length;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const centroids = clusterCentroids(nodes);
	const cx = width / 2;
	const cy = height / 2;

	for (const node of nodes) {
		node.vx = 0;
		node.vy = 0;
	}

	// Repulsion — sample when large to stay smooth.
	const stride = n > 120 ? 2 : 1;
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
			const repulse = (520 * state.alpha) / dist2;
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
		const want = link.bridge ? 72 : 52;
		const pull = ((dist - want) * 0.045 * state.alpha) / (link.bridge ? 1.4 : 1);
		if (!a.fixed) {
			a.vx += dx * pull;
			a.vy += dy * pull;
		}
		if (!b.fixed) {
			b.vx -= dx * pull;
			b.vy -= dy * pull;
		}
	}

	for (const node of nodes) {
		if (node.fixed) continue;
		const c = centroids.get(node.cluster);
		if (c && c.n > 1) {
			node.vx += (c.x - node.x) * 0.004 * state.alpha;
			node.vy += (c.y - node.y) * 0.004 * state.alpha;
		}
		node.vx += (cx - node.x) * 0.0012 * state.alpha;
		node.vy += (cy - node.y) * 0.0012 * state.alpha;
	}

	for (const node of nodes) {
		if (node.fixed) continue;
		node.vx *= 0.6;
		node.vy *= 0.6;
		node.x += node.vx * 0.22;
		node.y += node.vy * 0.22;
	}

	separate(nodes, 22 + state.alpha * 6);
	state.tick += 1;
	state.alpha *= 0.985;
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
				const need = minDist + a.radius + b.radius - 8;
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
	maxTicks = 240,
): number {
	const state = createSimulationState();
	seedPositions(nodes, opts.width, opts.height);
	let ticks = 0;
	while (ticks < maxTicks && simulationTick(nodes, links, state, opts)) ticks += 1;
	return ticks;
}
