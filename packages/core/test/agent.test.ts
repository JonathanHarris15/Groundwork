import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { DemoProvider } from "../src/agent/demo";
import type { AgentEvent } from "../src/agent/types";
import { MemoryVaultIO } from "../src/io";
import { buildSystemPrompt } from "../src/prompt";
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
			system: buildSystemPrompt("obsidian"),
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
});
