import { describe, expect, it } from "vitest";
import { DemoProvider } from "../src/agent/demo";
import type { ChatMessage, ContentBlock, ProviderResponse } from "../src/agent/types";

async function step(messages: ChatMessage[]): Promise<ProviderResponse> {
	return new DemoProvider(0).complete({ system: "", messages, tools: [], onText() {} });
}

function toolInput(res: ProviderResponse, name: string): Record<string, unknown> | undefined {
	const block = res.content.find((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === name);
	return block && typeof block.input === "object" && block.input ? (block.input as Record<string, unknown>) : undefined;
}

describe("Calc 1 final demo fixture", () => {
	it("leaves the default practice test alone", async () => {
		const res = await step([{ role: "user", content: "Give me a practice test" }]);
		const test = toolInput(res, "practice_test");
		expect(test?.title).toBe("Derivative basics (demo)");
		expect(JSON.stringify(res.content)).not.toContain("Calc 1 final");
	});

	it("writes the Calc 1 final practice test, grades the written answer as partial, and does not teach after", async () => {
		const opened = await step([{ role: "user", content: "Write a practice test for my Calc 1 final on derivatives and the chain rule." }]);
		const test = toolInput(opened, "practice_test");
		expect(test?.title).toBe("Calc 1 final · Practice 1");
		expect(test?.timeLimitMinutes).toBe(25);
		expect(test?.questions).toHaveLength(10);
		expect(JSON.stringify(opened.content)).not.toMatch(/re-?teach/i);

		const graded = await step([
			{ role: "user", content: "Write a practice test for my Calc 1 final." },
			{ role: "assistant", content: [{ type: "tool_use", id: "demo_1_practice_test", name: "practice_test", input: {} }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "demo_1_practice_test",
						content: 'call grade_practice_test with test_id "t_calc"\n\n### Question 5\nThey wrote:\n$\\cos(3x)$\nReference answer: $3\\cos(3x)$',
					},
				],
			},
		]);
		const grade = toolInput(graded, "grade_practice_test");
		expect(grade?.test_id).toBe("t_calc");
		expect(grade?.grades).toEqual([
			{
				question: 5,
				outcome: "partial",
				feedback: "The outer derivative is right. The inner derivative of $3x$ is $3$, so the answer is $3\\cos(3x)$.",
			},
		]);

		const done = await step([
			{ role: "user", content: "Calc 1 final" },
			{ role: "assistant", content: [{ type: "tool_use", id: "g1", name: "grade_practice_test", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: 'Practice test evaluated: "Calc 1 final · Practice 1"' }] },
		]);
		expect(done.content).toEqual([]);
	});

	it("shows the chain-rule check and stops without a follow-up line", async () => {
		const quiz = await step([{ role: "user", content: "Check the chain rule for my Calc 1 final." }]);
		expect(quiz.content.some((b) => b.type === "text")).toBe(false);
		const input = toolInput(quiz, "quiz");
		expect(input).toMatchObject({
			concept: "Chain rule",
			purpose: "Whether you multiply by the inner derivative.",
			difficulty: 2,
			kind: "check",
			shuffle: false,
			correctAnswer: "full",
		});
		const after = await step([
			{ role: "user", content: "Check the chain rule for my Calc 1 final." },
			{ role: "assistant", content: [{ type: "tool_use", id: "q1", name: "quiz", input: { concept: "Chain rule" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "The learner answered INCORRECTLY." }] },
		]);
		expect(after.content).toEqual([]);
	});
});
