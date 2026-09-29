import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { ASIDE_PROMPT, ASIDE_TOOL_NAMES, DemoAsideProvider, asideOpening, marginNotes, type AsideThread } from "../src/aside";
import { MemoryVaultIO } from "../src/io";
import { buildSystemPrompt } from "../src/prompt";
import { KnowledgeStore } from "../src/store";
import { TOOLS, toolByName, type ToolUI } from "../src/tools";

const thread = (over: Partial<AsideThread> = {}): AsideThread => ({
	id: "m1",
	anchor: "item:2",
	quote: "the $x$ is constant in $\\alpha$",
	created: "2026-09-29T12:00:00Z",
	messages: [
		{ role: "user", text: "Why is x constant?", at: "2026-09-29T12:00:01Z" },
		{ role: "assistant", text: "Because we only vary $\\alpha$; $x$ is the fixed base point.", at: "2026-09-29T12:00:05Z" },
	],
	shared: 0,
	...over,
});

describe("margin notes", () => {
	it("hands unseen questions to the main tutor once", () => {
		const t = thread();
		const first = marginNotes([t]);
		expect(first?.text).toContain("<margin_questions>");
		expect(first?.text).toContain("Why is x constant?");
		expect(first?.text).toContain("fixed base point");
		t.shared = first!.shared.get("m1")!;
		expect(marginNotes([t])).toBeNull();

		t.messages.push({ role: "user", text: "And y?", at: "2026-09-29T12:01:00Z" });
		const second = marginNotes([t]);
		expect(second?.text).toContain("And y?");
		expect(second?.text).not.toContain("Why is x constant?");
	});

	it("skips threads with no learner question", () => {
		expect(marginNotes([thread({ messages: [] })])).toBeNull();
	});

	it("opens a side session with the lesson, highlight, and pending quiz but not its answer", () => {
		const text = asideOpening(
			{
				lesson: "Lesson body",
				quote: "inner Jacobian",
				pendingQuiz: { concept: "Gradient", question: "What is h'(α)?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
			},
			"what's a Jacobian?",
		);
		expect(text).toContain("<lesson_so_far>\nLesson body");
		expect(text).toContain("<quiz_waiting_for_learner");
		expect(text).toContain("<highlighted_passage>\ninner Jacobian");
		expect(text).toMatch(/Learner's question: what's a Jacobian\?$/);
		expect(text).not.toContain("correct");
	});

	it("tells the Obsidian tutor how to use margin questions", () => {
		expect(buildSystemPrompt("obsidian")).toContain("<margin_questions>");
		expect(buildSystemPrompt("chat")).not.toContain("<margin_questions>");
	});
});

describe("interactive tools carry margin notes", () => {
	it("appends them to a quiz result so a blocked tutor still sees them", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), { now: () => new Date("2026-09-29T12:00:00Z") });
		await store.upsertConcept({ title: "Gradient" });
		const ui: ToolUI = {
			quiz: async () => ({ dontKnow: false, selected: ["a"] }),
			ask: async () => null,
			marginNotes: () => "<margin_questions>why?</margin_questions>",
		};
		const r = await toolByName("quiz")!.run(
			{ concept: "Gradient", question: "Q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a", explanation: "E", difficulty: 2, kind: "check" },
			{ store, ui },
		);
		expect(r.text).toContain("CORRECTLY");
		expect(r.text).toContain("<margin_questions>why?</margin_questions>");
	});
});

describe("margin side session", () => {
	it("answers with read-only tools and never quizzes", async () => {
		const tools = TOOLS.filter((t) => ASIDE_TOOL_NAMES.includes(t.name));
		expect(tools.map((t) => t.name).sort()).toEqual([...ASIDE_TOOL_NAMES].sort());
		expect(tools.some((t) => t.interactive)).toBe(false);

		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({ provider: new DemoAsideProvider(0), store, tools, system: ASIDE_PROMPT, session: { id: "s-margin" } });
		let out = "";
		await agent.send(asideOpening({ lesson: "L", quote: "q" }, "why?"), (e) => {
			if (e.type === "text_delta") out += e.text;
		});
		expect(out).toContain("why?");
	});
});
