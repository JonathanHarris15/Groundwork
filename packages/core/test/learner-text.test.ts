import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import type { Provider } from "../src/agent/types";
import { MemoryVaultIO } from "../src/io";
import { holdsFixturePrefix, isGarbageReply, LOST_REPLY, scrubLearnerText } from "../src/learner-text";
import { KnowledgeStore } from "../src/store";

describe("learner-visible text", () => {
	it("drops an internal fixture id and leaves ordinary prose", () => {
		expect(scrubLearnerText("test_tutor_prevention_1")).toBe(LOST_REPLY);
		expect(scrubLearnerText("  test_eval_fixture  ")).toBe(LOST_REPLY);
		expect(scrubLearnerText("Bayes rule updates a probability. test_tutor_prevention_2")).toBe("Bayes rule updates a probability.");
		expect(scrubLearnerText("The test was hard, and the midterm is next.")).toBe("The test was hard, and the midterm is next.");
	});

	it("does not store a fixture id as the tutor's reply", async () => {
		let calls = 0;
		const provider: Provider = {
			name: "scripted",
			async complete(req) {
				calls += 1;
				const text = "test_tutor_prevention_1";
				req.onText(text);
				return { content: [{ type: "text", text }], stopReason: "end_turn" };
			},
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		const agent = new AgentSession({ provider, store, tools: [], system: "Teach.", session: { id: "s" } });
		const shown: string[] = [];
		await agent.send("hello", (event) => {
			if (event.type === "text_delta") shown.push(event.text);
		});
		expect(calls).toBeGreaterThan(1);
		expect(shown.join("")).not.toContain("test_tutor_prevention_1");
		const saved = JSON.stringify(agent.messages);
		expect(saved).not.toContain("test_tutor_prevention_1");
		expect(saved).toContain(LOST_REPLY);
	});

	it("continues a turn that stops on a blank reply or only test_tutor_prevention_1", async () => {
		expect(isGarbageReply("")).toBe(true);
		expect(isGarbageReply("test_tutor_prevention_1")).toBe(true);
		expect(isGarbageReply("The test was hard.")).toBe(false);
		expect(holdsFixturePrefix("test_tutor_pre")).toBe(true);
		expect(holdsFixturePrefix("The derivative")).toBe(false);
		for (const first of ["test_tutor_prevention_1", ""]) {
			let calls = 0;
			const provider: Provider = {
				name: "scripted",
				async complete(req) {
					calls += 1;
					if (calls === 1) {
						if (first) req.onText(first);
						return { content: first ? [{ type: "text", text: first }] : [], stopReason: "end_turn" };
					}
					const text = "Bayes rule updates a probability with evidence.";
					req.onText(text);
					return { content: [{ type: "text", text }], stopReason: "end_turn" };
				},
			};
			const store = new KnowledgeStore(new MemoryVaultIO());
			const agent = new AgentSession({ provider, store, tools: [], system: "Teach.", session: { id: "s" } });
			const shown: string[] = [];
			await agent.send("hello", (event) => {
				if (event.type === "text_delta") shown.push(event.text);
			});
			expect(calls, first || "empty").toBe(2);
			expect(shown.join(""), first || "empty").toBe("Bayes rule updates a probability with evidence.");
			expect(JSON.stringify(agent.messages)).not.toContain("test_tutor_prevention");
		}
	});
});
