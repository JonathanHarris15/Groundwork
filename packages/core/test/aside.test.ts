import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { ASIDE_PROMPT, ASIDE_TOOL_NAMES, HINT_PROMPT, DemoAsideProvider, asideOpening, hintNotes, hintOpening, marginNotes, type AsideThread } from "../src/aside";
import { FREE_RESPONSE_GRADING } from "../src/grading";
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
		expect(buildSystemPrompt()).toContain("<margin_questions>");
	});

	it("does not hand hint chats to the tutor as margin questions", () => {
		const hint = thread({
			id: "h1",
			kind: "hint",
			hintFor: "q1",
			messages: [
				{ role: "user", text: "Give me a hint.", at: "2026-09-29T12:02:00Z" },
				{ role: "assistant", text: "Start from the chain rule.", at: "2026-09-29T12:02:05Z" },
			],
		});
		const notes = marginNotes([thread(), hint]);
		expect(notes?.text).toContain("Why is x constant?");
		expect(notes?.text).not.toContain("chain rule");
		expect(notes?.shared.has("h1")).toBe(false);
	});
});

describe("hint chats", () => {
	const hint = (over: Partial<AsideThread> = {}): AsideThread =>
		thread({
			id: "h1",
			anchor: "quiz:q1",
			quote: "What is h'(α)?",
			kind: "hint",
			hintFor: "q1",
			messages: [
				{ role: "user", text: "Give me a hint.", at: "2026-09-29T12:02:00Z" },
				{ role: "assistant", text: "Differentiate the outside function first.", at: "2026-09-29T12:02:05Z" },
			],
			...over,
		});

	it("gives the hint model the private key and keeps it out of the margin opening", () => {
		const text = hintOpening(
			{
				lesson: "Lesson body",
				quote: "What is h'(α)?",
				brief: {
					concept: "Chain rule",
					question: "What is h'(α)?",
					format: "choice",
					options: [
						{ label: "f'(g(α)) g'(α)", correct: true },
						{ label: "f'(α)", correct: false },
					],
					explanation: "Outer derivative times inner derivative.",
				},
			},
			"Give me a hint.",
		);
		expect(text).toContain("<question_they_are_stuck_on>");
		expect(text).toContain("<private_answer_key");
		expect(text).toContain("f'(g(α)) g'(α)  ← correct");
		expect(text).toContain("Do not quote this on the first hint.");
		expect(text).toMatch(/Learner's question: Give me a hint\.$/);
		expect(text).not.toContain("f'(α)  ← correct");

		const margin = asideOpening(
			{
				lesson: "Lesson body",
				quote: "inner Jacobian",
				pendingQuiz: { concept: "Gradient", question: "What is h'(α)?", options: [{ label: "A", value: "a" }] },
			},
			"what's a Jacobian?",
		);
		expect(margin).not.toContain("private_answer_key");
		expect(margin).not.toContain("← correct");
	});

	it("hands the dialogue to the main tutor once, including a reply that landed later", () => {
		const t = hint();
		const first = hintNotes([t, thread()]);
		expect(first?.text).toContain("<hint_transcript>");
		expect(first?.text).toContain("Give me a hint.");
		expect(first?.text).toContain("outside function");
		expect(first?.text).toContain("quiz q1");
		expect(first?.text).not.toContain("Why is x constant?");
		t.shared = first!.shared.get("h1")!;
		expect(hintNotes([t])).toBeNull();

		t.messages = [{ role: "user", text: "Give me a hint.", at: "2026-09-29T12:02:00Z" }];
		t.shared = 0;
		const asked = hintNotes([t]);
		t.shared = asked!.shared.get("h1")!;
		t.messages.push({ role: "assistant", text: "The result is 3x^2.", at: "2026-09-29T12:03:00Z" });
		const later = hintNotes([t]);
		expect(later?.text).toContain("3x^2");
		expect(later?.text).not.toContain("Give me a hint.");
	});

	it("scripts a nudge that does not repeat the answer key", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({ provider: new DemoAsideProvider(0), store, tools: [], system: HINT_PROMPT, session: { id: "s-hint" } });
		const opening = hintOpening(
			{
				lesson: "L",
				quote: "What is 2+2?",
				brief: { concept: "Addition", question: "What is 2+2?", format: "free", reference: "the secret sum is forty-two" },
			},
			"Give me a hint.",
		);
		let out = "";
		await agent.send(opening, (e) => {
			if (e.type === "text_delta") out += e.text;
		});
		expect(out).toContain("One step");
		expect(out).not.toContain("forty-two");
		expect(out).not.toContain("private_answer_key");
	});

	it("tells the Obsidian tutor to judge how much of a hint was used", () => {
		const obsidian = buildSystemPrompt();
		expect(obsidian).toContain("<hint_transcript>");
		expect(obsidian).toContain("assisted correct is not solid mastery");
		expect(FREE_RESPONSE_GRADING).toContain("<hint_transcript>");
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
