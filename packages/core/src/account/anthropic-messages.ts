/**
 * The Anthropic Messages API rejects a turn the tutor would otherwise send.
 * OpenRouter reports some schema misses as "Invalid Anthropic Messages API request"
 * and names others. A saved session that contains one of those misses — a thinking
 * block, an empty block, two turns of the same role, a tool call with no result,
 * or an image or PDF whose source is missing data or uses a disallowed media type —
 * is replayed on every later message, so the whole chat goes down.
 * Repair the transcript and keep the repaired copy. Tool results stay strings.
 * A valid PDF or image that arrived inside a tool result is moved beside that
 * result, so the model can still read the file it just opened. Invalid media
 * becomes a text note. Drop thinking blocks; this request does not enable
 * extended thinking, and sending one back is itself an invalid request.
 */

import type { ChatMessage, ContentBlock } from "../agent/types";
import { compactTutorHistory } from "./history-budget";

export const TUTOR_SEND_RETRY = "That didn't go through. Try again.";

/** A sentence for the red banner. Provider JSON and request dumps stay off the screen. */
export function plainTutorError(text: string): string {
	const raw = text.replace(/\s+/g, " ").trim();
	if (!raw || raw === TUTOR_SEND_RETRY) return TUTOR_SEND_RETRY;
	if (/rate limit|usage limit|overloaded|too many requests/i.test(raw)) return "The model is busy. Wait a moment and try again.";
	if (/api key|authentication|unauthorized|credit balance|invalid x-api-key/i.test(raw)) {
		return "The model key was refused. Check the key on the website, then try again.";
	}
	if (/^[A-Za-z][^.!?]{0,160}[.!?]?$/.test(raw) && !/\b(api|anthropic|invalid_|messages\.|tool_use|tool_result|request_id)\b/i.test(raw)) return raw;
	return TUTOR_SEND_RETRY;
}

/** Stored-session repair. Does not invent a trailing "Continue." turn. */
export function normalizeAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
	const cleaned = messages.map(cleanMessage).filter((message): message is ChatMessage => message !== null);
	const merged = mergeRoles(cleaned);
	const opened = merged[0]?.role === "assistant" ? [{ role: "user" as const, content: "Continue from the conversation so far." }, ...merged] : merged;
	return pairTools(opened);
}

/** The body of one Messages API call. A thread that still ends on the assistant gets a user turn. */
export function messagesForAnthropic(messages: ChatMessage[]): ChatMessage[] {
	const healed = compactTutorHistory(normalizeAnthropicMessages(messages));
	if (!healed.length || healed[healed.length - 1]?.role === "assistant") return [...healed, { role: "user", content: "Continue." }];
	return healed;
}

/**
 * Last resort when a repaired history is still rejected. One user message, text
 * only, so the next attempt cannot replay a tool call or a document block.
 */
export function collapseAnthropicTranscript(messages: ChatMessage[]): ChatMessage[] {
	const lines: string[] = [];
	for (const message of normalizeAnthropicMessages(messages)) {
		const text = plainMessage(message).trim();
		if (!text) continue;
		lines.push(`${message.role === "assistant" ? "Tutor" : "Learner"}: ${text}`);
	}
	const body = lines.join("\n\n").trim().slice(-40_000);
	return [{ role: "user", content: body || "Continue." }];
}

export function invalidAnthropicRequest(text: string): boolean {
	return /Invalid Anthropic Messages API request|That didn't go through/i.test(text) || /messages\.\d+/i.test(text);
}

function cleanMessage(message: ChatMessage): ChatMessage | null {
	if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
	if (typeof message.content === "string") {
		return message.content.trim() ? { role: message.role, content: message.content } : null;
	}
	if (!Array.isArray(message.content)) return null;
	const blocks = message.content.flatMap((block) => cleanBlock(message.role, block));
	if (!blocks.length) return null;
	return { role: message.role, content: blocks };
}

function cleanBlock(role: "user" | "assistant", block: ContentBlock): ContentBlock[] {
	if (!block || typeof block !== "object" || typeof block.type !== "string") return [];
	if (block.type === "text") {
		return typeof block.text === "string" && block.text.trim() ? [{ type: "text", text: block.text }] : [];
	}
	if (block.type === "tool_use" && role === "assistant") {
		const id = typeof block.id === "string" ? block.id.trim() : "";
		const name = typeof block.name === "string" ? block.name.trim() : "";
		if (!id || !name) return [];
		return [{ type: "tool_use", id, name, input: objectInput(block.input) }];
	}
	if (block.type === "tool_result" && role === "user") {
		const id = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
		if (!id) return [];
		const split = splitResult(block.content);
		return [
			{ type: "tool_result", tool_use_id: id, content: split.text, ...(block.is_error ? { is_error: true } : {}) },
			...split.media,
		];
	}
	// Extended thinking is not turned on. A stored thinking block makes every later request invalid.
	if (block.type === "thinking" || block.type === "redacted_thinking") return [];
	// An image on an assistant turn is rejected. Drop it.
	if ((block.type === "image" || block.type === "document") && role === "user") return mediaOrNote(block);
	return [];
}

function objectInput(input: unknown): Record<string, unknown> {
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>) };
		} catch {
			return {};
		}
		return {};
	}
	if (input && typeof input === "object" && !Array.isArray(input)) return { ...(input as Record<string, unknown>) };
	return {};
}

const IMAGE_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DOCUMENT_MEDIA = new Set(["application/pdf", "text/plain"]);

/**
 * A tool result is a string. A valid PDF or image that came with it is a sibling
 * block, which this endpoint accepts. A source with no data, or an image type
 * other than jpeg, png, gif, or webp, is the generic invalid-request error, so
 * it becomes a note instead of a block.
 */
function splitResult(content: unknown): { text: string; media: ContentBlock[] } {
	if (typeof content === "string") return { text: content.trim() ? content : "No result.", media: [] };
	if (!Array.isArray(content)) return { text: "No result.", media: [] };
	const lines: string[] = [];
	const media: ContentBlock[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
			lines.push(record.text.trim());
			continue;
		}
		if (record.type === "image" || record.type === "document") {
			const kept = validMedia(record);
			if (kept) media.push(kept);
			else lines.push(invalidMediaNote(record));
		}
	}
	const text = lines.join("\n") || (media.length ? "Opened the attached file." : "No result.");
	return { text, media };
}

function mediaOrNote(block: ContentBlock): ContentBlock[] {
	const record = block as Record<string, unknown>;
	const kept = validMedia(record);
	return kept ? [kept] : [{ type: "text", text: invalidMediaNote(record) }];
}

function validMedia(block: Record<string, unknown>): ContentBlock | null {
	if (block.type !== "image" && block.type !== "document") return null;
	const source = block.source;
	if (!source || typeof source !== "object") return null;
	const fields = source as Record<string, unknown>;
	if (fields.type !== "base64") return null;
	const mediaType = typeof fields.media_type === "string" ? fields.media_type : "";
	const data = typeof fields.data === "string" ? fields.data.trim() : "";
	if (!data) return null;
	if (block.type === "image" && !IMAGE_MEDIA.has(mediaType)) return null;
	if (block.type === "document" && !DOCUMENT_MEDIA.has(mediaType)) return null;
	const clean: ContentBlock = { type: block.type, source: { type: "base64", media_type: mediaType, data } };
	if (block.type === "document" && typeof block.title === "string" && block.title.trim()) clean.title = block.title.trim();
	return clean;
}

function invalidMediaNote(block: Record<string, unknown>): string {
	const kind = block.type === "image" ? "image" : "document";
	const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : "file";
	return `[The ${kind} ${title} was not a valid attachment, so it was left out. Open it again with read_vault_file.]`;
}

function plainMessage(message: ChatMessage): string {
	return asBlocks(message.content)
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "tool_use") {
				const name = fields(block).name;
				return `Tool ${typeof name === "string" && name.trim() ? name : "call"} was called.`;
			}
			if (block.type === "tool_result") return resultText(block);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function mergeRoles(messages: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const message of messages) {
		const prev = out[out.length - 1];
		if (!prev || prev.role !== message.role) {
			out.push(message);
			continue;
		}
		out[out.length - 1] = { role: message.role, content: joinContent(prev.content, message.content) };
	}
	return out;
}

function joinContent(left: ChatMessage["content"], right: ChatMessage["content"]): ChatMessage["content"] {
	if (typeof left === "string" && typeof right === "string") return `${left}\n\n${right}`;
	return [...asBlocks(left), ...asBlocks(right)];
}

function asBlocks(content: ChatMessage["content"]): ContentBlock[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function pairTools(messages: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message) continue;
		if (message.role !== "assistant") {
			out.push(loosenOrphans(message));
			continue;
		}
		const uses = toolUses(message);
		out.push(message);
		if (!uses.length) continue;
		const next = messages[i + 1];
		const follow = next?.role === "user" ? next : null;
		if (follow) i++;
		out.push({ role: "user", content: matchedResults(uses, follow) });
	}
	return out;
}

function toolUses(message: ChatMessage): Array<{ id: string }> {
	return asBlocks(message.content).filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
}

function matchedResults(uses: Array<{ id: string }>, follow: ChatMessage | null): ContentBlock[] {
	const found = new Map<string, ContentBlock>();
	const extra: ContentBlock[] = [];
	for (const block of follow ? asBlocks(follow.content) : []) {
		const id = toolResultId(block);
		if (id && uses.some((use) => use.id === id) && !found.has(id)) found.set(id, block);
		else if (id) extra.push({ type: "text", text: resultText(block) });
		else extra.push(block);
	}
	const results: ContentBlock[] = uses.map(
		(use) => found.get(use.id) ?? { type: "tool_result", tool_use_id: use.id, content: "The tool did not return a result.", is_error: true },
	);
	return [...results, ...extra];
}

/** A tool result with no call is still the memory the tutor fetched. Keep it as text. */
function loosenOrphans(message: ChatMessage): ChatMessage {
	if (typeof message.content === "string") return message;
	const blocks = message.content.map((block) => (toolResultId(block) ? { type: "text" as const, text: resultText(block) } : block));
	const first = blocks[0];
	const only = blocks.length === 1 && first ? textOf(first) : null;
	if (only !== null) return { role: message.role, content: only };
	return { role: message.role, content: blocks };
}

function fields(block: ContentBlock): Record<string, unknown> {
	return block;
}

function toolResultId(block: ContentBlock): string | null {
	if (block.type !== "tool_result") return null;
	const id = fields(block).tool_use_id;
	return typeof id === "string" && id.trim() ? id : null;
}

function textOf(block: ContentBlock): string | null {
	if (block.type !== "text") return null;
	const text = fields(block).text;
	return typeof text === "string" ? text : null;
}

function resultText(block: ContentBlock): string {
	if (block.type !== "tool_result") return "";
	const content = fields(block).content;
	if (typeof content === "string") return content.trim() || "No result.";
	if (!Array.isArray(content)) return "No result.";
	const text = content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const record = item as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
	return text || "No result.";
}
