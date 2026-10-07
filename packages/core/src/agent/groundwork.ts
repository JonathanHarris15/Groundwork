import { httpClient, type HttpClient } from "../http";
import { asRecord } from "../unknown";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

/**
 * Tutor turns for a hosted plan, or a bring-your-own key saved on the account.
 * The key stays on the Groundwork server. This device only sends the conversation.
 */
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
		if (!token) throw new Error("Sign in on the Groundwork website, then choose Open Obsidian.");
		const fetchImpl = this.opts.fetchImpl ?? httpClient();
		const res = await fetchImpl(`${this.opts.origin.replace(/\/+$/, "")}/v1/tutor/complete`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				system: req.system,
				messages: req.messages,
				tools: req.tools,
				maxTokens: this.opts.maxTokens,
			}),
			signal: req.signal,
		});
		const text = await res.text();
		let body: { error?: string; content?: ProviderResponse["content"]; stopReason?: string; usage?: ProviderResponse["usage"] } = {};
		try {
			const parsed = text ? asRecord(JSON.parse(text)) : {};
			body = {
				error: typeof parsed?.error === "string" ? parsed.error : undefined,
				content: Array.isArray(parsed?.content) ? contentBlocks(parsed.content) : undefined,
				stopReason: typeof parsed?.stopReason === "string" ? parsed.stopReason : undefined,
				usage: usageFrom(parsed?.usage),
			};
		} catch {
			throw new Error("The Groundwork server did not answer.");
		}
		if (!res.ok) throw new Error(body.error || "The tutor could not reach the model.");
		const content = Array.isArray(body.content) ? body.content : [];
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string" && block.text) req.onText(block.text);
		}
		return { content, stopReason: body.stopReason || "end_turn", usage: body.usage };
	}
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
