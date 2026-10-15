import { describe, expect, it } from "vitest";
import { normalizeAnthropicMessages, plainTutorError, TUTOR_SEND_RETRY } from "../src/account/anthropic-messages";
import { buildUpstream, upstreamErrorMessage } from "../src/account/tutor";
import { AgentSession } from "../src/agent/loop";
import type { AgentEvent, ChatMessage, ContentBlock, Provider } from "../src/agent/types";
import { MemoryVaultIO } from "../src/io";
import { asksToResumeConversation, resumePrompt } from "../src/resume";
import { KnowledgeStore } from "../src/store";
import type { ToolDef } from "../src/tools";

const PICK_UP = "Pick up on the conversation about this homework that we were just having";

const memory = JSON.stringify({
	conceptCount: 60,
	activeGoals: ["DAEN 429 Homework 3 Concepts", "Exam readiness"],
	dueReviews: Array.from({ length: 10 }, (_, i) => `Concept ${i + 1}`),
});

function blocks(message: ChatMessage): ContentBlock[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** What the Messages API accepts: alternating roles, a user at each end, no empty text, every tool call paired. */
function assertSendable(messages: ChatMessage[]): void {
	expect(messages.length).toBeGreaterThan(0);
	expect(messages[0]?.role).toBe("user");
	expect(messages[messages.length - 1]?.role).toBe("user");
	const pending = new Set<string>();
	let previous: string | null = null;
	for (const message of messages) {
		expect(message.role).not.toBe(previous);
		previous = message.role;
		const content = blocks(message);
		expect(content.length).toBeGreaterThan(0);
		for (const block of content) {
			if (block.type === "text") expect(typeof block.text === "string" && block.text.trim()).not.toBe("");
			if (block.type === "thinking") {
				expect(String(block.thinking ?? "").trim()).not.toBe("");
				expect(String(block.signature ?? "").trim()).not.toBe("");
			}
			if (block.type === "tool_use") {
				const id = typeof block.id === "string" ? block.id : "";
				expect(id).toBeTruthy();
				expect(block.input && typeof block.input === "object" && !Array.isArray(block.input)).toBe(true);
				pending.add(id);
			}
			if (block.type === "tool_result") {
				const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
				expect(pending.has(id)).toBe(true);
				pending.delete(id);
			}
		}
		if (message.role === "user") expect(pending.size).toBe(0);
	}
	expect(pending.size).toBe(0);
}

describe("Anthropic message history", () => {
	it("keeps a homework resume that loaded memory sendable", () => {
		const history: ChatMessage[] = [
			{ role: "user", content: PICK_UP },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "" },
					{ type: "thinking", thinking: "", signature: "" },
					{ type: "tool_use", id: "toolu_mem", name: "get_learner_overview", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mem", content: memory }] },
		];
		const normalized = normalizeAnthropicMessages(history);
		assertSendable(normalized);
		expect(JSON.stringify(normalized)).toContain("DAEN 429 Homework 3 Concepts");
		expect(JSON.stringify(normalized)).toContain("60");
		expect(JSON.stringify(normalized)).not.toContain('"text":""');
		expect(normalizeAnthropicMessages(normalized)).toEqual(normalized);

		const upstream = buildUpstream(
			{ action: "key", provider: "anthropic", model: "claude-sonnet-4-5", key: "user" },
			"sk-ant-user",
			{
				system: "Teach.",
				messages: history,
				tools: [{ name: "get_learner_overview", description: "Memory", input_schema: { type: "object", properties: {} } }],
				maxTokens: 1000,
			},
		);
		const body = upstream.body as { messages: ChatMessage[] };
		assertSendable(body.messages);
		expect(JSON.stringify(body.messages)).toContain("DAEN 429 Homework 3 Concepts");
	});

	it("repairs tool history: dangling calls, consecutive roles, a leading assistant, and empty turns", () => {
		const history: ChatMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "   " }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "get_concepts", input: "{\"concepts\":[\"logistic loss\"]}" }] },
			{ role: "user", content: "" },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "orphan memory" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_b", name: "quiz", input: [] }] },
		];
		const normalized = normalizeAnthropicMessages(history);
		assertSendable(normalized);
		const encoded = JSON.stringify(normalized);
		expect(encoded).toContain("logistic loss");
		expect(encoded).toContain("orphan memory");
		expect(encoded).toContain("toolu_a");
		expect(encoded).toContain("toolu_b");
		expect(encoded).toContain("The tool did not return a result.");
		const quiz = normalized.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "quiz");
		expect(quiz && quiz.type === "tool_use" && quiz.input).toEqual({});
	});

	it("hides the raw Anthropic error behind a retry", () => {
		const banner = upstreamErrorMessage(
			{ type: "error", error: { type: "invalid_request_error", message: "Invalid Anthropic Messages API request" } },
			["sk-ant-secret"],
		);
		expect(banner).toBe(TUTOR_SEND_RETRY);
		expect(banner).not.toMatch(/Invalid Anthropic|sk-ant-secret|invalid_request/);
		expect(plainTutorError("messages.1.content.0.text: text content blocks must be non-empty")).toBe(TUTOR_SEND_RETRY);
		expect(plainTutorError("The model provider returned nothing.")).toBe("The model provider returned nothing.");
	});
});

describe("pick up the homework conversation", () => {
	it("recognizes the request and carries the saved transcript", () => {
		expect(asksToResumeConversation(PICK_UP)).toBe(true);
		expect(asksToResumeConversation("What's the chain rule?")).toBe(false);
		const prompt = resumePrompt(PICK_UP, "Tutor: logistic loss with L2 regularization.\nLearner: the contour plot.");
		expect(prompt).toContain("<previous_conversation>");
		expect(prompt).toContain("logistic loss with L2 regularization");
		expect(prompt).toContain(PICK_UP);
		expect(resumePrompt(prompt, "again")).toBe(prompt);
	});

	it("continues after memory loads instead of failing the next request", async () => {
		const seen: ChatMessage[][] = [];
		let step = 0;
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				seen.push(req.messages.map((message) => structuredClone(message)));
				step += 1;
				if (step === 1) {
					return {
						content: [
							{ type: "text", text: "" },
							{ type: "thinking", thinking: "", signature: "" },
							{ type: "tool_use", id: "toolu_mem", name: "get_learner_overview", input: {} },
						],
						stopReason: "tool_use",
					};
				}
				const text = "We left off on logistic loss and L2 regularization.";
				req.onText(text);
				return { content: [{ type: "text", text }], stopReason: "end_turn" };
			},
		};
		const tool: ToolDef = {
			name: "get_learner_overview",
			description: "Memory",
			inputSchema: { type: "object", properties: {} },
			async run() {
				return { text: memory, summary: "Loaded memory: 60 concepts, 2 active goals, 10 due reviews" };
			},
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({
			provider,
			store,
			tools: [tool],
			system: "Teach.",
			session: { id: "hw", title: "DAEN 429 Homework 3 Concepts" },
		});
		const events: AgentEvent[] = [];
		await agent.send(PICK_UP, (event) => events.push(event));
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		expect(events.some((event) => event.type === "text_delta" && event.text.includes("logistic loss"))).toBe(true);
		expect(seen.length).toBeGreaterThan(1);
		for (const messages of seen) assertSendable(messages);
		expect(JSON.stringify(seen[1])).toContain("DAEN 429 Homework 3 Concepts");
		expect(JSON.stringify(seen[1])).not.toContain('"text":""');
	});
});
