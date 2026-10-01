import { basename, listVaultFiles, loadVaultFile, resolveVaultFile, RESOURCES_DIR, fileKind, type VaultFile } from "./files";
import { demoteHeadings, setSection } from "./markdown";
import { awaitJudgment, describeQuizOutcome, recordQuizAnswer, takeAwaiting, type QuizOutcome } from "./grading";
import { describeEdge, type EvidenceKind, type Outcome } from "./model";
import {
	applyTestJudgments,
	describeTestForGrading,
	describeTestReport,
	finishTest,
	MAX_TEST_QUESTIONS,
	prepareTest,
	startTestGrading,
	testInProgress,
	ungraded,
	type PracticeTestInput,
	type PreparedTest,
	type TestReport,
	type TestResponse,
} from "./practice";
import { needsJudgment, prepareQuiz, type FreeResponseJudgment, type PreparedQuiz, type QuizInput, type QuizResponse } from "./quiz";
import { isBuilt } from "./graph";
import { conceptSummary, describeGoalProgress, type ConceptInput, type GoalInput, type GoalStatus, type KnowledgeStore } from "./store";

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

/** Interactive surface. The Obsidian plugin renders cards; MCP uses elicitation or a two-step fallback. */
export interface ToolUI {
	quiz(quiz: PreparedQuiz): Promise<QuizResponse | null>;
	/** Called once an answer is graded and recorded (for free response, after the tutor's grade_answer). */
	quizRecorded?(outcome: QuizOutcome): void;
	/** Show a whole practice test and resolve when the learner submits it. */
	test?(test: PreparedTest): Promise<TestResponse | null>;
	testGraded?(report: TestReport): void;
	ask(input: AskInput): Promise<AskResponse | null>;
	/** Side questions the learner asked since the tutor last looked; appended to interactive results. */
	marginNotes?(): string | undefined;
	/** The dropdown pin changed (a goal title, or null for "you choose"). */
	focusGoal?(title: string | null): void;
}

function withMarginNotes(text: string, ui: ToolUI): string {
	const notes = ui.marginNotes?.();
	return notes ? `${text}\n\n${notes}` : text;
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
	/** Files to show the model alongside `text` (images, PDFs, text files). */
	files?: VaultFile[];
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

const questionProperties: Record<string, JSONSchema> = {
	concept: str("Title of the concept this question measures (create it with upsert_concept or set_goal first)."),
	question: str(
		"Exactly one question, fully self-contained: the learner sees only this card, not your files. State every given, and define every symbol and term the first time it appears (e.g. 'where $\\mu$ is the coefficient of friction'). Never write 'as in the lecture' or rely on notation from a document. Markdown and LaTeX allowed.",
	),
	details: str("Setup shown under the question: the scenario, the givens, and what each symbol means."),
	format: {
		type: "string",
		enum: ["choice", "free"],
		description:
			'"choice" (default): multiple choice, graded instantly. "free": the learner types an answer (markdown + LaTeX; math renders in the answer box) and YOU grade it against referenceAnswer with grade_answer. Use free when the skill is producing something: a computation, an expression, a derivation step, a definition in their words.',
	},
	options: {
		type: "array",
		minItems: 2,
		description: "Choice only: the real, gradable options (2+). Never include an 'I don't know' option — it is added automatically.",
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
		description: "Choice only: option value (single-select) or array of values (multi-select, exact-set grading).",
		anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
	},
	referenceAnswer: str("Free only (required): the model answer, with LaTeX. Shown to the learner after grading."),
	rubric: str("Free only: what full credit requires and what earns partial credit."),
	explanation: str("Revealed after answering: why the correct answer is correct (and why tempting distractors are wrong)."),
	difficulty: {
		type: "integer",
		minimum: 1,
		maximum: 5,
		description: "1 recognize · 2 recall/restate · 3 apply (standard) · 4 combine/multi-step · 5 transfer/novel.",
	},
	multiSelect: { type: "boolean", description: "Choice only: true when more than one option is correct." },
	shuffle: { type: "boolean", description: "Choice only. Default true. False only when option order carries meaning." },
};

export const quizInputSchema: JSONSchema = {
	type: "object",
	properties: {
		...questionProperties,
		purpose: str(
			"Shown above the question, one plain sentence to the learner: what this checks and why it matters for where you are headed, e.g. 'Checking you can find a slope from two points — the derivative is built from exactly this.'",
		),
		kind: { type: "string", enum: evidenceKinds.slice(0, 3), description: "probe = mapping the edge, check = confirming a node just taught, review = spaced retrieval." },
	},
	required: ["concept", "question", "purpose", "explanation", "difficulty", "kind"],
};

export const practiceTestInputSchema: JSONSchema = {
	type: "object",
	properties: {
		title: str("e.g. 'Midterm 1 practice — derivatives'."),
		goal: str("Goal this test measures, if any."),
		examPlan: str("Exam plan it mirrors, if any."),
		objective: str("Shown at the top, in plain terms: what skills this test measures and why that matters for their goal or exam."),
		instructions: str("Shown at the top: scope, rules (e.g. no calculator), how it maps to the real exam. Define any notation the whole test shares here."),
		timeLimitMinutes: { type: "integer", minimum: 1, description: "Optional. Shown as a countdown; the test is not cut off." },
		questions: {
			type: "array",
			minItems: 1,
			maxItems: MAX_TEST_QUESTIONS,
			description: "In exam order. Mix choice and free response as the real exam would.",
			items: { type: "object", properties: questionProperties, required: ["concept", "question", "explanation", "difficulty"] },
		},
	},
	required: ["title", "objective", "questions"],
};

const judgmentProperties: Record<string, JSONSchema> = {
	outcome: { type: "string", enum: ["correct", "partial", "incorrect"] },
	feedback: str("Shown to the learner: what is right, then the exact step that went wrong. LaTeX allowed."),
	misconception: str("If a wrong belief shows: that belief, stated specifically. Never for a slip."),
	slip: {
		type: "boolean",
		description:
			"True when the method and understanding are right and the only error is non-conceptual (arithmetic, a sign, copying a term, a typo). Recorded as correct, barely counted against them. Mention the slip in feedback and move on.",
	},
};

function iconFor(outcome: Outcome): string {
	return outcome === "correct" ? "✓" : outcome === "partial" ? "◐" : outcome === "dont_know" ? "?" : "✗";
}

function outcomeSummary(o: QuizOutcome): string {
	return `${iconFor(o.grade.outcome)} ${o.conceptTitle}: ${o.before.attempts ? pct(o.before.current) : "—"} → ${pct(o.after.current)}`;
}

export const TOOLS: ToolDef[] = [
	{
		name: "get_learner_overview",
		description:
			"Call FIRST in every learning session. Returns the learner profile, tutorContext (extra notes the learner wrote in Settings — read them, do not rewrite them or copy them into the learner profile), knowledge counts, active goals (each goal is the targets not yet built), workingGoal (the goal pinned in the dropdown, or null when they left it on \"you choose\"), due spaced reviews, recently practiced concepts, and open misconceptions. Use it to recall what they already hold about the topic they brought. A pin is not a reason to ignore a topic or file they just brought.",
		inputSchema: { type: "object", properties: {} },
		async run(_i, { store }) {
			const o = await store.overview();
			const { nextUp: _nextUp, ...forTutor } = o;
			return {
				text: json(forTutor),
				summary: `Loaded memory: ${o.conceptCount} concepts, ${o.activeGoals.length} active goals, ${o.dueReviews.length} due reviews`,
			};
		},
	},
	{
		name: "suggest_what_to_study",
		description:
			"One concept to study when the learner asks what to study and did not name a topic, a goal, or bring a file. Do not call this to change the subject when they already said what they want to learn.",
		inputSchema: { type: "object", properties: {} },
		async run(_i, { store }) {
			const step = await store.studyNext();
			if (!step) return { text: "Nothing is waiting in the vault. Ask what they want to learn.", summary: "Nothing queued to study" };
			return { text: json(step), summary: `Suggested ${step.concept}` };
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
			"Create or update a concept note in the vault. A concept is a reusable idea (Linear functions, Affine compositions), never a source document or a task tied to one (Lecture Note 1 fluency, Practice Exam 1, Prepare for the midterm). Those are goals: put the file in the goal's sources. Prerequisites are DIRECT dependencies (missing ones are created as stubs) and are merged with existing ones unless replacePrerequisites is true. Sections are markdown and replace the existing section. Do not mention a file path or a document title in the note.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Reusable idea, e.g. 'Linear functions'. Not a lecture, homework, exam, or fluency task."),
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
			"Save a learning goal. A goal is the list of targets: concepts the learner has not built yet. The title may name a course, exam, or document (Lecture 1 note fluency, Prepare for the midterm). targets and nodes must be abstract concepts that would still make sense in another class — never a file and never fluency on a file. Pass sources for the vault files this goal draws on. nodes is the construction graph: the targets plus the foundations they rest on, each with its direct prerequisites. Concepts the learner already holds are stored as built, not as open targets. Returns the open targets, what is already built, the frontier, and a mermaid map.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Short name. May name a course or a file, e.g. 'Lecture 1 note fluency' or 'Backpropagation'."),
				objective: str("Optional context in the learner's words. The goal is the targets, not this sentence."),
				why: str("What the learner wants this for."),
				approach: str("Your teaching plan in prose: order and why."),
				targets: strList(
					"Concepts this goal is made of. A target is a concept not yet built (not solid at its required level). Each must also appear in nodes. Name concepts they already hold too; those are recorded as built.",
				),
				nodes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: str("Concept title."),
							prerequisites: strList("Direct prerequisite titles."),
							summary: str("Optional one-line summary."),
							domain: str("Optional subject area."),
							requiredLevel: {
								type: "integer",
								minimum: 1,
								maximum: 5,
								description: "Exam depth this node must reach (same 1–5 scale as quizzes). Set when the goal is exam prep.",
							},
						},
						required: ["title"],
					},
				},
				status: { type: "string", enum: ["active", "paused", "done"] },
				examPlan: str("Title of the exam plan note this goal was built from, if any."),
				sources: strList("Vault paths of the source documents for this goal, e.g. resources/Lecture Note 1.pdf. Never put these on a concept."),
			},
			required: ["title", "targets", "nodes"],
		},
		async run(input: GoalInput, { store, ui }) {
			const r = await store.setGoal(input);
			ui?.focusGoal?.((await store.workingGoal())?.title ?? null);
			const titleOf = (id: string) => r.nodes.find((n) => n.id === id)?.title ?? id;
			return {
				text: json({
					goal: r.goal.title,
					note: r.goal.path,
					status: r.goal.status,
					progress: describeGoalProgress(r.goal),
					targets: r.goal.targets.map(titleOf),
					built: r.goal.built.map(titleOf),
					next: r.next ?? null,
					frontier: r.analysis.frontier.map((n) => n.title),
					blocked: r.analysis.blocked.map((n) => n.title),
					rusty: r.analysis.rusty.map((n) => n.title),
					unassessed: r.analysis.unassessed.map((n) => n.title),
					sources: r.goal.sources,
					mermaid: r.mermaid,
					judgments: r.judgmentNotes ?? [],
				}),
				summary: `Saved goal “${r.goal.title}” — ${describeGoalProgress(r.goal)}`,
			};
		},
	},
	{
		name: "get_goal",
		description:
			"Calibrated status of a goal the learner is already working: the targets not yet built, what is already built, per-node role and edge, the frontier, and a mermaid map. `next` is the step to take on this goal, not a reason to switch away from something else they asked to learn.",
		inputSchema: { type: "object", properties: { goal: str("Goal title.") }, required: ["goal"] },
		async run({ goal }: { goal: string }, { store }) {
			const r = await store.goalReport(goal);
			const next = await store.chooseNext(r);
			const titleOf = (id: string) => r.nodes.find((n) => n.id === id)?.title ?? id;
			return {
				text: json({
					goal: r.goal.title,
					status: r.goal.status,
					objective: r.goal.objective,
					progress: describeGoalProgress(r.goal),
					targets: r.goal.targets.map(titleOf),
					built: r.goal.built.map(titleOf),
					next: next ?? r.next ?? null,
					order: r.analysis.order.map((n) => {
						const d = r.nodes.find((x) => x.id === n.id)!;
						const need = r.goal.requiredLevels[n.id];
						return {
							title: n.title,
							role: d.role,
							status: n.status,
							built: isBuilt(n.status, d.floor, need),
							now: n.status === "unassessed" ? null : pct(n.current),
							edge: d.edge,
							requiredLevel: need,
							misconceptions: d.openMisconceptions,
						};
					}),
					frontier: r.analysis.frontier.map((n) => n.title),
					blocked: r.analysis.blocked.map((n) => n.title),
					rusty: r.analysis.rusty.map((n) => n.title),
					unassessed: r.analysis.unassessed.map((n) => n.title),
					sources: r.goal.sources,
					mermaid: r.mermaid,
				}),
				summary: `Checked goal “${r.goal.title}” — ${describeGoalProgress(r.goal)}`,
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
		async run({ goal, status }: { goal: string; status: GoalStatus }, { store, ui }) {
			const g = await store.setGoalStatus(goal, status);
			const pinned = await store.workingGoal();
			if (!pinned || pinned.id === g.id) ui?.focusGoal?.(pinned?.title ?? null);
			return { text: `Goal "${g.title}" is now ${status}.`, summary: `Goal “${g.title}” → ${status}` };
		},
	},
	{
		name: "set_working_goal",
		description:
			'Set the goal shown in the learner\'s dropdown. Pass the goal title, or "you choose" when they are not pinned to one. Call this when you create a goal, switch goals, or merge into one, so the dropdown matches the conversation.',
		inputSchema: {
			type: "object",
			properties: { goal: str('Goal title, or "you choose".') },
			required: ["goal"],
		},
		async run({ goal }: { goal: string }, { store, ui }) {
			const pinned = await store.setWorkingGoal(goal);
			ui?.focusGoal?.(pinned?.title ?? null);
			if (!pinned) return { text: 'The goal dropdown is now "you choose".', summary: "Goal dropdown → you choose" };
			const left = pinned.left === 1 ? "1 concept left" : `${pinned.left} concepts left`;
			return { text: `The goal dropdown is now "${pinned.title}" (${left}). Teach toward it.`, summary: `Goal dropdown → ${pinned.title}` };
		},
	},
	{
		name: "merge_goals",
		description:
			"Fold duplicate goals into one. The kept goal gains the others' concepts. The others are marked done and point at the kept goal. If the dropdown was on a goal you folded in, it moves to the kept goal.",
		inputSchema: {
			type: "object",
			properties: {
				keep: str("Goal title to keep."),
				merge: strList("Goal titles to fold into it. These are marked done."),
			},
			required: ["keep", "merge"],
		},
		async run({ keep, merge }: { keep: string; merge: string[] }, { store, ui }) {
			const report = await store.mergeGoals(keep, merge ?? []);
			const pinned = await store.workingGoal();
			ui?.focusGoal?.(pinned?.title ?? null);
			const titleOf = (id: string) => report.nodes.find((n) => n.id === id)?.title ?? id;
			return {
				text: json({
					goal: report.goal.title,
					status: report.goal.status,
					progress: describeGoalProgress(report.goal),
					targets: report.goal.targets.map(titleOf),
					built: report.goal.built.map(titleOf),
					workingGoal: pinned?.title ?? null,
				}),
				summary: `Merged into “${report.goal.title}”`,
			};
		},
	},
	{
		name: "quiz",
		interactive: true,
		description:
			"Ask ONE graded question and wait for the learner's answer; it is recorded as calibrated evidence on the concept. Multiple choice (format choice) is graded instantly and shown with the explanation. Free response (format free) lets the learner type an answer with LaTeX; you then grade it with grade_answer. Use for probing the edge (kind probe), confirming a node (check), and spaced review (review). 'I don't know' (with a familiarity slider from 'never seen this' to 'almost have it') and a note are always offered automatically. The result includes a 'Next move' from the diagnosis ladder: follow it.",
		inputSchema: quizInputSchema,
		async run(input: QuizInput, { store, ui, session }) {
			if (!ui) return { text: "quiz needs an interactive surface.", isError: true };
			const hit = await store.resolveForEvidence(input.concept, input.question);
			if (!hit) {
				return { text: `Unknown concept "${input.concept}". Create it with upsert_concept (or set_goal) first, then ask again.`, isError: true };
			}
			const concept = hit.concept;
			const quiz = prepareQuiz({ ...input, concept: concept.title });
			const response = await ui.quiz(quiz);
			if (!response) return { text: withMarginNotes("The learner dismissed the quiz without answering. Nothing was recorded.", ui), summary: "Quiz dismissed" };
			if (needsJudgment(quiz, response)) {
				return { text: withMarginNotes(awaitJudgment(quiz, response), ui), summary: `Answer submitted on ${concept.title} — grading` };
			}
			const outcome = await recordQuizAnswer(store, quiz, response, session);
			ui.quizRecorded?.(outcome);
			const matched = hit.matchedFrom ? `Matched “${hit.matchedFrom}” to [[${concept.title}]].\n` : "";
			return { text: withMarginNotes(matched + describeQuizOutcome(outcome), ui), summary: outcomeSummary(outcome), data: outcome };
		},
	},
	{
		name: "grade_answer",
		description:
			"Grade a free-response answer the learner submitted to quiz (format free). Your grade, feedback, and the reference answer are shown on their card and recorded as evidence. Call right after the quiz result, before anything else.",
		inputSchema: {
			type: "object",
			properties: { quiz_id: str("The quiz_id from the quiz result."), ...judgmentProperties },
			required: ["quiz_id", "outcome", "feedback"],
		},
		async run(input: FreeResponseJudgment & { quiz_id: string }, { store, ui, session }) {
			const pending = takeAwaiting(input.quiz_id);
			if (!pending) return { text: `No free-response answer is waiting with quiz_id ${input.quiz_id}. It may already be graded.`, isError: true };
			const outcome = await recordQuizAnswer(store, pending.quiz, pending.response, session, input);
			ui?.quizRecorded?.(outcome);
			const text = describeQuizOutcome(outcome);
			return { text: ui ? withMarginNotes(text, ui) : text, summary: outcomeSummary(outcome), data: outcome };
		},
	},
	{
		name: "practice_test",
		interactive: true,
		description:
			"Give the learner a full practice test (exam prep): many questions at once, multiple choice and free response mixed, with no feedback until they submit. Multiple choice is graded on submit; you grade free responses with grade_practice_test. Every answer is recorded as evidence, and an evaluation (score, per-concept breakdown, misconceptions) is saved to tests/ and shown to the learner. Build it from the exam plan or goal: cover every topic, at the required levels, in the real exam's proportions.",
		inputSchema: practiceTestInputSchema,
		async run(input: PracticeTestInput, { store, ui, session }) {
			if (!ui?.test) return { text: "practice_test needs an interactive surface; quiz them one question at a time instead.", isError: true };
			const unknown: string[] = [];
			const questions: QuizInput[] = [];
			for (const q of input.questions ?? []) {
				const hit = await store.resolveForEvidence(q.concept, q.question);
				if (!hit) unknown.push(q.concept);
				else questions.push({ ...q, concept: hit.concept.title });
			}
			if (unknown.length) {
				return { text: `Unknown concepts: ${[...new Set(unknown)].join(", ")}. Create them with upsert_concept (or set_goal) first, then give the test.`, isError: true };
			}
			const test = prepareTest({ ...input, questions });
			const response = await ui.test(test);
			if (!response) return { text: withMarginNotes("The learner closed the practice test without submitting. Nothing was recorded.", ui), summary: "Practice test dismissed" };
			const state = await startTestGrading(store, test, response, session);
			if (ungraded(state).length) {
				return { text: withMarginNotes(describeTestForGrading(state), ui), summary: `Practice test submitted — grading ${ungraded(state).length} written answer${ungraded(state).length === 1 ? "" : "s"}` };
			}
			const report = await finishTest(store, state);
			ui.testGraded?.(report);
			return { text: withMarginNotes(describeTestReport(report), ui), summary: `Practice test: ${pct(report.percent)}`, data: report };
		},
	},
	{
		name: "grade_practice_test",
		description: "Grade the free-response answers of a submitted practice test. Pass one grade per question listed in the practice_test result. When all are graded, the evaluation is saved and shown to the learner.",
		inputSchema: {
			type: "object",
			properties: {
				test_id: str("The test_id from the practice_test result."),
				grades: {
					type: "array",
					items: {
						type: "object",
						properties: { question: { type: "integer", description: "Question number (1-based)." }, ...judgmentProperties },
						required: ["question", "outcome", "feedback"],
					},
				},
			},
			required: ["test_id", "grades"],
		},
		async run(input: { test_id: string; grades: Array<FreeResponseJudgment & { question: number }> }, { store, ui }) {
			const state = testInProgress(input.test_id);
			if (!state) return { text: `No practice test awaiting grades with test_id ${input.test_id}. It may already be evaluated.`, isError: true };
			const problems = await applyTestJudgments(store, state, input.grades ?? []);
			const left = ungraded(state);
			if (left.length) {
				const nums = left.map((q) => state.test.questions.indexOf(q) + 1);
				return {
					text: [...problems, `Still ungraded: question${nums.length === 1 ? "" : "s"} ${nums.join(", ")}. Call grade_practice_test again for ${nums.length === 1 ? "it" : "them"}.`].join("\n"),
					summary: `Graded — ${left.length} left`,
				};
			}
			const report = await finishTest(store, state);
			ui?.testGraded?.(report);
			const text = [...problems, describeTestReport(report)].join("\n");
			return { text: ui ? withMarginNotes(text, ui) : text, summary: `Practice test: ${pct(report.percent)}`, data: report };
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
			if (!r) return { text: withMarginNotes("The learner dismissed the question.", ui), summary: "Question dismissed" };
			const parts = [];
			if (r.selected.length) parts.push(`Selected: ${r.selected.join(" | ")}`);
			if (r.text) parts.push(`Wrote: ${r.text}`);
			return { text: withMarginNotes(parts.join("\n") || "(no answer)", ui), summary: "Learner answered" };
		},
	},
	{
		name: "record_evidence",
		description:
			"Record a graded observation you judged yourself from conversation, e.g. an explanation they typed in chat. Prefer quiz (choice or free response) for anything you ask on purpose: it records automatically and feeds the diagnosis ladder.",
		inputSchema: {
			type: "object",
			properties: {
				concept: str("Concept title."),
				outcome: { type: "string", enum: ["correct", "partial", "incorrect", "dont_know"] },
				difficulty: { type: "integer", minimum: 1, maximum: 5 },
				kind: { type: "string", enum: evidenceKinds },
				what: str("What was asked / what they did."),
				misconception: str("If incorrect: the specific wrong belief revealed."),
				slip: { type: "boolean", description: "Right understanding, careless error only. Recorded as correct with a slip." },
			},
			required: ["concept", "outcome", "difficulty", "what"],
		},
		async run(
			input: { concept: string; outcome: Outcome; difficulty: number; kind?: EvidenceKind; what: string; misconception?: string; slip?: boolean },
			{ store, session },
		) {
			const slip = input.slip === true;
			const hit = await store.resolveForEvidence(input.concept, input.what);
			if (!hit) return { text: `Unknown concept "${input.concept}". Create it with upsert_concept or set_goal first.`, isError: true };
			const { concept, before, after } = await store.recordEvidence(hit.concept.title, {
				outcome: slip ? "correct" : input.outcome,
				difficulty: input.difficulty,
				kind: input.kind ?? "explain",
				question: input.what,
				misconception: slip ? undefined : input.misconception,
				...(slip ? { slip } : {}),
				session: session?.id,
			});
			return {
				text: `Recorded. ${concept.title}: ${before.attempts ? pct(before.current) : "unassessed"} → ${pct(after.current)} (${after.status}; ${describeEdge(after)}).`,
				summary: `Recorded ${input.outcome.replace("_", " ")} on “${concept.title}”`,
			};
		},
	},
	{
		name: "ingest_exam_materials",
		description:
			"Parse course files (lecture slides, homeworks, study guides, practice exams) into the topics and the level each must be learned to, save an exam plan, and create a teaching goal. Call this as soon as the learner attaches or mentions those files — do not wait to 'just start teaching'. Pass vault paths and/or the text you extracted. Returns the blueprint, required levels (1–5), and the goal map.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Goal / exam-plan title, e.g. 'Prepare for the calc midterm'."),
				why: str("Why they are studying, in their words."),
				userText: str("The learner's message, used to guess exam kind (midterm/final/quiz)."),
				files: strList("Vault paths of attached or existing files (e.g. resources/HW2.md)."),
				materials: {
					type: "array",
					description: "Text you pulled from a file the automatic parser couldn't read (compressed PDF, image, etc.).",
					items: {
						type: "object",
						properties: {
							name: str("File name."),
							text: str("Extracted text or a close paraphrase of every problem/topic."),
							kind: { type: "string", enum: ["lecture", "homework", "study_guide", "practice_exam", "exam", "notes", "unknown"] },
							path: str("Vault path if you have one."),
						},
						required: ["name", "text"],
					},
				},
				createGoal: { type: "boolean", description: "Default true. Set false to only write the exam plan." },
			},
		},
		async run(input: { title?: string; why?: string; userText?: string; files?: string[]; materials?: Array<{ name: string; text: string; kind?: any; path?: string }>; createGoal?: boolean }, { store, ui }) {
			if (!(input.files?.length || input.materials?.length)) {
				return { text: "Pass files (vault paths) and/or materials (extracted text).", isError: true };
			}
			const r = await store.ingestExamMaterials(input);
			ui?.focusGoal?.((await store.workingGoal())?.title ?? null);
			return {
				text: json({
					title: r.blueprint.title,
					examKind: r.blueprint.examKind,
					plan: r.planPath,
					goal: r.goal
						? {
								title: r.goal.goal.title,
								progress: describeGoalProgress(r.goal.goal),
								targets: r.goal.goal.targets.map((id) => r.goal!.nodes.find((n) => n.id === id)?.title ?? id),
								built: r.goal.goal.built.map((id) => r.goal!.nodes.find((n) => n.id === id)?.title ?? id),
								frontier: r.goal.analysis.frontier.map((n) => n.title),
								sources: r.goal.goal.sources,
								mermaid: r.goal.mermaid,
							}
						: null,
					mustKnow: r.blueprint.mustKnow,
					topics: r.blueprint.topics.map((t) => ({
						title: t.title,
						requiredLevel: t.requiredLevel,
						sources: t.sources,
						ideas: t.ideas,
					})),
					materials: r.blueprint.materials,
					notes: r.blueprint.notes,
					judgments: r.goal?.judgmentNotes ?? [],
				}),
				summary: r.blueprint.topics.length
					? `Exam plan: ${r.blueprint.topics.length} topic${r.blueprint.topics.length === 1 ? "" : "s"} from ${r.blueprint.materials.length} file${r.blueprint.materials.length === 1 ? "" : "s"}`
					: "Couldn't extract topics yet — read the files and try again",
			};
		},
	},
	{
		name: "get_exam_plan",
		description: "Load a saved exam plan (topics, required levels, source files). Use after ingest_exam_materials or when continuing exam prep.",
		inputSchema: { type: "object", properties: { exam: str("Exam plan title.") }, required: ["exam"] },
		async run({ exam }: { exam: string }, { store }) {
			const path = await store.resolveExamPlan(exam);
			if (!path) return { text: `No exam plan named "${exam}". Call ingest_exam_materials first.`, isError: true };
			return { text: await store.io.read(path), summary: `Opened exam plan “${exam}”` };
		},
	},
	{
		name: "list_vault_files",
		description: `List the learner's files: PDFs, slides, images, problem sets, and notes they keep in ${RESOURCES_DIR}/ (the default folder) or elsewhere in the vault. Use it when they mention a document you haven't seen.`,
		inputSchema: { type: "object", properties: { folder: str(`Vault folder to list, recursively. Default "${RESOURCES_DIR}"; "" lists the whole vault.`) } },
		async run({ folder }: { folder?: string }, { store }) {
			const dir = (folder ?? RESOURCES_DIR).replace(/^\/+|\/+$/g, "");
			const files = await listVaultFiles(store.io, dir);
			if (!files.length) {
				return {
					text: `No files in ${dir || "the vault"}/ yet. The learner can attach files in the chat or put them in ${RESOURCES_DIR}/.`,
					summary: `No files in ${dir || "the vault"}`,
				};
			}
			return {
				text: files.map((f) => `- ${f} (${fileKind(f).kind})`).join("\n"),
				summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"} in ${dir || "the vault"}`,
			};
		},
	},
	{
		name: "read_vault_file",
		description: "Open one of the learner's files: a PDF, image, text or markdown file. Pass a vault path, or just a file name to look it up in resources/ and then the whole vault.",
		inputSchema: { type: "object", properties: { path: str(`e.g. "${RESOURCES_DIR}/Lecture 3.pdf" or "Lecture 3.pdf".`) }, required: ["path"] },
		async run({ path }: { path: string }, { store }) {
			const found = await resolveVaultFile(store.io, path);
			if (!found) return { text: `No file matching "${path}" in the vault. Use list_vault_files to see what's there.`, isError: true };
			const file = await loadVaultFile(store.io, found);
			return { text: `Contents of ${found}:`, files: [file], summary: `Opened ${basename(found)}` };
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
		description:
			"Write durable observations about the learner to learner.md: background, how they learn best, patterns seen across several sessions. Not a list of weak topics (per-concept mastery already lives in the evidence), and never a conclusion from one or two misses or from slips. When later evidence contradicts an observation, rewrite the section with mode replace.",
		inputSchema: {
			type: "object",
			properties: {
				section: str("Section heading, e.g. 'Background', 'How I learn best', 'Observations'."),
				content: str("Markdown. With mode replace, the whole new section."),
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
