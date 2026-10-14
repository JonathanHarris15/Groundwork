import { describe, expect, it } from "vitest";
import { announcesQuestion, repairNote } from "../src/turn-repair";

describe("announced questions", () => {
	const announced = [
		"Here's a question.",
		"Here’s a question.",
		"Here is a problem.",
		"Let's try one.",
		"Let’s try this.",
		"Lets try another question.",
		"Try this one.",
		"Quick question.",
		"A question for you.",
		"Let me quiz you.",
		"See if you can.",
	];
	const plain = ["The chain rule multiplies rates.", "The answer is 2.", "A question mark is not a quiz.", "Here is the derivative."];

	it("recognizes an announcement and ignores a plain answer", () => {
		for (const text of announced) expect(announcesQuestion(text), text).toBe(true);
		for (const text of plain) expect(announcesQuestion(text), text).toBe(false);
	});

	it("asks for a card once, and stays quiet once a card or a goal already ran", () => {
		const note = repairNote({
			userText: "I want to be able to do the homework",
			assistantText: "Let's try one.",
			calledQuestion: false,
			calledGoal: false,
		});
		expect(note).toContain("<tutor_repair>");
		expect(note).toContain("Call quiz");
		expect(note).toContain("Call set_goal");
		expect(
			repairNote({
				userText: "I want to be able to do the homework",
				assistantText: "Let's try one.",
				calledQuestion: true,
				calledGoal: true,
			}),
		).toBeNull();
		expect(
			repairNote({
				userText: "what's the chain rule?",
				assistantText: "The chain rule multiplies rates.",
				calledQuestion: false,
				calledGoal: false,
			}),
		).toBeNull();
	});
});
