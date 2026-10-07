import type { Provider, ProviderRequest, ProviderResponse } from "./agent/types";
import { later } from "./timers";
import type { PreparedQuiz } from "./quiz";

/**
 * Side threads saved with the chat and handed to the main tutor at its next
 * turn (or with the next quiz/ask result).
 *
 * Margin: the learner highlights part of the lesson and asks about it. Those
 * questions are evidence about which step did not land. A margin answer must
 * not reveal a quiz that is still open.
 *
 * Hint: on a question, "Give me a hint" opens a side chat that nudges toward
 * the answer. The answer key stays in the hint model's prompt, never on the
 * saved thread. The main tutor reads the dialogue and judges how much of the
 * answer was actually supplied.
 */

export interface AsideMessage {
	role: "user" | "assistant";
	text: string;
	at: string;
}

export interface AsideThread {
	id: string;
	/** Which lesson element the highlight sits in, e.g. "item:4" or "quiz:q_abc". */
	anchor: string;
	quote: string;
	created: string;
	messages: AsideMessage[];
	/** How many messages the main tutor has already been shown. */
	shared: number;
	resolved?: boolean;
	/** Margin highlight (default) or a hint chat on a quiz question. */
	kind?: "margin" | "hint";
	/** Quiz id this hint thread is about. The answer key is never stored on the thread. */
	hintFor?: string;
}

/** Tools a margin answer may use: reading the vault, never quizzing or rewriting it. */
export const ASIDE_TOOL_NAMES = ["search_knowledge", "get_concepts", "list_vault_files", "read_vault_file"];

export const ASIDE_PROMPT = `# You are answering in the margin
You are the learner's tutor. While reading your lesson they highlighted a passage and asked about it in a side thread, like a comment in the margin of a document. The main lesson is paused, not over; they return to it after this.

- Answer exactly what they asked about the highlighted passage. Be direct and short: a few sentences, a small worked step, or one tiny example. Build on what the lesson already established.
- Stay faithful to the lesson's notation and framing. If the passage you wrote was wrong or unclear, say so plainly and fix it.
- If a quiz is waiting for them, do not reveal or hint at its answer. Clarify the underlying idea instead, and tell them they can go answer it.
- Do not quiz them, start a new topic, or re-teach the whole lesson. The main tutor sees this thread and will adapt.

# Formatting (rendered in Obsidian)
- Math is always LaTeX: inline $f(x)=x^2$, display math between $$ fences on their own lines. Only the formula goes inside $...$.
- Markdown, callouts, and [[Concept]] links work. Never ==highlight== math.`;

export const HINT_PROMPT = `# You are giving a hint
The learner is stuck on one quiz question and opened a side chat. Nudge them toward the answer so they are not stuck at "I don't know", and so they can still arrive at it themselves.

- The first hint is one step only: the idea to use, or the first move. Never the option letter, the final expression, or the full answer. Do not quote the private answer key.
- Each later reply is one step stronger than the last. If they keep asking, you may walk them closer, and you may eventually state the answer, but leave the last step for them when you still can.
- Stay on this question. Do not quiz them, start a new topic, or re-teach the whole lesson.
- Use the private answer key to aim the nudge. Never say that you were given a key.
- Be short: a few sentences or one small step.

# Formatting (rendered in Obsidian)
- Math is always LaTeX: inline $f(x)=x^2$, display math between $$ fences on their own lines. Only the formula goes inside $...$.
- Markdown and [[Concept]] links work. Never ==highlight== math.`;

export interface AsideContext {
	/** Recent main-thread transcript (markdown). */
	lesson: string;
	quote: string;
	pendingQuiz?: Pick<PreparedQuiz, "question" | "options" | "concept">;
	/** Earlier messages in this thread, when the side session has to be rebuilt. */
	earlier?: AsideMessage[];
}

const LESSON_CHARS = 16_000;

/** First message of a side session: the lesson so far, the highlight, and the question. */
export function asideOpening(ctx: AsideContext, question: string): string {
	const parts = [`<lesson_so_far>\n${ctx.lesson.slice(-LESSON_CHARS).trim() || "(nothing yet)"}\n</lesson_so_far>`];
	if (ctx.pendingQuiz) {
		const opts = ctx.pendingQuiz.options.map((o) => `- ${o.label}`).join("\n");
		parts.push(`<quiz_waiting_for_learner concept="${ctx.pendingQuiz.concept}">\n${ctx.pendingQuiz.question}\n${opts}\n</quiz_waiting_for_learner>`);
	}
	parts.push(`<highlighted_passage>\n${ctx.quote.trim()}\n</highlighted_passage>`);
	if (ctx.earlier?.length) {
		const thread = ctx.earlier.map((m) => `${m.role === "user" ? "Learner" : "You"}: ${m.text.trim()}`).join("\n\n");
		parts.push(`<this_thread_so_far>\n${thread}\n</this_thread_so_far>`);
	}
	parts.push(`Learner's question: ${question.trim()}`);
	return parts.join("\n\n");
}

/** What the hint model needs and the saved thread must not keep. */
export interface HintBrief {
	concept: string;
	question: string;
	format: "choice" | "free";
	/** Problem data the learner already sees under the question. */
	details?: string;
	multiSelect?: boolean;
	options?: { label: string; correct: boolean }[];
	reference?: string;
	rubric?: string;
	explanation?: string;
}

export interface HintContext {
	lesson: string;
	/** The question text, shown in the panel. */
	quote: string;
	/** Absent after a reload: the key is memory-only, so nudge without inventing an answer. */
	brief?: HintBrief;
	earlier?: AsideMessage[];
}

/** First message of a hint chat. The key is for the model, never written onto the thread. */
export function hintOpening(ctx: HintContext, learnerText: string): string {
	const parts = [`<lesson_so_far>\n${ctx.lesson.slice(-LESSON_CHARS).trim() || "(nothing yet)"}\n</lesson_so_far>`];
	parts.push(`<question_they_are_stuck_on>\n${ctx.quote.trim()}\n</question_they_are_stuck_on>`);
	parts.push(privateAnswerKey(ctx.brief));
	if (ctx.earlier?.length) {
		const thread = ctx.earlier.map((m) => `${m.role === "user" ? "Learner" : "You"}: ${m.text.trim()}`).join("\n\n");
		parts.push(`<this_hint_thread_so_far>\n${thread}\n</this_hint_thread_so_far>`);
	}
	parts.push(`Learner's question: ${learnerText.trim()}`);
	return parts.join("\n\n");
}

function privateAnswerKey(brief: HintBrief | undefined): string {
	if (!brief) {
		return [
			`<private_answer_key unavailable="true">`,
			"The answer key is not in this session. Nudge from the lesson. Do not invent a specific final answer or option.",
			`</private_answer_key>`,
		].join("\n");
	}
	const lines = [
		`<private_answer_key concept="${brief.concept}" format="${brief.format}"${brief.multiSelect ? ` multi="true"` : ""}>`,
		"For you only. Do not quote this on the first hint.",
		`Question: ${brief.question}`,
	];
	if (brief.details?.trim()) lines.push(`Given: ${brief.details.trim()}`);
	if (brief.options?.length) {
		lines.push("Options:");
		for (const o of brief.options) lines.push(`- ${o.label}${o.correct ? "  ← correct" : ""}`);
	}
	if (brief.reference?.trim()) lines.push(`Reference answer: ${brief.reference.trim()}`);
	if (brief.rubric?.trim()) lines.push(`Rubric: ${brief.rubric.trim()}`);
	if (brief.explanation?.trim()) lines.push(`Explanation: ${brief.explanation.trim()}`);
	lines.push("</private_answer_key>");
	return lines.join("\n");
}

const NOTE_ANSWER_CHARS = 700;
/** Hint replies are how the tutor judges what was given away, so keep them long enough to include a walkthrough. */
const HINT_CHARS = 4_000;

/**
 * Margin messages the main tutor hasn't seen yet, as one block for its next input.
 * Returns the text plus how far each thread has now been shared.
 */
export function marginNotes(threads: AsideThread[]): { text: string; shared: Map<string, number> } | null {
	const shared = new Map<string, number>();
	const blocks: string[] = [];
	for (const t of threads) {
		if (t.kind === "hint") continue;
		const fresh = t.messages.slice(t.shared);
		if (!fresh.some((m) => m.role === "user")) continue;
		shared.set(t.id, t.messages.length);
		const lines = [`On "${oneLine(t.quote, 240)}":`];
		for (const m of fresh) {
			const text = m.role === "user" ? m.text.trim() : clip(m.text.trim(), NOTE_ANSWER_CHARS);
			lines.push(`  ${m.role === "user" ? "Learner asked" : "Margin answer"}: ${indent(text)}`);
		}
		blocks.push(lines.join("\n"));
	}
	if (!blocks.length) return null;
	return {
		text: `<margin_questions>\nWhile reading, the learner asked these side questions in the margin (already answered there). Treat them as evidence of which step did not land, not as a verdict on the topic.\n\n${blocks.join("\n\n")}\n</margin_questions>`,
		shared,
	};
}

/**
 * Hint dialogue the main tutor hasn't seen yet.
 * A reply that arrives after the request was already shared is still delivered:
 * that reply is what shows how much of the answer was given away.
 */
export function hintNotes(threads: AsideThread[]): { text: string; shared: Map<string, number> } | null {
	const shared = new Map<string, number>();
	const blocks: string[] = [];
	for (const t of threads) {
		if (t.kind !== "hint") continue;
		if (!t.messages.some((m) => m.role === "user")) continue;
		const fresh = t.messages.slice(t.shared);
		if (!fresh.length) continue;
		shared.set(t.id, t.messages.length);
		const lines = [`On "${oneLine(t.quote, 240)}"${t.hintFor ? ` (quiz ${t.hintFor})` : ""}:`];
		for (const m of fresh) {
			const text = clip(m.text.trim(), HINT_CHARS);
			lines.push(`  ${m.role === "user" ? "Learner" : "Hint"}: ${indent(text)}`);
		}
		blocks.push(lines.join("\n"));
	}
	if (!blocks.length) return null;
	return {
		text: `<hint_transcript>\nThe learner opened a hint chat on a question. Read the dialogue and judge how much of the answer was supplied.\n- A nudge (the idea or the first move, not the result) means the answer is still theirs.\n- A walkthrough that states the letter, the final expression, or the result means an assisted correct is not solid mastery.\n\n${blocks.join("\n\n")}\n</hint_transcript>`,
		shared,
	};
}

export const MARGIN_GUIDANCE = `# Margin questions
The learner can highlight any part of your lesson and ask about it in a side thread. You receive those as a <margin_questions> block with their next message or quiz answer. They are evidence, not noise:
- A question reveals the exact step that did not land. Account for it: if it exposes a misconception, write it into the concept with \`upsert_concept\` (misconceptions); if it shows a clear gap you can grade, \`record_evidence\` (kind "explain"); only patterns seen across sessions go to \`update_learner_profile\`. A clarifying question is curiosity or a gap in your explanation, not a weakness to record.
- Do not re-answer what the margin already answered. Adjust the next explanation or quiz to the gap it revealed, and mention it briefly if useful ("you asked why x is constant — that is the key step, so…").`;

export const HINT_GUIDANCE = `# Hint chats
On a quiz or practice-test question the learner can press "Give me a hint". A side chat then nudges them, and may walk further if they keep asking. You receive that dialogue as a <hint_transcript> block, with their answer or with a later message. Read it and judge how much of the answer was supplied.
- A nudge (the idea or the first move, not the result) means the answer is still theirs. Grade and move on as usual.
- A walkthrough that states the letter, the final expression, or the result means an assisted correct is not solid mastery. For a free response, grade only the unaided part: an answer that only repeats what the hint stated is partial or incorrect. For multiple choice already recorded as correct, do not treat that as solid — revisit the gap next, and you may record_evidence for what they actually missed. Do not re-answer the hint chat in the main thread.`;

function oneLine(s: string, max: number): string {
	return clip(s.replace(/\s+/g, " ").trim(), max);
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function indent(s: string): string {
	return s.replace(/\n/g, "\n    ");
}

/** Scripted margin replies for the demo provider. */
export class DemoAsideProvider implements Provider {
	readonly name = "demo-aside";

	constructor(private readonly delayMs = 10) {}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const last = req.messages[req.messages.length - 1];
		const opening = typeof last?.content === "string" ? last.content : "";
		const asked = /Learner's question: ([\s\S]*)$/.exec(opening)?.[1] ?? opening;
		const hint = opening.includes("<private_answer_key");
		const text = hint
			? `One step, not the answer${asked ? ` — “${oneLine(asked, 80)}”` : ""}. Name what is changing and what stays fixed, and take that step yourself. Ask again if you want a stronger nudge.`
			: `Good question${asked ? ` — “${oneLine(asked, 80)}”` : ""}. In the demo tutor this margin reply is scripted, but the thread is real: it is saved with the chat and the main tutor reads it at its next turn.\n\nFor example, the secant slope $\\frac{f(x+h)-f(x)}{h}$ is just rise over run between two points on the curve.`;
		const chunks = text.match(/[\s\S]{1,18}/g) ?? [];
		for (const c of chunks) {
			if (req.signal?.aborted) throw new Error("aborted");
			req.onText(c);
			if (this.delayMs) await new Promise<void>((r) => later(() => r(), this.delayMs));
		}
		return { content: [{ type: "text", text }], stopReason: "end_turn" };
	}
}
