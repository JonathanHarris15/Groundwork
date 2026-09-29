/**
 * Practice tests: a timed, feedback-free run through a set of questions
 * (multiple choice and free response), graded as a whole, recorded as
 * evidence, and written up as an evaluation note the tutor teaches from.
 */

import { seedLadder } from "./diagnose";
import { FREE_RESPONSE_GRADING, recordQuizAnswer, stripMd } from "./grading";
import { demoteHeadings, safeFileName, serializeNote, wikilink } from "./markdown";
import type { ConceptStats, ConceptStatus, Outcome } from "./model";
import { familiarityLabel, letter, needsJudgment, prepareQuiz, type FreeResponseJudgment, type PreparedQuiz, type QuizGrade, type QuizInput, type QuizResponse } from "./quiz";
import { PATHS, type KnowledgeStore } from "./store";

export const MAX_TEST_QUESTIONS = 40;

export interface PracticeTestInput {
	title: string;
	/** Goal this test measures, if any. */
	goal?: string;
	/** Exam plan this test mirrors, if any. */
	examPlan?: string;
	instructions?: string;
	timeLimitMinutes?: number;
	questions: QuizInput[];
}

export interface PreparedTest {
	id: string;
	title: string;
	goal?: string;
	examPlan?: string;
	instructions?: string;
	timeLimitMinutes?: number;
	questions: PreparedQuiz[];
}

export interface TestResponse {
	/** Question id → answer. Missing questions count as left blank. */
	answers: Record<string, QuizResponse>;
	elapsedSeconds?: number;
}

export interface TestQuestionResult {
	id: string;
	number: number;
	concept: string;
	difficulty: number;
	format: PreparedQuiz["format"];
	outcome: Outcome;
	points: number;
	response: QuizResponse;
	grade: QuizGrade;
}

export interface TestConceptResult {
	concept: string;
	earned: number;
	possible: number;
	percent: number;
	questions: number[];
	before?: ConceptStats;
	status: ConceptStatus;
	now: number;
}

export interface TestReport {
	testId: string;
	title: string;
	goal?: string;
	examPlan?: string;
	date: string;
	elapsedSeconds?: number;
	earned: number;
	possible: number;
	percent: number;
	results: TestQuestionResult[];
	byConcept: TestConceptResult[];
	misconceptions: Array<{ concept: string; misconception: string }>;
	notePath?: string;
}

export function prepareTest(input: PracticeTestInput, random: () => number = Math.random): PreparedTest {
	const title = String(input.title ?? "").trim() || "Practice test";
	const qs = input.questions ?? [];
	if (!qs.length) throw new Error("A practice test needs at least one question.");
	if (qs.length > MAX_TEST_QUESTIONS) throw new Error(`Keep a practice test to ${MAX_TEST_QUESTIONS} questions or fewer.`);
	const id = `t_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
	const questions = qs.map((q, i) => {
		try {
			return { ...prepareQuiz({ ...q, kind: "test" }, random), id: `${id}_${i + 1}` };
		} catch (e) {
			throw new Error(`Question ${i + 1}: ${(e as Error).message}`);
		}
	});
	const minutes = Number(input.timeLimitMinutes);
	return {
		id,
		title,
		goal: input.goal?.trim() || undefined,
		examPlan: input.examPlan?.trim() || undefined,
		instructions: input.instructions?.trim() || undefined,
		timeLimitMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined,
		questions,
	};
}

interface TestGrading {
	test: PreparedTest;
	response: TestResponse;
	session?: { id: string };
	grades: Map<string, QuizGrade>;
	before: Map<string, ConceptStats>;
	after: Map<string, ConceptStats>;
}

const inProgress = new Map<string, TestGrading>();

const BLANK: QuizResponse = { dontKnow: true, selected: [], familiarity: 0, note: "Left blank" };

export function answerFor(test: PreparedTest, response: TestResponse, questionId: string): QuizResponse {
	const r = response.answers[questionId];
	if (!r) return BLANK;
	const q = test.questions.find((x) => x.id === questionId);
	const empty = !r.dontKnow && (q?.format === "free" ? !r.text?.trim() : !r.selected.length);
	return empty ? { ...BLANK, note: r.note ?? BLANK.note } : r;
}

/** Record everything that grades itself; free-response answers wait for the tutor. */
export async function startTestGrading(store: KnowledgeStore, test: PreparedTest, response: TestResponse, session?: { id: string }): Promise<TestGrading> {
	const state: TestGrading = { test, response, session, grades: new Map(), before: new Map(), after: new Map() };
	for (const q of test.questions) {
		const r = answerFor(test, response, q.id);
		if (needsJudgment(q, r)) continue;
		await recordOne(store, state, q, r);
	}
	inProgress.set(test.id, state);
	return state;
}

async function recordOne(store: KnowledgeStore, state: TestGrading, q: PreparedQuiz, r: QuizResponse, judgment?: FreeResponseJudgment): Promise<void> {
	const o = await recordQuizAnswer(store, q, r, state.session, judgment);
	if (!state.before.has(o.conceptTitle)) state.before.set(o.conceptTitle, o.before);
	state.after.set(o.conceptTitle, o.after);
	state.grades.set(q.id, o.grade);
}

export function ungraded(state: TestGrading): PreparedQuiz[] {
	return state.test.questions.filter((q) => !state.grades.has(q.id));
}

export function testInProgress(testId: string): TestGrading | undefined {
	return inProgress.get(testId);
}

export async function applyTestJudgments(
	store: KnowledgeStore,
	state: TestGrading,
	judgments: Array<FreeResponseJudgment & { question: string | number }>,
): Promise<string[]> {
	const problems: string[] = [];
	for (const j of judgments) {
		const q = findQuestion(state.test, j.question);
		if (!q) {
			problems.push(`No question ${j.question} in this test.`);
			continue;
		}
		if (state.grades.has(q.id)) continue;
		await recordOne(store, state, q, answerFor(state.test, state.response, q.id), j);
	}
	return problems;
}

function findQuestion(test: PreparedTest, ref: string | number): PreparedQuiz | undefined {
	const s = String(ref).trim();
	const byId = test.questions.find((q) => q.id === s);
	if (byId) return byId;
	const n = Number(s.replace(/^q/i, ""));
	return Number.isInteger(n) ? test.questions[n - 1] : undefined;
}

export function describeTestForGrading(state: TestGrading): string {
	const pending = ungraded(state);
	const lines = [
		`The learner submitted the practice test "${state.test.title}". Multiple-choice answers are graded and recorded. ${pending.length} free-response answer${pending.length === 1 ? "" : "s"} still need your judgment: call grade_practice_test with test_id "${state.test.id}" and one grade per question below. The evaluation is written once every answer is graded.`,
		"",
	];
	for (const q of pending) {
		const n = state.test.questions.indexOf(q) + 1;
		const r = answerFor(state.test, state.response, q.id);
		lines.push(
			`### Question ${n} (${q.concept}, d${q.difficulty})`,
			q.question,
			`They wrote:\n${r.text ?? ""}`,
			r.note ? `Their note: ${r.note}` : "",
			`Reference answer: ${q.reference ?? ""}`,
			q.rubric ? `Rubric: ${q.rubric}` : "",
			"",
		);
	}
	lines.push(FREE_RESPONSE_GRADING, "Do not show grades to the learner until the evaluation is back; they see it in the test card.");
	return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

const POINTS: Record<Outcome, number> = { correct: 1, partial: 0.5, incorrect: 0, dont_know: 0 };

export async function finishTest(store: KnowledgeStore, state: TestGrading): Promise<TestReport> {
	const { test, response } = state;
	const results: TestQuestionResult[] = test.questions.map((q, i) => {
		const grade = state.grades.get(q.id)!;
		return {
			id: q.id,
			number: i + 1,
			concept: q.concept,
			difficulty: q.difficulty,
			format: q.format,
			outcome: grade.outcome,
			points: POINTS[grade.outcome],
			response: answerFor(test, response, q.id),
			grade,
		};
	});
	const concepts = new Map<string, TestConceptResult>();
	for (const r of results) {
		const c = concepts.get(r.concept) ?? {
			concept: r.concept,
			earned: 0,
			possible: 0,
			percent: 0,
			questions: [],
			before: state.before.get(r.concept),
			status: state.after.get(r.concept)?.status ?? "unassessed",
			now: state.after.get(r.concept)?.current ?? 0,
		};
		c.earned += r.points;
		c.possible += 1;
		c.questions.push(r.number);
		concepts.set(r.concept, c);
	}
	for (const c of concepts.values()) c.percent = c.possible ? c.earned / c.possible : 0;
	const byConcept = [...concepts.values()].sort((a, b) => a.percent - b.percent || a.now - b.now);
	const earned = results.reduce((s, r) => s + r.points, 0);
	const misconceptions = results.filter((r) => r.grade.misconception).map((r) => ({ concept: r.concept, misconception: r.grade.misconception! }));

	const report: TestReport = {
		testId: test.id,
		title: test.title,
		goal: test.goal,
		examPlan: test.examPlan,
		date: new Date().toISOString(),
		elapsedSeconds: response.elapsedSeconds,
		earned,
		possible: results.length,
		percent: results.length ? earned / results.length : 0,
		results,
		byConcept,
		misconceptions,
	};
	report.notePath = await writeTestNote(store, test, report);
	inProgress.delete(test.id);

	const firstMiss = results
		.filter((r) => r.outcome !== "correct")
		.sort((a, b) => (concepts.get(a.concept)!.percent - concepts.get(b.concept)!.percent) || a.difficulty - b.difficulty)[0];
	if (firstMiss) {
		const q = test.questions[firstMiss.number - 1];
		seedLadder(state.session?.id ?? "default", {
			concept: q.concept,
			difficulty: q.difficulty,
			question: stripMd(q.question),
			outcome: firstMiss.outcome,
			familiarity: firstMiss.response.familiarity,
			misconception: firstMiss.grade.misconception,
		});
	}
	return report;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtPoints = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function fmtTime(s?: number): string | undefined {
	if (s === undefined) return undefined;
	const m = Math.floor(s / 60);
	return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function describeTestReport(report: TestReport): string {
	const lines = [
		`Practice test evaluated: "${report.title}" — ${fmtPoints(report.earned)}/${report.possible} (${pct(report.percent)})${report.elapsedSeconds !== undefined ? `, ${fmtTime(report.elapsedSeconds)} taken` : ""}. Saved to ${report.notePath}. The learner sees the full breakdown in the test card.`,
		"",
		"By concept, weakest first:",
		...report.byConcept.map(
			(c) => `- ${c.concept}: ${fmtPoints(c.earned)}/${c.possible} on Q${c.questions.join(", Q")} → now ${pct(c.now)} (${c.status})`,
		),
		"",
		"Per question:",
		...report.results.map((r) => {
			const what = r.outcome === "dont_know" ? `I don't know (${familiarityLabel(r.response.familiarity)})` : r.outcome;
			return `- Q${r.number} ${r.concept} d${r.difficulty} ${r.format === "free" ? "free response" : "choice"}: ${what}${r.grade.misconception ? ` — belief: ${r.grade.misconception}` : ""}`;
		}),
	];
	if (report.misconceptions.length) lines.push("", `Misconceptions surfaced: ${report.misconceptions.map((m) => `${m.concept}: ${m.misconception}`).join("; ")}`);
	const weak = report.byConcept.filter((c) => c.percent < 1);
	lines.push(
		"",
		weak.length
			? `Next move — debrief briefly (what held, where it broke, in two or three sentences, no re-listing of every question), then ask whether to work on the weakest area now. Remediate from ${weak[0].concept}, but do not re-teach from the top: diagnose down first. Ask a smaller question on the piece that missed question needed, keep stepping down until they get one right, then teach up from there. The diagnosis ladder is seeded with that miss.`
			: "Next move — everything held. Say so briefly, then raise the bar: a harder test, or questions at a higher difficulty than the exam needs.",
	);
	return lines.join("\n");
}

async function writeTestNote(store: KnowledgeStore, test: PreparedTest, report: TestReport): Promise<string> {
	const date = report.date.slice(0, 10);
	let path = `${PATHS.tests}/${safeFileName(`${date} ${test.title}`)}.md`;
	for (let i = 2; await store.io.exists(path); i++) path = `${PATHS.tests}/${safeFileName(`${date} ${test.title}`)} ${i}.md`;
	const verdict = { correct: "✅", partial: "🟡", incorrect: "❌", dont_know: "❔" } as const;
	const body: string[] = [
		`# ${test.title}`,
		"",
		`**Score:** ${fmtPoints(report.earned)}/${report.possible} (${pct(report.percent)})${report.elapsedSeconds !== undefined ? ` · **Time:** ${fmtTime(report.elapsedSeconds)}${test.timeLimitMinutes ? ` of ${test.timeLimitMinutes}:00` : ""}` : ""}`,
		"",
		"## By concept",
		"",
		"| Concept | Score | Questions | Now |",
		"| --- | --- | --- | --- |",
		...report.byConcept.map((c) => `| [[${c.concept}]] | ${fmtPoints(c.earned)}/${c.possible} | ${c.questions.map((n) => `Q${n}`).join(", ")} | ${pct(c.now)} (${c.status}) |`),
		"",
	];
	if (report.misconceptions.length) {
		body.push("## Misconceptions surfaced", "", ...report.misconceptions.map((m) => `- [[${m.concept}]]: ${m.misconception}`), "");
	}
	body.push("## Questions", "");
	for (const r of report.results) {
		const q = test.questions[r.number - 1];
		body.push(`### Q${r.number} ${verdict[r.outcome]} · [[${q.concept}]] · level ${q.difficulty}`, "", demoteHeadings(q.question), "");
		if (q.format === "free") {
			body.push(
				r.outcome === "dont_know" ? `**Your answer:** I don't know (${familiarityLabel(r.response.familiarity)})` : `**Your answer:**\n\n${r.response.text ?? ""}`,
				"",
				`**Model answer:**\n\n${q.reference ?? ""}`,
				"",
			);
			if (r.grade.feedback) body.push(`**Feedback:** ${r.grade.feedback}`, "");
		} else {
			body.push(
				...q.options.map((o, i) => {
					const mark = q.correct.includes(o.value) ? " ✓" : r.response.selected.includes(o.value) ? " ✗" : "";
					return `${letter(i)}. ${o.label}${mark}`;
				}),
				"",
			);
			if (r.outcome === "dont_know") body.push(`*I don't know — ${familiarityLabel(r.response.familiarity)}*`, "");
		}
		if (r.grade.misconception) body.push(`> [!warning] Likely belief\n> ${r.grade.misconception}`, "");
		if (q.explanation) body.push(`> [!note]- Explanation\n${q.explanation.split("\n").map((l) => `> ${l}`).join("\n")}`, "");
	}
	const fm = {
		title: test.title,
		type: "practice-test",
		date,
		score: `${fmtPoints(report.earned)}/${report.possible}`,
		percent: Math.round(report.percent * 100),
		goal: test.goal ? wikilink(test.goal) : undefined,
		exam: test.examPlan ? wikilink(test.examPlan) : undefined,
		concepts: report.byConcept.map((c) => wikilink(c.concept)),
		weakest: report.byConcept.filter((c) => c.percent < 1).slice(0, 3).map((c) => wikilink(c.concept)),
		tags: ["groundwork/test"],
	};
	await store.writeFile(path, serializeNote(fm, body.join("\n")));
	return path;
}
