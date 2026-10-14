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
}): string | null {
	const objective = statesLearningObjective(visibleAsk(input.userText));
	const invented = inventsAppBehavior(input.assistantText);
	const gated = objective && asksToConfirmStudy(input.assistantText);
	const spoken = stripStudyOffer(input.assistantText);
	const lines: string[] = [];
	if (invented) {
		lines.push(
			"You invented a rule about how the app works. There is no confirmation step and nothing to unlock. Do not explain the app. If a card or goal did not appear, call the tool again. If it still fails, say it did not load.",
		);
	}
	if (!input.calledQuestion && awaitsChatAnswer(spoken)) {
		lines.push(freeResponseRepair(spoken));
	} else if (!input.calledQuestion && (announcesQuestion(spoken) || gated || objective)) {
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
