import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { freeResponseRequest, WRITTEN_GRADE_CONFIDENCE, judgmentFromAnswers, judgmentsFor, type AnswerGrader } from "../src/jev/grade";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";
import type { QuizOutcome } from "../src/grading";

const item = {
	question: "Find $f'(x)$ for $f(x) = x^3$.",
	reference: "$3x^2$",
	rubric: "Full credit for $3x^2$. Partial for the right rule and a wrong coefficient.",
	answer: "$3x^2 + C$",
};

describe("Jev grading request", () => {
	it("asks Jev for an outcome and a slip, and does not carry an API key", () => {
		const request = freeResponseRequest([item]);
		expect(request.model).toBe("jev-latest");
		expect(request.questions.i0_outcome).toMatchObject({ type: "choice" });
		expect(request.questions.i0_slip).toMatchObject({ type: "noul" });
		expect(request.questions.i0_echoed).toBeUndefined();
		expect(JSON.stringify(request)).not.toMatch(/apiKey|TYPESAFE/);
	});

	it("adds a hint question only when a hint transcript is present", () => {
		const request = freeResponseRequest([{ ...item, hintTranscript: "The power comes down in front." }]);
		expect(request.questions.i0_echoed).toMatchObject({ type: "noul" });
	});

	it("records a confident partial and defers a low-confidence guess", () => {
		const partial = judgmentFromAnswers(0, {
			i0_outcome: { type: "choice", choice: "partial", confidence: 0.8 },
			i0_slip: { type: "noul", noul: 0.1 },
		});
		expect(partial?.outcome).toBe("partial");
		expect(partial?.slip).toBe(false);
		expect(partial?.feedback).toMatch(/conceptual piece/);

		const unsure = judgmentFromAnswers(0, {
			i0_outcome: { type: "choice", choice: "correct", confidence: WRITTEN_GRADE_CONFIDENCE - 0.01 },
			i0_slip: { type: "noul", noul: 0.99 },
		});
		expect(unsure).toBeNull();
	});

	it("marks a careless error as a slip and a hinted answer as partial", () => {
		const slip = judgmentFromAnswers(0, {
			i0_outcome: { type: "choice", choice: "correct", confidence: 0.9 },
			i0_slip: { type: "noul", noul: 0.91 },
		});
		expect(slip).toMatchObject({ outcome: "correct", slip: true });

		const echoed = judgmentFromAnswers(0, {
			i0_outcome: { type: "choice", choice: "correct", confidence: 0.9 },
			i0_slip: { type: "noul", noul: 0.1 },
			i0_echoed: { type: "noul", noul: 0.95 },
		});
		expect(echoed?.outcome).toBe("partial");
		expect(echoed?.slip).toBe(false);
	});
});

describe("quiz tool with a grader", () => {
	it("records the written answer without asking the tutor to grade it", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Derivative" });
		const recorded: QuizOutcome[] = [];
		const ui: ToolUI = {
			async quiz() {
				return { dontKnow: false, selected: [], text: "$3x^2$" };
			},
			quizRecorded: (o) => recorded.push(o),
			async ask() {
				return { selected: [] };
			},
		};
		const grader: AnswerGrader = {
			async grade(items) {
				expect(items[0].answer).toBe("$3x^2$");
				return [{ outcome: "correct", feedback: "That matches.", slip: false }];
			},
		};
		const submitted = await toolByName("quiz")!.run(
			{ concept: "Derivative", question: "Differentiate $x^3$", format: "free", referenceAnswer: "$3x^2$", explanation: "Power rule", difficulty: 3 },
			{ store, ui, session: { id: "free" }, grader },
		);
		expect(submitted.text).toContain("Already graded");
		expect(submitted.text).not.toContain("Grade it now");
		expect(recorded[0].grade.outcome).toBe("correct");
		expect((await store.resolve("Derivative"))!.stats.attempts).toBe(1);
	});

	it("falls back to the tutor when Jev is unsure or unreachable", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Derivative" });
		const ui: ToolUI = {
			async quiz() {
				return { dontKnow: false, selected: [], text: "hello" };
			},
			async ask() {
				return { selected: [] };
			},
		};
		const unsure: AnswerGrader = { async grade() { return [null]; } };
		const deferred = await toolByName("quiz")!.run(
			{ concept: "Derivative", question: "Differentiate $x^3$", format: "free", referenceAnswer: "$3x^2$", explanation: "Power rule", difficulty: 3 },
			{ store, ui, grader: unsure },
		);
		expect(deferred.text).toContain("call grade_answer");

		const down: AnswerGrader = { async grade() { throw new Error("offline"); } };
		const fallback = await judgmentsFor(down, [{ question: "q", reference: "a", answer: "b" }]);
		expect(fallback).toEqual([null]);
	});
});
