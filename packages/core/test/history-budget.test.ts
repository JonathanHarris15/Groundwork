import { describe, expect, it } from "vitest";
import { messagesForAnthropic } from "../src/account/anthropic-messages";
import { estimateMessageTokens } from "../src/account/history-budget";
import { buildUpstream } from "../src/account/tutor";
import { AgentSession } from "../src/agent/loop";
import type { ChatMessage, ContentBlock, Provider } from "../src/agent/types";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import type { ToolDef } from "../src/tools";

const FILE = `limit definition ${"x".repeat(50_000)}`;

function blocks(message: ChatMessage): ContentBlock[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function assertSendable(messages: ChatMessage[]): void {
	expect(messages[0]?.role).toBe("user");
	expect(messages[messages.length - 1]?.role).toBe("user");
	const pending = new Set<string>();
	let previous: string | null = null;
	for (const message of messages) {
		expect(message.role).not.toBe(previous);
		previous = message.role;
		for (const block of blocks(message)) {
			expect(block.type).not.toBe("thinking");
			expect(block.type).not.toBe("redacted_thinking");
			if (block.type === "tool_use" && typeof block.id === "string") pending.add(block.id);
			if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
				expect(pending.has(block.tool_use_id)).toBe(true);
				expect(typeof block.content).toBe("string");
				if (typeof block.content === "string") expect(block.content).not.toContain('"type":"document"');
				pending.delete(block.tool_use_id);
			}
		}
		if (message.role === "user") expect(pending.size).toBe(0);
	}
}

function readTurn(index: number, body: string): ChatMessage[] {
	const path = `courses/lecture-${index}.pdf`;
	return [
		{ role: "user", content: `Read ${path}` },
		{ role: "assistant", content: [{ type: "tool_use", id: `read_${index}`, name: "read_vault_file", input: { path } }] },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: `read_${index}`, content: `Contents of ${path}:\n<file path="${path}">\n${body}\n</file>` },
				{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "A".repeat(8_000) }, title: path },
			],
		},
		{ role: "assistant", content: [{ type: "text", text: `Lecture ${index} introduces the limit.` }] },
	];
}

describe("tutor history budget", () => {
	it("keeps token size bounded after many large vault reads", () => {
		const fat = "C".repeat(8_000);
		const history: ChatMessage[] = [
			{ role: "user", content: "What concepts are saved?" },
			{ role: "assistant", content: [{ type: "tool_use", id: "concepts", name: "get_concepts", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "concepts", content: fat }] },
			{ role: "assistant", content: [{ type: "text", text: "Sixty concepts." }] },
			...Array.from({ length: 12 }, (_, index) => readTurn(index, FILE)).flat(),
		];
		const rawTokens = estimateMessageTokens(history);
		const open = messagesForAnthropic(history);
		expect(JSON.stringify(open)).toContain(FILE.slice(0, 40));

		history.push({ role: "user", content: "What should I study next?" });
		const sent = messagesForAnthropic(history);
		const sentTokens = estimateMessageTokens(sent);
		expect(rawTokens).toBeGreaterThan(100_000);
		expect(sentTokens).toBeLessThan(12_000);
		expect(sentTokens).toBeLessThan(rawTokens / 10);
		expect(JSON.stringify(sent)).not.toContain(FILE.slice(0, 40));
		expect(JSON.stringify(sent)).not.toContain(fat);
		expect(JSON.stringify(sent)).toContain("Older tool output trimmed");
		expect(JSON.stringify(sent)).not.toContain("A".repeat(200));
		expect(JSON.stringify(sent)).toContain("courses/lecture-0.pdf");
		expect(JSON.stringify(sent)).toContain("Call read_vault_file");
		assertSendable(sent);
		expect(estimateMessageTokens(messagesForAnthropic(sent))).toBe(sentTokens);

		const upstream = buildUpstream(
			{ action: "key", provider: "anthropic", model: "claude-sonnet-4-5", key: "user" },
			"sk-ant-test",
			{
				system: "Teach.",
				messages: history,
				tools: [{ name: "read_vault_file", description: "Read a vault file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
				maxTokens: 1000,
			},
		);
		const body = upstream.body as {
			system: Array<{ cache_control?: { type: string } }>;
			tools: Array<{ cache_control?: { type: string } }>;
			messages: ChatMessage[];
		};
		expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(body.tools[0]?.cache_control).toEqual({ type: "ephemeral" });
		const tail = body.messages[body.messages.length - 1];
		const tailBlocks = tail ? blocks(tail) : [];
		expect(tailBlocks[tailBlocks.length - 1]).toMatchObject({ cache_control: { type: "ephemeral" } });
		expect(estimateMessageTokens(body.messages)).toBeLessThan(12_000);
		const hosted = buildUpstream(
			{ action: "hosted", model: "google/gemini-3.8-flash", provider: "openrouter", key: "groundwork", weight: "light" },
			"sk-or-test",
			{
				system: "Teach.",
				messages: history,
				tools: [{ name: "read_vault_file", description: "Read a vault file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
				maxTokens: 1000,
			},
		);
		expect(JSON.stringify(hosted.body)).not.toContain(FILE.slice(0, 40));
	});

	it("still shows a vault read on the turn that opened it", async () => {
		const seen: string[] = [];
		let step = 0;
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				seen.push(JSON.stringify(req.messages));
				step += 1;
				if (step === 1) {
					return { content: [{ type: "tool_use", id: "read_now", name: "read_vault_file", input: { path: "courses/lecture.pdf" } }], stopReason: "tool_use" };
				}
				const text = step === 2 ? "The lecture defines a limit." : "We can leave the file and practice.";
				req.onText(text);
				return { content: [{ type: "text", text }], stopReason: "end_turn" };
			},
		};
		const tool: ToolDef = {
			name: "read_vault_file",
			description: "Read a vault file",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			async run() {
				return { text: `Contents of courses/lecture.pdf:\n<file path="courses/lecture.pdf">\n${FILE}\n</file>`, summary: "Opened lecture.pdf" };
			},
		};
		const agent = new AgentSession({
			provider,
			store: new KnowledgeStore(new MemoryVaultIO()),
			tools: [tool],
			system: "Teach.",
			session: { id: "s", title: "Limits" },
		});
		await agent.send("Read the lecture", () => undefined);
		expect(seen[1]).toContain(FILE.slice(0, 40));
		await agent.send("What should I study next?", () => undefined);
		expect(seen[2]).not.toContain(FILE.slice(0, 40));
		expect(seen[2]).toContain("Already read");
		expect(seen[2]).toContain("courses/lecture.pdf");
		expect(estimateMessageTokens(agent.messages)).toBeLessThan(4_000);
	});
});
