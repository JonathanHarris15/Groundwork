import type { ConceptStatus } from "./model";

export interface GraphNode {
	id: string;
	title: string;
	prerequisites: string[];
	status: ConceptStatus;
	current: number;
}

/** Returns a cycle (list of ids) if adding `from -> to` edges would create one. */
export function findCycle(edges: Map<string, string[]>): string[] | null {
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	const stack: string[] = [];

	const visit = (n: string): string[] | null => {
		color.set(n, GREY);
		stack.push(n);
		for (const m of edges.get(n) ?? []) {
			const c = color.get(m) ?? WHITE;
			if (c === GREY) return [...stack.slice(stack.indexOf(m)), m];
			if (c === WHITE) {
				const found = visit(m);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(n, BLACK);
		return null;
	};

	for (const n of edges.keys()) {
		if ((color.get(n) ?? WHITE) === WHITE) {
			const found = visit(n);
			if (found) return found;
		}
	}
	return null;
}

/** Topological order with prerequisites first; ties broken by title for stable output. */
export function topoOrder(nodes: GraphNode[]): GraphNode[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const n of nodes) {
		indeg.set(n.id, 0);
		dependents.set(n.id, []);
	}
	for (const n of nodes) {
		for (const p of n.prerequisites) {
			if (!byId.has(p)) continue;
			indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
			dependents.get(p)!.push(n.id);
		}
	}
	const ready = nodes.filter((n) => indeg.get(n.id) === 0).sort(byTitle);
	const out: GraphNode[] = [];
	while (ready.length) {
		const n = ready.shift()!;
		out.push(n);
		for (const d of dependents.get(n.id) ?? []) {
			indeg.set(d, (indeg.get(d) ?? 0) - 1);
			if (indeg.get(d) === 0) {
				ready.push(byId.get(d)!);
				ready.sort(byTitle);
			}
		}
	}
	return out.length === nodes.length ? out : nodes;
}

const byTitle = (a: GraphNode, b: GraphNode) => a.title.localeCompare(b.title);

/**
 * A concept is built when the learner currently holds it: status solid, and —
 * when the goal names a depth — their floor reaches that level. Rusty means it
 * was built and has faded, so it is not built right now.
 */
export function isBuilt(status: ConceptStatus, floor?: number, requiredLevel?: number): boolean {
	if (status !== "solid") return false;
	if (requiredLevel == null || requiredLevel <= 0) return true;
	return (floor ?? 0) >= requiredLevel;
}

/** Open targets reachable from `fromId`, including itself when it is a target. */
export function targetsServed(
	fromId: string,
	nodes: Array<{ id: string; prerequisites: string[] }>,
	targetIds: Set<string>,
): string[] {
	const dependents = new Map<string, string[]>();
	for (const n of nodes) {
		for (const p of n.prerequisites) {
			const list = dependents.get(p);
			if (list) list.push(n.id);
			else dependents.set(p, [n.id]);
		}
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const stack = [fromId];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		if (targetIds.has(id)) out.push(id);
		for (const d of dependents.get(id) ?? []) stack.push(d);
	}
	return out;
}

export interface GoalAnalysis {
	order: GraphNode[];
	/** Not yet built, but every in-goal prerequisite is built: teach these next. */
	frontier: GraphNode[];
	/** Not built and blocked by at least one prerequisite that is not built. */
	blocked: GraphNode[];
	/** Previously solid, now decayed: review before building on them. */
	rusty: GraphNode[];
	/** No evidence at all: probe these before planning around them. */
	unassessed: GraphNode[];
	solidCount: number;
}

export function analyzeGoal(nodes: GraphNode[], known?: (node: GraphNode) => boolean): GoalAnalysis {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const order = topoOrder(nodes);
	const isKnown = (id: string) => {
		const n = byId.get(id);
		if (!n) return false;
		return known ? known(n) : n.status === "solid";
	};
	const frontier: GraphNode[] = [];
	const blocked: GraphNode[] = [];
	for (const n of order) {
		if (isKnown(n.id)) continue;
		const prereqs = n.prerequisites.filter((p) => byId.has(p));
		if (prereqs.every(isKnown)) frontier.push(n);
		else blocked.push(n);
	}
	return {
		order,
		frontier,
		blocked,
		rusty: order.filter((n) => n.status === "rusty"),
		unassessed: order.filter((n) => n.status === "unassessed"),
		solidCount: order.filter((n) => isKnown(n.id)).length,
	};
}

const STATUS_CLASS: Record<ConceptStatus, string> = {
	solid: "solid",
	shaky: "shaky",
	learning: "learning",
	rusty: "rusty",
	unassessed: "unassessed",
};

/**
 * Mermaid dependency map. Arrows point from prerequisite to dependent.
 * Hexagons are open targets; rounded nodes are targets already built.
 */
export function goalMermaid(nodes: GraphNode[], openTargetIds: string[] = [], builtTargetIds: string[] = []): string {
	const open = new Set(openTargetIds);
	const built = new Set(builtTargetIds);
	const ids = new Map<string, string>();
	nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
	const lines = ["graph BT"];
	for (const n of topoOrder(nodes)) {
		const label = n.title.replace(/"/g, "'");
		const pct = n.status === "unassessed" ? "?" : `${Math.round(n.current * 100)}%`;
		const shape = open.has(n.id) ? [`{{"`, `"}}`] : built.has(n.id) ? [`(["`, `"])`] : [`["`, `"]`];
		lines.push(`  ${ids.get(n.id)}${shape[0]}${label} · ${pct}${shape[1]}`);
	}
	for (const n of nodes) {
		for (const p of n.prerequisites) {
			if (ids.has(p)) lines.push(`  ${ids.get(p)} --> ${ids.get(n.id)}`);
		}
	}
	lines.push(
		"  classDef solid fill:#1f7a4d,stroke:#145235,color:#fff",
		"  classDef shaky fill:#b7791f,stroke:#7c5212,color:#fff",
		"  classDef learning fill:#c05621,stroke:#7b3514,color:#fff",
		"  classDef rusty fill:#6b46c1,stroke:#44297f,color:#fff",
		"  classDef unassessed fill:#4a5568,stroke:#2d3748,color:#fff",
	);
	for (const n of nodes) lines.push(`  class ${ids.get(n.id)} ${STATUS_CLASS[n.status]}`);
	return lines.join("\n");
}
