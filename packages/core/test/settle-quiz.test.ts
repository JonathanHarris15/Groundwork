import { describe, expect, it } from "vitest";
import { settleQuizAnswer, takeAwaiting } from "../src/grading";
import { MemoryVaultIO } from "../src/io";
import { prepareQuiz } from "../src/quiz";
import { KnowledgeStore } from "../src/store";

describe("settleQuizAnswer", () => {
	it("records a multiple-choice answer that was still open", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.upsertConcept({ title: "Chain rule", summary: "Derivative of a composition." });
		const quiz = prepareQuiz(
			{
				concept: "Chain rule",
				question: "What rule differentiates f(g(x))?",
				explanation: "The chain rule.",
				difficulty: 2,
				options: [
					{ label: "Chain rule", value: "a" },
					{ label: "Product rule", value: "b" },
				],
				correctAnswer: "a",
			},
			() => 0,
		);
		const settled = await settleQuizAnswer(store, quiz, { dontKnow: false, selected: ["a"] }, { id: "chat-1" });
		expect(settled).toHaveProperty("outcome");
		if (!("outcome" in settled)) return;
		expect(settled.outcome.grade.outcome).toBe("correct");
		expect(settled.outcome.conceptTitle).toBe("Chain rule");
		expect((await store.resolve("Chain rule"))?.stats.attempts).toBe(1);
	});

	it("holds a written answer for the tutor when nothing else can grade it", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.upsertConcept({ title: "Chain rule" });
		const quiz = prepareQuiz({
			concept: "Chain rule",
			question: "Differentiate sin(x^2).",
			format: "free",
			referenceAnswer: "2x cos(x^2)",
			explanation: "Chain rule.",
			difficulty: 3,
		});
		const settled = await settleQuizAnswer(store, quiz, { dontKnow: false, selected: [], text: "2x cos(x^2)" }, { id: "chat-1" });
		expect(settled).toHaveProperty("pending");
		if (!("pending" in settled)) return;
		expect(settled.pending).toContain(quiz.id);
		expect(settled.pending).toContain("grade_answer");
		expect(takeAwaiting(quiz.id)?.response.text).toBe("2x cos(x^2)");
		expect((await store.resolve("Chain rule"))?.stats.attempts ?? 0).toBe(0);
	});
});