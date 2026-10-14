/**
 * What the learner asked for on this turn, and whether a goal, concept, or quiz is allowed.
 * The tutor answers by default. Study tools run only after an explicit opt-in.
 */

import type { ChatMessage, ContentBlock } from "./agent/types";

/**
 * One offer after a study guide or flashcards. A goal and a quiz are the same
 * effort. This is not a choice between them, and it is not required before either.
 */
export const STUDY_FOLLOW_UP = "Want me to set this up as a goal and quiz you on it?";

/** True when the tutor already made that offer, including the older either/or wording still in a transcript. */
export function offeredStudyFollowUp(text: string): boolean {
	return /want me to set this up as a goal and quiz you/i.test(text) || /do you want to study this or make a goal/i.test(text);
}

export type LearnerAsk = "study" | "survey" | "artifact" | "answer";

export interface DialogueTurn {
	role: "user" | "assistant";
	text: string;
}

/** Tools that create a goal or concept, or start quizzing. Refused until the learner opts in. */
export const STUDY_TOOLS = new Set([
	"set_goal",
	"upsert_concept",
	"quiz",
	"record_evidence",
	"practice_test",
	"ingest_exam_materials",
	"set_working_goal",
	"ask_user",
]);

const HIDDEN_BLOCK = /<(working_goal|exam_plan|margin_questions|hint_transcript|tutor_repair)>[\s\S]*?<\/\1>/gi;

/** Learner text with the hidden notes the app prepends taken out, so those notes are not an ask. */
export function visibleAsk(text: string): string {
	return text.replace(HIDDEN_BLOCK, " ").replace(/\s+/g, " ").trim();
}

/** What this message is asking for, ignoring earlier turns. */
export function classifyLearnerAsk(text: string): LearnerAsk {
	const visible = visibleAsk(text);
	if (!visible) return "answer";
	if (isArtifact(visible) && !isStrongStudy(visible)) return "artifact";
	if (isStudy(visible)) return "study";
	if (isSurvey(visible)) return "survey";
	return "answer";
}

/**
 * True when this conversation already opted into goals, concepts, or quizzing.
 * A yes counts only after the tutor asked {@link STUDY_FOLLOW_UP}.
 */
export function learnerOptedIntoStudy(turns: DialogueTurn[]): boolean {
	let offered = false;
	for (const turn of turns) {
		if (turn.role === "assistant") {
			if (offeredStudyFollowUp(turn.text)) offered = true;
			continue;
		}
		const visible = visibleAsk(turn.text);
		if (!visible) continue;
		if (classifyLearnerAsk(visible) === "study") return true;
		if (offered && isAffirmative(visible)) return true;
	}
	return false;
}

export function studyToolBlock(name: string, dialogue: DialogueTurn[]): { text: string; isError: true; summary: string } | null {
	if (!STUDY_TOOLS.has(name)) return null;
	if (learnerOptedIntoStudy(dialogue)) return null;
	return {
		isError: true,
		summary: "Waiting until they ask to study",
		text: `Not yet. ${name} did not run because this message did not ask to study. Answer what they asked. Do not tell them a confirmation, a setting, or the system blocked it. If you just finished a study guide or flashcards, you may ask once: "${STUDY_FOLLOW_UP}" That is an offer, not a gate. Then wait.`,
	};
}

/** Learner and tutor text, skipping tool results so a tool payload cannot count as an ask. */
export function dialogueFromMessages(messages: ChatMessage[]): DialogueTurn[] {
	const out: DialogueTurn[] = [];
	for (const message of messages) {
		if (Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) continue;
		const text = messageText(message);
		if (!text.trim()) continue;
		out.push({ role: message.role, text });
	}
	return out;
}

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function isArtifact(text: string): boolean {
	return (
		/\b(study guide|flash\s?cards?|cheat sheet|formula sheet|review sheet)\b/i.test(text) &&
		/\b(put together|make|write|create|draft|build|generate|prepare|give me|come up with|assemble|want|need)\b/i.test(text)
	);
}

/** Study signals that outrank "make a study guide". "Let's build" alone does not, so a study guide stays an artifact. */
function isStrongStudy(text: string): boolean {
	return (
		/\b(teach me|quiz me|test me|drill me)\b/i.test(text) ||
		/\bhelp me (learn|study|practice|review|prep|prepare)\b/i.test(text) ||
		/\b(i want to|i'd like to|i would like to)\s+(learn|study|practice|review)\b/i.test(text) ||
		/\b(let's|lets)\s+(learn|study|practice|review|prepare|prep)\b/i.test(text) ||
		/\b(make|create|set|start|add|save)\s+(a\s+|me\s+a\s+)?(new\s+)?goal\b/i.test(text) ||
		/\bi have\b.{0,100}\b(exam|midterm)\b/i.test(text) ||
		/\bi have\b.{0,100}\bfinal(?!\s+(answer|step|result|value|form))\b/i.test(text) ||
		/\bi have\b.{0,80}\b(a|an|my)\s+quiz\b/i.test(text) ||
		/\bprep(are|ping)?\s+(me\s+)?for\b/i.test(text) ||
		/\b(practice|mock)\s+(test|exam)\b/i.test(text) ||
		/\breview\b.{0,120}\bwith me\b/i.test(text)
	);
}

function isStudy(text: string): boolean {
	return isStrongStudy(text) || /\blet'?s build\b/i.test(text) || statesLearningObjective(text);
}

/**
 * They named an outcome they are working toward: a homework, an exam, a skill,
 * or "I want to be able to …". A direct question that only mentions a homework
 * ("solve problem 4 on the homework") is not an objective.
 */
export function statesLearningObjective(text: string): boolean {
	const visible = visibleAsk(text);
	if (!visible) return false;
	if (isDirectLookup(visible) && !wantsAbility(visible)) return false;
	return wantsAbility(visible) || homeworkObjective(visible) || examStudy(visible);
}

function wantsAbility(text: string): boolean {
	return (
		/\b(?:want|need|like|trying|hope)(?:\s+\w+){0,4}\s+to be able to\b/i.test(text) ||
		/\b(?:working|work)\s+towards?\b/i.test(text) ||
		/\bmy goal is\b/i.test(text) ||
		/\b(?:i'm|i am|im)\s+trying to\s+(?:learn|understand|get|master|be able)\b/i.test(text)
	);
}

function homeworkObjective(text: string): boolean {
	if (!/\b(?:homework|homeworks|problem sets?|assignments?)\b/i.test(text)) return false;
	if (isDirectLookup(text) && !wantsAbility(text)) return false;
	return /\b(?:due|working on|work on|i have|i've got|i’ve got|need to do|have to do|need to finish|have to finish)\b/i.test(text);
}

function examStudy(text: string): boolean {
	return (
		/\b(?:studying|preparing|prepping|getting ready)\s+for\b/i.test(text) &&
		/\b(?:exam|midterm|final|quiz|test|homework|assignment|problem set)\b/i.test(text)
	);
}

/** A request to solve, explain, or look something up. Not an objective by itself. */
function isDirectLookup(text: string): boolean {
	return /\b(?:solve|summarize|summarise|explain|answer|what(?:'s| is| does)|show me|graph of)\b/i.test(text);
}

function isSurvey(text: string): boolean {
	const asks = /\b(summarize|summarise|sum up|survey|overview|skim)\b/i.test(text) || /\bwhat(?:'s| is| are) in\b/i.test(text) || /\b(go|look) through\b/i.test(text);
	const docs = /\b(documents?|files?|notes?|context|readings?|vault|slides?|lectures?|materials?|attachments?)\b/i.test(text);
	return asks && docs;
}

function isAffirmative(text: string): boolean {
	const t = text.trim().replace(/[.!]+$/g, "").replace(/\s+/g, " ");
	return (
		/^(yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|sounds good|let's|lets)(?: (please|do it|study(?: this| it)?|make a goal(?: for it)?))?$/i.test(t) ||
		/^(yes|yeah|yep|sure|ok|okay)[, ]+(please|let's study|lets study|study(?: this| it)?|make a goal(?: for it)?)$/i.test(t) ||
		/^(let's|lets) (study|do) (it|this|that)$/i.test(t) ||
		/^study (this|it|that)$/i.test(t)
	);
}
