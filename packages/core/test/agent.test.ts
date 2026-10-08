import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { DemoProvider } from "../src/agent/demo";
import type { AgentEvent, ChatMessage, Provider } from "../src/agent/types";
import { STUDY_FOLLOW_UP } from "../src/intent";
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

	it("blocks a goal on a direct question and allows one after they opt in", async () => {
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
		expect(events.some((e) => e.type === "tool_end" && e.name === "set_goal" && e.isError)).toBe(true);
		expect(await store.goals()).toEqual([]);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toContain(STUDY_FOLLOW_UP);

		await agent.send("yes", (e) => events.push(e));
		expect((await store.goals()).map((g) => g.title)).toEqual(["Parabolas"]);
	});
});

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : block.type === "tool_result" ? String(block.content) : "")).join("\n");
}
