/**
 * One extra model step when a turn stops short: an objective with no goal,
 * or a sentence that announces a question and never calls the card tool.
 */

import { statesLearningObjective, visibleAsk } from "./intent";

const QUESTION_TOOLS = new Set(["quiz", "ask_user", "practice_test"]);

export function isQuestionTool(name: string): boolean {
	return QUESTION_TOOLS.has(name);
}

/** Prose that promises a question. The card is what the learner actually sees. */
export function announcesQuestion(text: string): boolean {
	return (
		/\bhere(?:'|’)s (?:a |another )?(?:question|problem|check)\b/i.test(text) ||
		/\bhere is (?:a |another )?(?:question|problem|check)\b/i.test(text) ||
		/\blet(?:'|’)s try (?:one|this|another)(?:\s+question)?\b/i.test(text) ||
		/\blets try (?:one|this|another)(?:\s+question)?\b/i.test(text) ||
		/\btry this (?:one|question)\b/i.test(text) ||
		/\b(?:a )?quick question\b/i.test(text) ||
		/\bquestion for you\b/i.test(text) ||
		/\blet me (?:ask|quiz) you\b/i.test(text) ||
		/\bsee if you (?:can|know|remember)\b/i.test(text) ||
		/\bquiz you\b/i.test(text)
	);
}

/**
 * Hidden note for one follow-up completion. Null when this turn already did
 * the thing the learner is waiting on.
 */
export function repairNote(input: { userText: string; assistantText: string; calledQuestion: boolean; calledGoal: boolean }): string | null {
	const lines: string[] = [];
	if (!input.calledQuestion && announcesQuestion(input.assistantText)) {
		lines.push(
			"You announced a question and no quiz, ask_user, or practice_test card was shown. Call quiz for a graded question, or ask_user when there is no right answer. The card is the question. Do not describe it in prose.",
		);
	}
	if (!input.calledGoal && statesLearningObjective(visibleAsk(input.userText))) {
		lines.push(
			"They stated an objective they are working toward. Call set_goal now: a short title and the concepts that objective needs. Then tell them the plan in a few sentences. Do not ask whether to make a goal.",
		);
	}
	if (!lines.length) return null;
	return `<tutor_repair>\n${lines.join("\n")}\n</tutor_repair>`;
}
