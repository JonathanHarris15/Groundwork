import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/types";
import { loadVaultFile } from "../src/files";
import { MemoryVaultIO } from "../src/io";
import { NodeVaultIO } from "../src/node/fs-io";
import { checkClaudeCode, claudeCodeEnv, ClaudeCodeSession, findClaudeExecutable, friendlyError } from "../src/node/claude-code";
import { KnowledgeStore } from "../src/store";
import { TOOLS, type ToolUI } from "../src/tools";
import { startMockAnthropic, toolResults, type MockBlock, type MockRequest } from "./fixtures/mock-anthropic";

/** The Claude Code binary the SDK installs for this platform; tests drive it against a mock Messages API. */
function bundledClaude(): string | null {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
		const bin = path.join(path.dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
		return existsSync(bin) ? bin : null;
	} catch {
		return null;
	}
}

const exe = bundledClaude();

function lastUserText(req: MockRequest): string {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		if (text && !m.content.some((b: any) => b.type === "tool_result")) return text;
	}
	return "";
}

function tutor(req: MockRequest): MockBlock[] {
	const said = lastUserText(req);
	if (/thanks/i.test(said)) return [{ type: "text", text: "Any time — see you at the next review." }];
	if (/where were we/i.test(said)) return [{ type: "text", text: said.includes("<previous_conversation>") ? "We were on slope (from the transcript)." : "We were on slope." }];
	const results = toolResults(req);
	switch (results.length) {
		case 0:
			return [{ type: "text", text: "Checking your vault. " }, { type: "tool_use", name: "mcp__groundwork__get_learner_overview", input: {} }];
		case 1:
			return [
				{
					type: "tool_use",
					name: "mcp__groundwork__set_goal",
					input: {
						title: "Understand slope",
						objective: "Compute the slope of a line from two points.",
						target: "Slope of a line",
						nodes: [{ title: "Slope of a line", summary: "Rise over run." }],
					},
				},
			];
		case 2:
			return [
				{ type: "text", text: "Quick check on $m$:" },
				{
					type: "tool_use",
					name: "mcp__groundwork__quiz",
					input: {
						concept: "Slope of a line",
						question: "A line passes through $(1, 2)$ and $(3, 8)$. What is its slope?",
						options: [
							{ label: "$3$", value: "three" },
							{ label: "$6$", value: "six", misconception: "Uses the rise alone" },
						],
						correctAnswer: "three",
						explanation: "$\\frac{8-2}{3-1} = 3$.",
						difficulty: 2,
						kind: "probe",
					},
				},
			];
		default:
			return [{ type: "text", text: `Recorded. ${/CORRECTLY/.test(results.at(-1) ?? "") ? "Nice work." : "Let's revisit."}` }];
	}
}

describe.skipIf(!exe)("ClaudeCodeSession against the real Claude Code binary", () => {
	let mock: Awaited<ReturnType<typeof startMockAnthropic>>;
	let env: NodeJS.ProcessEnv;
	let cwd: string;

	beforeAll(async () => {
		mock = await startMockAnthropic(tutor);
		const home = mkdtempSync(path.join(os.tmpdir(), "gw-claude-home-"));
		cwd = mkdtempSync(path.join(os.tmpdir(), "gw-claude-vault-"));
		env = {
			...claudeCodeEnv({ ...process.env, ANTHROPIC_API_KEY: "must-be-stripped" }),
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			ANTHROPIC_BASE_URL: mock.url,
			ANTHROPIC_AUTH_TOKEN: "mock-token",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		};
	});
	afterAll(async () => {
		await mock?.close();
	});

	function setup() {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		const quizzes: string[] = [];
		const ui: ToolUI = {
			async quiz(q) {
				quizzes.push(q.question);
				return { dontKnow: false, selected: [q.correct[0]] };
			},
			async ask() {
				return { selected: [], text: "ok" };
			},
		};
		return { io, store, ui, quizzes };
	}

	it("strips the API key so Claude Code uses its own login", () => {
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("runs tools in-process, streams text, blocks on the quiz UI and keeps one process across turns", async () => {
		const { io, store, ui, quizzes } = setup();
		await store.ensureLayout();
		const ids: string[] = [];
		const session = new ClaudeCodeSession({
			executable: exe!,
			cwd,
			env,
			store,
			tools: TOOLS,
			system: "You are the Groundwork tutor.",
			ui,
			session: { id: "s1", notePath: "sessions/s1.md" },
			onSessionId: (id) => ids.push(id),
		});
		const events: AgentEvent[] = [];
		await session.send("Teach me slope", (e) => events.push(e));

		const errors = events.filter((e) => e.type === "error");
		expect(errors).toEqual([]);
		const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
		expect(text).toContain("Checking your vault.");
		expect(text).toContain("Recorded. Nice work.");
		const started = events.flatMap((e) => (e.type === "tool_start" ? [e.name] : []));
		expect(started).toEqual(["get_learner_overview", "set_goal", "quiz"]);
		const ended = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
		expect(ended.map((e) => e.name)).toEqual(started);
		expect(ended.every((e) => !e.isError)).toBe(true);
		expect(events.at(-1)).toEqual({ type: "turn_end" });

		expect(quizzes).toEqual(["A line passes through $(1, 2)$ and $(3, 8)$. What is its slope?"]);
		expect(await io.exists("goals/Understand slope.md")).toBe(true);
		expect((await store.resolve("Slope of a line"))!.stats.attempts).toBe(1);

		const toolNames = mock.requests.at(-1)!.tools.map((t) => t.name);
		expect(toolNames).toContain("mcp__groundwork__quiz");
		expect(toolNames.filter((n) => !n.startsWith("mcp__groundwork__"))).toEqual(["Read"]);
		expect(JSON.stringify(mock.requests.at(-1)!.system)).toContain("You are the Groundwork tutor.");

		expect(ids).toHaveLength(1);
		expect(session.sessionId).toBe(ids[0]);

		const second: AgentEvent[] = [];
		await session.send("thanks!", (e) => second.push(e));
		expect(second.filter((e) => e.type === "error")).toEqual([]);
		expect(second.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toContain("Any time");
		expect(ids).toHaveLength(1);
		session.close();

		const resumed = new ClaudeCodeSession({ executable: exe!, cwd, env, store, tools: TOOLS, system: "x", ui, session: { id: "s1" }, resume: ids[0] });
		const third: AgentEvent[] = [];
		await resumed.send("where were we?", (e) => third.push(e));
		expect(third.filter((e) => e.type === "error")).toEqual([]);
		expect(third.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toBe("We were on slope.");
		expect(JSON.stringify(mock.requests.at(-1)!.messages)).toContain("Teach me slope");
		resumed.close();
	}, 90_000);

	it("stops cleanly while a quiz is open and carries on afterwards", async () => {
		const { store } = setup();
		await store.ensureLayout();
		const abort = new AbortController();
		const ui: ToolUI = {
			quiz: () =>
				new Promise((resolve) => {
					setTimeout(() => abort.abort(), 200);
					abort.signal.addEventListener("abort", () => resolve(null));
				}),
			async ask() {
				return null;
			},
		};
		const session = new ClaudeCodeSession({ executable: exe!, cwd, env, store, tools: TOOLS, system: "x", ui, session: { id: "s4" } });
		const events: AgentEvent[] = [];
		const started = Date.now();
		await session.send("Teach me slope", (e) => events.push(e), abort.signal);
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(events.filter((e) => e.type === "error")).toEqual([]);
		expect(events.at(-1)).toEqual({ type: "turn_end" });
		expect(session.busy).toBe(false);

		const next: AgentEvent[] = [];
		await session.send("thanks", (e) => next.push(e));
		expect(next.filter((e) => e.type === "error")).toEqual([]);
		expect(next.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toContain("Any time");
		session.close();
	}, 60_000);

	it("falls back to the transcript when the session only exists on another computer", async () => {
		const { store, ui } = setup();
		const session = new ClaudeCodeSession({
			executable: exe!,
			cwd,
			env,
			store,
			tools: TOOLS,
			system: "x",
			ui,
			session: { id: "s2" },
			resume: "3f0c3a8e-1111-4222-8333-944455556666",
			history: "> You: Teach me slope\n\nSlope is rise over run.",
		});
		const events: AgentEvent[] = [];
		await session.send("where were we?", (e) => events.push(e));
		expect(events.filter((e) => e.type === "error")).toEqual([]);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toBe("We were on slope (from the transcript).");
		expect(lastUserText(mock.requests.at(-1)!)).toContain("Slope is rise over run.");
		expect(session.sessionId).not.toBe("3f0c3a8e-1111-4222-8333-944455556666");
		session.close();
	}, 60_000);

	it("sends attached files and opens vault PDFs with Read, but nothing outside the vault", async () => {
		const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
		const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
		const vaultDir = mkdtempSync(path.join(os.tmpdir(), "gw-claude-files-"));
		mkdirSync(path.join(vaultDir, "resources"));
		writeFileSync(path.join(vaultDir, "resources", "diagram.png"), PNG);
		writeFileSync(path.join(vaultDir, "resources", "Lecture 3.pdf"), PDF);
		const store = new KnowledgeStore(new NodeVaultIO(vaultDir));
		const files = await startMockAnthropic((req) => {
			const results = toolResults(req);
			if (results.length === 0) return [{ type: "tool_use", name: "mcp__groundwork__read_vault_file", input: { path: "Lecture 3.pdf" } }];
			if (results.length === 1) {
				const file = /file_path "([^"]+)"/.exec(results[0])?.[1] ?? "missing";
				return [
					{ type: "tool_use", name: "Read", input: { file_path: file } },
					{ type: "tool_use", name: "Read", input: { file_path: "/etc/hostname" } },
				];
			}
			return [{ type: "text", text: "It's a lecture." }];
		});
		const session = new ClaudeCodeSession({ executable: exe!, cwd: vaultDir, env: { ...env, ANTHROPIC_BASE_URL: files.url }, store, tools: TOOLS, system: "x", session: { id: "s5" } });
		const attached = await Promise.all(["resources/diagram.png", "resources/Lecture 3.pdf"].map((p) => loadVaultFile(store.io, p)));
		const events: AgentEvent[] = [];
		await session.send("What's in these?", (e) => events.push(e), undefined, attached);
		session.close();
		await files.close();

		expect(events.filter((e) => e.type === "error")).toEqual([]);
		const first = files.requests.find((r) => r.messages.length)!.messages[0].content as any[];
		expect(first.map((b) => b.type).slice(0, 5)).toEqual(["text", "image", "text", "document", "text"]);
		expect(first[4].text).toContain("What's in these?");

		const last = files.requests.at(-1)!.messages;
		const results = last.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : []));
		expect(JSON.stringify(results[0].content)).toContain("Open it with the Read tool");
		const blocks = results.flatMap((r: any) => (Array.isArray(r.content) ? r.content : []));
		expect(blocks.some((b: any) => b.type === "document" && b.source.data === PDF.toString("base64"))).toBe(true);
		expect(results.some((r: any) => r.is_error && /denied/.test(JSON.stringify(r.content)))).toBe(true);

		const ends = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
		expect(ends.map((e) => e.summary)).toContain("Opened Lecture 3.pdf");
	}, 60_000);

	it("reports a missing login in plain language", async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "gw-claude-nologin-"));
		const bare = claudeCodeEnv({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") });
		delete bare.ANTHROPIC_AUTH_TOKEN;
		delete bare.ANTHROPIC_BASE_URL;

		const status = await checkClaudeCode({ executable: exe!, cwd, env: bare });
		expect(status.ok).toBe(false);
		expect(status.message).toMatch(/isn't signed in/);
		expect(status.models?.length).toBeGreaterThan(0);

		const { store, ui } = setup();
		const session = new ClaudeCodeSession({ executable: exe!, cwd, env: bare, store, tools: TOOLS, system: "x", ui, session: { id: "s3" } });
		const events: AgentEvent[] = [];
		await session.send("hi", (e) => events.push(e));
		const errors = events.flatMap((e) => (e.type === "error" ? [e.message] : []));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/run `claude`, and type \/login/);
		session.close();
	}, 60_000);

	it("reports a signed-in account", async () => {
		const status = await checkClaudeCode({ executable: exe!, cwd, env });
		expect(status.ok).toBe(true);
		expect(status.message).toMatch(/^Signed in/);
	}, 60_000);
});

describe("Claude Code helpers", () => {
	it("finds an explicit executable and rejects a missing one", () => {
		expect(findClaudeExecutable(process.execPath)).toBe(process.execPath);
		expect(findClaudeExecutable("/definitely/not/here/claude")).toBeNull();
	});

	it("explains common failures", () => {
		expect(friendlyError("Not logged in · Please run /login")).toMatch(/type \/login/);
		expect(friendlyError("spawn /usr/bin/claude ENOENT")).toMatch(/Install it/);
		expect(friendlyError("something else")).toBe("something else");
	});
});
