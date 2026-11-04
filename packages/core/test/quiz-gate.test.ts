import { describe, expect, it } from "vitest";
import { isInternalToolReport, sanitizeTutorOutput } from "../src/learner-text";
import { MemoryVaultIO } from "../src/io";
import {
	isQuizGateFailure,
	modelQuizGateMessage,
	QUIZ_GATE_EXHAUSTED_LEARNER,
	QUIZ_GATE_MAX_ATTEMPTS,
} from "../src/quiz-gate";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

describe("quiz gate", () => {
	it("treats pre-show failures as internal tool reports", () => {
		const text = "Broken math in this question was not shown. Wrap each formula in $…$ or $$…$$, keep delimiters balanced, and do not leave TeX commands outside math mode. Then call quiz again.";
		expect(isQuizGateFailure("Broken math", text)).toBe(true);
		expect(isInternalToolReport("Broken math", text)).toBe(true);
		expect(isInternalToolReport("Quiz missed the preferred method", "Write the quiz with the professor's preferred method: tabular form")).toBe(true);
	});

	it("strips gate text from learner-visible sanitizer output", () => {
		const leaked =
			"Here is the idea.\n\nError: The model check and an independent check disagree. Recompute and call quiz again. The question was not shown.";
		expect(sanitizeTutorOutput(leaked).trim()).toBe("Here is the idea.");
	});

	it("returns a gate summary from the quiz tool without throwing", async () => {
		const quiz = toolByName("quiz")!;
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.upsertConcept({ title: "Constraints", summary: "Linear constraints." });
		const result = await quiz.run(
			{
				concept: "Constraints",
				question: "c$tops",
				purpose: "Checks constraints.",
				explanation: "Broken.",
				difficulty: 2,
				kind: "check",
				options: [
					{ label: "$0$", value: "a" },
					{ label: "$1$", value: "b" },
				],
				correctAnswer: "a",
			},
			{ store, ui: { quiz: async () => null } },
		);
		expect(result.isError).toBe(true);
		expect(isQuizGateFailure(result.summary, result.text ?? "")).toBe(true);
		expect(isInternalToolReport(result.summary, result.text ?? "")).toBe(true);
	});

	it("exhaustion message names the learner recovery line", () => {
		const exhausted = modelQuizGateMessage("Broken math", "bad $", 0);
		expect(exhausted).toContain(QUIZ_GATE_EXHAUSTED_LEARNER);
		expect(QUIZ_GATE_MAX_ATTEMPTS).toBe(4);
	});
});
