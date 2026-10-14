/**
 * One extra model step when a turn stops short: an objective with no goal,
 * a sentence that announces a question and never calls the card tool, or an
 * ASCII diagram where a figure should have been.
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

const CODE_FENCE = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g;
const BOX_DRAWING = /[─│┌┐└┘├┤┬┴┼╭╮╯╰╱╲╔╗╚╝║═]/;
const SOURCE_CODE = /\b(?:import|from|def|class|function|const|let|return|plt\.|np\.)\b/;

/** A fenced sketch, not a program and not a short inline mark such as x^2. */
export function asciiDiagram(text: string): boolean {
	if (BOX_DRAWING.test(text)) return true;
	CODE_FENCE.lastIndex = 0;
	for (const match of text.matchAll(CODE_FENCE)) {
		if (fencedArt(match[1] ?? "")) return true;
	}
	return false;
}

function fencedArt(body: string): boolean {
	const lines = body.split("\n").filter((line) => line.trim());
	if (lines.length < 3) return false;
	if (SOURCE_CODE.test(body)) return false;
	const slashes = body.match(/[\\/]/g)?.length ?? 0;
	if (slashes < 4) return false;
	const symbols = body.match(/[|\\/\-_=+*^<>]/g)?.length ?? 0;
	const words = body.match(/[A-Za-z0-9]+/g)?.length ?? 0;
	return symbols >= 12 && symbols > words;
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
export function repairNote(input: {
	userText: string;
	assistantText: string;
	calledQuestion: boolean;
	calledGoal: boolean;
	calledFigure?: boolean;
}): string | null {
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
	if (!input.calledFigure && asciiDiagram(input.assistantText)) {
		lines.push(
			"You drew an ASCII diagram. Call show_figure with kind program. The source is Python using numpy and matplotlib, and it writes figure.png. Do not sketch the picture in a code block.",
		);
	}
	if (!lines.length) return null;
	return `<tutor_repair>\n${lines.join("\n")}\n</tutor_repair>`;
}
