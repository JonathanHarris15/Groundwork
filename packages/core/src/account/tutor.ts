/**
 * Which API a tutor turn uses.
 *
 * Free and Groundwork share one OpenRouter key on the server (`OPENROUTER_API_KEY`).
 * The account's hosted allowance is the per-learner limit. We do not mint a key per learner:
 * a second key would still be billed to us, and the ledger already draws the line.
 *
 * Bring your own model is the exception. A pasted provider key is that learner's, so it is
 * stored for them and sent only to that provider. A Claude subscription is not a key we can
 * provision: Claude Code's login on this computer is the credential, and those turns never
 * pass through Groundwork.
 *
 * The tutor does not run until the device is signed in. A signed-out attempt is a prompt
 * to sign in on the website and choose Open Obsidian.
 *
 * Clients receive `tutorStatus`. It has no dollar amounts.
 */

import type { ContentBlock, ProviderTool, ChatMessage } from "../agent/types";
import { USER_KEY_PROVIDERS, type UserKeyProvider } from "./plans";
import { type AccountView, type TutorChoice } from "./usage";

export const HOSTED_MODEL = {
	id: "anthropic/claude-haiku-4.5",
	label: "Groundwork small",
	/** USD per million tokens. Matches the published Haiku 4.5 rate. */
	inputUsdPerMillion: 1,
	outputUsdPerMillion: 5,
} as const;

export const PROVIDER_LABEL: Record<UserKeyProvider, string> = {
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	google: "Google",
	xai: "xAI",
	openai: "OpenAI",
};

const BYOM_MODEL: Record<UserKeyProvider, string> = {
	anthropic: "claude-sonnet-4-5",
	openrouter: "anthropic/claude-sonnet-4-5",
	openai: "gpt-4.1-mini",
	google: "gemini-2.5-flash",
	xai: "grok-3",
};

export const CLAUDE_SETUP = [
	{
		title: "Install Claude Code",
		detail: "In a terminal, run curl -fsSL https://claude.ai/install.sh | bash. On Windows PowerShell: irm https://claude.ai/install.ps1 | iex",
	},
	{
		title: "Sign in",
		detail: "Run claude, then type /login and use the Claude subscription you already pay for.",
	},
	{
		title: "Check the connection",
		detail: "In Obsidian, open Groundwork settings and choose Check connection. The tutor uses that login on this computer.",
	},
] as const;

export const CLAUDE_SETUP_DETAIL =
	"Install Claude Code, run `claude` in a terminal and type /login with your Claude subscription, then choose Check connection in Groundwork settings.";

export const SIGN_IN_DETAIL = "Sign in on the Groundwork website, then choose Open Obsidian.";

export type UpstreamKind = "anthropic" | "openai" | "google";

export type TutorDecision =
	| { action: "hosted"; model: string; provider: "openrouter"; key: "groundwork" }
	| { action: "claude" }
	| { action: "key"; provider: UserKeyProvider; model: string; key: "user" }
	| { action: "blocked"; status: 402 | 409; error: string; setup: "plan" | "credit" | "key" };

/** What a client may see. No dollar amounts. */
export interface TutorStatus {
	action: "hosted" | "claude" | "key" | "blocked";
	via: "hosted" | "claude" | "key";
	model: string | null;
	provider: string | null;
	label: string;
	error: string | null;
	setup: "plan" | "credit" | "claude" | "key" | null;
	budgetUsed: number;
	ownModel: boolean;
	claude: typeof CLAUDE_SETUP;
}

export interface TutorCall {
	system: string;
	messages: ChatMessage[];
	tools: ProviderTool[];
	maxTokens: number;
	/** Honored for a bring-your-own key. Hosted turns always use the small model. */
	model?: string;
}

export interface UpstreamRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	kind: UpstreamKind;
}

export interface UpstreamResult {
	content: ContentBlock[];
	stopReason: string;
	usage: { input: number; output: number };
}

export function hostedCostUsd(usage: { input: number; output: number }): number {
	const cost = (usage.input * HOSTED_MODEL.inputUsdPerMillion + usage.output * HOSTED_MODEL.outputUsdPerMillion) / 1_000_000;
	return Math.round(cost * 10_000) / 10_000;
}

export function tutorDecision(view: AccountView, choice: TutorChoice, saved: Partial<Record<UserKeyProvider, boolean>>): TutorDecision {
	if (view.needsPlan || !view.plan) {
		return { action: "blocked", status: 402, error: "Choose a plan on the Groundwork website.", setup: "plan" };
	}
	if (!view.ownModel) {
		if (view.remainingUsd <= 0) {
			return { action: "blocked", status: 402, error: "This month's model budget is used up. It resets at the start of next month.", setup: "credit" };
		}
		return { action: "hosted", model: HOSTED_MODEL.id, provider: "openrouter", key: "groundwork" };
	}
	if (choice.via === "key") {
		const provider = choice.provider;
		if (!provider || !saved[provider]) {
			const which = provider ? PROVIDER_LABEL[provider] : "provider";
			return {
				action: "blocked",
				status: 409,
				error: `Paste a ${which} key on the website, or switch the tutor to your Claude subscription.`,
				setup: "key",
			};
		}
		return { action: "key", provider, model: BYOM_MODEL[provider], key: "user" };
	}
	return { action: "claude" };
}

export function tutorStatus(decision: TutorDecision, view: AccountView, choice: TutorChoice): TutorStatus {
	const budgetUsed = view.ownModel || view.creditUsd <= 0 ? 0 : Math.min(1, view.spentUsd / view.creditUsd);
	const shared = { budgetUsed, ownModel: view.ownModel, claude: CLAUDE_SETUP };
	if (decision.action === "hosted") {
		return { ...shared, action: "hosted", via: "hosted", model: decision.model, provider: "openrouter", label: HOSTED_MODEL.label, error: null, setup: null };
	}
	if (decision.action === "claude") {
		return { ...shared, action: "claude", via: "claude", model: null, provider: null, label: "Claude subscription", error: null, setup: null };
	}
	if (decision.action === "key") {
		return { ...shared, action: "key", via: "key", model: decision.model, provider: decision.provider, label: PROVIDER_LABEL[decision.provider], error: null, setup: null };
	}
	return {
		...shared,
		action: "blocked",
		via: view.ownModel ? choice.via : "hosted",
		model: null,
		provider: choice.provider,
		label: "Tutor paused",
		error: decision.error,
		setup: decision.setup,
	};
}

export function tutorRuntime(input: {
	selected: "demo" | "claude" | "anthropic";
	account: TutorStatus | null;
	signedIn: boolean;
	claudeReady: boolean;
}): { runtime: "demo" | "claude" | "proxy" | "setup"; detail: string | null; website: boolean } {
	if (!input.signedIn) return { runtime: "setup", detail: SIGN_IN_DETAIL, website: true };
	if (input.selected === "demo") return { runtime: "demo", detail: null, website: false };
	const account = input.account;
	if (!account) return { runtime: "setup", detail: "On the website, choose Open Obsidian so this device can use your account.", website: true };
	if (account.action === "hosted" || account.action === "key") return { runtime: "proxy", detail: null, website: false };
	if (account.action === "claude") {
		return input.claudeReady
			? { runtime: "claude", detail: null, website: false }
			: { runtime: "setup", detail: CLAUDE_SETUP_DETAIL, website: false };
	}
	return { runtime: "setup", detail: account.error ?? "Open the Groundwork website to finish setup.", website: true };
}

export function parseTutorCall(body: unknown): TutorCall | null {
	if (!body || typeof body !== "object") return null;
	const raw = body as { system?: unknown; messages?: unknown; tools?: unknown; maxTokens?: unknown; model?: unknown };
	if (typeof raw.system !== "string") return null;
	if (!Array.isArray(raw.messages) || raw.messages.length > 400) return null;
	if (raw.messages.some((message) => !message || typeof message !== "object" || ((message as { role?: unknown }).role !== "user" && (message as { role?: unknown }).role !== "assistant"))) return null;
	const tools = Array.isArray(raw.tools) ? raw.tools : [];
	if (tools.length > 80) return null;
	if (tools.some((tool) => !tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string")) return null;
	const requested = Number(raw.maxTokens);
	const maxTokens = Number.isFinite(requested) ? Math.min(8192, Math.max(256, Math.round(requested))) : 8192;
	const model = typeof raw.model === "string" && /^[A-Za-z0-9_.:/@-]{1,120}$/.test(raw.model) ? raw.model : undefined;
	return { system: raw.system, messages: raw.messages as ChatMessage[], tools: tools as ProviderTool[], maxTokens, model };
}

export function buildUpstream(decision: Extract<TutorDecision, { action: "hosted" | "key" }>, apiKey: string, call: TutorCall): UpstreamRequest {
	const model = decision.action === "hosted" ? HOSTED_MODEL.id : call.model || decision.model;
	const provider = decision.action === "hosted" ? "openrouter" : decision.provider;
	const kind = providerKind(provider);
	const headers: Record<string, string> = { "content-type": "application/json" };
	let url: string;
	if (provider === "anthropic") {
		url = "https://api.anthropic.com/v1/messages";
		headers["x-api-key"] = apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else if (provider === "openrouter") {
		url = "https://openrouter.ai/api/v1/messages";
		headers.authorization = `Bearer ${apiKey}`;
		headers["anthropic-version"] = "2023-06-01";
		headers["x-title"] = "Groundwork";
	} else if (provider === "openai") {
		url = "https://api.openai.com/v1/chat/completions";
		headers.authorization = `Bearer ${apiKey}`;
	} else if (provider === "xai") {
		url = "https://api.x.ai/v1/chat/completions";
		headers.authorization = `Bearer ${apiKey}`;
	} else {
		url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
		headers["x-goog-api-key"] = apiKey;
	}
	const body = kind === "anthropic" ? anthropicBody(call, model) : kind === "openai" ? openaiBody(call, model) : googleBody(call);
	return { url, headers, body, kind };
}

export function readUpstream(kind: UpstreamKind, body: unknown): { ok: true; result: UpstreamResult } | { ok: false; error: string } {
	if (!body || typeof body !== "object") return { ok: false, error: "The model provider returned nothing." };
	if (kind === "anthropic") return readAnthropic(body as AnthropicMessage);
	if (kind === "openai") return readOpenAI(body as OpenAIMessage);
	return readGoogle(body as GoogleMessage);
}

export function upstreamErrorMessage(body: unknown, secrets: string[]): string {
	let message = "The model provider refused the request.";
	if (body && typeof body === "object") {
		const record = body as { error?: { message?: unknown } | string; message?: unknown };
		if (typeof record.error === "string") message = record.error;
		else if (record.error && typeof record.error === "object" && typeof record.error.message === "string") message = record.error.message;
		else if (typeof record.message === "string") message = record.message;
	}
	return redactSecrets(message, secrets);
}

export function redactSecrets(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 4) out = out.split(secret).join("[redacted]");
	}
	return out.slice(0, 400);
}

export function providerKind(provider: UserKeyProvider | "openrouter"): UpstreamKind {
	if (provider === "openai" || provider === "xai") return "openai";
	if (provider === "google") return "google";
	return "anthropic";
}

export function providerNames(): UserKeyProvider[] {
	return [...USER_KEY_PROVIDERS];
}

function anthropicBody(call: TutorCall, model: string): unknown {
	return {
		model,
		max_tokens: call.maxTokens,
		system: call.system,
		messages: call.messages,
		tools: call.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
	};
}

function openaiBody(call: TutorCall, model: string): unknown {
	const messages: unknown[] = [{ role: "system", content: call.system }];
	for (const message of call.messages) messages.push(...openaiTurns(message));
	const body: Record<string, unknown> = { model, max_tokens: call.maxTokens, messages };
	if (call.tools.length) {
		body.tools = call.tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
		}));
	}
	return body;
}

function openaiTurns(message: ChatMessage): unknown[] {
	if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
	if (message.role === "assistant") {
		const text = message.content.filter((block) => block.type === "text").map((block) => (block as { text?: string }).text ?? "").join("");
		const calls = message.content.filter((block) => block.type === "tool_use") as Array<{ id: string; name: string; input: unknown }>;
		const turn: Record<string, unknown> = { role: "assistant", content: text || null };
		if (calls.length) {
			turn.tool_calls = calls.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
			}));
		}
		return [turn];
	}
	const out: unknown[] = [];
	const notes: string[] = [];
	for (const block of message.content) {
		if (block.type === "tool_result") {
			const result = block as { tool_use_id?: string; content?: string | ContentBlock[] };
			out.push({ role: "tool", tool_call_id: result.tool_use_id, content: flatten(result.content) });
		} else if (block.type === "text") notes.push((block as { text?: string }).text ?? "");
	}
	if (notes.length) out.push({ role: "user", content: notes.join("\n") });
	return out;
}

function googleBody(call: TutorCall): unknown {
	const names = new Map<string, string>();
	const contents: unknown[] = [];
	for (const message of call.messages) {
		const role = message.role === "assistant" ? "model" : "user";
		const parts: unknown[] = [];
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		for (const block of blocks) {
			if (block.type === "text" && (block as { text?: string }).text) parts.push({ text: (block as { text: string }).text });
			if (block.type === "tool_use") {
				const use = block as { id: string; name: string; input: unknown };
				names.set(use.id, use.name);
				parts.push({ functionCall: { name: use.name, args: use.input ?? {} } });
			}
			if (block.type === "tool_result") {
				const result = block as { tool_use_id?: string; content?: string | ContentBlock[] };
				parts.push({
					functionResponse: {
						name: names.get(result.tool_use_id ?? "") ?? "tool",
						response: { result: flatten(result.content) },
					},
				});
			}
		}
		if (parts.length) contents.push({ role, parts });
	}
	const body: Record<string, unknown> = {
		systemInstruction: { parts: [{ text: call.system }] },
		contents,
		generationConfig: { maxOutputTokens: call.maxTokens },
	};
	if (call.tools.length) {
		body.tools = [
			{
				functionDeclarations: call.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.input_schema,
				})),
			},
		];
	}
	return body;
}

function readAnthropic(body: AnthropicMessage): { ok: true; result: UpstreamResult } | { ok: false; error: string } {
	if (!Array.isArray(body.content)) return { ok: false, error: "The model provider returned no message." };
	const content = body.content.filter((block) => block && (block.type === "text" || block.type === "tool_use")) as ContentBlock[];
	return {
		ok: true,
		result: {
			content,
			stopReason: typeof body.stop_reason === "string" ? body.stop_reason : content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
			usage: { input: count(body.usage?.input_tokens), output: count(body.usage?.output_tokens) },
		},
	};
}

function readOpenAI(body: OpenAIMessage): { ok: true; result: UpstreamResult } | { ok: false; error: string } {
	const choice = body.choices?.[0];
	if (!choice?.message) return { ok: false, error: "The model provider returned no message." };
	const content: ContentBlock[] = [];
	if (typeof choice.message.content === "string" && choice.message.content) content.push({ type: "text", text: choice.message.content });
	for (const call of choice.message.tool_calls ?? []) {
		let input: unknown = {};
		try {
			input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
		} catch {
			input = {};
		}
		content.push({ type: "tool_use", id: call.id || `call_${content.length}`, name: call.function?.name || "tool", input });
	}
	const reason = choice.finish_reason;
	const stopReason = reason === "tool_calls" || content.some((block) => block.type === "tool_use") ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn";
	return {
		ok: true,
		result: {
			content,
			stopReason,
			usage: { input: count(body.usage?.prompt_tokens), output: count(body.usage?.completion_tokens) },
		},
	};
}

function readGoogle(body: GoogleMessage): { ok: true; result: UpstreamResult } | { ok: false; error: string } {
	const parts = body.candidates?.[0]?.content?.parts ?? [];
	const content: ContentBlock[] = [];
	for (const part of parts) {
		if (typeof part.text === "string" && part.text) content.push({ type: "text", text: part.text });
		if (part.functionCall?.name) {
			content.push({
				type: "tool_use",
				id: part.functionCall.id || `call_${content.length}`,
				name: part.functionCall.name,
				input: part.functionCall.args ?? {},
			});
		}
	}
	const reason = body.candidates?.[0]?.finishReason;
	const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : reason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
	return {
		ok: true,
		result: {
			content,
			stopReason,
			usage: { input: count(body.usageMetadata?.promptTokenCount), output: count(body.usageMetadata?.candidatesTokenCount) },
		},
	};
}

function flatten(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? ((block as { text?: string }).text ?? "") : JSON.stringify(block))).join("\n");
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

interface AnthropicMessage {
	content?: Array<{ type?: string }>;
	stop_reason?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
}

interface OpenAIMessage {
	choices?: Array<{
		finish_reason?: string;
		message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface GoogleMessage {
	candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: unknown } }> } }>;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
