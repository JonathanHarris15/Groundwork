import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import type { Provider } from "../src/agent/types";
import { MemoryVaultIO } from "../src/io";
import { LOST_REPLY, scrubLearnerText } from "../src/learner-text";
import { KnowledgeStore } from "../src/store";

describe("learner-visible text", () => {
	it("drops an internal fixture id and leaves ordinary prose", () => {
		expect(scrubLearnerText("test_tutor_prevention_1")).toBe(LOST_REPLY);
		expect(scrubLearnerText("  test_eval_fixture  ")).toBe(LOST_REPLY);
		expect(scrubLearnerText("Bayes rule updates a probability. test_tutor_prevention_2")).toBe("Bayes rule updates a probability.");
		expect(scrubLearnerText("The test was hard, and the midterm is next.")).toBe("The test was hard, and the midterm is next.");
	});

	it("does not store a fixture id as the tutor's reply", async () => {
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				const text = "test_tutor_prevention_1";
				req.onText(text);
				return { content: [{ type: "text", text }], stopReason: "end_turn" };
			},
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({ provider, store, tools: [], system: "Teach.", session: { id: "s" } });
		await agent.send("hello", () => {});
		const saved = JSON.stringify(agent.messages);
		expect(saved).not.toContain("test_tutor_prevention_1");
		expect(saved).toContain(LOST_REPLY);
	});
});
