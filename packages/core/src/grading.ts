import { nextMove, type PrerequisiteState } from "./diagnose";
import { judgeUnderstanding, pickLabel } from "./judgments";
import { describeEdge, predictCorrect, type ConceptStats } from "./model";
import { familiarityLabel, gradeQuiz, type FreeResponseJudgment, type PreparedQuiz, type QuizGrade, type QuizResponse } from "./quiz";
import type { KnowledgeStore } from "./store";

export interface QuizOutcome {
	quiz: PreparedQuiz;
	response: QuizResponse;
	grade: QuizGrade;
	before: ConceptStats;
	after: ConceptStats;
	conceptTitle: string;
	/** What to ask or teach next, from the session's diagnosis ladder. */
	guidance?: string;
	/** Set when a judgment labeled the written answer differently from the tutor. */
	judgmentNote?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const VERDICT = {
	correct: "CORRECTLY",
	partial: "PARTLY CORRECTLY (partial credit)",
	incorrect: "INCORRECTLY",
} as const;

export function describeQuizOutcome(o: QuizOutcome): string {
	const { grade, quiz, response, before, after } = o;
	const lines: string[] = [];
	if (grade.outcome === "dont_know") {
		const f = response.familiarity ?? 0;
		lines.push(`The learner chose "I don't know" — an honest gap, not a guess. Familiarity: ${familiarityLabel(f)} (${f}/3).`);
	} else if (grade.slip) {
		lines.push("The learner answered CORRECTLY, with a slip: the understanding is there, only a careless step went wrong. Point out the slip in one line and move on. Do not step back, re-check it, or treat it as a gap.");
		if (quiz.format === "free") lines.push(`They wrote:\n${response.text ?? ""}`);
	} else {
		lines.push(`The learner answered ${VERDICT[grade.outcome]}.`);
		if (quiz.format === "free") lines.push(`They wrote:\n${response.text ?? ""}`);
		else lines.push(`Selected: ${grade.selectedLabels.join(" | ")}`);
	}
	lines.push(quiz.format === "free" ? `Reference answer: ${quiz.reference ?? ""}` : `Correct: ${grade.correctLabels.join(" | ")}`);
	if (grade.feedback) lines.push(`Your feedback (shown to them): ${grade.feedback}`);
	if (grade.misconception) lines.push(`Diagnosed misconception: ${grade.misconception}`);
	if (response.note) lines.push(`Learner's note: ${response.note}`);
	lines.push(
		`Recorded in vault → ${o.conceptTitle}: ${before.attempts ? pct(before.current) : "unassessed"} → ${pct(after.current)} (status ${after.status}; ${describeEdge(after)}; d${quiz.difficulty} ${quiz.kind}).`,
	);
	lines.push(`Predicted chance on next d${Math.min(5, quiz.difficulty + 1)}: ${pct(predictCorrect(after, quiz.difficulty + 1))}.`);
	if (o.judgmentNote) lines.push(o.judgmentNote);
	if (o.guidance) lines.push("", o.guidance);
	return lines.join("\n");
}

/** Grade, record, and describe a quiz answer. Shared by the Obsidian card flow, MCP, and practice tests. */
export async function recordQuizAnswer(
	store: KnowledgeStore,
	quiz: PreparedQuiz,
	response: QuizResponse,
	session?: { id: string },
	judgment?: FreeResponseJudgment,
): Promise<QuizOutcome> {
	let applied = judgment;
	let judgmentNote: string | undefined;
	const client = store.judgments();
	if (client && judgment && quiz.format === "free" && response.text?.trim()) {
		const graded = await judgeUnderstanding(client, {
			question: quiz.question,
			response: response.text,
			reference: quiz.reference,
			rubric: quiz.rubric,
		});
		if (graded) {
			const tutorSlip = judgment.slip === true;
			const tutorOutcome = tutorSlip ? "correct" : judgment.outcome;
			if (graded.outcome !== tutorOutcome || graded.slip !== tutorSlip) {
				judgmentNote = `Jev graded the understanding as ${graded.slip ? "a slip" : graded.outcome}. That is what was recorded.`;
			}
			applied = { ...judgment, outcome: graded.outcome, slip: graded.slip };
		}
	}
	const grade = gradeQuiz(quiz, response, applied);
	const { concept, before, after } = await store.recordEvidence(quiz.concept, {
		outcome: grade.outcome,
		difficulty: quiz.difficulty,
		kind: quiz.kind,
		question: stripMd(quiz.question),
		chosen: quiz.format === "free" ? undefined : grade.selectedLabels.join(" | ") || undefined,
		response: quiz.format === "free" && response.text ? response.text.slice(0, 2000) : undefined,
		correctAnswer: grade.correctLabels.join(" | ").slice(0, 500),
		misconception: grade.misconception,
		slip: grade.slip,
		familiarity: grade.outcome === "dont_know" ? (response.familiarity ?? 0) : undefined,
		note: response.note,
		session: session?.id,
	});
	const index = await store.concepts();
	const prerequisites: PrerequisiteState[] = concept.prerequisites
		.map((id) => index.get(id))
		.filter((c): c is NonNullable<typeof c> => !!c)
		.map((c) => ({ title: c.title, status: c.stats.status, floor: c.stats.floor }));
	let guidance = nextMove(
		session?.id ?? "default",
		{
			concept: concept.title,
			difficulty: quiz.difficulty,
			question: stripMd(quiz.question),
			outcome: grade.outcome,
			familiarity: response.familiarity,
			misconception: grade.misconception,
			slip: grade.slip,
			kind: quiz.kind,
		},
		{ prerequisites, floor: after.floor, ceiling: after.ceiling },
	);
	const weak = prerequisites.filter((p) => p.status !== "solid");
	if (client && guidance.includes("prerequisite") && weak.length >= 2 && grade.outcome !== "correct") {
		const piece = await pickLabel(
			client,
			"Which prerequisite is the piece this missed question actually depends on?",
			{ concept: concept.title, question: stripMd(quiz.question), misconception: grade.misconception ?? "" },
			weak.map((p) => ({ id: p.title, label: p.title, detail: `${p.status}${p.floor ? `, holds d${p.floor}` : ""}` })),
		);
		if (piece) guidance = `${guidance}\nThe missing piece is ${piece}. Ask about that prerequisite, not the others.`;
	}
	return { quiz, response, grade, before, after, conceptTitle: concept.title, guidance: guidance || undefined, judgmentNote };
}

/** Free-response answers wait here until the tutor grades them with grade_answer. */
const awaiting = new Map<string, { quiz: PreparedQuiz; response: QuizResponse }>();

export function awaitJudgment(quiz: PreparedQuiz, response: QuizResponse): string {
	awaiting.set(quiz.id, { quiz, response });
	return [
		`The learner submitted a free-response answer. Grade it now: call grade_answer with quiz_id "${quiz.id}". Nothing is recorded until you do.`,
		"",
		`Question (${quiz.concept}, d${quiz.difficulty}): ${quiz.question}`,
		`They wrote:\n${response.text ?? ""}`,
		response.note ? `Their note: ${response.note}` : undefined,
		`Reference answer: ${quiz.reference ?? ""}`,
		quiz.rubric ? `Rubric: ${quiz.rubric}` : undefined,
		"",
		FREE_RESPONSE_GRADING,
	]
		.filter((l) => l !== undefined)
		.join("\n");
}

export const FREE_RESPONSE_GRADING =
	"Grading rules: judge the understanding, not the formatting or the arithmetic. An equivalent form (rearranged, unsimplified but correct, different notation) is correct. A slip is a non-conceptual error in otherwise right work: an arithmetic or sign mistake, a dropped term while copying, a typo. Set slip: true for it (it is recorded as correct) and never call a slip a misconception. partial = the key idea is right but a conceptual piece is missing or wrong; incorrect = the approach itself is wrong or missing. In feedback, address them directly: name what is right first, then the exact step that went wrong (for a slip, one short line). Use LaTeX for math. If a wrong belief shows, put it in misconception. If a <hint_transcript> is in the conversation, an answer that only repeats what the hint already stated is not full credit: mark partial or incorrect for the part they did not reach on their own.";

export function takeAwaiting(quizId: string): { quiz: PreparedQuiz; response: QuizResponse } | undefined {
	const hit = awaiting.get(quizId);
	awaiting.delete(quizId);
	return hit;
}

export function stripMd(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 300);
}
