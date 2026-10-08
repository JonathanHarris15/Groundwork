import { accessFromContext, pathInsideAny, type FolderAccess } from "./access";
import type { MaterialKind } from "./exam";
import { ensureDir } from "./io";
import { basename, listVaultFiles, loadVaultFile, resolveSubmissionPath, resolveVaultFile, fileKind, type VaultFile } from "./files";
import { demoteHeadings, setSection } from "./markdown";
import { awaitJudgment, describeQuizOutcome, recordQuizAnswer, takeAwaiting, type QuizOutcome } from "./grading";
import { describeEdge, type EvidenceKind, type Outcome } from "./model";
import {
	applyTestJudgments,
	describeTestForGrading,
	describeTestReport,
	finishTest,
	gradeOutstandingWritten,
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
import { judgmentsFor, toGradeItem, type AnswerGrader } from "./jev/grade";
import { needsJudgment, prepareQuiz, type FreeResponseJudgment, type PreparedQuiz, type QuizInput, type QuizResponse } from "./quiz";
import { isBuilt } from "./graph";
import { cardsToPractice, loadFlashcardLibrary, saveFlashcard } from "./flashcards";
import { daysLeftPhrase } from "./goal-plan";
import { saveFigure, type SessionFigure } from "./figure";
import { describePublicBody, fetchPublic } from "./figure-net";
import { conceptSummary, describeGoalProgress, type ConceptInput, type GoalInput, type GoalReport, type GoalStatus, type KnowledgeStore } from "./store";

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

/** Interactive surface. The Obsidian plugin renders quiz cards and questions. */
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
	/** A figure to pin in the left margin of the current turn. */
	showFigure?(figure: SessionFigure): void;
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
	/** Folders the learner picked. Omitted means resources/ to read and submissions/ to write. */
	access?: FolderAccess;
	/** Server-side Jev grader. When set, written answers are graded without another tutor turn. */
	grader?: AnswerGrader;
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

export interface ToolDef<I = unknown> {
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
		"One self-contained question. They see only this card. State every given and define every symbol. Never 'as in the lecture'. Markdown and LaTeX.",
	),
	details: str("Setup shown under the question: the scenario, the givens, and what each symbol means."),
	format: {
		type: "string",
		enum: ["choice", "free"],
		description:
			'"choice" (default) grades instantly. "free": they type an answer (LaTeX renders) and you grade it with grade_answer unless the result says already graded. Use free when they must produce something.',
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
		purpose: str("One sentence above the question: what this checks and why it matters now."),
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
			"After they opt in to study, not for a direct answer, a summary, or a study guide. Returns the profile, tutorContext (read it; do not copy it into the profile), goals, workingGoal (the dropdown pin, or null for \"you choose\"), due reviews, recent concepts, and open misconceptions. Teach what they brought. A pin is not a reason to switch topics.",
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
			if (!step) return { text: "Nothing is waiting on the account. Ask what they want to learn.", summary: "Nothing queued to study" };
			return { text: json(step), summary: `Suggested ${step.concept}` };
		},
	},
	{
		name: "search_knowledge",
		description: "Search concepts and goals on the account. Use before probing so you build on what is already recorded.",
		inputSchema: { type: "object", properties: { query: str("Keywords.") }, required: ["query"] },
		async run({ query }: { query: string }, { store }) {
			const hits = await store.search(query);
			return {
				text: hits.length
					? json(hits.map((h) => (h.concept ? { kind: h.kind, ...conceptSummary(h.concept) } : { kind: h.kind, title: h.title })))
					: `Nothing on the account matches "${query}" yet.`,
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
			"Create or update a concept on the account. Only after they opt in to study. A concept is a reusable idea, never a file or a task on a file (that is a goal; put the file in sources). Direct prerequisites only; missing ones are created as stubs and merged unless replacePrerequisites is true. Sections replace. No path or document title in the note.",
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
			"Save a learning goal. Only after they opt in to study. A goal is its targets: concepts not yet built. The title may name a course, exam, or document. targets and nodes are reusable ideas, never a file. Pass sources for the vault files. nodes are the targets plus foundations, direct prerequisites only. due is YYYY-MM-DD; omit it and a new goal is due in 14 days. weights are percents. Concepts they already hold are stored as built. Returns open targets, built, the frontier, and a mermaid map.",
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
				due: str("Deadline as YYYY-MM-DD, such as the exam day. Omit it and a new goal is due in 14 days."),
				weights: {
					type: "array",
					description: "How much of the goal each concept is worth, as percents that add up to about 100. Leave a concept out and it shares what remains.",
					items: {
						type: "object",
						properties: {
							title: str("Concept title, one of the nodes."),
							weight: { type: "number", exclusiveMinimum: 0, description: "Percent of the goal, e.g. 25." },
						},
						required: ["title", "weight"],
					},
				},
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
					...(await goalCalendarFields(store, r)),
					progress: describeGoalProgress(r.nodes),
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
				summary: `Saved goal “${r.goal.title}” — ${describeGoalProgress(r.nodes)}`,
			};
		},
	},
	{
		name: "get_goal",
		description:
			"Status of a goal they are already studying: open targets, built, frontier, and a mermaid map. next is the step on this goal, not a reason to switch topics.",
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
					...(await goalCalendarFields(store, r)),
					progress: describeGoalProgress(r.nodes),
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
				summary: `Checked goal “${r.goal.title}” — ${describeGoalProgress(r.nodes)}`,
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
			'Set the dropdown goal. Only after they opt in to study. Pass a goal title, or "you choose". Call it when you create, switch, or merge a goal.',
		inputSchema: {
			type: "object",
			properties: { goal: str('Goal title, or "you choose".') },
			required: ["goal"],
		},
		async run({ goal }: { goal: string }, { store, ui }) {
			const pinned = await store.setWorkingGoal(goal);
			ui?.focusGoal?.(pinned?.title ?? null);
			if (!pinned) return { text: "No goal is pinned. Teach whatever they ask.", summary: "No goal pinned" };
			const left = pinned.left === 1 ? "1 concept left" : `${pinned.left} concepts left`;
			return { text: `Working on "${pinned.title}" (${left}). Teach toward it.`, summary: `Working on “${pinned.title}”` };
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
					progress: describeGoalProgress(report.nodes),
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
			"Ask one graded question and wait. Only after they opt in to study. Choice is graded instantly. Free response: if the result says already graded, teach from it; otherwise call grade_answer before anything else. kind is probe, check, or review. \"I don't know\" and a note are added automatically. Follow the Next move in the result.",
		inputSchema: quizInputSchema,
		async run(input: QuizInput, { store, ui, session, grader, signal }) {
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
				const [judgment] = await judgmentsFor(grader, [toGradeItem(quiz, response)], signal);
				if (!judgment) return { text: withMarginNotes(awaitJudgment(quiz, response), ui), summary: `Answer submitted on ${concept.title} — grading` };
				const outcome = await recordQuizAnswer(store, quiz, response, session, judgment);
				ui.quizRecorded?.(outcome);
				return {
					text: withMarginNotes(`${describeQuizOutcome(outcome)}\n\nAlready graded. Teach from this result.`, ui),
					summary: outcomeSummary(outcome),
					data: outcome,
				};
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
			"A full practice test: many questions, no feedback until they submit. Only when they asked for a test, or exam prep they opted into hits a checkpoint. Choice grades on submit. Grade written answers with grade_practice_test unless the result already graded them. Cover the exam plan or goal at the required levels. The evaluation is saved to tests/ and shown to them.",
		inputSchema: practiceTestInputSchema,
		async run(input: PracticeTestInput, { store, ui, session, grader, signal }) {
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
			await gradeOutstandingWritten(store, state, grader, signal);
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
			"Ask something with no right answer (goal, preference, direction). Only after they opt in to study. A direct question is answered in chat. Anything gradable uses quiz.",
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
			"Record a grade you judged from conversation, not from a quiz. Only after they opt in to study. Prefer quiz for anything you ask on purpose.",
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
			"Turn course files into topics and the level each must reach, save an exam plan, and create a goal. Only after they asked to study for an exam or from these files. Not for a summary or a study guide. Pass vault paths and any text you extracted. Returns the blueprint, required levels (1–5), and the goal map.",
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
		async run(input: { title?: string; why?: string; userText?: string; files?: string[]; materials?: Array<{ name: string; text: string; kind?: MaterialKind; path?: string }>; createGoal?: boolean }, ctx) {
			const { store, ui } = ctx;
			if (!(input.files?.length || input.materials?.length)) {
				return { text: "Pass files (vault paths) and/or materials (extracted text).", isError: true };
			}
			const reads = accessFromContext(ctx).readFolders;
			const files: string[] = [];
			for (const file of input.files ?? []) {
				if (!reads.length) return { text: "No folders are open for reading. The learner picks them in Settings → Groundwork.", isError: true };
				const found = await resolveVaultFile(store.context, file, reads);
				if (!found) {
					return {
						text: `"${file}" isn't in a folder Groundwork can read (${reads.map((dir) => `${dir}/`).join(", ")}).`,
						isError: true,
						summary: "File is outside the read folders",
					};
				}
				files.push(found);
			}
			const r = await store.ingestExamMaterials({ ...input, files });
			ui?.focusGoal?.((await store.workingGoal())?.title ?? null);
			return {
				text: json({
					title: r.blueprint.title,
					examKind: r.blueprint.examKind,
					plan: r.planPath,
					goal: r.goal
						? {
								title: r.goal.goal.title,
								progress: describeGoalProgress(r.goal.nodes),
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
		description:
			"List files inside the folders the learner allowed (named in your instructions). Omit folder to list every allowed folder. Pass a folder only when it is one of those, or a subfolder of one. The rest of the vault stays closed.",
		inputSchema: { type: "object", properties: { folder: str("A read folder, or a subfolder of one. Omit it to list every folder the learner allowed.") } },
		async run({ folder }: { folder?: string }, ctx) {
			const { store } = ctx;
			const reads = accessFromContext(ctx).readFolders;
			if (!reads.length) {
				return { text: "No folders are open for reading. The learner picks them in Settings → Groundwork.", isError: true, summary: "No read folders" };
			}
			const requested = folder?.trim() ?? "";
			let files: string[];
			let where: string;
			if (!requested) {
				files = [];
				for (const dir of reads) {
					for (const file of await listVaultFiles(store.context, dir)) {
						if (pathInsideAny(file, reads) && !files.includes(file)) files.push(file);
					}
				}
				where = reads.map((dir) => `${dir}/`).join(", ");
			} else if (!pathInsideAny(requested, reads)) {
				return {
					text: `Groundwork can only list ${reads.map((dir) => `${dir}/`).join(", ")}. "${requested}" is outside those folders.`,
					isError: true,
					summary: "Folder isn't readable",
				};
			} else {
				const dir = requested.replace(/^\/+|\/+$/g, "");
				files = (await listVaultFiles(store.context, dir)).filter((file) => pathInsideAny(file, reads));
				where = `${dir}/`;
			}
			if (!files.length) {
				return { text: `No files in ${where} yet. The learner can attach files in the chat or put them in a read folder.`, summary: `No files in ${where}` };
			}
			return {
				text: files.map((f) => `- ${f} (${fileKind(f).kind})`).join("\n"),
				summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"} in ${where}`,
			};
		},
	},
	{
		name: "read_vault_file",
		description:
			"Open a PDF, image, text, or markdown file inside a folder the learner allowed. Pass a vault path or a file name. Files outside those folders are not opened.",
		inputSchema: { type: "object", properties: { path: str('e.g. "resources/Lecture 3.pdf" or "Lecture 3.pdf".') }, required: ["path"] },
		async run({ path }: { path: string }, ctx) {
			const reads = accessFromContext(ctx).readFolders;
			if (!reads.length) return { text: "No folders are open for reading. The learner picks them in Settings → Groundwork.", isError: true };
			const found = await resolveVaultFile(ctx.store.context, path, reads);
			if (!found) {
				return {
					text: `No file matching "${path}" in ${reads.map((dir) => `${dir}/`).join(", ")}. list_vault_files shows what is there. Files outside those folders stay closed.`,
					isError: true,
				};
			}
			const file = await loadVaultFile(ctx.store.context, found);
			return { text: `Contents of ${found}:`, files: [file], summary: `Opened ${basename(found)}` };
		},
	},
	{
		name: "write_submission_file",
		description:
			"Write a text or markdown file the learner can hand in: a solution, a writeup, or answers to a problem set. The path has to be inside a write folder from your instructions. A bare file name is saved in the first write folder. This does not edit concept notes, goals, session notes, or their reference files.",
		inputSchema: {
			type: "object",
			properties: {
				path: str('File name or vault path inside a write folder, e.g. "homework-1.md" or "submissions/homework-1.md".'),
				content: str("The full file, markdown or plain text, ready to hand in."),
			},
			required: ["path", "content"],
		},
		async run({ path, content }: { path: string; content: string }, ctx) {
			const writes = accessFromContext(ctx).writeFolders;
			const target = resolveSubmissionPath(path, writes);
			if ("error" in target) return { text: target.error, isError: true, summary: "Couldn't write the file" };
			const body = content ?? "";
			if (!body.trim()) return { text: "The file is empty. Pass the text they should hand in.", isError: true };
			if (body.length > 200_000) return { text: "That file is over 200,000 characters. Shorten it and try again.", isError: true };
			const vault = ctx.store.context;
			const existed = await vault.exists(target.path);
			const dir = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
			if (dir) await ensureDir(vault, dir);
			await vault.write(target.path, body.endsWith("\n") ? body : `${body}\n`);
			const verb = existed ? "Replaced" : "Wrote";
			return { text: `${verb} ${target.path}. The learner can open it in the vault and hand it in.`, summary: `${verb} ${target.path}` };
		},
	},
	{
		name: "save_flashcard",
		description:
			"Save one flashcard on the account when they asked for a card. Not copied into the vault unless they ask. One question, back is a few words. deck creates a deck if the name is new. Omit it for Unsorted. A deleted deck name starts that deck again, without the cards they removed.",
		inputSchema: {
			type: "object",
			properties: {
				concept: str("Concept this card checks. The title of a concept you have already saved."),
				front: str("One specific question with a single short answer (not “list all types of…”). Markdown and LaTeX allowed."),
				back: str("A few words max — one atomic answer, no comma-separated lists."),
				deck: str("Deck name. A name that does not exist yet creates that deck. Omit for the Unsorted deck. A deleted deck name starts that deck again, empty of the cards they removed."),
			},
			required: ["concept", "front", "back"],
		},
		async run({ concept, front, back, deck }: { concept: string; front: string; back: string; deck?: string }, ctx) {
			try {
				const saved = await saveFlashcard(ctx.store, { concept, front, back, deck });
				return {
					text: `Saved a flashcard on ${saved.card.concept} in ${saved.deckTitle}. It stays on the account until the learner asks to write cards into the vault.`,
					summary: `Saved a flashcard on ${saved.card.concept}`,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { text: message, isError: true, summary: "Couldn't save the flashcard" };
			}
		},
	},
	{
		name: "list_flashcards",
		description:
			"Decks on the account, and the cards in them. Use this before offering a flashcard session or choosing a deck. A sitting includes every card in the deck. Ratings only change the order inside that sitting.",
		inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
		async run({ limit }: { limit?: number }, { store }) {
			const lib = await loadFlashcardLibrary(store.io);
			const deckTitle = (id: string) => lib.decks.find((d) => d.id === id)?.title ?? id;
			const names = [...lib.decks].sort((a, b) => a.title.localeCompare(b.title)).map((d) => d.title);
			const deckLine = names.length ? `Decks: ${names.join(", ")}` : "Decks: none yet";
			const cards = cardsToPractice(lib.cards);
			const shown = cards.slice(0, limit ?? 20);
			if (!shown.length) return { text: `No flashcards yet.\n${deckLine}`, summary: "No flashcards yet" };
			const lines = shown.map((c) => `- ${c.concept} · ${deckTitle(c.deckId)} ${c.front.split("\n")[0]}`);
			const more = cards.length > shown.length ? `\n${cards.length - shown.length} more.` : "";
			return { text: `${deckLine}\n${lines.join("\n")}${more}`, summary: `${cards.length} flashcard${cards.length === 1 ? "" : "s"}` };
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
			"Update the learner profile: background, how they learn, patterns across several sessions. Not weak topics, not tutorContext, and never a conclusion from one or two misses or from slips. If later evidence contradicts a section, mode replace.",
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
		name: "fetch_public",
		description:
			"Read one public https URL (page, JSON, or GeoJSON) before show_figure. Private and local addresses are refused. Image bytes are not returned; pass the URL to show_figure.",
		inputSchema: {
			type: "object",
			properties: { url: str("https URL of a public page, API, GeoJSON file, or image.") },
			required: ["url"],
		},
		async run({ url }: { url?: string }, { signal }) {
			const body = await fetchPublic(String(url ?? ""), { signal });
			let host = body.finalUrl;
			try {
				host = new URL(body.finalUrl).host;
			} catch {
				/* the fetched URL is already checked */
			}
			return { text: describePublicBody(body), summary: `Read ${host}` };
		},
	},
	{
		name: "show_figure",
		description:
			"Show one figure in the left margin. Plates: plot, plot3d, story, conjugation, sentence, or a rough map. A real place: kind image or geo with a public url. kind svg is your drawing. kind program is Python that writes figure.svg, figure.png, figure.gif, or figure.webp inside Groundwork. Then say what to look at. Do not paste the picture.",
		inputSchema: {
			type: "object",
			properties: {
				title: str("Short title on the figure."),
				caption: str("One sentence under the figure."),
				kind: {
					type: "string",
					enum: ["plot", "plot3d", "story", "map", "conjugation", "sentence", "image", "svg", "geo", "program"],
					description: "plot, plot3d, story, map, conjugation, sentence, image, svg, geo, or program.",
				},
				url: str("Public https URL for kind image or geo."),
				credit: str("Where an image or map came from."),
				markup: str("SVG markup for kind svg. No scripts."),
				geojson: { type: "object", description: "GeoJSON for kind geo, when you already have it. Otherwise pass url." },
				source: str("Python source for kind program. Groundwork runs it. Write figure.svg, figure.png, figure.gif, or figure.webp."),
				xLabel: str("Horizontal axis name."),
				yLabel: str("Vertical axis name."),
				zLabel: str("Height axis name, for plot3d."),
				xMin: { type: "number" },
				xMax: { type: "number" },
				yMin: { type: "number" },
				yMax: { type: "number" },
				expr: str("For plot3d, z as an expression in x and y. Use 2*x, not 2x. Functions: sin cos tan exp log ln log10 sqrt abs."),
				series: {
					type: "array",
					description: "Plot series. Each has points [[x,y],...] or expr in x, and mark line, scatter, or bar.",
					items: {
						type: "object",
						properties: {
							name: str("Legend label."),
							expr: str("Expression in x."),
							points: { type: "array", items: { type: "array", items: { type: "number" } } },
							mark: { type: "string", enum: ["line", "scatter", "bar"] },
						},
					},
				},
				grid: { type: "array", description: "Optional z grid for plot3d. Prefer expr.", items: { type: "array", items: { type: "number" } } },
				beats: {
					type: "array",
					description: "Story beats in order.",
					items: {
						type: "object",
						properties: {
							stage: { type: "string", enum: ["exposition", "rising", "climax", "falling", "resolution"] },
							label: str("What happens here."),
						},
						required: ["stage", "label"],
					},
				},
				markers: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: str("Place name."),
							lat: { type: "number" },
							lon: { type: "number" },
							side: str("Group that shares a color, such as Allies or Axis."),
						},
						required: ["name", "lat", "lon"],
					},
				},
				movements: {
					type: "array",
					items: {
						type: "object",
						properties: {
							from: str("Marker name."),
							to: str("Marker name."),
							label: str("What moved."),
						},
						required: ["from", "to"],
					},
				},
				lemma: str("Dictionary form of the verb."),
				language: str("For a conjugation, the language name. For a program, python."),
				tense: str("Tense or mood."),
				highlight: str("Person or form to emphasize."),
				rows: {
					type: "array",
					items: {
						type: "object",
						properties: { person: str("Person."), form: str("Conjugated form.") },
						required: ["person", "form"],
					},
				},
				words: {
					type: "array",
					description: "Sentence words in order. A modifier's of is the index it hangs from.",
					items: {
						type: "object",
						properties: {
							text: str("The word."),
							role: { type: "string", enum: ["subject", "verb", "object", "complement", "modifier"] },
							of: { type: "number" },
						},
						required: ["text", "role"],
					},
				},
			},
			required: ["title", "kind"],
		},
		async run(input: unknown, { store, ui, session, signal }) {
			const figure = await saveFigure(store, input, { sessionId: session?.id }, { signal });
			ui?.showFigure?.(figure);
			return {
				text: `Showing a ${figure.kind} figure “${figure.title}” in the left margin (${figure.id}). It is saved on the learner's account. Refer to it in your reply. Do not paste the SVG.`,
				summary: `Figure: ${figure.title}`,
			};
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

async function goalCalendarFields(store: KnowledgeStore, report: GoalReport) {
	const timing = await store.goalTiming(report);
	const titleOf = (id: string) => report.nodes.find((node) => node.id === id)?.title ?? id;
	return {
		due: report.goal.due ?? null,
		daysLeft: timing.schedule?.daysLeft ?? null,
		dueLabel: timing.schedule ? daysLeftPhrase(timing.schedule.daysLeft) : null,
		pace: timing.schedule?.pace ?? null,
		readiness: Math.round(timing.readiness * 100),
		weights: report.nodes.map((node) => ({ title: titleOf(node.id), percent: Math.round(timing.weights[node.id] ?? 0) })),
		studiedDays: timing.schedule?.studiedDays ?? 0,
	};
}

export function toolByName(name: string): ToolDef | undefined {
	return TOOLS.find((t) => t.name === name);
}
