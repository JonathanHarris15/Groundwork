import { describe, expect, it } from "vitest";
import type { PreparedQuiz } from "@groundwork/core";
import { pendingQuiz } from "../src/open-quiz";

const quiz: PreparedQuiz = {
	id: "q1",
	concept: "Chain rule",
	question: "Differentiate sin(x^2).",
	format: "free",
	options: [],
	correct: [],
	reference: "2x cos(x^2)",
	explanation: "Chain rule.",
	difficulty: 3,
	kind: "check",
	multiSelect: false,
};

describe("pendingQuiz", () => {
	it("returns the quiz that was open when the chat was saved", () => {
		expect(pendingQuiz({ openQuiz: quiz, items: [{ kind: "assistant", text: "Here is why." }] })).toEqual(quiz);
	});

	it("stays available when a different quiz was already answered", () => {
		expect(pendingQuiz({ openQuiz: quiz, items: [{ kind: "quiz", quiz: { id: "earlier" } }] })).toEqual(quiz);
	});

	it("drops the quiz once that question has an answer in the chat", () => {
		expect(pendingQuiz({ openQuiz: quiz, items: [{ kind: "quiz", quiz: { id: "q1" } }] })).toBeNull();
	});

	it("drops a saved quiz that cannot be shown", () => {
		expect(pendingQuiz({ items: [] })).toBeNull();
		expect(pendingQuiz({ openQuiz: { ...quiz, id: " " }, items: [] })).toBeNull();
		expect(pendingQuiz({ openQuiz: { ...quiz, question: "" }, items: [] })).toBeNull();
		expect(pendingQuiz({ openQuiz: { ...quiz, concept: "" }, items: [] })).toBeNull();
		expect(pendingQuiz({ openQuiz: { ...quiz, format: "essay" }, items: [] })).toBeNull();
		expect(pendingQuiz({ openQuiz: { ...quiz, options: undefined }, items: [] })).toBeNull();
	});
});
