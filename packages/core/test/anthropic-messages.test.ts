import { describe, expect, it } from "vitest";
import { messagesForAnthropic, normalizeAnthropicMessages, plainTutorError, TUTOR_SEND_RETRY } from "../src/account/anthropic-messages";
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
			expect(block.type).not.toBe("thinking");
			expect(block.type).not.toBe("redacted_thinking");
			expect(block).not.toHaveProperty("caller");
			expect(block).not.toHaveProperty("citations");
			if (block.type === "image" || block.type === "document") {
				expect(message.role).toBe("user");
				const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
				expect(source?.type).toBe("base64");
				expect(typeof source?.data).toBe("string");
				expect(source?.data?.length).toBeGreaterThan(0);
				const allowed = block.type === "image" ? ["image/jpeg", "image/png", "image/gif", "image/webp"] : ["application/pdf", "text/plain"];
				expect(allowed).toContain(source?.media_type);
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
				expect(typeof block.content).toBe("string");
				expect(block.content).not.toContain('"type":"document"');
				expect(block.content).not.toContain('"type":"image"');
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF_DATA = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");

describe("media in every position", () => {
	it("keeps valid documents and images, and drops thinking and invalid sources", () => {
		const history: ChatMessage[] = [
			{
				role: "user",
				content: [
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_DATA }, title: "before.pdf" },
					{ type: "text", text: "The slides are in Recources." },
					{ type: "image", source: { type: "base64", media_type: "image/jpg", data: PNG } },
					{ type: "document", source: { type: "base64", media_type: "application/pdf" }, title: "missing.pdf" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
					{ type: "thinking", thinking: "look at the slides", signature: "sig" },
					{ type: "redacted_thinking", data: "abc" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "open the pdf", signature: "sig" },
					{ type: "redacted_thinking", data: "abc" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
					{ type: "text", text: "Listing the folder.", citations: [] },
					{
						type: "tool_use",
						id: "toolu_list",
						name: "list_vault_files",
						input: { folder: "Recources" },
						caller: { type: "direct" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_DATA }, title: "ahead.pdf" },
					{
						type: "tool_result",
						tool_use_id: "toolu_list",
						content: [
							{ type: "text", text: "Listed 2 files." },
							{ type: "thinking", thinking: "hidden", signature: "sig" },
							{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_DATA }, title: "Lecture1.pdf" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG }, title: "board.png" },
							{ type: "image", source: { type: "base64", media_type: "image/jpg", data: "not-an-image" }, title: "bad.jpg" },
							{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "" }, title: "empty.pdf" },
						],
					},
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_DATA }, title: "after.pdf" },
				],
			},
		];
		const sent = messagesForAnthropic(history);
		assertSendable(sent);
		const encoded = JSON.stringify(sent);
		expect(encoded).not.toContain('"type":"thinking"');
		expect(encoded).not.toContain("redacted_thinking");
		expect(encoded).not.toContain("image/jpg");
		expect(encoded).not.toContain('"title":"missing.pdf"');
		expect(encoded).not.toContain('"title":"empty.pdf"');
		expect(encoded).toContain("missing.pdf");
		expect(encoded).toContain("empty.pdf");
		expect(encoded).not.toContain("caller");
		expect(encoded).not.toContain("citations");
		expect(encoded).toContain("not a valid attachment");
		const documents = sent.flatMap(blocks).filter((block) => block.type === "document");
		const titles = documents.map((block) => block.title);
		expect(titles).toEqual(expect.arrayContaining(["before.pdf", "ahead.pdf", "Lecture1.pdf", "after.pdf"]));
		for (const block of documents) {
			expect(block.source).toMatchObject({ type: "base64", media_type: "application/pdf", data: PDF_DATA });
		}
		const images = sent.flatMap(blocks).filter((block) => block.type === "image");
		expect(images.length).toBeGreaterThan(0);
		for (const block of images) expect(block.source).toMatchObject({ media_type: "image/png", data: PNG });
		const result = sent.flatMap(blocks).find((block) => block.type === "tool_result");
		expect(result && result.type === "tool_result" && result.content).toContain("Listed 2 files.");
		expect(normalizeAnthropicMessages(sent)).toEqual(sent);
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

/** What OpenRouter's Anthropic adapter rejects with "Invalid Anthropic Messages API request". */
function poisonedReason(messages: ChatMessage[]): string | null {
	if (!messages.length) return "empty";
	if (messages[0]?.role !== "user") return "leading assistant";
	const pending = new Set<string>();
	let previous: string | null = null;
	for (const message of messages) {
		if (message.role === previous) return "same role twice";
		previous = message.role;
		const content = blocks(message);
		if (!content.length) return "empty message";
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) return "empty text";
			if (block.type === "thinking" || block.type === "redacted_thinking") return "thinking block";
			if (block.type === "tool_use") {
				const id = typeof block.id === "string" ? block.id : "";
				if (!id) return "tool_use without id";
				pending.add(id);
			}
			if (block.type === "tool_result") {
				const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
				if (!pending.has(id)) return "tool_result without tool_use";
				if (typeof block.content !== "string") return "tool_result content is not a string";
				if (Array.isArray(block.content) && block.content.some((part) => part.type === "document")) return "document inside tool_result";
				pending.delete(id);
			}
		}
		if (message.role === "user" && pending.size) return "tool_use without tool_result";
	}
	if (pending.size) return "dangling tool_use";
	if (messages[messages.length - 1]?.role !== "user") return "ends on assistant";
	return null;
}

const poisonedSession: ChatMessage[] = [
	{ role: "user", content: PICK_UP },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Open the homework PDF.", signature: "sig" },
			{ type: "text", text: "" },
			{ type: "tool_use", id: "toolu_pdf", name: "read_vault_file", input: { path: "DAEN 429 Homework 3.pdf" } },
		],
	},
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "toolu_pdf",
				content: [
					{ type: "text", text: "Opened DAEN 429 Homework 3." },
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QQ==" }, title: "DAEN 429 Homework 3.pdf" },
				],
			},
		],
	},
	{ role: "assistant", content: [{ type: "tool_use", id: "toolu_quiz", name: "quiz", input: { concept: "logistic loss" } }] },
];

describe("poisoned session outage", () => {
	it("rejects hello, move on, and pick up while the bad history is replayed", () => {
		expect(poisonedReason(poisonedSession)).toBeTruthy();
		for (const text of ["hello?", "move on to something else", PICK_UP]) {
			const replayed = [...poisonedSession, { role: "user" as const, content: text }];
			expect(poisonedReason(replayed), text).toBeTruthy();
		}
	});

	it("repairs the stored session so later messages are sendable", () => {
		const healed = normalizeAnthropicMessages(poisonedSession);
		expect(JSON.stringify(healed)).not.toContain("signature");
		expect(JSON.stringify(healed)).not.toContain("thinking");
		expect(JSON.stringify(healed)).toContain("DAEN 429 Homework 3.pdf");
		expect(JSON.stringify(healed)).toContain("toolu_quiz");
		const pdf = healed.flatMap(blocks).find((block) => block.type === "document");
		expect(pdf).toMatchObject({ source: { type: "base64", media_type: "application/pdf", data: "QQ==" }, title: "DAEN 429 Homework 3.pdf" });
		const result = healed.flatMap(blocks).find((block) => block.type === "tool_result");
		expect(result && result.type === "tool_result" && typeof result.content).toBe("string");
		for (const text of ["hello?", "move on to something else", PICK_UP]) {
			const sent = messagesForAnthropic([...healed, { role: "user", content: text }]);
			expect(poisonedReason(sent), text).toBeNull();
			assertSendable(sent);
		}
	});

	it("self-heals the saved thread and retries when the provider still rejects it", async () => {
		const seen: ChatMessage[][] = [];
		let calls = 0;
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				seen.push(req.messages.map((message) => structuredClone(message)));
				calls += 1;
				if (calls === 1) throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid Anthropic Messages API request"}}');
				const text = "Hello. We can leave the homework PDF and talk about something else.";
				req.onText(text);
				return { content: [{ type: "text", text }], stopReason: "end_turn" };
			},
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({
			provider,
			store,
			tools: [],
			system: "Teach.",
			session: { id: "hw", title: "DAEN 429 Homework 3 Concepts" },
			messages: poisonedSession,
		});
		expect(JSON.stringify(agent.messages)).toContain('"type":"document"');
		const events: AgentEvent[] = [];
		await agent.send("hello?", (event) => events.push(event));
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		expect(seen.length).toBe(2);
		expect(poisonedReason(seen[1] ?? [])).toBeNull();
		expect(JSON.stringify(agent.messages)).not.toContain('"type":"document"');
		expect(JSON.stringify(agent.messages)).not.toContain('"type":"thinking"');

		await agent.send("move on to something else", (event) => events.push(event));
		await agent.send(PICK_UP, (event) => events.push(event));
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		for (const messages of seen) expect(poisonedReason(messages)).toBeNull();
	});
});
