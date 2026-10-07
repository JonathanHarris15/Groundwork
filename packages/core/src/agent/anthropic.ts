import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Provider, ProviderRequest, ProviderResponse } from "./types";

export interface AnthropicOptions {
	apiKey: string;
	model: string;
	maxTokens?: number;
	/** Adds Anthropic's server-side web search so the tutor can verify facts. */
	webSearch?: boolean;
	baseURL?: string;
}

export class AnthropicProvider implements Provider {
	readonly name = "anthropic";
	private readonly client: Anthropic;

	constructor(private readonly opts: AnthropicOptions) {
		this.client = new Anthropic({
			apiKey: opts.apiKey,
			baseURL: opts.baseURL,
			// Obsidian runs in an Electron renderer; the key never leaves this device except to Anthropic.
			dangerouslyAllowBrowser: true,
		});
	}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const tools = req.tools.map((t, i) => ({
			name: t.name,
			description: t.description,
			input_schema: t.input_schema,
			...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
		})) as Anthropic.ToolUnion[];
		if (this.opts.webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });

		const stream = this.client.messages.stream(
			{
				model: this.opts.model,
				max_tokens: this.opts.maxTokens ?? 8192,
				system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
				messages: req.messages as unknown as Anthropic.MessageParam[],
				tools,
			},
			{ signal: req.signal },
		);
		stream.on("text", (delta) => req.onText(delta));
		const msg = await stream.finalMessage();
		return {
			content: msg.content as unknown as ContentBlock[],
			stopReason: msg.stop_reason ?? "end_turn",
			usage: {
				input: msg.usage.input_tokens,
				output: msg.usage.output_tokens,
				cacheRead: msg.usage.cache_read_input_tokens ?? undefined,
			},
		};
	}
}

export async function listAnthropicModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
	const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
	const out: Array<{ id: string; name: string }> = [];
	for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name });
	return out;
}
