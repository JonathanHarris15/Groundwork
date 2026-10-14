/**
 * One extra model step when a turn stops short: an objective with no goal,
 * or a sentence that announces a question and never calls the card tool.
 */

import { statesLearningObjective, visibleAsk } from "./intent";

const QUESTION_TOOLS = new Set(["quiz", "ask_user", "practice_test"]);

export function isQuestionTool(name: string): boolean {
	return QUESTION_TOOLS.has(name);
}

/** The model explained a missing card or goal by inventing a rule about the app. */
export function inventsAppBehavior(text: string): boolean {
	return (
		/\b(?:our |the )?system requires\b/i.test(text) ||
		/\bformal confirmation\b/i.test(text) ||
		/\bofficial question\b/i.test(text) ||
		/\bgoal tracker\b/i.test(text) ||
		/\binitialize the goal\b/i.test(text) ||
		/\bdid(?:n't| not) (?:pop up|load|appear) because\b/i.test(text) ||
		/\bunlock\b.{0,40}\b(?:features|quizzes|quiz|goal)\b/i.test(text)
	);
}

/** They asked permission to study or to make a goal, instead of starting. */
export function asksToConfirmStudy(text: string): boolean {
	return /do you want to study this or make a goal/i.test(text) || /want me to set this up as a goal and quiz you/i.test(text);
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
	const objective = statesLearningObjective(visibleAsk(input.userText));
	const invented = inventsAppBehavior(input.assistantText);
	const gated = objective && asksToConfirmStudy(input.assistantText);
	const spoken = input.assistantText.replace(/want me to set this up as a goal and quiz you on it\??/gi, " ");
	const lines: string[] = [];
	if (invented) {
		lines.push(
			"You invented a rule about how the app works. There is no confirmation step and nothing to unlock. Do not explain the app. If a card or goal did not appear, call the tool again. If it still fails, say it did not load.",
		);
	}
	if (!input.calledQuestion && (announcesQuestion(spoken) || gated || objective)) {
		lines.push(
			"Call quiz for a graded question, or ask_user when there is no right answer. The card is the question. Do not ask permission first, and do not describe the card in prose.",
		);
	}
	if (!input.calledGoal && objective) {
		lines.push(
			"They stated an objective they are working toward. Call set_goal on this turn and start studying. A goal and a quiz go together. Do not ask whether to study or make a goal.",
		);
	}
	if (!lines.length) return null;
	return `<tutor_repair>\n${lines.join("\n")}\n</tutor_repair>`;
}
