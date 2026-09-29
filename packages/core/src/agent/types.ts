import type { VaultFile } from "../files";

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: any }
	| { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
	// Server-side tool blocks (web search), thinking, etc. are passed through untouched.
	| { type: string; [key: string]: any };

export interface ChatMessage {
	role: "user" | "assistant";
	content: string | ContentBlock[];
}

export interface ProviderTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface ProviderRequest {
	system: string;
	messages: ChatMessage[];
	tools: ProviderTool[];
	signal?: AbortSignal;
	onText: (delta: string) => void;
}

export interface ProviderResponse {
	content: ContentBlock[];
	stopReason: string;
	usage?: { input: number; output: number; cacheRead?: number };
}

export interface Provider {
	readonly name: string;
	complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** A running tutor conversation, whichever backend drives it. */
export interface TutorSession {
	readonly busy: boolean;
	/** `files` are what the learner attached to this message. */
	send(text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, files?: VaultFile[]): Promise<void>;
	close?(): void;
}

export type AgentEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; id: string; name: string; input: any }
	| { type: "tool_end"; id: string; name: string; summary?: string; isError?: boolean; text: string }
	| { type: "turn_end" }
	| { type: "error"; message: string };
