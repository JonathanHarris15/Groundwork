import { describe, expect, it } from "vitest";
import { classifyLearnerAsk, learnerOptedIntoStudy, STUDY_FOLLOW_UP, studyToolBlock, visibleAsk } from "../src/intent";
import { practiceTestRequest, workingGoalNote } from "../src/prompt";

describe("classifyLearnerAsk", () => {
	it("answers a direct question", () => {
		expect(classifyLearnerAsk("can you show me a graph of x^2?")).toBe("answer");
		expect(classifyLearnerAsk("what's the chain rule")).toBe("answer");
		expect(classifyLearnerAsk("solve this")).toBe("answer");
		expect(classifyLearnerAsk("summarize the chain rule")).toBe("answer");
		expect(classifyLearnerAsk("I have the final answer")).toBe("answer");
	});

	it("surveys documents without starting study", () => {
		expect(classifyLearnerAsk("summarize my documents")).toBe("survey");
		expect(classifyLearnerAsk("what's in these notes")).toBe("survey");
		expect(classifyLearnerAsk("survey the context documents")).toBe("survey");
	});

	it("treats a study guide or flashcards as an artifact", () => {
		expect(classifyLearnerAsk("put together a study guide for derivatives")).toBe("artifact");
		expect(classifyLearnerAsk("I want a study guide")).toBe("artifact");
		expect(classifyLearnerAsk("make flashcards")).toBe("artifact");
		expect(classifyLearnerAsk("let's build a study guide")).toBe("artifact");
	});

	it("opts in only on an explicit study ask", () => {
		expect(classifyLearnerAsk("help me learn derivatives")).toBe("study");
		expect(classifyLearnerAsk("quiz me")).toBe("study");
		expect(classifyLearnerAsk("I have a Calc 1 final Dec 9, help me study")).toBe("study");
		expect(classifyLearnerAsk("make a goal")).toBe("study");
		expect(classifyLearnerAsk("Let's build the chain rule.")).toBe("study");
		expect(classifyLearnerAsk("Quiz me on Slope of a line.")).toBe("study");
		expect(classifyLearnerAsk("Teach me derivatives.")).toBe("study");
		expect(classifyLearnerAsk("Review limits with me.")).toBe("study");
		expect(classifyLearnerAsk(practiceTestRequest("derivatives"))).toBe("study");
		expect(classifyLearnerAsk("prep me for the midterm")).toBe("study");
	});

	it("ignores the hidden working-goal note", () => {
		const text = [workingGoalNote({ title: "Calc final", left: 3 }), "can you show me a graph of x^2?"].join("\n\n");
		expect(visibleAsk(text)).not.toMatch(/working_goal/);
		expect(classifyLearnerAsk(text)).toBe("answer");
	});

	it("lets a yes after the follow-up opt in, and a bare yes does not", () => {
		expect(learnerOptedIntoStudy([{ role: "user", text: "yes" }])).toBe(false);
		expect(
			learnerOptedIntoStudy([
				{ role: "user", text: "put together a study guide for derivatives" },
				{ role: "assistant", text: `Here is the guide.\n\n${STUDY_FOLLOW_UP}` },
				{ role: "user", text: "yes" },
			]),
		).toBe(true);
		expect(
			learnerOptedIntoStudy([
				{ role: "user", text: "make flashcards" },
				{ role: "assistant", text: STUDY_FOLLOW_UP },
				{ role: "user", text: "no thanks" },
			]),
		).toBe(false);
	});

	it("refuses a goal tool until they opt in, then allows the study flow", () => {
		const asking = [{ role: "user" as const, text: "can you show me a graph of x^2?" }];
		expect(studyToolBlock("set_goal", asking)?.isError).toBe(true);
		expect(studyToolBlock("quiz", asking)?.isError).toBe(true);
		expect(studyToolBlock("show_figure", asking)).toBeNull();
		expect(studyToolBlock("save_flashcard", [{ role: "user", text: "make flashcards" }])).toBeNull();
		expect(studyToolBlock("set_goal", [{ role: "user", text: "I have a Calc 1 final Dec 9, help me study" }])).toBeNull();
		expect(studyToolBlock("practice_test", [{ role: "user", text: practiceTestRequest() }])).toBeNull();
		expect(studyToolBlock("ingest_exam_materials", [{ role: "user", text: "help me study for the midterm" }])).toBeNull();
	});
});
