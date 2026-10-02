import type { FreeResponseJudgment, PreparedQuiz, QuizResponse } from "../quiz";

/**
 * One written answer for Jev to grade. The tutor model is not asked to do this
 * when the server is configured, which skips a full-context turn per answer.
 */
export interface FreeResponseToGrade {
	question: string;
	reference: string;
	rubric?: string;
	answer: string;
	note?: string;
	/** Hint chat, when one was open. Repeating only the hint is not full credit. */
	hintTranscript?: string;
}

/** Choice confidence below this sends the answer back to the tutor instead of recording a guess. */
export const WRITTEN_GRADE_CONFIDENCE = 0.55;
/** A slip has to be this clearly a careless error before we record one. */
export const SLIP_PROBABILITY = 0.7;

export interface AnswerGrader {
	/** One result per item, in order. `null` means the tutor should grade that one. */
	grade(items: FreeResponseToGrade[], signal?: AbortSignal): Promise<Array<FreeResponseJudgment | null>>;
}

interface GradeAnswer {
	type?: string;
	choice?: string;
	confidence?: number;
	noul?: number;
}

/**
 * The System One request for a batch of written answers. Questions for one
 * item share that item's text and cannot see each other's answers.
 */
export function freeResponseRequest(items: FreeResponseToGrade[]): {
	state: { task: string };
	model: "jev-latest";
	questions: Record<string, unknown>;
} {
	const questions: Record<string, unknown> = {};
	items.forEach((item, i) => {
		const payload = itemPayload(item);
		questions[`i${i}_outcome`] = {
			type: "choice",
			instructions: {
				question: "How should this written answer be graded against its reference and rubric?",
				item: payload,
			},
			criteria: {
				correct: "Equivalent to the reference. Rearranged, unsimplified-but-right, or differently notated forms count. A purely careless slip in otherwise right work belongs here.",
				partial: "The key idea is right, but a conceptual piece is missing or wrong.",
				incorrect: "The approach itself is wrong or missing.",
			},
		};
		questions[`i${i}_slip`] = {
			type: "noul",
			instructions: {
				question: "Is the only error a non-conceptual slip, such as arithmetic, a sign, copying a term, or a typo, in otherwise right work?",
				item: payload,
			},
			criteria: {
				true: "The method and understanding are right. The mistake is careless.",
				false: "The answer is fully right, or the mistake is conceptual, or the approach is wrong.",
			},
		};
		if (item.hintTranscript?.trim()) {
			questions[`i${i}_echoed`] = {
				type: "noul",
				instructions: {
					question: "Did this answer only repeat what the hint already stated, without reaching the rest on their own?",
					item: payload,
				},
				criteria: {
					true: "The answer stops at what the hint supplied.",
					false: "They reached the answer themselves, or the hint did not give it away.",
				},
			};
		}
	});
	return {
		state: { task: "Grade each written answer on its own. An item's questions do not share credit with any other item." },
		model: "jev-latest",
		questions,
	};
}

function itemPayload(item: FreeResponseToGrade): Record<string, string> {
	const payload: Record<string, string> = {
		question: item.question,
		reference: item.reference,
		answer: item.answer,
	};
	if (item.rubric?.trim()) payload.rubric = item.rubric.trim();
	if (item.note?.trim()) payload.note = item.note.trim();
	if (item.hintTranscript?.trim()) payload.hint = item.hintTranscript.trim();
	return payload;
}

/** Read one item's answers out of a System One response. `null` defers to the tutor. */
export function judgmentFromAnswers(index: number, answers: Record<string, GradeAnswer>): FreeResponseJudgment | null {
	const outcome = answers[`i${index}_outcome`];
	if (!outcome || outcome.type !== "choice") return null;
	if (outcome.choice !== "correct" && outcome.choice !== "partial" && outcome.choice !== "incorrect") return null;
	if (typeof outcome.confidence !== "number" || outcome.confidence < WRITTEN_GRADE_CONFIDENCE) return null;

	const slipAnswer = answers[`i${index}_slip`];
	const slipYes = slipAnswer?.type === "noul" && typeof slipAnswer.noul === "number" && slipAnswer.noul >= SLIP_PROBABILITY;
	const echoed = answers[`i${index}_echoed`];
	const onlyHint = echoed?.type === "noul" && typeof echoed.noul === "number" && echoed.noul >= SLIP_PROBABILITY;

	let graded: FreeResponseJudgment["outcome"] = outcome.choice;
	let slip = slipYes && graded !== "incorrect";
	if (onlyHint && graded === "correct") {
		graded = "partial";
		slip = false;
	}
	return {
		outcome: graded,
		slip,
		feedback: cardFeedback(graded, slip, onlyHint),
	};
}

function cardFeedback(outcome: FreeResponseJudgment["outcome"], slip: boolean, onlyHint: boolean): string {
	if (onlyHint) return "This mostly repeats the hint. The part you still needed to reach isn't there yet.";
	if (slip) return "The approach is right. A small slip in the steps.";
	if (outcome === "correct") return "That matches what this question was looking for.";
	if (outcome === "partial") return "Part of this is right. A conceptual piece is still missing.";
	return "The approach doesn't match this question yet.";
}

export function toGradeItem(quiz: PreparedQuiz, response: QuizResponse, hintTranscript?: string): FreeResponseToGrade {
	return {
		question: quiz.question,
		reference: quiz.reference ?? "",
		rubric: quiz.rubric,
		answer: response.text ?? "",
		note: response.note,
		hintTranscript,
	};
}

function asJudgment(value: unknown): FreeResponseJudgment | null {
	if (!value || typeof value !== "object") return null;
	const outcome = (value as { outcome?: unknown }).outcome;
	if (outcome !== "correct" && outcome !== "partial" && outcome !== "incorrect") return null;
	const raw = value as FreeResponseJudgment;
	return {
		outcome,
		feedback: typeof raw.feedback === "string" ? raw.feedback : undefined,
		misconception: typeof raw.misconception === "string" ? raw.misconception : undefined,
		slip: raw.slip === true,
	};
}

/** Grade a batch. A failure or a short response defers every item to the tutor. */
export async function judgmentsFor(grader: AnswerGrader | undefined, items: FreeResponseToGrade[], signal?: AbortSignal): Promise<Array<FreeResponseJudgment | null>> {
	if (!grader || !items.length) return items.map(() => null);
	try {
		const out = await grader.grade(items, signal);
		if (!Array.isArray(out) || out.length !== items.length) return items.map(() => null);
		return out.map(asJudgment);
	} catch {
		return items.map(() => null);
	}
}

/** Calls the Groundwork server. The Jev key never leaves that server. */
export function remoteAnswerGrader(baseUrl: string, fetchImpl: typeof fetch = fetch, authorization?: () => Promise<string | null>): AnswerGrader {
	const root = baseUrl.replace(/\/$/, "");
	return {
		async grade(items, signal) {
			const token = await authorization?.();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (token) headers.authorization = `Bearer ${token}`;
			const res = await fetchImpl(`${root}/v1/grade`, {
				method: "POST",
				headers,
				body: JSON.stringify({ items }),
				signal,
			});
			if (!res.ok) throw new Error(`Grading failed (${res.status}).`);
			const body = (await res.json()) as { judgments?: unknown };
			if (!Array.isArray(body.judgments)) throw new Error("Grading returned no judgments.");
			return body.judgments.map(asJudgment);
		},
	};
}
