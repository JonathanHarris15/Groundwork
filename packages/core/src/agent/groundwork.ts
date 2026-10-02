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
			fetchImpl?: typeof fetch;
		},
	) {}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const token = await this.opts.token();
		if (!token) throw new Error("Sign in on the Groundwork website, then choose Open Obsidian.");
		const fetchImpl = this.opts.fetchImpl ?? fetch;
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
			body = text ? JSON.parse(text) : {};
		} catch {
			throw new Error("The Groundwork server did not answer.");
		}
		if (!res.ok) throw new Error(body.error || "The tutor could not reach the model.");
		const content = Array.isArray(body.content) ? body.content : [];
		for (const block of content) {
			if (block.type === "text" && block.text) req.onText(block.text);
		}
		return { content, stopReason: body.stopReason || "end_turn", usage: body.usage };
	}
}
