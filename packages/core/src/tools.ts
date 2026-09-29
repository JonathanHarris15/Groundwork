import { demoteHeadings, setSection } from "./markdown";
import { describeEdge, predictCorrect, type ConceptStats, type EvidenceKind, type Outcome } from "./model";
import { gradeQuiz, prepareQuiz, type PreparedQuiz, type QuizGrade, type QuizInput, type QuizResponse } from "./quiz";
import { conceptSummary, type ConceptInput, type GoalInput, type GoalStatus, type KnowledgeStore } from "./store";

export type JSONSchema = Record<string, unknown>;

export interface AskInput {
	question: string;
	details?: string;
	options?: string[];
	allowFreeText?: boolean;
	multiSelect?: boolean;
}

export interface AskResponse {
	selected: string[];
	text?: string;
}

export interface QuizOutcome {
	quiz: PreparedQuiz;
	response: QuizResponse;
	grade: QuizGrade;
	before: ConceptStats;
	after: ConceptStats;
	conceptTitle: string;
}

/** Interactive surface. The Obsidian plugin renders cards; MCP uses elicitation or a two-step fallback. */
export interface ToolUI {
	quiz(quiz: PreparedQuiz): Promise<QuizResponse | null>;
	quizRecorded?(outcome: QuizOutcome): void;
	ask(input: AskInput): Promise<AskResponse | null>;
}

export interface SessionInfo {
	id: string;
	title?: string;
	notePath?: string;
}

export interface ToolContext {
	store: KnowledgeStore;
	ui?: ToolUI;
	session?: SessionInfo;
	signal?: AbortSignal;
}

export interface ToolResult {
	text: string;
	isError?: boolean;
	/** One-line human summary for activity chips in the UI. */
	summary?: string;
	data?: unknown;
}

export interface ToolDef<I = any> {
	name: string;
	description: string;
	inputSchema: JSONSchema;
	/** Interactive tools need a ToolUI and block until the learner responds. */
	interactive?: boolean;
	run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

const str = (description: string) => ({ type: "string", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const json = (v: unknown) => JSON.stringify(v, null, 2);
const pct = (x: number) => `${Math.round(x * 100)}%`;

const evidenceKinds = ["probe", "check", "review", "explain"];

export const quizInputSchema: JSONSchema = {
	type: "object",
	properties: {
		concept: str("Title of the concept this question measures (create it with upsert_concept or set_goal first)."),
		question: str("Exactly one question. Markdown and LaTeX allowed."),
		details: str("Optional context shown under the question."),
		options: {
			type: "array",
			minItems: 2,
			description: "The real, gradable options (2+). Never include an 'I don't know' option — it is added automatically.",
			items: {
				type: "object",
				properties: {
					label: str("The option as shown. A bare claim with no justification. Markdown/LaTeX allowed."),
					value: str("Short stable id used in correctAnswer, e.g. 'a' or 'chain-rule'."),
					misconception: str("Distractors only: the specific wrong belief that would lead someone to pick this."),
				},
				required: ["label", "value"],
			},
		},
		correctAnswer: {
			description: "Option value (single-select) or array of values (multi-select, exact-set grading).",
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
		},
		explanation: str("Revealed after answering: why the correct answer is correct (and why tempting distractors are wrong)."),
		difficulty: {
			type: "integer",
			minimum: 1,
			maximum: 5,
			description: "1 recognize · 2 recall/restate · 3 apply (standard) · 4 combine/multi-step · 5 transfer/novel.",
		},
		kind: { type: "string", enum: evidenceKinds.slice(0, 3), description: "probe = mapping the edge, check = confirming a node just taught, review = spaced retrieval." },
		multiSelect: { type: "boolean", description: "True when more than one option is correct." },
		shuffle: { type: "boolean", description: "Default true. False only when option order carries meaning." },
	},
	required: ["concept", "question", "options", "correctAnswer", "explanation", "difficulty", "kind"],
};

export function describeQuizOutcome(o: QuizOutcome): string {
	const { grade, quiz, response, before, after } = o;
	const lines: string[] = [];
	if (grade.outcome === "dont_know") {
		lines.push(`The learner chose "I don't know" — an honest gap, not a guess. Teach into it.`);
	} else {
		lines.push(`The learner answered ${grade.correct ? "CORRECTLY" : "INCORRECTLY"}.`);
		lines.push(`Selected: ${grade.selectedLabels.join(" | ")}`);
	}
	lines.push(`Correct: ${grade.correctLabels.join(" | ")}`);
	if (grade.misconception) lines.push(`Diagnosed misconception (from the distractor chosen): ${grade.misconception}`);
	if (response.note) lines.push(`Learner's note: ${response.note}`);
	lines.push(
		`Recorded in vault → ${o.conceptTitle}: ${before.attempts ? pct(before.current) : "unassessed"} → ${pct(after.current)} (status ${after.status}; ${describeEdge(after)}; d${quiz.difficulty} ${quiz.kind}).`,
	);
	lines.push(`Predicted chance on next d${Math.min(5, quiz.difficulty + 1)}: ${pct(predictCorrect(after, quiz.difficulty + 1))}.`);
	return lines.join("\n");
}

/** Grade, record, and describe a quiz answer. Shared by the Obsidian card flow and MCP. */
export async function recordQuizAnswer(store: KnowledgeStore, quiz: PreparedQuiz, response: QuizResponse, session?: SessionInfo): Promise<QuizOutcome> {
	const grade = gradeQuiz(quiz, response);
	const { concept, before, after } = await store.recordEvidence(quiz.concept, {
		outcome: grade.outcome,
		difficulty: quiz.difficulty,
		kind: quiz.kind,
		question: stripMd(quiz.question),
		chosen: grade.selectedLabels.join(" | ") || undefined,
		correctAnswer: grade.correctLabels.join(" | "),
		misconception: grade.misconception,
		note: response.note,
		session: session?.id,
	});
	return { quiz, response, grade, before, after, conceptTitle: concept.title };
}

function stripMd(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

export const TOOLS: ToolDef[] = [
	{
		name: "get_learner_overview",
		description:
			"Call FIRST in every learning session. Returns the learner profile, knowledge counts, active goals with progress and next nodes, due spaced reviews, recently practiced concepts, and open misconceptions.",
		inputSchema: { type: "object", properties: {} },
		async run(_i, { store }) {
			const o = await store.overview();
			return {
				text: json(o),
				summary: `Loaded memory: ${o.conceptCount} concepts, ${o.activeGoals.length} active goals, ${o.dueReviews.length} due reviews`,
			};
		},
	},
	{
		name: "search_knowledge",
		description: "Search the learner's vault for concepts and goals related to a topic. Use before probing so you build on recorded knowledge.",
		inputSchema: { type: "object", properties: { query: str("Keywords.") }, required: ["query"] },
		async run({ query }: { query: string }, { store }) {
			const hits = await store.search(query);
			return {
				text: hits.length
					? json(hits.map((h) => (h.concept ? { kind: h.kind, ...conceptSummary(h.concept) } : { kind: h.kind, title: h.title })))
					: `Nothing in the vault matches "${query}" yet.`,
				summary: `Searched memory for “${query}” — ${hits.length} hits`,
			};
		},
	},
	{
		name: "get_concepts",
		description:
			"Full detail for concepts: calibrated status, current strength, bracketed edge (floor/ceiling difficulty), open misconceptions, prerequisites with their status, dependents, and the concept note.",
		inputSchema: { type: "object", properties: { concepts: strList("Concept titles.") }, required: ["concepts"] },
		async run({ concepts }: { concepts: string[] }, { store }) {
			const out = [];
			const index = await store.concepts();
			for (const ref of concepts) {
				const c = await store.resolve(ref);
				if (!c) {
					out.push({ title: ref, found: false });
					continue;
				}
				out.push({
					...conceptSummary(c),
					found: true,
					domain: c.domain,
					attempts: c.stats.attempts,
					correct: c.stats.correct,
					openMisconceptions: c.stats.openMisconceptions,
					prerequisites: c.prerequisites.map((p) => {
						const pc = index.get(p);
						return pc ? { title: pc.title, status: pc.stats.status } : { title: p, status: "unknown" };
					}),
					dependents: (await store.dependents(c.id)).map((d) => d.title),
					note: c.body.slice(0, 4000),
				});
			}
			return { text: json(out), summary: `Read ${concepts.length} concept note${concepts.length === 1 ? "" : "s"}` };
		},
	},
	{
		name: "upsert_concept",
		description:
			"Create or update a concept note in the vault. Prerequisites are DIRECT dependencies (missing ones are created as stubs) and are merged with existing ones unless replacePrerequisites is true. Sections are markdown and replace the existing section.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Short canonical title, reused across goals."),
				domain: str("Subject area, e.g. 'linear algebra'."),
				aliases: strList("Other names."),
				prerequisites: strList("Titles of direct prerequisite concepts."),
				replacePrerequisites: { type: "boolean" },
				summary: str("What it is, in terms the learner has accepted."),
				unconditionalTruths: str("The caveat-free facts this rests on."),
				connections: str("How it follows from its prerequisites and what it unlocks."),
				misconceptions: str("Traps to watch for."),
				notes: str("Anything else worth keeping."),
			},
			required: ["title"],
		},
		async run(input: ConceptInput, { store }) {
			const { concept, created, createdPrerequisites } = await store.upsertConcept(input);
			const extra = createdPrerequisites.length ? ` Created prerequisite stubs: ${createdPrerequisites.join(", ")}.` : "";
			return {
				text: `${created ? "Created" : "Updated"} [[${concept.title}]] (${concept.path}).${extra}`,
				summary: `${created ? "Created" : "Updated"} concept “${concept.title}”`,
			};
		},
	},
	{
		name: "set_goal",
		description:
			"Save a learning goal as a dependency DAG: the target concept (the sink), every node with its direct prerequisites, the objective, and your approach. Creates/links concept notes and returns the calibrated map: which nodes are solid, the frontier (ready to learn), blocked nodes, rusty nodes, unassessed nodes, and a mermaid map to show the learner.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Goal title, e.g. 'Understand backpropagation'."),
				objective: str("Concrete, checkable end state in the learner's own terms."),
				why: str("What the learner wants this for."),
				approach: str("Your teaching plan in prose: order and why."),
				target: str("Title of the node that represents the goal."),
				nodes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: str("Concept title."),
							prerequisites: strList("Direct prerequisite titles."),
							summary: str("Optional one-line summary."),
							domain: str("Optional subject area."),
						},
						required: ["title"],
					},
				},
				status: { type: "string", enum: ["active", "paused", "done"] },
			},
			required: ["title", "objective", "target", "nodes"],
		},
		async run(input: GoalInput, { store }) {
			const r = await store.setGoal(input);
			return {
				text: json({
					goal: r.goal.title,
					note: r.goal.path,
					progress: `${r.analysis.solidCount}/${r.nodes.length} solid`,
					frontier: r.analysis.frontier.map((n) => n.title),
					blocked: r.analysis.blocked.map((n) => n.title),
					rusty: r.analysis.rusty.map((n) => n.title),
					unassessed: r.analysis.unassessed.map((n) => n.title),
					mermaid: r.mermaid,
				}),
				summary: `Saved goal “${r.goal.title}” — ${r.nodes.length} nodes`,
			};
		},
	},
	{
		name: "get_goal",
		description: "Calibrated status of a goal's dependency map: per-node status and edge, frontier, blocked, rusty, unassessed, and a mermaid map.",
		inputSchema: { type: "object", properties: { goal: str("Goal title.") }, required: ["goal"] },
		async run({ goal }: { goal: string }, { store }) {
			const r = await store.goalReport(goal);
			return {
				text: json({
					goal: r.goal.title,
					status: r.goal.status,
					objective: r.goal.objective,
					order: r.analysis.order.map((n) => {
						const d = r.nodes.find((x) => x.id === n.id)!;
						return { title: n.title, status: n.status, now: n.status === "unassessed" ? null : pct(n.current), edge: d.edge, misconceptions: d.openMisconceptions };
					}),
					frontier: r.analysis.frontier.map((n) => n.title),
					blocked: r.analysis.blocked.map((n) => n.title),
					rusty: r.analysis.rusty.map((n) => n.title),
					unassessed: r.analysis.unassessed.map((n) => n.title),
					mermaid: r.mermaid,
				}),
				summary: `Checked goal “${r.goal.title}” — ${r.analysis.solidCount}/${r.nodes.length} solid`,
			};
		},
	},
	{
		name: "set_goal_status",
		description: "Mark a goal active, paused, or done.",
		inputSchema: {
			type: "object",
			properties: { goal: str("Goal title."), status: { type: "string", enum: ["active", "paused", "done"] } },
			required: ["goal", "status"],
		},
		async run({ goal, status }: { goal: string; status: GoalStatus }, { store }) {
			const g = await store.setGoalStatus(goal, status);
			return { text: `Goal "${g.title}" is now ${status}.`, summary: `Goal “${g.title}” → ${status}` };
		},
	},
	{
		name: "quiz",
		interactive: true,
		description:
			"Ask ONE graded multiple-choice question and wait for the learner's answer. It is graded instantly, shown with the explanation, and recorded as calibrated evidence on the concept. Use for probing the edge (kind probe), confirming a node (check), and spaced review (review). 'I don't know' and a free-text note are always offered automatically.",
		inputSchema: quizInputSchema,
		async run(input: QuizInput, { store, ui, session }) {
			if (!ui) return { text: "quiz needs an interactive surface.", isError: true };
			const concept = await store.resolve(input.concept);
			if (!concept) {
				return { text: `Unknown concept "${input.concept}". Create it with upsert_concept (or set_goal) first, then ask again.`, isError: true };
			}
			const quiz = prepareQuiz({ ...input, concept: concept.title });
			const response = await ui.quiz(quiz);
			if (!response) return { text: "The learner dismissed the quiz without answering. Nothing was recorded.", summary: "Quiz dismissed" };
			const outcome = await recordQuizAnswer(store, quiz, response, session);
			ui.quizRecorded?.(outcome);
			const icon = outcome.grade.outcome === "correct" ? "✓" : outcome.grade.outcome === "dont_know" ? "?" : "✗";
			return {
				text: describeQuizOutcome(outcome),
				summary: `${icon} ${concept.title}: ${outcome.before.attempts ? pct(outcome.before.current) : "—"} → ${pct(outcome.after.current)}`,
				data: outcome,
			};
		},
	},
	{
		name: "ask_user",
		interactive: true,
		description:
			"Ask the learner a question with NO right answer (their goal, preference, direction, energy). Offer options when useful; free text is allowed by default. For anything gradable use quiz instead.",
		inputSchema: {
			type: "object",
			properties: {
				question: str("The question."),
				details: str("Optional context."),
				options: strList("Suggested answers."),
				multiSelect: { type: "boolean" },
				allowFreeText: { type: "boolean", description: "Default true." },
			},
			required: ["question"],
		},
		async run(input: AskInput, { ui }) {
			if (!ui) return { text: "ask_user needs an interactive surface; ask in chat instead.", isError: true };
			const r = await ui.ask(input);
			if (!r) return { text: "The learner dismissed the question.", summary: "Question dismissed" };
			const parts = [];
			if (r.selected.length) parts.push(`Selected: ${r.selected.join(" | ")}`);
			if (r.text) parts.push(`Wrote: ${r.text}`);
			return { text: parts.join("\n") || "(no answer)", summary: "Learner answered" };
		},
	},
	{
		name: "record_evidence",
		description:
			"Record a graded observation you judged yourself — e.g. the learner's free-form explanation or worked problem. Use quiz for multiple choice (it records automatically).",
		inputSchema: {
			type: "object",
			properties: {
				concept: str("Concept title."),
				outcome: { type: "string", enum: ["correct", "incorrect", "dont_know"] },
				difficulty: { type: "integer", minimum: 1, maximum: 5 },
				kind: { type: "string", enum: evidenceKinds },
				what: str("What was asked / what they did."),
				misconception: str("If incorrect: the specific wrong belief revealed."),
			},
			required: ["concept", "outcome", "difficulty", "what"],
		},
		async run(
			input: { concept: string; outcome: Outcome; difficulty: number; kind?: EvidenceKind; what: string; misconception?: string },
			{ store, session },
		) {
			const { concept, before, after } = await store.recordEvidence(input.concept, {
				outcome: input.outcome,
				difficulty: input.difficulty,
				kind: input.kind ?? "explain",
				question: input.what,
				misconception: input.misconception,
				session: session?.id,
			});
			return {
				text: `Recorded. ${concept.title}: ${before.attempts ? pct(before.current) : "unassessed"} → ${pct(after.current)} (${after.status}; ${describeEdge(after)}).`,
				summary: `Recorded ${input.outcome.replace("_", " ")} on “${concept.title}”`,
			};
		},
	},
	{
		name: "get_due_reviews",
		description: "Concepts whose memory has decayed enough that a spaced review is due, oldest first.",
		inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
		async run({ limit }: { limit?: number }, { store }) {
			const due = await store.dueReviews(limit ?? 10);
			return {
				text: due.length ? json(due.map(conceptSummary)) : "No reviews are due.",
				summary: `${due.length} review${due.length === 1 ? "" : "s"} due`,
			};
		},
	},
	{
		name: "update_learner_profile",
		description: "Write durable observations about the learner (background, how they learn best, recurring patterns) to learner.md.",
		inputSchema: {
			type: "object",
			properties: {
				section: str("Section heading, e.g. 'Background', 'How I learn best', 'Observations'."),
				content: str("Markdown."),
				mode: { type: "string", enum: ["append", "replace"] },
			},
			required: ["section", "content"],
		},
		async run({ section, content, mode }: { section: string; content: string; mode?: "append" | "replace" }, { store }) {
			await store.updateProfile(section, content, mode ?? "append");
			return { text: `Updated learner profile section "${section}".`, summary: `Updated learner profile (${section})` };
		},
	},
	{
		name: "save_session_summary",
		description: "Save a session summary: what was covered, where the edges now sit, and what to do next. Call at the end of a session or at natural breaks.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Short session title."),
				summary: str("Markdown summary."),
				concepts: strList("Concept titles touched."),
				next: str("What to do next time."),
			},
			required: ["summary"],
		},
		async run(input: { title?: string; summary: string; concepts?: string[]; next?: string }, { store, session }) {
			const links = (input.concepts ?? []).map((c) => `[[${c}]]`).join(", ");
			const block = [
				demoteHeadings(input.summary.trim()),
				links ? `\n**Concepts:** ${links}` : "",
				input.next ? `\n**Next time:** ${input.next.trim()}` : "",
			].join("\n");
			let path = session?.notePath;
			if (!path) {
				path = await store.sessionNotePath(input.title ?? "Session");
				if (session) session.notePath = path;
			}
			const existing = (await store.io.exists(path)) ? await store.io.read(path) : `# ${input.title ?? "Session"}\n`;
			await store.writeFile(path, setSection(existing, "Summary", block, ["Transcript"]));
			return { text: `Saved summary to ${path}.`, summary: "Saved session summary" };
		},
	},
];

export function toolByName(name: string): ToolDef | undefined {
	return TOOLS.find((t) => t.name === name);
}
