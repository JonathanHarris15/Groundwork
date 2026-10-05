import type { ConceptMapModel } from "../goal-plan";
import type { ConceptStatus } from "../model";
import type { GroundworkGraph } from "../groundwork-graph";
import { GROUNDWORK_COLORS } from "../groundwork-graph";
import { MASTERY_LABEL, MASTERY_TONES, masteryTone, STUDY_MOVE_HINT, studyMove } from "../mastery-tone";
import { STATUS_COLORS, TONE_FALLBACK_COLORS } from "./colors";
import type { ForceGraphData, ForceGraphLegendItem, ForceGraphLink, ForceGraphNode } from "./types";

export function buildFromConceptMap(model: ConceptMapModel): ForceGraphData {
	const degree = new Map<string, number>();
	for (const edge of model.edges) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
	}
	const nodes: ForceGraphNode[] = model.nodes.map((node) => {
		const tone = node.tone;
		const state = tone === "goal" ? "Goal" : MASTERY_LABEL[tone];
		const action = STUDY_MOVE_HINT[studyMove(tone, node.next)];
		return {
			id: node.id,
			title: node.title,
			x: node.x,
			y: node.y,
			vx: 0,
			vy: 0,
			radius: node.r + 2,
			color: TONE_FALLBACK_COLORS[tone],
			cluster: node.visual === "goal" ? "Goal" : node.visual,
			visual: node.visual,
			tone,
			faded: node.offPath,
			open: tone === "unstarted",
			label: true,
			isNext: node.next,
			actionHint: `${node.next ? "Next · " : ""}${state}${node.offPath ? " · off this goal's path" : ""} — ${action}`,
		};
	});
	const links: ForceGraphLink[] = model.edges.map((edge) => ({
		from: edge.from,
		to: edge.to,
		kind: edge.kind,
		bridge: edge.kind === "dim" || edge.kind === "faint",
		highlight: edge.kind === "built",
	}));
	const legend: ForceGraphLegendItem[] = [
		...MASTERY_TONES.map((tone) => ({ key: tone, label: MASTERY_LABEL[tone], color: TONE_FALLBACK_COLORS[tone] })),
		{ key: "goal", label: "Goal", color: TONE_FALLBACK_COLORS.goal },
		{ key: "edge-built", label: "Solid arrow — the next step up", color: "#7f848e" },
		{ key: "edge-bridge", label: "Dashed arrow — link across subjects", color: "#a8adb6" },
	];
	return { nodes, links, legend, layout: "layered" };
}

export function buildFromGroundwork(
	concepts: Array<{ id: string; title: string; status: ConceptStatus }>,
	graph: GroundworkGraph,
	opts: {
		/** Hover text names the click's study move instead of the website's "see the list below". */
		studyHints?: boolean;
		/** Dashed warning rings around shaky, rusty, and open nodes. Off where a legend explains every mark. */
		attentionRings?: boolean;
	} = {},
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
		const hint = opts.studyHints
			? `${MASTERY_LABEL[masteryTone(status)]} — ${STUDY_MOVE_HINT[studyMove(masteryTone(status))]}`
			: status === "unassessed"
				? "Not quizzed yet — find it in the list below"
				: status === "shaky" || status === "rusty"
					? "Needs review — find it in the list below"
					: status === "learning"
						? "Still building — see the list below"
						: "Solid — see the list below";
		const placed = graph.nodes.find((n) => n.id === node.id);
		return {
			id: node.id,
			title: node.title,
			x: placed?.x ?? 0,
			y: placed?.y ?? 0,
			vx: 0,
			vy: 0,
			radius: 5 + Math.min(12, Math.sqrt(deg + 1) * 2.4),
			color: open ? node.color : STATUS_COLORS[status],
			cluster: node.domain,
			status,
			tone: open ? undefined : masteryTone(status),
			open,
			label: deg >= 2 || graph.nodes.length <= 8 || attention,
			needsAttention: attention && opts.attentionRings !== false,
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
		{ key: "edge-built", label: "Solid arrow — groundwork you build on", color: "#7f848e" },
		{ key: "edge-bridge", label: "Dashed arrow — ties two subjects", color: "#a8adb6" },
	];
	return { nodes, links, legend, layout: "layered" };
}

type SyllabusCluster = {
	domain: string;
	color: string;
	chains: string[][];
};

const SYNTHETIC_SYLLABUS: SyllabusCluster[] = [
	{
		domain: "Calculus",
		color: GROUNDWORK_COLORS[0]!,
		chains: [
			["Limits", "Continuity", "Derivative", "Product rule", "Chain rule", "Implicit diff", "Related rates"],
			["Antiderivative", "Definite integral", "FTC", "Substitution", "Area between curves"],
		],
	},
	{
		domain: "Linear algebra",
		color: GROUNDWORK_COLORS[1]!,
		chains: [
			["Vectors", "Dot product", "Matrices", "Row reduction", "Linear systems", "Determinant", "Eigenvalues"],
			["Vector spaces", "Basis", "Dimension", "Linear maps", "Change of basis"],
		],
	},
	{
		domain: "Probability",
		color: GROUNDWORK_COLORS[2]!,
		chains: [
			["Sample space", "Conditional probability", "Bayes' rule", "Random variables", "Expectation", "Variance"],
			["Binomial", "Normal approximation", "CLT", "Estimators", "Confidence intervals"],
		],
	},
	{
		domain: "Mechanics",
		color: GROUNDWORK_COLORS[3]!,
		chains: [
			["Position", "Velocity", "Acceleration", "Newton's laws", "Friction", "Work", "Energy"],
			["Momentum", "Collisions", "Rotational kinematics", "Torque", "Angular momentum"],
		],
	},
];

const STATUSES: ConceptStatus[] = ["solid", "learning", "shaky", "rusty", "unassessed"];

function titleFor(domain: string, topic: string, index: number): string {
	if (index === 0) return topic;
	return `${topic} (${domain.split(" ")[0]} ${index + 1})`;
}

/**
 * Synthetic graph with domain islands, prerequisite chains, and sparse cross-domain bridges.
 * Used for perf harnesses and layout regression tests.
 */
export function buildSyntheticGraph(count: number, _density = 3): ForceGraphData {
	const target = Math.max(24, count);
	const nodes: ForceGraphNode[] = [];
	const links: ForceGraphLink[] = [];
	const byDomain = new Map<string, string[]>();

	let made = 0;
	for (const cluster of SYNTHETIC_SYLLABUS) {
		const ids: string[] = [];
		const perChain = Math.ceil(target / (SYNTHETIC_SYLLABUS.length * cluster.chains.length));
		for (const chain of cluster.chains) {
			let prev: string | null = null;
			for (let i = 0; i < perChain && made < target; i++) {
				const topic = chain[Math.min(i, chain.length - 1)]!;
				const id = `c${made}`;
				const status = STATUSES[made % STATUSES.length]!;
				nodes.push({
					id,
					title: titleFor(cluster.domain, topic, i),
					x: 0,
					y: 0,
					vx: 0,
					vy: 0,
					radius: 5 + (made % 4) + (prev ? 0 : 1),
					color: cluster.color,
					cluster: cluster.domain,
					status,
					label: i === 0 || i === chain.length - 1 || made % 11 === 0,
					needsAttention: status === "unassessed" || status === "shaky" || status === "rusty",
				});
				ids.push(id);
				if (prev) links.push({ from: prev, to: id, bridge: false });
				prev = id;
				made += 1;
			}
		}
		byDomain.set(cluster.domain, ids);
	}

	while (made < target) {
		const cluster = SYNTHETIC_SYLLABUS[made % SYNTHETIC_SYLLABUS.length]!;
		const id = `c${made}`;
		nodes.push({
			id,
			title: `Extra ${cluster.domain} ${made}`,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 6,
			color: cluster.color,
			cluster: cluster.domain,
			status: "learning",
			label: false,
		});
		const domainIds = byDomain.get(cluster.domain) ?? [];
		if (domainIds.length) {
			const anchor = domainIds[made % domainIds.length]!;
			links.push({ from: anchor, to: id, bridge: false });
		}
		domainIds.push(id);
		byDomain.set(cluster.domain, domainIds);
		made += 1;
	}

	const domains = SYNTHETIC_SYLLABUS.map((c) => c.domain);
	for (let i = 0; i < domains.length; i++) {
		const a = byDomain.get(domains[i]!) ?? [];
		const b = byDomain.get(domains[(i + 1) % domains.length]!) ?? [];
		if (!a.length || !b.length) continue;
		const from = a[Math.floor(a.length / 3)]!;
		const to = b[Math.floor(b.length / 2)]!;
		links.push({ from, to, bridge: true });
		if (a.length > 4 && b.length > 4) {
			links.push({ from: a[a.length - 2]!, to: b[1]!, bridge: true });
		}
	}

	const legend = SYNTHETIC_SYLLABUS.map((c) => ({ key: c.domain, label: c.domain, color: c.color }));
	return { nodes, links, legend };
}
