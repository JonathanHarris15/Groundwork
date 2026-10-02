/**
 * Where Jev is allowed to judge, and where code still decides.
 *
 * Alignment attaches a new name to a concept already in the vault.
 * Prerequisite votes accept or drop edges; cycles are removed here.
 * A next-step pick chooses among nodes the graph already marked ready.
 * A written answer is labeled correct, partial, incorrect, or a slip.
 * Ability, retention, and "built" stay a replay of the evidence log.
 */

import { choice, noul, score, type Questions } from "@typesafe-ai/sdk";
import { findCycle } from "./graph";
import {
	decideAlignment,
	decideGrade,
	keepEdge,
	PICK_CONFIDENCE,
	type Alignment,
	type EdgeVote,
	type GradedUnderstanding,
	type JevClient,
} from "./jev";
import { getSection, slugify, unwikilink } from "./markdown";
import type { Concept, GoalInput, KnowledgeStore, StudyStep } from "./store";

const SAME_LEVELS = [
	"This idea and the candidate are different concepts.",
	"They are related, but not the same concept: a part, a variant, an example, or a nearby idea.",
	"They are the same concept, even if the wording differs. A quiz about one is evidence about the other.",
] as const;

const GRADE_LEVELS = [
	"The approach is wrong or missing.",
	"The key idea is right, but a conceptual piece is missing or wrong.",
	"The method is right. Only a careless non-conceptual error remains: arithmetic, a sign, copying, or a typo.",
	"The answer is right, including an equivalent form.",
] as const;

export interface ResolvedConcept {
	concept: Concept;
	/** The name the caller used, when it was aligned onto a different existing concept. */
	matchedFrom?: string;
}

function summaryOf(concept: Concept): string {
	return (getSection(concept.body, "Summary") ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

async function shortlist(store: KnowledgeStore, title: string, text?: string): Promise<Concept[]> {
	const all = [...(await store.concepts()).values()];
	const id = slugify(unwikilink(title));
	const rest = all.filter((c) => c.id !== id);
	if (rest.length <= 8) return rest;
	const hits = await store.search([title, text ?? ""].join(" ").slice(0, 400), 8);
	const byId = new Map<string, Concept>();
	for (const hit of hits) if (hit.concept && hit.concept.id !== id) byId.set(hit.concept.id, hit.concept);
	return [...byId.values()];
}

/** Match a name that did not resolve exactly. Exact slug and alias hits never reach this. */
export async function alignUnmatched(store: KnowledgeStore, title: string, text?: string): Promise<Alignment | null> {
	const client = store.judgments();
	if (!client) return null;
	const candidates = await shortlist(store, title, text);
	if (!candidates.length) return null;
	try {
		const questions: Questions = {};
		candidates.forEach((c, i) => {
			questions[`c${i}`] = score(
				{
					question: `How does \`idea\` relate to \`candidates[${i}]\` as concepts a learner would study?`,
					focus: "Same concept means evidence about one is evidence about the other. A prerequisite, a special case, or a neighbor is not the same concept.",
				},
				SAME_LEVELS,
			);
		});
		const answers = await client.ask(
			{
				idea: { title: unwikilink(title).trim(), text: (text ?? "").slice(0, 1500) },
				candidates: candidates.map((c) => ({ title: c.title, aliases: c.aliases, summary: summaryOf(c) })),
			},
			questions,
		);
		const scores = candidates.flatMap((c, i) => {
			const answer = answers[`c${i}`];
			if (answer?.score == null || answer.confidence == null) return [];
			return [{ id: c.id, title: c.title, score: answer.score, confidence: answer.confidence }];
		});
		if (!scores.length) return null;
		return decideAlignment(scores);
	} catch {
		return null;
	}
}

export async function resolveForEvidence(store: KnowledgeStore, ref: string, text?: string): Promise<ResolvedConcept | undefined> {
	const exact = await store.resolve(ref);
	if (exact) return { concept: exact };
	const aligned = await alignUnmatched(store, ref, text);
	if (aligned?.action !== "same") return undefined;
	const concept = await store.resolve(aligned.id);
	if (!concept) return undefined;
	return { concept, matchedFrom: unwikilink(ref).trim() };
}

function nodeSummary(storeConcepts: Map<string, Concept>, title: string, summary?: string): string {
	if (summary?.trim()) return summary.trim().slice(0, 400);
	const existing = storeConcepts.get(slugify(unwikilink(title)));
	return existing ? summaryOf(existing) : "";
}

interface NamedNode {
	title: string;
	prerequisites?: string[];
	summary?: string;
	domain?: string;
	requiredLevel?: number;
	aliases?: string[];
}

/** Rewrite goal nodes onto existing concepts and keep only the prerequisite edges that survive a vote and a cycle check. */
export async function refineGoalInput(
	store: KnowledgeStore,
	input: GoalInput,
	mode: "tutor" | "proposed",
): Promise<{ input: GoalInput; notes: string[] }> {
	const client = store.judgments();
	if (!client) return { input, notes: [] };
	try {
		return await refine(store, client, input, mode);
	} catch {
		return { input, notes: [] };
	}
}

async function refine(
	store: KnowledgeStore,
	client: JevClient,
	input: GoalInput,
	mode: "tutor" | "proposed",
): Promise<{ input: GoalInput; notes: string[] }> {
	const notes: string[] = [];
	const renames = new Map<string, string>();
	const aliases = new Map<string, string[]>();
	const index = await store.concepts();

	for (const node of input.nodes) {
		const title = unwikilink(node.title).trim();
		if (!title || (await store.resolve(title))) continue;
		const aligned = await alignUnmatched(store, title, node.summary);
		if (aligned?.action !== "same") continue;
		if (slugify(aligned.title) === slugify(title)) continue;
		renames.set(title, aligned.title);
		const prior = aliases.get(aligned.title) ?? [];
		aliases.set(aligned.title, [...prior, title]);
		notes.push(`Matched “${title}” to [[${aligned.title}]].`);
	}

	const rename = (title: string) => renames.get(unwikilink(title).trim()) ?? unwikilink(title).trim();
	const merged = new Map<string, NamedNode>();
	for (const node of input.nodes) {
		const title = rename(node.title);
		if (!slugify(title)) continue;
		const prev = merged.get(slugify(title));
		const prerequisites = [...(prev?.prerequisites ?? []), ...(node.prerequisites ?? []).map(rename)];
		const requiredLevel = Math.max(prev?.requiredLevel ?? 0, node.requiredLevel ?? 0) || undefined;
		merged.set(slugify(title), {
			title: prev?.title ?? title,
			prerequisites: [...new Set(prerequisites.map((p) => unwikilink(p).trim()).filter(Boolean))],
			summary: prev?.summary ?? node.summary,
			domain: prev?.domain ?? node.domain,
			requiredLevel,
			aliases: [...new Set([...(prev?.aliases ?? []), ...(aliases.get(title) ?? [])])],
		});
	}

	const nodes = [...merged.values()];
	const titles = new Set(nodes.map((n) => n.title));
	const stated: EdgeVote[] = [];
	for (const node of nodes) {
		for (const parent of node.prerequisites ?? []) {
			if (!titles.has(parent) || parent === node.title) continue;
			stated.push({ child: node.title, parent, source: "stated", yes: 1 });
		}
	}

	const candidates: EdgeVote[] = [];
	// A tutor-written graph is only filtered. Extra edges are proposed for maps guessed from course files.
	if (mode === "proposed") {
		for (const node of nodes) {
			const statedParents = new Set(node.prerequisites ?? []);
			let added = 0;
			for (const other of nodes) {
				if (other.title === node.title || statedParents.has(other.title)) continue;
				if (!sharesToken(node.title, other.title)) continue;
				candidates.push({ child: node.title, parent: other.title, source: "candidate", yes: 0 });
				if (++added >= 2) break;
			}
		}
	}

	const votes = [...stated, ...candidates].slice(0, 24);
	if (votes.length) {
		const questions: Questions = {};
		votes.forEach((edge, i) => {
			questions[`e${i}`] = noul(
				{
					question: `Is \`pairs[${i}].parent\` a direct prerequisite of \`pairs[${i}].child\`?`,
					focus: "Yes only when the child is the next idea built from the parent. A sibling, a later idea, or a distant ancestor is no.",
				},
				{
					true: "Someone learning the child needs this parent immediately under it.",
					false: "The parent is unrelated, a sibling, a later idea, or only a distant ancestor.",
				},
			);
		});
		const answers = await client.ask(
			{
				pairs: votes.map((edge) => ({
					child: { title: edge.child, summary: nodeSummary(index, edge.child, nodes.find((n) => n.title === edge.child)?.summary) },
					parent: { title: edge.parent, summary: nodeSummary(index, edge.parent, nodes.find((n) => n.title === edge.parent)?.summary) },
				})),
			},
			questions,
		);
		votes.forEach((edge, i) => {
			const yes = answers[`e${i}`]?.noul;
			if (typeof yes === "number") edge.yes = yes;
		});
	}

	const kept = dropCycles(
		votes.filter((edge) => keepEdge(edge, mode)),
		notes,
	);
	const surviving = new Set(kept);
	for (const edge of votes) {
		if (edge.source === "stated" && !surviving.has(edge)) notes.push(`Dropped prerequisite ${edge.parent} → ${edge.child}.`);
		if (edge.source === "candidate" && surviving.has(edge)) notes.push(`Added prerequisite ${edge.parent} → ${edge.child}.`);
	}

	const byChild = new Map<string, string[]>();
	for (const edge of kept) {
		const list = byChild.get(edge.child) ?? [];
		list.push(edge.parent);
		byChild.set(edge.child, list);
	}
	const nextNodes = nodes.map((node) => ({
		...node,
		prerequisites: [...new Set([...(node.prerequisites ?? []).filter((parent) => !titles.has(parent)), ...(byChild.get(node.title) ?? [])])],
		aliases: node.aliases?.length ? node.aliases : undefined,
	}));
	const targets = [...new Set((input.targets ?? (input.target ? [input.target] : [])).map(rename).filter((t) => nextNodes.some((n) => n.title === t)))];
	return {
		input: { ...input, targets, nodes: nextNodes },
		notes,
	};
}

function sharesToken(a: string, b: string): boolean {
	const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
	const A = words(a);
	for (const w of words(b)) if (A.has(w)) return true;
	return false;
}

/** Remove edges until the graph is a DAG. Candidate edges go first, then the least affirmed. */
export function dropCycles(edges: EdgeVote[], notes: string[]): EdgeVote[] {
	let kept = [...edges];
	for (let guard = 0; guard < kept.length + 1; guard++) {
		const graph = new Map<string, string[]>();
		for (const edge of kept) {
			const child = slugify(edge.child);
			const parent = slugify(edge.parent);
			graph.set(child, [...(graph.get(child) ?? []), parent]);
			if (!graph.has(parent)) graph.set(parent, []);
		}
		const cycle = findCycle(graph);
		if (!cycle) return kept;
		const ids = new Set(cycle);
		const onCycle = kept.filter((edge) => ids.has(slugify(edge.child)) && ids.has(slugify(edge.parent)));
		onCycle.sort((a, b) => (a.source === b.source ? a.yes - b.yes : a.source === "candidate" ? -1 : 1));
		const drop = onCycle[0];
		if (!drop) return kept;
		kept = kept.filter((edge) => edge !== drop);
		notes.push(`Dropped ${drop.parent} → ${drop.child} to keep the map acyclic.`);
	}
	return kept;
}

export async function judgeUnderstanding(
	client: JevClient,
	input: { question: string; response: string; reference?: string; rubric?: string },
): Promise<GradedUnderstanding | null> {
	if (!input.response.trim()) return null;
	try {
		const answers = await client.ask(
			{
				question: input.question.slice(0, 2000),
				reference: (input.reference ?? "").slice(0, 2000),
				rubric: (input.rubric ?? "").slice(0, 1000),
				response: input.response.slice(0, 2000),
			},
			{
				understanding: score(
					{
						question: "How well does `response` show the understanding `question` asks for?",
						focus: "Judge the idea, not formatting. An equivalent form is right. A careless arithmetic or copying error in otherwise right work is a slip, not a wrong idea.",
						compare: ["`response`", "`reference`", "`rubric`"],
					},
					GRADE_LEVELS,
				),
			},
		);
		const answer = answers.understanding;
		if (answer?.score == null || answer.confidence == null) return null;
		return decideGrade(answer.score, answer.confidence);
	} catch {
		return null;
	}
}

export async function pickLabel(
	client: JevClient,
	question: string,
	state: unknown,
	options: Array<{ id: string; label: string; detail?: string }>,
): Promise<string | null> {
	if (options.length < 2) return null;
	try {
		const criteria: Record<string, string> = {};
		options.forEach((option, i) => {
			criteria[`o${i}`] = option.detail ? `${option.label}. ${option.detail}` : option.label;
		});
		const answers = await client.ask(state, {
			pick: choice(
				{
					question,
					focus: "Choose one of the supplied options. Do not invent another concept.",
				},
				criteria,
			),
		});
		const chosen = answers.pick?.choice;
		const index = chosen ? Number(chosen.slice(1)) : NaN;
		if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
		if ((answers.pick?.confidence ?? 0) < PICK_CONFIDENCE) return null;
		return options[index].id;
	} catch {
		return null;
	}
}

const pickCache = new Map<string, string | null>();

export async function pickReadyStep(client: JevClient | undefined, steps: StudyStep[], objective?: string): Promise<StudyStep | undefined> {
	if (steps.length <= 1 || !client) return steps[0];
	const key = steps
		.map((s) => `${s.goal ?? ""}:${s.concept}`)
		.sort()
		.join("|");
	if (!pickCache.has(key)) {
		const id = await pickLabel(
			client,
			"Which of these ready concepts should be taught next?",
			{
				objective: objective ?? "",
				options: steps.map((s) => ({ concept: s.concept, goal: s.goal, why: s.why })),
			},
			steps.map((s) => ({ id: s.concept, label: s.concept, detail: s.why })),
		);
		pickCache.set(key, id);
	}
	const id = pickCache.get(key);
	return steps.find((s) => s.concept === id) ?? steps[0];
}

export function clearPickCache(): void {
	pickCache.clear();
}
