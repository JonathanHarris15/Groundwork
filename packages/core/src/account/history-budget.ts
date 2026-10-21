/**
 * A long tutor session used to resend every vault read, and every file the
 * learner had attached, on every later turn. Once the model has answered
 * past that turn, the bytes are replaced with a short reference it can open
 * again with read_vault_file. The turn still in progress keeps its files,
 * up to TUTOR_INLINE_MEDIA_CHARS. Past that, older decks are named and left
 * in the vault. Older tool text is capped.
 *
 * Compaction is idempotent: a second pass does not rewrite a stub, so the
 * prefix stays stable for prompt caching.
 */

import type { ChatMessage, ContentBlock } from "../agent/types";
import { asRecord } from "../unknown";

/** Old tool results longer than this are cut. The active turn is left whole. */
export const OLD_TOOL_CHAR_CAP = 1_600;
/**
 * Base64 characters of images and PDFs kept on the wire. One fitted screenshot
 * and a trimmed lecture deck fit. Further decks are a path, not the file.
 */
export const TUTOR_INLINE_MEDIA_CHARS = 16_000_000;

const ALREADY_READ = "[Already read ";
const TRIMMED_MARK = "[Older tool output trimmed";

/** Rough Messages-API size: 4 characters per token, including tool payloads. */
export function estimateMessageTokens(messages: ChatMessage[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

export function compactTutorHistory(messages: ChatMessage[]): ChatMessage[] {
	const cut = learnerTurnIndex(messages);
	const names = toolNames(messages);
	return messages.map((message, index) => (index < cut ? compactMessage(message, names) : message));
}

/**
 * Cache the learner's latest question, and the tail of the request.
 * During a tool loop the question breakpoint does not move, so the provider
 * can reuse that prefix. The tail breakpoint stores the prefix for the next call.
 */
export function withStablePrefixCache(messages: ChatMessage[]): ChatMessage[] {
	if (!messages.length) return messages;
	const marks = new Set<number>();
	const cut = learnerTurnIndex(messages);
	if (cut >= 0) marks.add(cut);
	marks.add(messages.length - 1);
	return messages.map((message, index) => (marks.has(index) ? markLastBlock(message) : message));
}

function learnerTurnIndex(messages: ChatMessage[]): number {
	let cut = -1;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		if (isToolResultMessage(message) || isInternalUserTurn(message)) continue;
		cut = i;
	}
	return cut;
}

function isToolResultMessage(message: ChatMessage): boolean {
	return blocksOf(message).some((block) => block.type === "tool_result");
}

function isInternalUserTurn(message: ChatMessage): boolean {
	const lines: string[] = [];
	for (const block of blocksOf(message)) {
		if (block.type === "text" && typeof block.text === "string") lines.push(block.text);
	}
	const text = lines.join("\n").trim();
	if (!text) return false;
	if (text === "Continue." || text === "Continue from the conversation so far.") return true;
	return text.includes("<tutor_repair>");
}

function toolNames(messages: ChatMessage[]): Map<string, { name: string; path: string }> {
	const names = new Map<string, { name: string; path: string }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of blocksOf(message)) {
			if (block.type !== "tool_use") continue;
			const id = typeof block.id === "string" ? block.id : "";
			const name = typeof block.name === "string" ? block.name : "";
			if (!id || !name) continue;
			names.set(id, { name, path: pathFromInput(block.input) });
		}
	}
	return names;
}

function pathFromInput(input: unknown): string {
	const record = asRecord(input);
	const path = record?.path;
	return typeof path === "string" ? path.trim() : "";
}

function compactMessage(message: ChatMessage, names: Map<string, { name: string; path: string }>): ChatMessage {
	if (typeof message.content === "string") return message;
	const next: ContentBlock[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (!block) continue;
		if (block.type === "tool_result") {
			next.push(compactResult(block, names));
			continue;
		}
		if (block.type === "document" || block.type === "image") {
			next.push({ type: "text", text: mediaStub(block, neighborPath(message.content, index)) });
			continue;
		}
		next.push(block);
	}
	if (!next.length) return message;
	return { role: message.role, content: next };
}

/**
 * The active turn still carries the screenshot and the deck just opened.
 * If those files together would blow the tutor POST, keep the latest image
 * and name the rest. Oldest documents go first.
 */
export function capInlineMedia(messages: ChatMessage[], budget = TUTOR_INLINE_MEDIA_CHARS): ChatMessage[] {
	const refs: Array<{ message: number; block: number; kind: "image" | "document"; chars: number; title: string }> = [];
	messages.forEach((message, messageIndex) => {
		const content = message.content;
		if (!Array.isArray(content)) return;
		content.forEach((block, blockIndex) => {
			if (block.type !== "image" && block.type !== "document") return;
			const data = mediaData(block);
			if (!data) return;
			refs.push({ message: messageIndex, block: blockIndex, kind: block.type, chars: data.length, title: titleOf(block) || neighborPath(content, blockIndex) });
		});
	});
	const total = refs.reduce((sum, ref) => sum + ref.chars, 0);
	if (total <= budget) return messages;
	const protectedImage = [...refs].reverse().find((ref) => ref.kind === "image");
	const drop = new Set<string>();
	let over = total - budget;
	const ordered = [...refs.filter((ref) => ref.kind === "document"), ...refs.filter((ref) => ref.kind === "image" && ref !== protectedImage)];
	for (const ref of ordered) {
		if (over <= 0) break;
		drop.add(`${ref.message}:${ref.block}`);
		over -= ref.chars;
	}
	if (!drop.size) return messages;
	return messages.map((message, messageIndex) => {
		if (!Array.isArray(message.content)) return message;
		const next: ContentBlock[] = [];
		message.content.forEach((block, blockIndex) => {
			if (!drop.has(`${messageIndex}:${blockIndex}`)) {
				next.push(block);
				return;
			}
			const ref = refs.find((item) => item.message === messageIndex && item.block === blockIndex);
			next.push({ type: "text", text: droppedMediaStub(ref?.title || "that file") });
		});
		return next.length ? { role: message.role, content: next } : message;
	});
}

function droppedMediaStub(title: string): string {
	return `[${title} was left out of this request so the upload stays within the limit. Call read_vault_file on that path if you need it.]`;
}

function titleOf(block: ContentBlock): string {
	return "title" in block && typeof block.title === "string" ? block.title.trim() : "";
}

function mediaData(block: ContentBlock): string {
	const source = "source" in block ? block.source : undefined;
	if (!source || typeof source !== "object") return "";
	const data = (source as { data?: unknown }).data;
	return typeof data === "string" ? data : "";
}

function neighborPath(blocks: ContentBlock[], index: number): string {
	const own = titleOf(blocks[index] ?? { type: "text" });
	if (own) return own;
	for (let i = index - 1; i >= 0 && i >= index - 2; i--) {
		const block = blocks[i];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const match = block.text.match(/^File:\s*(.+)$/);
		if (match?.[1]) return match[1].trim();
	}
	return "";
}

function compactResult(block: ContentBlock, names: Map<string, { name: string; path: string }>): ContentBlock {
	if (block.type !== "tool_result") return block;
	const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
	const text = resultText(block);
	if (text.startsWith(ALREADY_READ) || text.includes(TRIMMED_MARK)) return { ...block, content: text };
	const tool = names.get(id);
	const filePath = tool?.name === "read_vault_file" ? tool.path || pathFromText(text) || "that file" : pathFromText(text);
	if (tool?.name === "read_vault_file" || filePath) {
		return { ...block, content: readStub(filePath || "that file", text.length) };
	}
	if (text.length <= OLD_TOOL_CHAR_CAP) return { ...block, content: text };
	return { ...block, content: trimTool(text) };
}

function readStub(path: string, chars: number): string {
	const size = chars > 0 ? ` (${chars.toLocaleString("en-US")} characters)` : "";
	return `${ALREADY_READ}${path}${size}. Call read_vault_file on that path if you need it again.]`;
}

function mediaStub(block: ContentBlock, path = ""): string {
	const title = path || ("title" in block && typeof block.title === "string" && block.title.trim() ? block.title.trim() : "that file");
	return `${ALREADY_READ}${title}. Call read_vault_file on that path if you need it again.]`;
}

function trimTool(text: string): string {
	return `${text.slice(0, OLD_TOOL_CHAR_CAP)}\n${TRIMMED_MARK} from ${text.length.toLocaleString("en-US")} characters. Call the tool again if you need the rest.]`;
}

function pathFromText(text: string): string {
	const tagged = text.match(/<file path="([^"]+)"/);
	if (tagged?.[1]) return tagged[1];
	const contents = text.match(/Contents of ([^:\n]+):/);
	if (contents?.[1]) return contents[1].trim();
	return "";
}

function resultText(block: ContentBlock): string {
	if (block.type !== "tool_result") return "";
	const content = block.content;
	if (typeof content === "string") return content;
	// Normalize turns tool results into strings before compaction. An array here is still unread text plus media.
	if (!Array.isArray(content)) return "";
	const lines: string[] = [];
	for (const part of content) {
		const record = asRecord(part);
		if (!record) continue;
		const type = typeof record.type === "string" ? record.type : "";
		if (type === "text" && typeof record.text === "string" && record.text.trim()) lines.push(record.text);
		else if (type === "document" || type === "image") {
			const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : type;
			lines.push(`File: ${title}`);
		}
	}
	return lines.join("\n");
}

function blocksOf(message: ChatMessage): ContentBlock[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function markLastBlock(message: ChatMessage): ChatMessage {
	const blocks = blocksOf(message).map((block) => ({ ...block }));
	const last = blocks[blocks.length - 1];
	if (!last) return message;
	blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
	return { role: message.role, content: blocks };
}
