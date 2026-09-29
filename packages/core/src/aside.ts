import type { Provider, ProviderRequest, ProviderResponse } from "./agent/types";
import type { PreparedQuiz } from "./quiz";

/**
 * Margin threads: the learner highlights part of the lesson and asks about it
 * without derailing the main thread. The questions are evidence about where
 * understanding breaks, so they are saved with the chat and handed to the main
 * tutor at its next turn (or with the next quiz/ask result).
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

const NOTE_ANSWER_CHARS = 700;

/**
 * Margin messages the main tutor hasn't seen yet, as one block for its next input.
 * Returns the text plus how far each thread has now been shared.
 */
export function marginNotes(threads: AsideThread[]): { text: string; shared: Map<string, number> } | null {
	const shared = new Map<string, number>();
	const blocks: string[] = [];
	for (const t of threads) {
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
		text: `<margin_questions>\nWhile reading, the learner asked these side questions in the margin (already answered there). Treat them as evidence of where their understanding is shaky.\n\n${blocks.join("\n\n")}\n</margin_questions>`,
		shared,
	};
}

export const MARGIN_GUIDANCE = `# Margin questions
The learner can highlight any part of your lesson and ask about it in a side thread. You receive those as a <margin_questions> block with their next message or quiz answer. They are evidence, not noise:
- A question reveals the exact step that did not land. Account for it: if it exposes a misconception, write it into the concept with \`upsert_concept\` (misconceptions); if it shows a clear gap you can grade, \`record_evidence\` (kind "explain"); durable patterns go to \`update_learner_profile\`.
- Do not re-answer what the margin already answered. Adjust the next explanation or quiz to the gap it revealed, and mention it briefly if useful ("you asked why x is constant — that is the key step, so…").`;

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
		const asked = typeof last?.content === "string" ? (/Learner's question: ([\s\S]*)$/.exec(last.content)?.[1] ?? last.content) : "";
		const text = `Good question${asked ? ` — “${oneLine(asked, 80)}”` : ""}. In the demo tutor this margin reply is scripted, but the thread is real: it is saved with the chat and the main tutor reads it at its next turn.\n\nFor example, the secant slope $\\frac{f(x+h)-f(x)}{h}$ is just rise over run between two points on the curve.`;
		const chunks = text.match(/[\s\S]{1,18}/g) ?? [];
		for (const c of chunks) {
			if (req.signal?.aborted) throw new Error("aborted");
			req.onText(c);
			if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		}
		return { content: [{ type: "text", text }], stopReason: "end_turn" };
	}
}
