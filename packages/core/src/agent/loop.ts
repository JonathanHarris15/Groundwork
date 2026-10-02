import type { FolderAccess } from "../access";
import { fileBlocks, userContent, type VaultFile } from "../files";
import type { KnowledgeStore } from "../store";
import type { SessionInfo, ToolDef, ToolUI } from "../tools";
import type { AgentEvent, ChatMessage, ContentBlock, Provider, TutorSession } from "./types";

export interface AgentOptions {
	provider: Provider;
	store: KnowledgeStore;
	tools: ToolDef[];
	system: string;
	ui?: ToolUI;
	session: SessionInfo;
	messages?: ChatMessage[];
	maxSteps?: number;
	/** Read and write folders for vault file tools. Omitted uses the defaults. */
	access?: FolderAccess;
}

export class AgentSession implements TutorSession {
	readonly messages: ChatMessage[];
	private running = false;

	constructor(private readonly opts: AgentOptions) {
		this.messages = opts.messages ? [...opts.messages] : [];
	}

	get session(): SessionInfo {
		return this.opts.session;
	}

	get busy(): boolean {
		return this.running;
	}

	async send(text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, files?: VaultFile[]): Promise<void> {
		if (this.running) throw new Error("The tutor is still responding.");
		this.running = true;
		this.messages.push({ role: "user", content: userContent(text, files) });
		try {
			await this.run(onEvent, signal);
		} catch (err) {
			if (signal?.aborted) {
				this.repairAfterAbort();
			} else {
				this.repairAfterAbort();
				onEvent({ type: "error", message: errorMessage(err) });
			}
		} finally {
			this.running = false;
			onEvent({ type: "turn_end" });
		}
	}

	private async run(onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
		const maxSteps = this.opts.maxSteps ?? 40;
		const tools = this.opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
		for (let step = 0; step < maxSteps; step++) {
			if (signal?.aborted) return;
			const res = await this.opts.provider.complete({
				system: this.opts.system,
				messages: this.messages,
				tools,
				signal,
				onText: (d) => onEvent({ type: "text_delta", text: d }),
			});
			this.messages.push({ role: "assistant", content: res.content });
			if (res.stopReason === "pause_turn") continue;

			const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
			if (!uses.length) return;

			const results: ContentBlock[] = [];
			for (const use of uses) {
				if (signal?.aborted) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "Cancelled by the learner.", is_error: true });
					continue;
				}
				onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });
				const tool = this.opts.tools.find((t) => t.name === use.name);
				let text: string;
				let isError = false;
				let summary: string | undefined;
				let files: VaultFile[] | undefined;
				try {
					if (!tool) throw new Error(`Unknown tool ${use.name}`);
					const r = await tool.run(use.input ?? {}, {
						store: this.opts.store,
						ui: this.opts.ui,
						session: this.opts.session,
						signal,
						access: this.opts.access,
					});
					text = r.text;
					isError = !!r.isError;
					summary = r.summary;
					files = r.files;
				} catch (err) {
					text = `Error: ${errorMessage(err)}`;
					isError = true;
				}
				onEvent({ type: "tool_end", id: use.id, name: use.name, summary, isError, text });
				const content = files?.length ? [{ type: "text", text }, ...files.flatMap(fileBlocks)] : text;
				results.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
			}
			this.messages.push({ role: "user", content: results });
		}
		onEvent({ type: "error", message: `Stopped after ${maxSteps} steps without finishing.` });
	}

	/** Keep history valid for the API: every tool_use needs a tool_result, and turns must alternate. */
	private repairAfterAbort(): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content)) {
			const uses = last.content.filter((b) => b.type === "tool_use") as Array<{ id: string }>;
			if (uses.length) {
				this.messages.push({
					role: "user",
					content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Cancelled by the learner.", is_error: true })),
				});
			}
		}
		const tail = this.messages[this.messages.length - 1];
		if (tail?.role === "user") {
			this.messages.push({ role: "assistant", content: [{ type: "text", text: "(stopped)" }] });
		}
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
