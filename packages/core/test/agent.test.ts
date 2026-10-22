import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { DemoProvider } from "../src/agent/demo";
import type { AgentEvent, ChatMessage, Provider } from "../src/agent/types";
import { STUDY_FOLLOW_UP } from "../src/intent";
import { PLAIN_NO_TOOL_ERROR, UNSAVED_GOAL_LINE } from "../src/turn-repair";
import { toBoard } from "../../obsidian-plugin/src/goal-board";
import { MemoryVaultIO } from "../src/io";
import type { TestReport } from "../src/practice";
import { buildSystemPrompt, practiceTestRequest } from "../src/prompt";
import { KnowledgeStore } from "../src/store";
import { TOOLS, type ToolUI } from "../src/tools";

describe("AgentSession with the demo tutor", () => {
	it("runs recall → plan → quiz → summary and writes the vault", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		await store.ensureLayout();
		const answered: string[] = [];
		const ui: ToolUI = {
			async quiz(q) {
				answered.push(q.concept);
				return { dontKnow: false, selected: [q.correct[0]] };
			},
			async ask() {
				return { selected: [], text: "ok" };
			},
		};
		const agent = new AgentSession({
			provider: new DemoProvider(0),
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui,
			session: { id: "s1", notePath: "sessions/demo.md" },
		});
		const events: AgentEvent[] = [];
		await agent.send("Teach me derivatives", (e) => events.push(e));
		expect(events.some((e) => e.type === "tool_start" && e.name === "set_goal")).toBe(true);
		expect(await io.exists("goals/Understand the derivative.md")).toBe(true);

		await agent.send("go", (e) => events.push(e));
		expect(answered).toEqual(["Slope of a line", "Secant line"]);
		expect((await store.resolve("Secant line"))!.stats.attempts).toBe(1);
		expect(io.files.get("sessions/demo.md")).toContain("## Summary");
		expect(events.filter((e) => e.type === "error")).toEqual([]);

		let graded: TestReport | undefined;
		ui.test = async (t) => ({
			answers: {
				[t.questions[0].id]: { dontKnow: false, selected: ["two"] },
				[t.questions[1].id]: { dontKnow: false, selected: [], text: "$2x$" },
				[t.questions[2].id]: { dontKnow: false, selected: [], text: "$\\frac{f(a+h)-f(a)}{h}$" },
			},
		});
		ui.testGraded = (r) => (graded = r);
		await agent.send(practiceTestRequest(), (e) => events.push(e));
		expect(graded?.results.map((r) => r.outcome)).toEqual(["correct", "correct", "partial"]);
		expect([...io.files.keys()].some((p) => p.startsWith("tests/"))).toBe(true);
		expect(events.filter((e) => e.type === "error")).toEqual([]);

		for (const m of agent.messages) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			const idx = agent.messages.indexOf(m);
			const uses = m.content.filter((b) => b.type === "tool_use");
			if (uses.length) {
				const next = agent.messages[idx + 1];
				expect(Array.isArray(next.content) && next.content.filter((b) => b.type === "tool_result").length).toBe(uses.length);
			}
		}
	});

	it("does not hard-block a goal on a direct question", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		await store.ensureLayout();
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = req.messages[req.messages.length - 1];
				const text = messageText(last);
				const say = (reply: string) => {
					req.onText(reply);
					return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
				};
				if (/Not yet/.test(text)) return say(`Here is $y = x^2$.\n\n${STUDY_FOLLOW_UP}`);
				if (/graph of x\^2/i.test(text)) {
					return {
						content: [{ type: "tool_use" as const, id: "g1", name: "set_goal", input: { title: "Parabolas", targets: ["Parabola"], nodes: [{ title: "Parabola" }] } }],
						stopReason: "tool_use" as const,
					};
				}
				if (/^yes$/i.test(text.trim())) {
					return {
						content: [{ type: "tool_use" as const, id: "g2", name: "set_goal", input: { title: "Parabolas", targets: ["Parabola"], nodes: [{ title: "Parabola" }] } }],
						stopReason: "tool_use" as const,
					};
				}
				return say("Saved.");
			},
		};
		const agent = new AgentSession({ provider, store, tools: TOOLS, system: buildSystemPrompt(), session: { id: "s" } });
		const events: AgentEvent[] = [];
		await agent.send("can you show me a graph of x^2?", (e) => events.push(e));
		expect(events.some((e) => e.type === "tool_end" && e.name === "set_goal" && e.isError)).toBe(false);
		expect((await store.goals()).map((g) => g.title)).toEqual(["Parabolas"]);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).not.toContain("Waiting until they ask to study");
	});

	it("does not append a study gate after a lesson the learner has not opted into", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		let calls = 0;
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				calls += 1;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_use" as const, id: "q1", name: "quiz", input: { question: "State additivity." } },
							{ type: "tool_use" as const, id: "a1", name: "ask_user", input: { question: "Ready?" } },
							{ type: "tool_use" as const, id: "q2", name: "quiz", input: { question: "State it again." } },
						],
						stopReason: "tool_use" as const,
					};
				}
				const reply = "Probability is additive over disjoint events.\n\nquiz: Waiting until they ask to study ask_user: Waiting until they ask to study quiz: Waiting until they ask to study";
				req.onText("Probability is additive over disjoint events.\n\nquiz: Wait");
				req.onText("ing until they ask to study ask_user: Waiting until they ask to study quiz: Waiting until they ask to study");
				return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: {
				async quiz() {
					return null;
				},
				async ask() {
					return null;
				},
			},
			session: { id: "axioms" },
		});
		const shown: string[] = [];
		await agent.send("Explain the probability axioms. I am not studying yet.", (event) => {
			if (event.type === "text_delta") shown.push(event.text);
		});
		const spoken = shown.join("");
		expect(spoken).toContain("Probability is additive over disjoint events.");
		expect(spoken).not.toContain("Waiting until they ask to study");
		expect(spoken).not.toContain("No tool returned an error");
		expect(spoken).not.toMatch(/(?:^|\s)(?:quiz|ask_user):\s/);
		expect(JSON.stringify(agent.messages)).not.toContain("Waiting until they ask to study");
	});

	it("starts the goal and a quiz when the reply invented a confirmation gate", async () => {
		const asked: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Derivative", summary: "A rate of change." });
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = messageText(req.messages[req.messages.length - 1]!);
				if (/tutor_repair/.test(last)) {
					return {
						content: [
							{
								type: "tool_use",
								id: "g1",
								name: "set_goal",
								input: { title: "Homework", targets: ["Derivative"], nodes: [{ title: "Derivative" }] },
							},
							{
								type: "tool_use",
								id: "q1",
								name: "quiz",
								input: {
									concept: "Derivative",
									question: "What is a derivative?",
									explanation: "A rate of change.",
									difficulty: 2,
									kind: "check",
									options: [
										{ label: "A rate of change", value: "rate" },
										{ label: "A constant", value: "constant" },
									],
									correctAnswer: "rate",
								},
							},
						],
						stopReason: "tool_use",
					};
				}
				const reply =
					"The quiz card didn't pop up because our system requires a formal confirmation step before it can initialize the goal tracker. Do you want to study this or make a goal for it?";
				req.onText(reply);
				return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: {
				async quiz(q) {
					asked.push(q.question);
					return { dontKnow: false, selected: ["rate"] };
				},
				async ask() {
					return null;
				},
			},
			session: { id: "s" },
		});
		await agent.send("I'm working toward being able to do the homework", () => undefined);
		expect((await store.goals()).map((g) => g.title)).toEqual(["Homework"]);
		expect(asked).toEqual(["What is a derivative?"]);
	});

	it("saves a goal when they state an objective, even if the first reply forgot the tool", async () => {
		const { agent, store } = await session();
		const events: AgentEvent[] = [];
		await agent.send("I want to be able to do the homework on derivatives", (e) => events.push(e));
		expect((await store.goals()).map((g) => g.title)).toEqual(["Homework"]);
		expect(events.some((e) => e.type === "tool_end" && e.name === "set_goal" && !e.isError)).toBe(true);
	});

	it("does not start a goal for a direct question", async () => {
		const { agent, store } = await session();
		await agent.send("what's the chain rule?", () => undefined);
		expect(await store.goals()).toEqual([]);
	});

	it("turns an announced question into a quiz card", async () => {
		const asked: string[] = [];
		const { agent, store } = await session({
			async quiz(q) {
				asked.push(q.question);
				return { dontKnow: false, selected: [q.correct[0] ?? ""] };
			},
		});
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		await agent.send("help me learn slopes", () => undefined);
		expect(asked).toEqual(["What is the slope?"]);
	});

	it("asks the model only once more when it keeps announcing and never calls the tool", async () => {
		let calls = 0;
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		await store.ensureLayout();
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				calls++;
				req.onText("Here's a question.");
				return { content: [{ type: "text", text: "Here's a question." }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({ provider, store, tools: TOOLS, system: buildSystemPrompt(), session: { id: "s" } });
		await agent.send("help me learn slopes", () => undefined);
		expect(calls).toBe(2);
	});

	it("shows a quiz card when the tool arguments arrive as a JSON string", async () => {
		const asked: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		let calls = 0;
		const provider: Provider = {
			name: "scripted",
			async complete() {
				calls++;
				if (calls > 1) return { content: [{ type: "text", text: "Rise over run." }], stopReason: "end_turn" };
				return {
					content: [
						{
							type: "tool_use",
							id: "q1",
							name: "quiz",
							input: JSON.stringify({
								concept: "Slope of a line",
								question: "What is the slope?",
								explanation: "Rise over run.",
								difficulty: 2,
								kind: "check",
								options: [
									{ label: "2", value: "2" },
									{ label: "3", value: "3" },
								],
								correctAnswer: "2",
							}),
						},
					],
					stopReason: "tool_use",
				};
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: {
				async quiz(q) {
					asked.push(q.question);
					return { dontKnow: false, selected: ["2"] };
				},
				async ask() {
					return null;
				},
			},
			session: { id: "s" },
		});
		await agent.send("help me learn slopes", () => undefined);
		expect(asked).toEqual(["What is the slope?"]);
	});

	it("replaces an ASCII sketch with a figure", async () => {
		const shown: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const sketch = ["```", "          x3", "          |", "    ------+------", "   /      |      \\", "  /   *   |   *   \\", " /________|________\\", "         / \\", "       x1   x2", "```"].join("\n");
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = messageText(req.messages[req.messages.length - 1]!);
				if (/tutor_repair/.test(last)) {
					expect(last).toContain("show_figure");
					expect(last).not.toContain("Call quiz");
					return {
						content: [
							{
								type: "tool_use",
								id: "f1",
								name: "show_figure",
								input: { title: "Lift", kind: "plot", series: [{ expr: "x^2", mark: "line" }] },
							},
						],
						stopReason: "tool_use",
					};
				}
				if (/Showing a plot figure/.test(last)) {
					const reply = "The curve is the lift.";
					req.onText(reply);
					return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
				}
				req.onText(sketch);
				return { content: [{ type: "text", text: sketch }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: {
				async quiz() {
					return null;
				},
				async ask() {
					return null;
				},
				showFigure(figure) {
					shown.push(figure.title);
				},
			},
			session: { id: "s" },
		});
		await agent.send("Show me the paraboloid that lifts points to x3 = r^2 with a separating plane.", () => undefined);
		expect(shown).toEqual(["Lift"]);
	});

	it("saves a pinned goal due Oct 28 when they say yes and will not quiz tonight", async () => {
		const bedtime = "Yes set this up as a goal due on Oct 28th. But I wont start quizzing tonight. I am going to bed";
		const quizzed: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = messageText(req.messages[req.messages.length - 1]!);
				if (/tutor_repair/.test(last)) {
					expect(last).toContain("Call set_goal");
					expect(last).toContain("Do not call quiz");
					expect(last).toContain("Do not ask permission again");
					return {
						content: [{ type: "tool_use" as const, id: "g1", name: "set_goal", input: { title: "Limits", targets: ["Limit"], nodes: [{ title: "Limit" }] } }],
						stopReason: "tool_use" as const,
					};
				}
				if (/"goal": "Limits"|Saved goal/.test(last)) {
					const reply = "Goodnight. The first concept is Limit.";
					req.onText(reply);
					return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
				}
				if (/\bStart\b/.test(last) && !/Reply Start/.test(last)) {
					return {
						content: [
							{
								type: "tool_use" as const,
								id: "q1",
								name: "quiz",
								input: {
									concept: "Limit",
									question: "What is a limit?",
									explanation: "A value the function approaches.",
									difficulty: 2,
									kind: "check",
									options: [
										{ label: "A value approached", value: "approach" },
										{ label: "The function itself", value: "function" },
									],
									correctAnswer: "approach",
								},
							},
						],
						stopReason: "tool_use" as const,
					};
				}
				if (/Not now/.test(last)) {
					const reply = "Goodnight.";
					req.onText(reply);
					return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
				}
				const reply =
					"Goodnight. The first concept is Limit. I've set this up as a goal. The system waits for a ready to study/quiz trigger to finalize the goal. Reply Start when you want me to save it.";
				req.onText(reply);
				return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			messages: [
				{ role: "user", content: "put together a study guide for limits" },
				{ role: "assistant", content: `Here is the guide.\n\n${STUDY_FOLLOW_UP}` },
			],
			ui: {
				async quiz(q) {
					quizzed.push(q.question);
					return { dontKnow: false, selected: ["approach"] };
				},
				async ask() {
					return null;
				},
			},
			session: { id: "hosted" },
		});
		const events: AgentEvent[] = [];
		await agent.send(bedtime, (e) => events.push(e));
		const goals = await store.goals();
		expect(goals.map((goal) => goal.title)).toEqual(["Limits"]);
		expect(goals[0]?.due).toBe("2026-10-28");
		expect((await store.workingGoal())?.due).toBe("2026-10-28");
		const report = await store.goalReport(goals[0]!.id);
		const board = toBoard(report, await store.goalTiming(report), report.next);
		expect(board.due).toBe("2026-10-28");
		expect(board.dueLabel).toMatch(/Oct 28/);
		expect(quizzed).toEqual([]);
		expect(events.some((e) => e.type === "tool_end" && e.name === "set_goal" && !e.isError)).toBe(true);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).not.toContain(UNSAVED_GOAL_LINE);

		await agent.send("Start", (e) => events.push(e));
		expect(quizzed).toEqual(["What is a limit?"]);
		expect(events.some((e) => e.type === "tool_end" && e.name === "quiz" && e.isError)).toBe(false);
		expect((await store.goals())[0]?.due).toBe("2026-10-28");
	});

	it("studies when they say let's work on this goal, and saves a goal with no quiz when they say not tonight", async () => {
		const asked: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Limit", summary: "A value being approached." });
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const lastMessage = req.messages[req.messages.length - 1]!;
				const last = messageText(lastMessage);
				const toolResult = Array.isArray(lastMessage.content) && lastMessage.content.some((block) => block.type === "tool_result");
				const learner = [...req.messages].reverse().find((message) => {
					if (message.role !== "user") return false;
					if (Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) return false;
					return !/<tutor_repair>/.test(messageText(message));
				});
				const ask = learner ? messageText(learner) : "";
				if (/tutor_repair/.test(last) && /let's work on this goal/i.test(ask)) {
					expect(last).toContain("Call quiz");
					return {
						content: [
							{
								type: "tool_use" as const,
								id: "q2",
								name: "quiz",
								input: {
									concept: "Additivity",
									question: "What is a limit?",
									explanation: "A value being approached.",
									difficulty: 2,
									kind: "check",
									options: [
										{ label: "A value approached", value: "approach" },
										{ label: "A sum", value: "sum" },
									],
									correctAnswer: "approach",
								},
							},
						],
						stopReason: "tool_use" as const,
					};
				}
				if (toolResult) {
					const reply = /not tonight/i.test(ask) ? "The goal is saved." : "Onward.";
					req.onText(reply);
					return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
				}
				if (/not tonight/i.test(ask)) {
					return {
						content: [
							{ type: "tool_use" as const, id: "g1", name: "set_goal", input: { title: "Additivity", targets: ["Limit"], nodes: [{ title: "Limit" }] } },
							{
								type: "tool_use" as const,
								id: "q1",
								name: "quiz",
								input: {
									concept: "Limit",
									question: "State additivity.",
									explanation: "Disjoint events add.",
									difficulty: 2,
									kind: "check",
									options: [
										{ label: "They add", value: "add" },
										{ label: "They multiply", value: "mul" },
									],
									correctAnswer: "add",
								},
							},
						],
						stopReason: "tool_use" as const,
					};
				}
				if (/let's work on this goal/i.test(ask)) {
					const reply = "What is a limit?";
					req.onText(reply);
					return {
						content: [
							{ type: "tool_use" as const, id: "c1", name: "upsert_concept", input: { title: "Additivity", summary: "Disjoint probabilities add." } },
							{ type: "text" as const, text: reply },
						],
						stopReason: "tool_use" as const,
					};
				}
				const reply = "Onward.";
				req.onText(reply);
				return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: {
				async quiz(q) {
					asked.push(q.question);
					return { dontKnow: false, selected: ["approach"] };
				},
				async ask() {
					return null;
				},
			},
			session: { id: "work" },
		});
		const workEvents: AgentEvent[] = [];
		await agent.send("let's work on this goal", (event) => workEvents.push(event));
		expect(workEvents.some((event) => event.type === "tool_end" && event.name === "upsert_concept" && !event.isError)).toBe(true);
		expect(asked).toEqual(["What is a limit?"]);
		expect(workEvents.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("")).not.toContain("Waiting until they ask to study");
		expect([...(await store.concepts()).values()].some((concept) => concept.title === "Additivity")).toBe(true);

		asked.length = 0;
		const nightEvents: AgentEvent[] = [];
		await agent.send("set a goal due Oct 28, not tonight", (event) => nightEvents.push(event));
		expect(nightEvents.some((event) => event.type === "tool_end" && event.name === "set_goal" && !event.isError)).toBe(true);
		expect(nightEvents.some((event) => event.type === "tool_end" && event.name === "quiz" && event.isError)).toBe(true);
		expect(asked).toEqual([]);
		const goal = (await store.goals()).find((item) => item.title === "Additivity");
		expect(goal?.due).toBe("2026-10-28");
		expect(nightEvents.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("")).not.toContain("Waiting until they ask to study");
	});

	it("saves the goal on Start after a made-up tool registration failure", async () => {
		const bedtime = "Yes set this up as a goal due on Oct 28th. But I wont start quizzing tonight. I am going to bed";
		const invention =
			"It looks like the tools did not load properly due to an issue registering the actions. Since the system isn't letting me initialize the database tools right now, I have saved our full study plan in chat history. send I'm ready to start studying the slides";
		const quizzed: string[] = [];
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = messageText(req.messages[req.messages.length - 1]!);
				const learner = [...req.messages].reverse().find((message) => {
					if (message.role !== "user") return false;
					if (Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) return false;
					return !/<tutor_repair>/.test(messageText(message));
				});
				const ask = learner ? messageText(learner) : "";
				if (/"goal": "Limits"|Saved goal/.test(last)) {
					const reply = "The goal is saved.";
					req.onText(reply);
					return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
				}
				if (ask.trim() === "Start") {
					if (/tutor_repair/.test(last)) {
						expect(last).toContain("Call set_goal");
						expect(last).not.toContain("Do not call quiz");
						expect(last).toContain("No tool failed");
						expect(last).not.toContain("No tool returned an error");
						expect(last).not.toContain("did not load");
						return {
							content: [{ type: "tool_use" as const, id: "g1", name: "set_goal", input: { title: "Limits", targets: ["Limit"], nodes: [{ title: "Limit" }] } }],
							stopReason: "tool_use" as const,
						};
					}
					req.onText(invention);
					return { content: [{ type: "text" as const, text: invention }], stopReason: "end_turn" as const };
				}
				req.onText(invention);
				return { content: [{ type: "text" as const, text: invention }], stopReason: "end_turn" as const };
			},
		};
		const agent = new AgentSession({
			provider,
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			messages: [
				{ role: "user", content: "put together a study guide for limits" },
				{ role: "assistant", content: `Here is the guide.\n\n${STUDY_FOLLOW_UP}` },
			],
			ui: {
				async quiz(q) {
					quizzed.push(q.question);
					return null;
				},
				async ask() {
					return null;
				},
			},
			session: { id: "hosted" },
		});
		const events: AgentEvent[] = [];
		await agent.send(bedtime, (e) => events.push(e));
		expect(await store.goals()).toEqual([]);
		const spoken = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
		expect(spoken).not.toContain(PLAIN_NO_TOOL_ERROR);
		expect(spoken).not.toContain("Waiting until they ask to study");
		expect(spoken).toContain(UNSAVED_GOAL_LINE);
		await agent.send("Start", (e) => events.push(e));
		expect(quizzed).toEqual([]);
		expect((await store.goals()).map((goal) => goal.title)).toEqual(["Limits"]);
		expect((await store.goals())[0]?.due).toBe("2026-10-28");
		expect(events.some((e) => e.type === "tool_end" && e.name === "set_goal" && !e.isError)).toBe(true);
	});

	it("corrects a claimed goal when set_goal never succeeds", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const last = messageText(req.messages[req.messages.length - 1]!);
				const reply = /tutor_repair/.test(last) ? "I've set this up as a goal. Goodnight." : "Goodnight. The first concept is Limit. I've set this up as a goal.";
				req.onText(reply);
				return { content: [{ type: "text" as const, text: reply }], stopReason: "end_turn" as const };
			},
		};
		const agent = new AgentSession({ provider, store, tools: TOOLS, system: buildSystemPrompt(), session: { id: "hosted" } });
		const events: AgentEvent[] = [];
		await agent.send("Yes set this up as a goal due on Oct 28th. But I wont start quizzing tonight. I am going to bed", (e) => events.push(e));
		expect(await store.goals()).toEqual([]);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toContain(UNSAVED_GOAL_LINE);
	});
});

function session(ui: Partial<ToolUI> = {}): Promise<{ agent: AgentSession; store: KnowledgeStore }> {
	const store = new KnowledgeStore(new MemoryVaultIO());
	const full: ToolUI = {
		async quiz() {
			return null;
		},
		async ask() {
			return null;
		},
		...ui,
	};
	return store.ensureLayout().then(() => ({
		store,
		agent: new AgentSession({
			provider: scriptedTutor(),
			store,
			tools: TOOLS,
			system: buildSystemPrompt(),
			ui: full,
			session: { id: "s" },
		}),
	}));
}

/** First reply is prose. A repair note is answered with the tool the note asks for. */
function scriptedTutor(): Provider {
	return {
		name: "scripted",
		async complete(req) {
			const last = messageText(req.messages[req.messages.length - 1]!);
			if (/tutor_repair/.test(last) && /set_goal/.test(last)) {
				return {
					content: [{ type: "tool_use", id: "g1", name: "set_goal", input: { title: "Homework", targets: ["Derivative"], nodes: [{ title: "Derivative" }] } }],
					stopReason: "tool_use",
				};
			}
			if (/tutor_repair/.test(last) && /quiz/.test(last)) {
				return {
					content: [
						{
							type: "tool_use",
							id: "q1",
							name: "quiz",
							input: {
								concept: "Slope of a line",
								question: "What is the slope?",
								explanation: "Rise over run.",
								difficulty: 2,
								kind: "check",
								options: [
									{ label: "2", value: "2" },
									{ label: "3", value: "3" },
								],
								correctAnswer: "2",
							},
						},
					],
					stopReason: "tool_use",
				};
			}
			if (/chain rule/i.test(last)) {
				const reply = "The chain rule multiplies rates along a composition.";
				req.onText(reply);
				return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
			}
			if (/homework/i.test(last)) {
				const reply = "We can work on that.";
				req.onText(reply);
				return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
			}
			const reply = "Let's try one.";
			req.onText(reply);
			return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
		},
	};
}

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : block.type === "tool_result" ? String(block.content) : "")).join("\n");
}
