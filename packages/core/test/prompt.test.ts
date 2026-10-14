import { describe, expect, it } from "vitest";
import { STUDY_FOLLOW_UP } from "../src/intent";
import { buildSystemPrompt, promptParts } from "../src/prompt";
import { toolByName } from "../src/tools";

describe("teaching method", () => {
	const method = buildSystemPrompt();

	it("introduces a node by one difference, then a small check on a new case", () => {
		expect(method).toContain("Unconditional truths first");
		expect(method).toContain("show one difference");
		expect(method).toContain("Two cases where it holds");
		expect(method).toContain("One minimal pair");
		expect(method).toContain("One fully worked example");
		expect(method).toContain("Use none of the labeled examples as the question");
		expect(method).toContain("one more question at the required level");
	});

	it("re-teaches a miss in the other representation", () => {
		expect(method).toContain("Re-teach in the other representation");
		expect(method).toContain("wrong kind of thing");
	});

	it("answers first and starts a goal only after they opt in", () => {
		expect(method.startsWith("# Answer first")).toBe(true);
		expect(method).toContain(STUDY_FOLLOW_UP);
		expect(method).toContain("Do not end with a question that checks them");
		expect(method).toContain("Then stop. No goal, no concepts, no quiz");
		expect(method).toContain("survey_documents");
		expect(method).toContain("A list of file names is not the summary");
		expect(method).toContain("Start this shape only after they opt in");
		expect(method).toContain("## An objective");
		expect(method).toContain("call `set_goal` and `quiz` on this turn");
		expect(method).toContain("## What you may say about the app");
		expect(method).toContain("Never invent how Groundwork");
		expect(method).toContain("say it did not load");
		expect(method).not.toContain("or make a goal");
		expect(method).toContain("## A question they answer");
		expect(method).toContain("The card is the question");
		expect(method).toContain("let's try one");
		expect(method).toContain("## A picture");
		expect(method).toContain("numpy");
		expect(method).toContain("matplotlib");
		expect(method).toContain("figure.png");
		expect(method).toContain("Do not draw ASCII art");
		expect(promptParts().find((part) => part.id === "figures")?.required).toBe(true);
		const figure = toolByName("show_figure");
		expect(figure?.description).toContain("kind program");
		expect(figure?.description).toContain("numpy");
		expect(figure?.description).toContain("matplotlib");
		expect(figure?.description).toContain("figure.png");
		expect(figure?.description).toContain("x**2 + y**2");
		expect(figure?.description).not.toMatch(/or make a goal/);
		expect(method).toContain("The dropdown does not opt them in");
		expect(method).toContain("Start this only when they ask to study for one");
	});

	it("believes prior knowledge and records it with mark_known", () => {
		expect(method).toContain("## Prior knowledge");
		expect(method).toContain("mark_known");
		expect(method).toContain("believe them");
		expect(method).toContain("Do not quiz them to verify");
	});

	it("names the default read and write folders, including a file to submit", () => {
		expect(method).toContain("`resources/`");
		expect(method).toContain("`submissions/`");
		expect(method).toContain("write_submission_file");
	});
});
