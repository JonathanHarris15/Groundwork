import { usageFeatureFromThread } from "../account/usage-feature";
import { httpClient, type HttpClient, type HttpInit, type HttpResponse } from "../http";
import { asRecord } from "../unknown";
import { pushTutorSse, type TutorWireEvent } from "./tutor-events";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

/**
 * Tutor turns for a hosted plan, or a bring-your-own key saved on the account.
 * The key stays on the Groundwork server. This device only sends the conversation.
 */
export class TutorHttpError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "TutorHttpError";
		this.status = status;
		this.code = code;
	}
}

export class GroundworkProvider implements Provider {
	readonly name = "groundwork";

	constructor(
		private readonly opts: {
			origin: string;
			token: () => Promise<string | null>;
			maxTokens?: number;
			fetchImpl?: HttpClient;
		},
	) {}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const token = await this.opts.token();
		if (!token) throw new Error("Sign in on the Groundwork website, then choose Connect Groundwork.");
		const fetchImpl = this.opts.fetchImpl ?? ((url, init) => streamingHttp(url, init, httpClient()));
		const res = await fetchImpl(`${this.opts.origin.replace(/\/+$/, "")}/v1/tutor/complete`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				system: req.system,
				messages: req.messages,
				tools: req.tools,
				maxTokens: this.opts.maxTokens,
				feature: usageFeatureFromThread(req.messages),
				stream: true,
			}),
			signal: req.signal,
		});
		const type = res.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) return readTutorStream(res, req.onText);
		return readTutorJson(res, req.onText);
	}
}

/** Prefer a streaming fetch. Fall back only when the connection itself fails, so a 4xx is not sent twice. */
export async function streamingHttp(url: string, init: HttpInit = {}, fallback?: HttpClient): Promise<HttpResponse> {
	const fetchFn = typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
	if (typeof fetchFn !== "function") {
		if (!fallback) throw new Error("No HTTP client.");
		return fallback(url, init);
	}
	try {
		const res = await fetchFn(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
		return adaptFetch(res);
	} catch (err) {
		if (init.signal?.aborted || !fallback) throw err instanceof Error ? err : new Error("The request failed.");
		return fallback(url, init);
	}
}

function adaptFetch(res: Response): HttpResponse {
	return {
		ok: res.ok,
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
		text: () => res.text(),
		json: () => res.json(),
		arrayBuffer: () => res.arrayBuffer(),
		body: res.body,
	};
}

async function readTutorStream(res: HttpResponse, onText: (delta: string) => void): Promise<ProviderResponse> {
	let buffer = "";
	const found: { done: Extract<TutorWireEvent, { type: "done" }> | null; error: Extract<TutorWireEvent, { type: "error" }> | null } = { done: null, error: null };
	const take = (chunk: string) => {
		const parsed = pushTutorSse(buffer, chunk);
		buffer = parsed.buffer;
		for (const event of parsed.events) {
			if (event.type === "text" && event.text) onText(event.text);
			else if (event.type === "done") found.done = event;
			else if (event.type === "error") found.error = event;
		}
	};
	if (res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.value) take(decoder.decode(next.value, { stream: !next.done }));
			if (next.done) break;
		}
		take(decoder.decode());
	} else {
		take(await res.text());
	}
	if (buffer.trim()) take("\n\n");
	if (found.error) throw new TutorHttpError(found.error.error || "The tutor could not reach the model.", found.error.status || res.status, found.error.code);
	if (!res.ok && !found.done) throw new TutorHttpError("The tutor could not reach the model.", res.status);
	if (!found.done) throw new Error("The tutor stream ended before the reply finished.");
	return { content: contentBlocks(found.done.content), stopReason: found.done.stopReason || "end_turn", usage: usageFrom(found.done.usage) };
}

async function readTutorJson(res: HttpResponse, onText: (delta: string) => void): Promise<ProviderResponse> {
	const text = await res.text();
	let body: { error?: string; code?: string; content?: ProviderResponse["content"]; stopReason?: string; usage?: ProviderResponse["usage"] } = {};
	try {
		const parsed = text ? asRecord(JSON.parse(text)) : {};
		body = {
			error: typeof parsed?.error === "string" ? parsed.error : undefined,
			code: typeof parsed?.code === "string" ? parsed.code : undefined,
			content: Array.isArray(parsed?.content) ? contentBlocks(parsed.content) : undefined,
			stopReason: typeof parsed?.stopReason === "string" ? parsed.stopReason : undefined,
			usage: usageFrom(parsed?.usage),
		};
	} catch {
		throw new Error("The Groundwork server did not answer.");
	}
	if (!res.ok) throw new TutorHttpError(body.error || "The tutor could not reach the model.", res.status, body.code);
	const content = Array.isArray(body.content) ? body.content : [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text) onText(block.text);
	}
	return { content, stopReason: body.stopReason || "end_turn", usage: body.usage };
}

function contentBlocks(value: unknown): ProviderResponse["content"] {
	if (!Array.isArray(value)) return [];
	const out: ProviderResponse["content"] = [];
	for (const item of value) {
		const block = asRecord(item);
		if (!block || typeof block.type !== "string") continue;
		out.push(block as ProviderResponse["content"][number]);
	}
	return out;
}

function usageFrom(value: unknown): ProviderResponse["usage"] {
	const row = asRecord(value);
	if (!row || typeof row.input !== "number" || typeof row.output !== "number") return undefined;
	return { input: row.input, output: row.output, cacheRead: typeof row.cacheRead === "number" ? row.cacheRead : undefined };
}
