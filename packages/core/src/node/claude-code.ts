import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query, type AccountInfo, type HookCallback, type ModelInfo, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { basename, fileBlocks, mcpContent, userContent, type McpContent, type VaultFile } from "../files";
import type { KnowledgeStore } from "../store";
import type { SessionInfo, ToolDef, ToolResult, ToolUI } from "../tools";
import type { AgentEvent, TutorSession } from "../agent/types";
import { errorMessage } from "../agent/loop";
import { guiPathDirs, withGuiPath } from "./env";
import { pdfLayout, type PdfLayout } from "./pdf-parts";

export type { AccountInfo, ModelInfo };

const MCP_NAME = "groundwork";
const MCP_PREFIX = `mcp__${MCP_NAME}__`;
const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** Claude Code's Read opens PDFs (split into parts by pdfLayout), which MCP tool results can't carry. Limited to the vault (cwd). */
const READ_TOOL = "Read";
const READ_RULE = "Read(./**)";
const READ_WHOLE = "Read each file whole: don't pass pages (page ranges need poppler, which may not be installed).";
const MAX_HISTORY_CHARS = 40_000;

export interface ClaudeCodeConfig {
	/** Path to the `claude` executable (Claude Code). Its login decides whose subscription is used. */
	executable: string;
	/** Working directory for Claude Code; its sessions are stored per directory, so keep it stable (the vault). */
	cwd: string;
	/** Model alias or id ("sonnet", "opus", …). Empty uses Claude Code's default. */
	model?: string;
	webSearch?: boolean;
	env?: NodeJS.ProcessEnv;
}

export interface ClaudeCodeSessionOptions extends ClaudeCodeConfig {
	store: KnowledgeStore;
	tools: ToolDef[];
	system: string;
	ui?: ToolUI;
	session: SessionInfo;
	/** Claude Code session id from an earlier run of this chat. */
	resume?: string;
	/** Earlier conversation as text, replayed when the Claude Code session can't be resumed (e.g. it started on another computer). */
	history?: string;
	onSessionId?: (id: string) => void;
}

/**
 * Environment for the Claude Code process. ANTHROPIC_API_KEY is removed so Claude Code
 * authenticates with the user's Claude subscription login instead of billing an API key.
 */
export function claudeCodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = withGuiPath(base);
	delete env.ANTHROPIC_API_KEY;
	env.CLAUDE_AGENT_SDK_CLIENT_APP = "groundwork/0.1.0";
	return env;
}

export function findClaudeExecutable(explicit?: string): string | null {
	if (explicit?.trim()) {
		const p = explicit.trim().replace(/^~(?=$|[\\/])/, os.homedir());
		return isFile(p) ? p : null;
	}
	const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
	const sep = process.platform === "win32" ? ";" : ":";
	const dirs = [...(process.env.PATH ?? "").split(sep).filter(Boolean), ...guiPathDirs()];
	for (const dir of dirs) {
		for (const name of names) {
			const p = path.join(dir, name);
			if (isFile(p)) return p;
		}
	}
	return null;
}

function isFile(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
}

export interface ClaudeCodeStatus {
	ok: boolean;
	message: string;
	version?: string;
	account?: AccountInfo;
	models?: ModelInfo[];
}

/** Starts Claude Code just long enough to read its login and model list. Uses no subscription quota. */
export async function checkClaudeCode(cfg: Pick<ClaudeCodeConfig, "executable" | "cwd" | "env">): Promise<ClaudeCodeStatus> {
	const input = new Inbox<SDKUserMessage>();
	let q: Query | null = null;
	try {
		q = query({ prompt: input, options: { ...baseOptions(cfg), tools: [] } });
		const init = await withTimeout(q.initializationResult(), 30_000, "Claude Code took too long to start.");
		const account = init.account;
		const loggedIn = !!account && account.tokenSource !== "none";
		if (!loggedIn) {
			return { ok: false, message: "Claude Code isn't signed in on this computer. Run `claude` in a terminal and type /login.", account, models: init.models };
		}
		const who = [account.email, account.subscriptionType && `Claude ${capitalize(account.subscriptionType)}`].filter(Boolean).join(" · ");
		return { ok: true, message: `Signed in${who ? ` as ${who}` : ""}.`, account, models: init.models };
	} catch (e) {
		return { ok: false, message: friendlyError(errorMessage(e)) };
	} finally {
		input.end();
		q?.close();
	}
}

function baseOptions(cfg: Pick<ClaudeCodeConfig, "executable" | "cwd" | "env">): Options {
	return {
		pathToClaudeCodeExecutable: cfg.executable,
		cwd: cfg.cwd,
		env: cfg.env ?? claudeCodeEnv(),
		// Isolate the tutor from the user's Claude Code setup: no CLAUDE.md, hooks, plugins or other MCP servers.
		settingSources: [],
		strictMcpConfig: true,
	};
}

/**
 * Runs the tutor through Claude Code, so it uses the Claude subscription Claude Code is signed in with.
 * Groundwork's tools run in this process (as an in-process MCP server), so quiz cards still block on the UI.
 * One Claude Code process stays alive per chat; it is restarted with `resume` if it exits.
 */
export class ClaudeCodeSession implements TutorSession {
	sessionId: string | undefined;
	private running = false;
	private q: Query | null = null;
	private input: Inbox<SDKUserMessage> | null = null;
	private emit: ((e: AgentEvent) => void) | null = null;
	private signal: AbortSignal | undefined;
	private history: string | undefined;

	constructor(private readonly opts: ClaudeCodeSessionOptions) {
		this.sessionId = opts.resume;
		this.history = opts.history?.trim() ? opts.history.slice(-MAX_HISTORY_CHARS) : undefined;
	}

	get busy(): boolean {
		return this.running;
	}

	async send(text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, files?: VaultFile[]): Promise<void> {
		if (this.running) throw new Error("The tutor is still responding.");
		this.running = true;
		this.emit = onEvent;
		this.signal = signal;
		const onAbort = () => this.interrupt();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			try {
				await this.turn(text, files, onEvent, signal);
			} catch (err) {
				if (!this.sessionId || !/No conversation found/i.test(errorMessage(err))) throw err;
				// The chat was started on another computer (Claude Code keeps sessions locally): start over with the transcript.
				this.teardown();
				this.sessionId = undefined;
				await this.turn(text, files, onEvent, signal);
			}
		} catch (err) {
			this.teardown();
			if (!signal?.aborted) onEvent({ type: "error", message: friendlyError(errorMessage(err)) });
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.running = false;
			this.emit = null;
			this.signal = undefined;
			onEvent({ type: "turn_end" });
		}
	}

	close(): void {
		this.teardown();
	}

	private async turn(text: string, files: VaultFile[] | undefined, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		let prompt = text;
		if (!this.q) {
			if (!this.sessionId && this.history) {
				prompt = `Here is our conversation so far, from an earlier session:\n\n<previous_conversation>\n${this.history}\n</previous_conversation>\n\nContinue from there. My new message:\n\n${text}`;
			}
			this.start();
		}
		const pointers = new Map<VaultFile, string>();
		for (const f of files ?? []) if (f.tooLarge) pointers.set(f, await this.readPointer(f));
		const content = userContent(prompt, files, (f) => (pointers.has(f) ? [{ type: "text", text: pointers.get(f)! }] : fileBlocks(f)));
		this.input!.push({ type: "user", message: { role: "user", content: content as SDKUserMessage["message"]["content"] }, parent_tool_use_id: null });

		const streamed = new Set<string>();
		const external = new Map<string, { name: string; input: any }>();
		let reported = false;
		const iter = this.q!;
		while (true) {
			const { value: msg, done } = await iter.next();
			if (done) {
				this.teardown();
				if (!signal?.aborted && !reported) throw new Error("Claude Code exited unexpectedly.");
				return;
			}
			if (msg.type === "result") {
				// After an error result the SDK refuses further reads, so the process is replaced on the next message.
				if (msg.is_error) this.teardown();
				if (msg.is_error && !signal?.aborted && !reported) {
					throw new Error((msg.subtype === "success" ? msg.result : msg.errors?.join("; ")) || "Claude Code stopped with an error.");
				}
				if (!msg.is_error) this.history = undefined;
				return;
			}
			if (this.handle(msg, onEvent, streamed, external)) reported = true;
		}
	}

	/** Returns true when it reported an error to the UI. */
	private handle(msg: SDKMessage, onEvent: (e: AgentEvent) => void, streamed: Set<string>, external: Map<string, { name: string; input: any }>): boolean {
		if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return false;
		switch (msg.type) {
			case "system":
				if (msg.subtype === "init" && msg.session_id && msg.session_id !== this.sessionId) {
					this.sessionId = msg.session_id;
					this.opts.onSessionId?.(msg.session_id);
				}
				return false;
			case "stream_event": {
				const ev = msg.event;
				if (ev.type === "message_start") streamed.add(ev.message.id);
				else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") onEvent({ type: "text_delta", text: ev.delta.text });
				return false;
			}
			case "assistant": {
				if (msg.error) {
					const text = msg.message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
					onEvent({ type: "error", message: friendlyError(text || msg.error, msg.error) });
					return true;
				}
				const wasStreamed = streamed.has(msg.message.id);
				for (const block of msg.message.content) {
					if (block.type === "text" && !wasStreamed) onEvent({ type: "text_delta", text: block.text });
					if (block.type === "tool_use" && !block.name.startsWith(MCP_PREFIX)) {
						external.set(block.id, { name: block.name, input: block.input });
						onEvent({ type: "tool_start", id: block.id, name: block.name, input: block.input });
					}
				}
				return false;
			}
			case "user": {
				const content = msg.message.content;
				if (!Array.isArray(content)) return false;
				for (const block of content) {
					if (block.type !== "tool_result" || !external.has(block.tool_use_id)) continue;
					const { name, input } = external.get(block.tool_use_id)!;
					external.delete(block.tool_use_id);
					const isError = !!block.is_error;
					const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
					onEvent({ type: "tool_end", id: block.tool_use_id, name, isError, text, summary: externalSummary(name, input) });
				}
				return false;
			}
			default:
				return false;
		}
	}

	private start(): void {
		const toolNames = this.opts.tools.map((t) => `${MCP_PREFIX}${t.name}`);
		const web = this.opts.webSearch ? WEB_TOOLS : [];
		this.input = new Inbox<SDKUserMessage>();
		this.q = query({
			prompt: this.input,
			options: {
				...baseOptions(this.opts),
				systemPrompt: this.opts.system,
				model: this.opts.model || undefined,
				tools: [READ_TOOL, ...web],
				allowedTools: [...toolNames, READ_RULE, ...web],
				permissionMode: "dontAsk",
				includePartialMessages: true,
				hooks: { PreToolUse: [{ matcher: READ_TOOL, hooks: [this.guardPdfRead] }] },
				resume: this.sessionId,
				mcpServers: { [MCP_NAME]: { type: "sdk", name: MCP_NAME, instance: this.toolServer() as unknown as McpServer } },
			},
		});
	}

	private toolServer(): Server {
		const server = new Server({ name: MCP_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
		const tools = this.opts.tools;
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any })),
		}));
		let n = 0;
		server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
			const { name } = req.params;
			const input = req.params.arguments ?? {};
			const id = String(req.params._meta?.["claudecode/toolUseId"] ?? `gw_${++n}`);
			const emit = this.emit;
			const tool = tools.find((t) => t.name === name);
			emit?.({ type: "tool_start", id, name, input });
			let result: ToolResult;
			try {
				if (!tool) throw new Error(`Unknown tool ${name}`);
				result = await tool.run(input, { store: this.opts.store, ui: this.opts.ui, session: this.opts.session, signal: this.signal ?? extra.signal });
			} catch (err) {
				result = { text: `Error: ${errorMessage(err)}`, isError: true };
			}
			const pointers = new Map<VaultFile, string>();
			for (const f of result.files ?? []) if (f.kind === "pdf" || (f.kind === "image" && f.tooLarge)) pointers.set(f, await this.readPointer(f));
			const pointed = [...pointers.keys()].map((f) => basename(f.path));
			const content = mcpContent(result.text, result.files, (f): McpContent[] | undefined => (pointers.has(f) ? [{ type: "text", text: pointers.get(f)! }] : undefined));
			const summary = pointed.length && pointed.length === result.files?.length ? `Found ${pointed.join(", ")}` : result.summary;
			emit?.({ type: "tool_end", id, name, summary, isError: !!result.isError, text: result.text });
			return { content, isError: !!result.isError };
		});
		return server;
	}

	private async readPointer(f: VaultFile): Promise<string> {
		if (f.kind !== "pdf") return `${f.path} is ${f.kind === "image" ? "an image" : "a file"}. Open it with the ${READ_TOOL} tool: file_path "${this.abs(f.path)}".`;
		const layout = await pdfLayout(this.opts.cwd, f.path).catch(() => null);
		if (!layout) return `${f.path} is a PDF. Open it with the ${READ_TOOL} tool: file_path "${this.abs(f.path)}". If it is too long to read whole, pass pages (e.g. "1-10") and read it in parts.`;
		if (layout.parts.length === 1 && layout.parts[0].path === f.path) {
			return `${f.path} is a PDF (${plural(layout.pages, "page")}). Open it with the ${READ_TOOL} tool: file_path "${this.abs(f.path)}". ${READ_WHOLE}`;
		}
		return this.partsPointer(f.path, layout);
	}

	private abs(rel: string): string {
		return path.join(this.opts.cwd, ...rel.split("/"));
	}

	private partsPointer(rel: string, layout: PdfLayout): string {
		const abs = (p: string) => this.abs(p);
		const lines = layout.parts.map((p) => {
			const pages = p.first === p.last ? `page ${p.first}` : `pages ${p.first}-${p.last}`;
			return p.bytes ? `- ${pages}: too large to open (${(p.bytes / 1024 / 1024).toFixed(1)} MB); ask the learner for a screenshot or the text` : `- ${pages}: file_path "${abs(p.path)}"`;
		});
		return [
			`${rel} is a PDF of ${plural(layout.pages, "page")}, too long to open in one go, so it has been split into parts. Open them with the ${READ_TOOL} tool. ${READ_WHOLE} Start with the first part to learn how it is organized, then read the parts you need.`,
			...lines,
		].join("\n");
	}

	/** A vault PDF too long or large for Read to open whole is turned away with its split parts instead of failing. */
	private guardPdfRead: HookCallback = async (input) => {
		if (input.hook_event_name !== "PreToolUse") return {};
		const args = input.tool_input as { file_path?: unknown; pages?: unknown } | undefined;
		if (typeof args?.file_path !== "string" || args.pages !== undefined || !/\.pdf$/i.test(args.file_path)) return {};
		const rel = path.relative(this.opts.cwd, path.resolve(this.opts.cwd, args.file_path));
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return {};
		const vaultPath = rel.split(path.sep).join("/");
		const layout = await pdfLayout(this.opts.cwd, vaultPath).catch(() => null);
		if (!layout || (layout.parts.length === 1 && layout.parts[0].path === vaultPath)) return {};
		return {
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: this.partsPointer(vaultPath, layout) },
		};
	};

	private interrupt(): void {
		const q = this.q;
		if (!q) return;
		q.interrupt().catch(() => this.teardown());
		// If Claude Code doesn't wind the turn down promptly, drop the process; the next message resumes the session.
		setTimeout(() => {
			if (this.running && this.q === q) this.teardown();
		}, 5_000);
	}

	private teardown(): void {
		const q = this.q;
		this.q = null;
		this.input?.end();
		this.input = null;
		try {
			q?.close();
		} catch {
			// already closed
		}
	}
}

function externalSummary(name: string, input: any): string {
	if (name === "WebSearch") return "Searched the web";
	if (name === "WebFetch") return "Read a web page";
	if (name === READ_TOOL && typeof input?.file_path === "string") return `Opened ${basename(input.file_path.replace(/\\/g, "/"))}`;
	return name;
}

/** Turns Claude Code's terse errors into something the learner can act on. */
export function friendlyError(text: string, code?: string): string {
	if (code === "authentication_failed" || /not logged in|please run \/login|invalid api key|oauth token/i.test(text)) {
		return "Claude Code isn't signed in on this computer. Open a terminal, run `claude`, and type /login to sign in with your Claude subscription. Then send your message again.";
	}
	if (code === "rate_limit" || /usage limit|rate limit|limit reached/i.test(text)) {
		return `You've reached your Claude plan's usage limit (${text}).`;
	}
	if (/ENOENT|spawn .* ENOENT|not found at/i.test(text)) {
		return "Couldn't start Claude Code. Install it (https://claude.com/claude-code) or set its path in Settings → Groundwork.";
	}
	return text;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function capitalize(s: string): string {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(message)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

/** A push-driven async iterable, used as Claude Code's streaming input. */
class Inbox<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiting: ((r: IteratorResult<T>) => void) | null = null;
	private ended = false;

	push(item: T): void {
		if (this.ended) return;
		if (this.waiting) {
			const w = this.waiting;
			this.waiting = null;
			w({ value: item, done: false });
		} else this.items.push(item);
	}

	end(): void {
		this.ended = true;
		this.waiting?.({ value: undefined as never, done: true });
		this.waiting = null;
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
				if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => (this.waiting = resolve));
			},
		};
	}
}
