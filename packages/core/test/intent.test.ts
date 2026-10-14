import { describe, expect, it } from "vitest";
import { classifyLearnerAsk, learnerOptedIntoStudy, statesLearningObjective, STUDY_FOLLOW_UP, studyToolBlock, visibleAsk } from "../src/intent";
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
		expect(studyToolBlock("set_goal", [{ role: "user", text: "summarize my documents" }])?.isError).toBe(true);
		expect(studyToolBlock("survey_documents", [{ role: "user", text: "summarize my documents" }])).toBeNull();
	});

	it("starts a goal when they state an objective, and not on a plain question", () => {
		const objectives = [
			"I'm working toward being able to do the homework",
			"I am working towards being able to finish the problem set",
			"I want to be able to do related rates",
			"I'd like to be able to integrate by parts",
			"I need to be able to write a proof",
			"My goal is to understand eigenvalues",
			"I'm studying for the midterm",
			"I have a homework due Friday",
			"I'm working on the homework",
			"I'm trying to learn the chain rule",
			"working toward the exam",
		];
		for (const text of objectives) {
			expect(statesLearningObjective(text), text).toBe(true);
			expect(classifyLearnerAsk(text), text).toBe("study");
			expect(studyToolBlock("set_goal", [{ role: "user", text }]), text).toBeNull();
		}
		const plain = [
			"what's the chain rule?",
			"solve this",
			"can you show me a graph of x^2?",
			"summarize my documents",
			"put together a study guide for derivatives",
			"make flashcards",
			"I already know the chain rule",
			"I have the final answer",
			"solve problem 4 on the homework",
			"what does the homework ask?",
			"explain the chain rule",
			"I finished the homework",
		];
		for (const text of plain) {
			expect(statesLearningObjective(text), text).toBe(false);
			expect(classifyLearnerAsk(text), text).not.toBe("study");
		}
	});

	it("allows mark_known without study opt-in when they disclose prior knowledge", () => {
		const claiming = [{ role: "user" as const, text: "I already know the chain rule" }];
		expect(classifyLearnerAsk(claiming[0]!.text)).toBe("answer");
		expect(studyToolBlock("mark_known", claiming)).toBeNull();
		expect(studyToolBlock("upsert_concept", claiming)?.isError).toBe(true);
		expect(studyToolBlock("quiz", claiming)?.isError).toBe(true);
	});
});
