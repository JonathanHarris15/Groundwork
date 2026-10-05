import type { ConceptMapModel } from "../goal-plan";
import type { ConceptStatus } from "../model";
import type { GroundworkGraph } from "../groundwork-graph";
import { GROUNDWORK_COLORS } from "../groundwork-graph";
import { MAP_VISUAL_COLORS, STATUS_COLORS } from "./colors";
import type { ForceGraphData, ForceGraphLegendItem, ForceGraphLink, ForceGraphNode } from "./types";

export function buildFromConceptMap(model: ConceptMapModel): ForceGraphData {
	const degree = new Map<string, number>();
	for (const edge of model.edges) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
	}
	const nodes: ForceGraphNode[] = model.nodes.map((node) => {
		const attention = node.visual === "ghost" || node.visual === "shaky" || node.visual === "rusty";
		const hint =
			node.next
				? "Start here in chat"
				: node.visual === "ghost"
					? "Still to learn — tap to start"
					: node.visual === "shaky" || node.visual === "rusty"
						? "Weak spot — tap to quiz"
						: node.visual === "goal"
							? "Your goal"
							: "Tap to open in chat";
		return {
			id: node.id,
			title: node.title,
			x: node.x,
			y: node.y,
			vx: 0,
			vy: 0,
			radius: node.r + 2,
			color: MAP_VISUAL_COLORS[node.visual] ?? MAP_VISUAL_COLORS.dim,
			cluster: node.visual === "goal" ? "Goal" : node.visual,
			visual: node.visual,
			label: node.visual === "goal" || node.next || attention || (degree.get(node.id) ?? 0) >= 2,
			needsAttention: attention,
			isNext: node.next,
			actionHint: hint,
		};
	});
	const links: ForceGraphLink[] = model.edges.map((edge) => ({
		from: edge.from,
		to: edge.to,
		kind: edge.kind,
		bridge: edge.kind === "faint",
	}));
	const legend: ForceGraphLegendItem[] = [
		{ key: "known", label: "Known", color: MAP_VISUAL_COLORS.known },
		{ key: "learning", label: "Learning", color: MAP_VISUAL_COLORS.learning },
		{ key: "ghost", label: "Ghost", color: MAP_VISUAL_COLORS.ghost },
		{ key: "goal", label: "Goal", color: MAP_VISUAL_COLORS.goal },
	];
	return { nodes, links, legend };
}

export function buildFromGroundwork(
	concepts: Array<{ id: string; title: string; status: ConceptStatus }>,
	graph: GroundworkGraph,
): ForceGraphData {
	const statusOf = new Map(concepts.map((c) => [c.id, c.status]));
	const degree = new Map<string, number>();
	for (const edge of graph.edges) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
	}
	const nodes: ForceGraphNode[] = graph.nodes.map((node) => {
		const status = statusOf.get(node.id) ?? "unassessed";
		const deg = degree.get(node.id) ?? 0;
		const open = status === "unassessed";
		const attention = status === "unassessed" || status === "shaky" || status === "rusty";
		const hint =
			status === "unassessed"
				? "Not quizzed yet — find it in the list below"
				: status === "shaky" || status === "rusty"
					? "Needs review — find it in the list below"
					: status === "learning"
						? "Still building — see the list below"
						: "Solid — see the list below";
		return {
			id: node.id,
			title: node.title,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 5 + Math.min(12, Math.sqrt(deg + 1) * 2.4),
			color: open ? node.color : STATUS_COLORS[status],
			cluster: node.domain,
			status,
			open,
			label: deg >= 2 || graph.nodes.length <= 8 || attention,
			needsAttention: attention,
			actionHint: hint,
		};
	});
	const links: ForceGraphLink[] = graph.edges.map((edge) => ({
		from: edge.from,
		to: edge.to,
		bridge: edge.bridge,
	}));
	const legend: ForceGraphLegendItem[] = [
		...(graph.legend ?? []).map((item) => ({ key: item.domain, label: item.domain, color: item.color })),
		{ key: "status-solid", label: "Solid", color: STATUS_COLORS.solid },
		{ key: "status-open", label: "Not quizzed", color: STATUS_COLORS.unassessed },
	];
	return { nodes, links, legend };
}

/** Synthetic stress graph for perf tests and screenshots. */
export function buildSyntheticGraph(count: number, density = 3): ForceGraphData {
	const domains = ["Calculus", "Linear algebra", "Probability", "Physics"];
	const nodes: ForceGraphNode[] = [];
	const links: ForceGraphLink[] = [];
	for (let i = 0; i < count; i++) {
		const domain = domains[i % domains.length]!;
		nodes.push({
			id: `c${i}`,
			title: `Concept ${i + 1}`,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 5 + (i % 5),
			color: GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length]!,
			cluster: domain,
			status: (["solid", "learning", "shaky", "unassessed"] as ConceptStatus[])[i % 4],
			label: i % 7 === 0,
		});
	}
	for (let i = 1; i < count; i++) {
		for (let j = 0; j < density; j++) {
			const from = `c${(i * 7 + j * 13) % i}`;
			links.push({ from, to: `c${i}`, bridge: nodes.find((n) => n.id === from)?.cluster !== nodes[i]!.cluster });
		}
	}
	const legend = domains.map((domain, i) => ({ key: domain, label: domain, color: GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length]! }));
	return { nodes, links, legend };
}
