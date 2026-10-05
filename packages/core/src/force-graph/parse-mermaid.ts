import type { ConceptStatus } from "../model";
import { STATUS_COLORS } from "./colors";
import type { ForceGraphData, ForceGraphLink, ForceGraphNode } from "./types";

const STATUS_WORDS = new Set<ConceptStatus>(["solid", "shaky", "learning", "rusty", "unassessed"]);

export interface ParsedMermaidNode {
	mermaidId: string;
	title: string;
	status: ConceptStatus;
	isTarget: boolean;
	isBuiltTarget: boolean;
}

/** Parse a `set_goal` Mermaid map (graph BT, class lines). Returns null when the text is not a goal map. */
export function parseGoalMermaid(source: string): { nodes: ParsedMermaidNode[]; links: ForceGraphLink[] } | null {
	const lines = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (!lines.some((line) => /^graph\s/i.test(line))) return null;

	const nodes = new Map<string, ParsedMermaidNode>();
	const links: ForceGraphLink[] = [];
	const classOf = new Map<string, ConceptStatus>();

	for (const line of lines) {
		if (line.startsWith("classDef")) continue;
		const classMatch = /^class\s+(\S+)\s+(\S+)/.exec(line);
		if (classMatch) {
			const status = classMatch[2] as ConceptStatus;
			if (STATUS_WORDS.has(status)) classOf.set(classMatch[1], status);
			continue;
		}
		const edge = /^(\S+)\s*-->\s*(\S+)/.exec(line);
		if (edge) {
			links.push({ from: edge[1], to: edge[2] });
			continue;
		}
		const nodeMatch = /^(n\d+)(\{\{|\(\[|\[)(.+)$/.exec(line);
		if (!nodeMatch) continue;
		const mermaidId = nodeMatch[1];
		const rest = nodeMatch[2] + nodeMatch[3];
		if (!/[\[\({]/.test(rest)) continue;
		const parsed = parseNodeLabel(rest);
		if (!parsed) continue;
		nodes.set(mermaidId, {
			mermaidId,
			title: parsed.title,
			status: "unassessed",
			isTarget: parsed.isTarget,
			isBuiltTarget: parsed.isBuiltTarget,
		});
	}

	if (!nodes.size) return null;
	for (const [id, status] of classOf) {
		const node = nodes.get(id);
		if (node) node.status = status;
	}

	const outNodes = [...nodes.values()];
	const degree = degreeMap(links);
	return {
		nodes: outNodes,
		links: links.filter((link) => nodes.has(link.from) && nodes.has(link.to)),
	};
}

function parseNodeLabel(fragment: string): { title: string; isTarget: boolean; isBuiltTarget: boolean } | null {
	const target = /^\{\{"([^"]+)"\}\}/.exec(fragment);
	if (target) return { title: cleanLabel(target[1]), isTarget: true, isBuiltTarget: false };
	const built = /^\(\["([^"]+)"\]\)/.exec(fragment);
	if (built) return { title: cleanLabel(built[1]), isTarget: true, isBuiltTarget: true };
	const plain = /^\["([^"]+)"\]/.exec(fragment);
	if (plain) return { title: cleanLabel(plain[1]), isTarget: false, isBuiltTarget: false };
	return null;
}

function cleanLabel(raw: string): string {
	const text = raw.replace(/"/g, "'").trim();
	const cut = text.replace(/\s*·\s*[^·]+$/, "").trim();
	return cut || text;
}

function degreeMap(links: ForceGraphLink[]): Map<string, number> {
	const degree = new Map<string, number>();
	for (const link of links) {
		degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
		degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
	}
	return degree;
}

export function forceGraphFromGoalMermaid(source: string, width = 640, height = 420): ForceGraphData | null {
	const parsed = parseGoalMermaid(source);
	if (!parsed) return null;
	const degree = degreeMap(parsed.links);
	const nodes: ForceGraphNode[] = parsed.nodes.map((node) => {
		const deg = degree.get(node.mermaidId) ?? 0;
		const attention = node.status !== "solid";
		return {
			id: node.mermaidId,
			title: node.title,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 6 + Math.min(10, Math.sqrt(deg + 1) * 2.2),
			color: STATUS_COLORS[node.status],
			cluster: "Goal",
			status: node.status,
			isTarget: node.isTarget,
			isBuiltTarget: node.isBuiltTarget,
			label: deg >= 1 || node.isTarget || attention,
			needsAttention: attention,
			actionHint: node.isTarget ? "Open target for this goal" : "Tap to study this in chat",
		};
	});
	const legend = [
		{ key: "solid", label: "Solid", color: STATUS_COLORS.solid },
		{ key: "learning", label: "Learning", color: STATUS_COLORS.learning },
		{ key: "shaky", label: "Shaky", color: STATUS_COLORS.shaky },
		{ key: "target", label: "Open target", color: STATUS_COLORS.unassessed },
	];
	return { nodes, links: parsed.links, legend };
}
