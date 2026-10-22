/**
 * One extra model step when a turn stops short: an objective with no goal,
 * a sentence that announces a question and never calls the card tool, or an
 * ASCII diagram where a figure should have been.
 */

import type { ChatMessage } from "./agent/types";
import { declinesQuizNow, dialogueFromMessages, requestsGoal, statesLearningObjective, visibleAsk, wantsToStudyNow } from "./intent";
import { learnerToolError } from "./learner-text";

const QUESTION_TOOLS = new Set(["quiz", "ask_user", "practice_test"]);

export function isQuestionTool(name: string): boolean {
	return QUESTION_TOOLS.has(name);
}

/** The model explained a missing card or goal by inventing a rule about the app. */
export function inventsAppBehavior(text: string): boolean {
	return (
		/\b(?:our |the )?system requires\b/i.test(text) ||
		/\b(?:our |the )?system waits\b/i.test(text) ||
		/\bformal confirmation\b/i.test(text) ||
		/\bofficial question\b/i.test(text) ||
		/\bgoal tracker\b/i.test(text) ||
		/\binitialize the goal\b/i.test(text) ||
		/\bfinalize the goal\b/i.test(text) ||
		/\b(?:study|quiz) trigger\b/i.test(text) ||
		/\b(?:reply|say|type)\s+["']?start["']?\b/i.test(text) ||
		/\bdid(?:n't| not) (?:pop up|load|appear) because\b/i.test(text) ||
		/\bunlock\b.{0,40}\b(?:features|quizzes|quiz|goal)\b/i.test(text) ||
		/\btools did not load\b/i.test(text) ||
		/\bdid not load properly\b/i.test(text) ||
		/\bregistering the actions\b/i.test(text) ||
		/\bdatabase tools\b/i.test(text) ||
		/\binitialize the database\b/i.test(text) ||
		/\b(?:send|reply|say|type)\b[^.]{0,80}\bready to start\b/i.test(text)
	);
}

/**
 * The old sentence a repair used to speak when no tool had failed.
 * It is internal. Learner-visible text must not contain it.
 */
export const PLAIN_NO_TOOL_ERROR = "No tool returned an error.";

/** A learner asked for a goal or named an objective in this transcript. */
export function goalAsked(messages: ChatMessage[]): boolean {
	return dialogueFromMessages(messages).some((turn) => turn.role === "user" && (requestsGoal(turn.text) || statesLearningObjective(turn.text)));
}

/** True when a set_goal result in this transcript was not an error. */
export function setGoalSucceeded(messages: ChatMessage[]): boolean {
	const ids = new Set<string>();
	let ok = false;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_use" && block.name === "set_goal" && block.id) ids.add(block.id);
			if (block.type === "tool_result" && block.tool_use_id && ids.has(block.tool_use_id) && !block.is_error) ok = true;
		}
	}
	return ok;
}

/** The reply says a goal was saved. Past tense, not the offer to set one up. */
export function claimsGoalSaved(text: string): boolean {
	return (
		/\b(?:i(?:'ve| have)|we(?:'ve| have)) (?:set|saved|created|made) (?:this |it |that )?(?:up as a |the |a |your )?goal\b/i.test(text) ||
		/\b(?:i(?:'ve| have)|we(?:'ve| have)) set (?:this |it |that )?up as a goal\b/i.test(text) ||
		/\bgoal is (?:now )?(?:set|saved|ready|created)\b/i.test(text) ||
		/\b(?:already |just )(?:saved|created|set up) (?:the |a |your )?goal\b/i.test(text)
	);
}

export const UNSAVED_GOAL_LINE = "The goal is not saved yet.";

export interface TurnCorrection {
	userText: string;
	assistantText: string;
	calledGoal: boolean;
	/** A goal was requested earlier and set_goal has not succeeded in this transcript. */
	goalPending?: boolean;
	/** Tool error lines from this turn, already phrased for the learner. */
	toolErrors?: string[];
	/** A tool was invoked this turn, including one that returned an error. */
	toolsRan?: boolean;
}

/** The learner was told a goal exists, or they asked for one, and set_goal did not succeed. Also true when the reply invents a tool failure. */
export function needsUnsavedGoalCorrection(input: TurnCorrection): boolean {
	return learnerFacingCorrection(input) !== null;
}

/** Plain text appended when the reply claims a save, invents a tool failure, or hides a tool error. */
export function learnerFacingCorrection(input: TurnCorrection): string | null {
	const parts: string[] = [];
	const errors = (input.toolErrors ?? []).map((line) => learnerToolError(line)).filter((line): line is string => !!line);
	for (const error of errors) {
		if (!input.assistantText.includes(error)) parts.push(error);
	}
	const unsaved =
		!input.calledGoal &&
		!input.assistantText.includes(UNSAVED_GOAL_LINE) &&
		(claimsGoalSaved(input.assistantText) || requestsGoal(input.userText) || !!input.goalPending);
	if (unsaved) parts.push(UNSAVED_GOAL_LINE);
	return parts.length ? parts.join(" ") : null;
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

const OPEN_OFFER = /^(?:want me to|do you want|shall i|should i)\b/i;
const SHORT_OFFER = /^(?:right|okay|ok|see|clear|follow|got it)\b|\b(?:sound good|make sense)\b/i;

/** A Quick Check heading, a waiting question callout, or a trailing question. */
export function awaitsChatAnswer(text: string): boolean {
	const spoken = stripStudyOffer(text);
	if (hasQuickCheck(spoken)) return true;
	if (questionCalloutAwaits(spoken)) return true;
	return trailingQuestion(spoken) !== null;
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
	goalPending?: boolean;
	quizOff?: boolean;
	toolErrors?: string[];
}): string | null {
	const user = visibleAsk(input.userText);
	const objective = statesLearningObjective(user);
	const goalRequest = requestsGoal(user);
	const postpone = declinesQuizNow(user) || !!input.quizOff;
	const studyingNow = wantsToStudyNow(user);
	const bulk = /<bulk_goal\b/.test(input.userText);
	const invented = inventsAppBehavior(input.assistantText);
	const claimed = claimsGoalSaved(input.assistantText);
	const gated = objective && asksToConfirmStudy(input.assistantText);
	const spoken = stripStudyOffer(input.assistantText);
	const errors = (input.toolErrors ?? []).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => learnerToolError(line));
	const lines: string[] = [];
	if (invented) {
		const cause = errors.length
			? `The tool error was: ${errors.join(" ")} Repeat that error in one sentence and add no other cause.`
			: "No tool failed. Do not invent a failure, and do not mention tools.";
		lines.push(
			`You invented a rule about how the app works. There is no confirmation step, no Start reply, nothing that waits to finalize a goal, and nothing that registers actions or initializes database tools. Do not explain the app. Do not say the tools failed to load. ${cause}`,
		);
	}
	if ((goalRequest || objective) && asksToConfirmStudy(input.assistantText)) {
		lines.push("They already said yes. Do not ask permission again.");
	}
	if (!postpone && bulk && !input.calledQuestion) {
		lines.push(
			"The goal is already saved. Call quiz on the frontier concept named in the bulk_goal block. The card is the question. Do not call set_goal again.",
		);
	} else if (!postpone && !input.calledQuestion && awaitsChatAnswer(spoken)) {
		lines.push(freeResponseRepair(spoken));
	} else if (!postpone && !input.calledQuestion && (announcesQuestion(spoken) || gated || objective || goalRequest || studyingNow)) {
		lines.push(
			"Call quiz for a graded question, or ask_user when there is no right answer. The card is the question. Do not ask permission first, and do not describe the card in prose.",
		);
	}
	if (!input.calledGoal && !bulk && (goalRequest || claimed || objective || input.goalPending)) {
		if (postpone) {
			lines.push(
				"Call set_goal on this turn. Pass due as YYYY-MM-DD for the date they named. Do not call quiz. Do not ask permission again. Do not tell them the goal is saved until set_goal succeeds. Do not ask them to reply Start.",
			);
		} else if (!objective && !goalRequest && !input.goalPending) {
			lines.push("You said a goal was saved, but set_goal did not succeed. They did not ask for a goal. Tell them it is not saved. Do not call set_goal.");
		} else {
			lines.push(
				"They stated an objective they are working toward. Call set_goal on this turn and start studying. A goal and a quiz go together. Do not ask whether to study or make a goal.",
			);
		}
	}
	if (!input.calledFigure && asciiDiagram(input.assistantText)) {
		lines.push(
			"You drew an ASCII diagram. Call show_figure with kind program. The source is Python using numpy and matplotlib, and it writes figure.png. Do not sketch the picture in a code block.",
		);
	}
	if (!lines.length) return null;
	return `<tutor_repair>\n${lines.join("\n")}\n</tutor_repair>`;
}

function stripStudyOffer(text: string): string {
	return text.replace(/want me to set this up as a goal and quiz you on it\??/gi, " ");
}

function freeResponseRepair(text: string): string {
	const question = clipQuestion(awaitedQuestion(text));
	return `Call quiz with format "free". Put this question on the card: ${question} Put the model answer in referenceAnswer and the worked steps in solution. Do not leave a Quick Check callout or a question in prose.`;
}

function awaitedQuestion(text: string): string {
	if (hasQuickCheck(text)) return extractQuickCheck(text);
	if (questionCalloutAwaits(text)) return extractQuestionCallout(text);
	return trailingQuestion(text) ?? "the question you just asked";
}

function clipQuestion(question: string): string {
	const flat = question.replace(/\s+/g, " ").trim();
	const capped = flat.length > 600 ? `${flat.slice(0, 600)}…` : flat;
	return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function hasQuickCheck(text: string): boolean {
	return text.split("\n").some((line) => isQuickCheckLabel(line));
}

function isQuickCheckLabel(line: string): boolean {
	const plain = line
		.trim()
		.replace(/^>\s?/, "")
		.replace(/^#+\s*/, "")
		.replace(/\*\*/g, "")
		.trim();
	return /^\[![a-z]+\]\s*quick check\b/i.test(plain) || /^quick check\b/i.test(plain);
}

function questionCalloutAwaits(text: string): boolean {
	const found = questionCallout(text);
	if (!found || !found.body.includes("?")) return false;
	const after = sentencesOf(dropHintLines(found.after));
	while (after.length && isOffer(after[after.length - 1] ?? "")) after.pop();
	const last = after[after.length - 1]?.trim() ?? "";
	return !last || last.endsWith("?");
}

function questionCallout(text: string): { body: string; after: string } | null {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^>\s*\[!question\]/i.test(line.trim()));
	if (start < 0) return null;
	let end = start;
	for (let i = start; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (trimmed && !trimmed.startsWith(">")) break;
		end = i;
	}
	return { body: lines.slice(start, end + 1).join("\n"), after: lines.slice(end + 1).join("\n") };
}

function extractQuestionCallout(text: string): string {
	const found = questionCallout(text);
	if (!found) return trailingQuestion(text) ?? "the question you just asked";
	return calloutBody(found.body) || "the question you just asked";
}

function extractQuickCheck(text: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => isQuickCheckLabel(line));
	if (start < 0) return "the question in your Quick Check";
	const quoted = /^\s*>/.test(lines[start] ?? "");
	const body: string[] = [];
	const rest = quickCheckRemainder(lines[start] ?? "");
	if (rest) body.push(rest);
	for (let i = start + 1; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (quoted) {
			if (trimmed && !trimmed.startsWith(">")) break;
		} else if (!trimmed) {
			if (body.length) break;
		}
		const plain = trimmed.replace(/^(?:>\s?)+/, "");
		if (!plain || /^hint\s*:/i.test(plain)) continue;
		body.push(plain);
	}
	return body.join(" ").trim() || "the question in your Quick Check";
}

function quickCheckRemainder(line: string): string {
	return line
		.trim()
		.replace(/^(?:>\s?)+/, "")
		.replace(/^#+\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/^\[![a-z]+\]\s*/i, "")
		.replace(/^quick check\b[:\s\-–—]*/i, "")
		.trim();
}

function calloutBody(block: string): string {
	const body: string[] = [];
	for (const line of block.split("\n")) {
		const plain = line
			.trim()
			.replace(/^>\s?/, "")
			.replace(/^\[!question\]\s*/i, "")
			.trim();
		if (!plain || /^hint\s*:/i.test(plain) || /^quick check\b[:\s\-–—]*$/i.test(plain)) continue;
		body.push(plain);
	}
	return body.join(" ").trim();
}

function trailingQuestion(text: string): string | null {
	const sentences = sentencesOf(dropHintLines(text));
	while (sentences.length && isOffer(sentences[sentences.length - 1] ?? "")) sentences.pop();
	const last = sentences[sentences.length - 1]?.trim() ?? "";
	return last.endsWith("?") ? last : null;
}

function dropHintLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^hint\s*:/i.test(line.trim().replace(/^(?:>\s?)+/, "")))
		.join("\n");
}

function sentencesOf(text: string): string[] {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return [];
	return flat
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function isOffer(sentence: string): boolean {
	const bare = sentence.replace(/[.!?]+$/g, "").trim();
	if (!bare) return false;
	if (OPEN_OFFER.test(bare)) return true;
	return bare.split(/\s+/).length <= 8 && SHORT_OFFER.test(bare);
}
