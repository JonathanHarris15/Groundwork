import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/agent/types";
import { usageFeatureFromClient, usageFeatureFromThread } from "../src/account/usage-feature";

describe("usage feature tag", () => {
	it("counts a missing tag as unknown", () => {
		expect(usageFeatureFromClient(undefined)).toBe("unknown");
		expect(usageFeatureFromClient("")).toBe("unknown");
		expect(usageFeatureFromClient("not-a-feature")).toBe("unknown");
		expect(usageFeatureFromClient("quiz")).toBe("quiz");
	});

	it("reads the latest study tool, and a probe quiz as diagnose", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "Quiz me on limits." },
			{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "quiz", input: { kind: "probe", question: "secret question text" } }] },
		];
		expect(usageFeatureFromThread(messages)).toBe("diagnose");
		messages.push({ role: "assistant", content: [{ type: "tool_use", id: "2", name: "grade_answer", input: { quiz_id: "q" } }] });
		expect(usageFeatureFromThread(messages)).toBe("grading");
	});

	it("tags the opening request before any tool runs", () => {
		expect(usageFeatureFromThread([{ role: "user", content: "I want a practice test on integrals." }])).toBe("practice_test");
		expect(usageFeatureFromThread([{ role: "user", content: "Make flashcards for the chain rule." }])).toBe("flashcards");
		expect(usageFeatureFromThread([{ role: "user", content: "What is a limit?" }])).toBe("tutor_chat");
		expect(usageFeatureFromThread([])).toBe("other");
	});
});
