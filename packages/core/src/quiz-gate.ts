/**
 * Quiz cards are checked before they are shown. Failures are feedback for the
 * tutor model only — not lines the learner should read in chat.
 */

import { QuizKeyError } from "./quiz-key";

/** Quiz gate failures on one learner turn before we stop retrying. */
export const QUIZ_GATE_MAX_ATTEMPTS = 4;

export const QUIZ_GATE_SUMMARIES = new Set(["Broken math", "Quiz missed the preferred method", "Quiz not shown"]);

const GATE_PHRASES = [
	"Broken math in",
	"Broken math in this prompt",
	"was not shown",
	"call quiz again",
	"Write the quiz with the professor's preferred method",
	"independent check disagree",
	"The key check did not confirm",
	"More than one option is correct",
	"worked solution and the explanation name different",
	"no option says that",
	"The worked answer and an independent check disagree",
	"The explanation and an independent check disagree",
	"Recompute and call quiz again",
];

/** One line after repeated gate failures. */
export const QUIZ_GATE_EXHAUSTED_LEARNER =
	"I couldn't put that question on a card after a few tries — I'll ask it here in chat instead, or we can try a simpler check.";

export const QUIZ_GATE_EXHAUSTED_MODEL = [
	"You hit the quiz gate too many times on this turn.",
	`Tell the learner exactly: "${QUIZ_GATE_EXHAUSTED_LEARNER}"`,
	"Then ask the same idea in plain chat (no quiz card), or call quiz once more with a simpler, fully wrapped LaTeX question.",
	"Do not quote gate errors or say Error.",
].join(" ");

export function isQuizGatePayload(text: string): boolean {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return false;
	if (GATE_PHRASES.some((phrase) => flat.includes(phrase))) return true;
	if (/^Error:\s*/i.test(flat) && GATE_PHRASES.some((phrase) => flat.includes(phrase))) return true;
	return false;
}

export function isQuizGateFailure(summary: string | undefined, text: string): boolean {
	const flatSummary = (summary ?? "").replace(/\s+/g, " ").trim();
	if (flatSummary && QUIZ_GATE_SUMMARIES.has(flatSummary)) return true;
	return isQuizGatePayload(text);
}

export function quizGateSummary(message: string): string {
	if (/preferred method/i.test(message)) return "Quiz missed the preferred method";
	if (/Broken math/i.test(message)) return "Broken math";
	return "Quiz not shown";
}

/** Tool result text for the model. Never paste this to the learner. */
export function modelQuizGateMessage(summary: string, detail: string, attemptsLeft: number): string {
	const tail =
		attemptsLeft <= 0
			? QUIZ_GATE_EXHAUSTED_MODEL
			: `Attempts left on this turn before you must stop calling quiz: ${attemptsLeft}. Fix the quiz and call quiz again. Do not show this gate text to the learner.`;
	return `${summary}. ${detail.replace(/\s+/g, " ").trim()}\n\n${tail}`;
}

export function quizGateToolResult(message: string, attemptsLeft: number): { text: string; isError: true; summary: string } {
	const summary = quizGateSummary(message);
	return {
		text: modelQuizGateMessage(summary, message, attemptsLeft),
		isError: true,
		summary,
	};
}

export function asQuizGateError(err: unknown): QuizKeyError | null {
	return err instanceof QuizKeyError ? err : null;
}
