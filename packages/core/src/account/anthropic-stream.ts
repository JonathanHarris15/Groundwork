/**
 * Anthropic message SSE, including OpenRouter's Anthropic-compatible stream.
 * Text is emitted as it arrives. Tool input is assembled from input_json_delta.
 */

import type { ContentBlock } from "../agent/types";
import type { UpstreamResult } from "./tutor";

export type AnthropicStreamPiece = { type: "text"; text: string } | { type: "done"; result: UpstreamResult } | { type: "error"; message: string };

interface BlockState {
	type: string;
	text: string;
	id: string;
	name: string;
	json: string;
	input: unknown;
	thinking: string;
	signature: string;
}

export class AnthropicEventParser {
	private buffer = "";
	private blocks: BlockState[] = [];
	private stopReason = "";
	private inputTokens = 0;
	private outputTokens = 0;
	private failed: string | null = null;
	private closed = false;

	push(chunk: string): AnthropicStreamPiece[] {
		this.buffer += chunk;
		const out: AnthropicStreamPiece[] = [];
		while (true) {
			const split = this.buffer.indexOf("\n\n");
			if (split < 0) break;
			const raw = this.buffer.slice(0, split);
			this.buffer = this.buffer.slice(split + 2);
			const data = sseData(raw);
			if (!data || data === "[DONE]") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			out.push(...this.consume(parsed));
		}
		return out;
	}

	/** Flush a trailing event that arrived without a blank line, then close. */
	finish(): AnthropicStreamPiece[] {
		const tail = this.buffer.trim() ? this.push("\n\n") : [];
		if (this.closed) return tail;
		this.closed = true;
		return [...tail, this.donePiece()];
	}

	private consume(value: unknown): AnthropicStreamPiece[] {
		if (!value || typeof value !== "object") return [];
		const event = value as {
			type?: string;
			index?: number;
			message?: { usage?: { input_tokens?: number; output_tokens?: number } };
			content_block?: Record<string, unknown>;
			delta?: Record<string, unknown>;
			usage?: { input_tokens?: number; output_tokens?: number };
			error?: { message?: string } | string;
		};
		if (event.type === "error") {
			const message = typeof event.error === "string" ? event.error : event.error?.message || "The model provider stopped the stream.";
			this.failed = message;
			this.closed = true;
			return [{ type: "error", message }];
		}
		if (event.type === "message_start") {
			this.inputTokens = count(event.message?.usage?.input_tokens) || this.inputTokens;
			this.outputTokens = count(event.message?.usage?.output_tokens) || this.outputTokens;
			return [];
		}
		if (event.type === "content_block_start") {
			const block = event.content_block ?? {};
			const type = typeof block.type === "string" ? block.type : "text";
			const state: BlockState = {
				type,
				text: typeof block.text === "string" ? block.text : "",
				id: typeof block.id === "string" ? block.id : "",
				name: typeof block.name === "string" ? block.name : "",
				json: "",
				input: block.input,
				thinking: typeof block.thinking === "string" ? block.thinking : "",
				signature: typeof block.signature === "string" ? block.signature : "",
			};
			const index = typeof event.index === "number" ? event.index : this.blocks.length;
			this.blocks[index] = state;
			return state.type === "text" && state.text ? [{ type: "text", text: state.text }] : [];
		}
		if (event.type === "content_block_delta") {
			const index = typeof event.index === "number" ? event.index : this.blocks.length - 1;
			const block = this.blocks[index];
			const delta = event.delta ?? {};
			if (!block) return [];
			if (delta.type === "text_delta" && typeof delta.text === "string") {
				block.text += delta.text;
				return delta.text ? [{ type: "text", text: delta.text }] : [];
			}
			if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.json += delta.partial_json;
			if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.thinking += delta.thinking;
			if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature += delta.signature;
			return [];
		}
		if (event.type === "message_delta") {
			const delta = event.delta ?? {};
			if (typeof delta.stop_reason === "string") this.stopReason = delta.stop_reason;
			const output = count(event.usage?.output_tokens);
			const input = count(event.usage?.input_tokens);
			if (output) this.outputTokens = output;
			if (input) this.inputTokens = input;
			return [];
		}
		if (event.type === "message_stop") {
			this.closed = true;
			return [this.donePiece()];
		}
		return [];
	}

	private donePiece(): AnthropicStreamPiece {
		if (this.failed) return { type: "error", message: this.failed };
		const content = this.blocks.filter(Boolean).map(toBlock);
		const stopReason = this.stopReason || (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn");
		return { type: "done", result: { content, stopReason, usage: { input: this.inputTokens, output: this.outputTokens } } };
	}
}

function toBlock(block: BlockState): ContentBlock {
	if (block.type === "text") return { type: "text", text: block.text };
	if (block.type === "tool_use") {
		return { type: "tool_use", id: block.id || `tool_${block.name || "call"}`, name: block.name, input: parseToolInput(block.json, block.input) };
	}
	if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signature: block.signature };
	return { type: block.type };
}

/** Models sometimes return tool arguments as a JSON string instead of an object. */
export function parseToolInput(json: string, fallback: unknown): unknown {
	const trimmed = json.trim();
	if (trimmed) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return {};
		}
	}
	if (typeof fallback === "string") {
		try {
			return JSON.parse(fallback);
		} catch {
			return {};
		}
	}
	if (fallback && typeof fallback === "object") return fallback;
	return {};
}

function sseData(raw: string): string | null {
	const lines = raw.split("\n").map((line) => line.trim());
	const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
	if (!data.length) return null;
	return data.join("\n");
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
