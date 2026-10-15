import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import type { ChatMessage, ContentBlock, Provider } from "../src/agent/types";
import { extractPdfText } from "../src/exam";
import { MemoryVaultIO } from "../src/io";
import { buildSystemPrompt } from "../src/prompt";
import { KnowledgeStore } from "../src/store";
import { TOOLS, type ToolUI } from "../src/tools";

const ASK =
	"Alright lets make a new goal, I need to know all of the content from the start of my 427 class to the midterm. The midterm already happened but I want to be prepared. I gave you all of the slides in your recourses folder from start to midterm.";

function literalPdf(sentence: string): Uint8Array {
	const stream = `BT (${sentence}) Tj ET`;
	const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`;
	return new TextEncoder().encode(pdf);
}

function blocks(message: ChatMessage): ContentBlock[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function textOf(message: ChatMessage): string {
	return blocks(message)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function toolUses(messages: ChatMessage[], name: string): ContentBlock[] {
	return messages.flatMap((message) => blocks(message).filter((block) => block.type === "tool_use" && block.name === name));
}

/** What a fresh list-then-read turn is allowed to send. */
function assertSendable(messages: ChatMessage[]): void {
	expect(messages[0]?.role).toBe("user");
	expect(messages[messages.length - 1]?.role).toBe("user");
	const pending = new Set<string>();
	for (const message of messages) {
		for (const block of blocks(message)) {
			expect(block.type).not.toBe("thinking");
			expect(block.type).not.toBe("redacted_thinking");
			if (block.type === "image" || block.type === "document") {
				expect(message.role).toBe("user");
				const source = block.source as { type?: string; media_type?: string; data?: string };
				expect(source.type).toBe("base64");
				expect(source.data?.length).toBeGreaterThan(0);
			}
			if (block.type === "tool_use" && typeof block.id === "string") pending.add(block.id);
			if (block.type === "tool_result") {
				expect(typeof block.content).toBe("string");
				if (typeof block.tool_use_id === "string") pending.delete(block.tool_use_id);
			}
		}
	}
	expect(pending.size).toBe(0);
}

function conceptsOnTheWire(messages: ChatMessage[]): string[] {
	const found: string[] = [];
	for (const message of messages) {
		for (const block of blocks(message)) {
			if (block.type !== "document") continue;
			const source = block.source as { data?: string };
			const text = extractPdfText(Uint8Array.from(Buffer.from(source.data ?? "", "base64")));
			if (/Bayes rule/.test(text) && !found.includes("Bayes rule")) found.push("Bayes rule");
			if (/directed acyclic graph/i.test(text) && !found.includes("Directed acyclic graph")) found.push("Directed acyclic graph");
		}
	}
	return found;
}

function listedFiles(messages: ChatMessage[]): string[] {
	const files: string[] = [];
	for (const message of messages) {
		for (const line of textOf(message).split("\n")) {
			const match = /^- (\S+\.pdf) /.exec(line);
			if (match?.[1] && !files.includes(match[1])) files.push(match[1]);
		}
		for (const block of blocks(message)) {
			if (block.type !== "tool_result" || typeof block.content !== "string") continue;
			for (const line of block.content.split("\n")) {
				const match = /^- (\S+\.pdf) /.exec(line);
				if (match?.[1] && !files.includes(match[1])) files.push(match[1]);
			}
		}
	}
	return files;
}

describe("a folder of course files through the midterm", () => {
	it("lists the folder, reads each PDF, and builds the goal from those pages", async () => {
		const io = new MemoryVaultIO();
		io.writeBinary("Recources/bayes.pdf", literalPdf("Bayes rule updates a probability with evidence."));
		io.writeBinary("Recources/dag.pdf", literalPdf("A DAG is a directed acyclic graph."));
		const store = new KnowledgeStore(io);
		await store.ensureLayout();
		const access = { readFolders: ["Recources"], writeFolders: [] as string[] };
		const prompt = buildSystemPrompt(undefined, access);
		expect(prompt).toContain("read_vault_file");
		expect(prompt).toContain("through a midterm");
		expect(prompt).toContain("Do not use `survey_documents` or `show_figure` to read a PDF");

		const seen: string[] = [];
		let figures = 0;
		const ui: ToolUI = {
			async quiz(quiz) {
				return { dontKnow: false, selected: [quiz.correct[0] ?? "rule"] };
			},
			async ask() {
				return null;
			},
			showFigure() {
				figures += 1;
			},
		};
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				assertSendable(req.messages);
				seen.push(req.messages.flatMap((message) => blocks(message).filter((block) => block.type === "tool_use").map((block) => block.name)).join(","));
				if (toolUses(req.messages, "show_figure").length) throw new Error("show_figure was called");
				const last = textOf(req.messages[req.messages.length - 1] ?? { role: "user", content: "" });
				const concepts = conceptsOnTheWire(req.messages);
				if (!toolUses(req.messages, "list_vault_files").length) {
					return { content: [{ type: "tool_use", id: "list1", name: "list_vault_files", input: { folder: "Recources" } }], stopReason: "tool_use" };
				}
				const files = listedFiles(req.messages);
				const read = new Set(
					toolUses(req.messages, "read_vault_file").map((block) => (block.type === "tool_use" ? String((block.input as { path?: string }).path ?? "") : "")),
				);
				const unread = files.filter((file) => !read.has(file));
				if (unread.length) {
					return {
						content: unread.map((file, index) => ({
							type: "tool_use" as const,
							id: `read${index}`,
							name: "read_vault_file",
							input: { path: file },
						})),
						stopReason: "tool_use",
					};
				}
				if (!toolUses(req.messages, "set_goal").length || /tutor_repair/.test(last)) {
					expect(concepts).toEqual(["Bayes rule", "Directed acyclic graph"]);
					return {
						content: [
							{
								type: "tool_use",
								id: "goal1",
								name: "set_goal",
								input: {
									title: "DAEN 427 Midterm Prep",
									targets: concepts,
									nodes: concepts.map((title) => ({ title })),
									sources: files,
								},
							},
							{
								type: "tool_use",
								id: "quiz1",
								name: "quiz",
								input: {
									concept: "Bayes rule",
									question: "What does Bayes rule update?",
									explanation: "A probability, using evidence.",
									difficulty: 2,
									kind: "check",
									options: [
										{ label: "A probability, using evidence", value: "rule" },
										{ label: "A constant", value: "constant" },
									],
									correctAnswer: "rule",
								},
							},
						],
						stopReason: "tool_use",
					};
				}
				const reply = "We'll start with Bayes rule, then a directed acyclic graph.";
				req.onText(reply);
				return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: prompt,
			ui,
			session: { id: "427" },
			access,
		});
		const errors: string[] = [];
		await agent.send(ASK, (event) => {
			if (event.type === "error") errors.push(event.message);
			if (event.type === "tool_end" && event.summary === "No documents to read") errors.push(event.summary);
		});
		expect(errors).toEqual([]);
		expect(figures).toBe(0);
		expect(seen.some((step) => step.includes("show_figure"))).toBe(false);
		const goals = await store.goals();
		expect(goals.map((goal) => goal.title)).toContain("DAEN 427 Midterm Prep");
		const titles = [...(await store.concepts()).values()].map((concept) => concept.title);
		expect(titles).toEqual(expect.arrayContaining(["Bayes rule", "Directed acyclic graph"]));
		const pages = agent.messages.flatMap((message) =>
			blocks(message)
				.filter((block) => block.type === "document")
				.map((block) => extractPdfText(Uint8Array.from(Buffer.from((block.source as { data?: string }).data ?? "", "base64")))),
		);
		expect(pages.join("\n")).toContain("Bayes rule updates a probability with evidence.");
		expect(pages.join("\n")).toContain("A DAG is a directed acyclic graph.");
	});
});
