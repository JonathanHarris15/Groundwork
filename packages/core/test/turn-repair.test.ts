import { describe, expect, it } from "vitest";
import { announcesQuestion, asciiDiagram, inventsAppBehavior, repairNote } from "../src/turn-repair";

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

	it("repairs an invented confirmation gate into a goal and a quiz", () => {
		const apology =
			"Ah! My apologies—the interactive quiz card didn't pop up because our system requires a formal confirmation step before it can initialize the goal tracker and start launching interactive quizzes. Do you want to study this or make a goal for it?";
		expect(inventsAppBehavior(apology)).toBe(true);
		expect(inventsAppBehavior("The chain rule multiplies rates.")).toBe(false);
		const note = repairNote({
			userText: "I'm working toward being able to do the homework",
			assistantText: apology,
			calledQuestion: false,
			calledGoal: false,
		});
		expect(note).toContain("did not load");
		expect(note).toContain("Call quiz");
		expect(note).toContain("Call set_goal");
		expect(note).toContain("Do not ask whether to study or make a goal");
		expect(
			repairNote({
				userText: "put together a study guide for derivatives",
				assistantText: "Want me to set this up as a goal and quiz you on it?",
				calledQuestion: false,
				calledGoal: false,
			}),
		).toBeNull();
	});

	it("turns a Quick Check into a free-response card and stays quiet once a card ran", () => {
		const callout = [
			"A perceptron labels a point $x$ with $\\operatorname{sign}(w \\cdot x + b)$.",
			"",
			"> [!question] Quick Check",
			"> What weights $w$ and bias $b$ make $\\operatorname{sign}(w \\cdot x + b)$ match the labels?",
			">",
			"> Hint: try small integers.",
		].join("\n");
		const note = repairNote({
			userText: "explain the perceptron",
			assistantText: callout,
			calledQuestion: false,
			calledGoal: false,
		});
		expect(note).toContain('format "free"');
		expect(note).toContain("referenceAnswer");
		expect(note).toContain("weights");
		expect(note).toContain("bias");
		expect(note).not.toContain("Hint:");
		expect(note).not.toContain("Call set_goal");
		expect(
			repairNote({
				userText: "explain the perceptron",
				assistantText: callout,
				calledQuestion: true,
				calledGoal: false,
			}),
		).toBeNull();
	});

	it("turns a trailing question into a free-response card", () => {
		const note = repairNote({
			userText: "explain the perceptron",
			assistantText: ["The boundary is $\\operatorname{sign}(w \\cdot x + b)$.", "", "What weights and bias make that match the labels?", "", "Hint: try small integers."].join("\n"),
			calledQuestion: false,
			calledGoal: false,
		});
		expect(note).toContain('format "free"');
		expect(note).toContain("What weights and bias make that match the labels?");
		expect(note).not.toContain("Hint:");
	});

	it("leaves a rhetorical question that the same message answers", () => {
		expect(
			repairNote({
				userText: "explain the sign chart",
				assistantText: "Why does the sign flip? The factors change sign between the roots.",
				calledQuestion: false,
				calledGoal: false,
			}),
		).toBeNull();
		expect(
			repairNote({
				userText: "explain the sign chart",
				assistantText: ["> [!question] Why does the sign flip?", "", "The factors change sign between the roots."].join("\n"),
				calledQuestion: false,
				calledGoal: false,
			}),
		).toBeNull();
	});

	it("turns an ASCII sketch into a figure and leaves a program and inline math alone", () => {
		const sketch = [
			"```",
			"          x3",
			"          |",
			"    ------+------",
			"   /      |      \\",
			"  /   *   |   *   \\",
			" /________|________\\",
			"         / \\",
			"       x1   x2",
			"```",
			"The plane separates the two classes.",
		].join("\n");
		expect(asciiDiagram(sketch)).toBe(true);
		expect(asciiDiagram("```python\nimport numpy as np\nprint(1)\n```")).toBe(false);
		expect(asciiDiagram("A short inline mark such as x^2.")).toBe(false);
		expect(asciiDiagram("```\n| term | value |\n| --- | --- |\n| slope | 2 |\n```")).toBe(false);
		const note = repairNote({
			userText: "Show me the paraboloid that lifts points to x3 = r^2 with a separating plane.",
			assistantText: sketch,
			calledQuestion: false,
			calledGoal: false,
		});
		expect(note).toContain("Call show_figure");
		expect(note).toContain("numpy");
		expect(note).toContain("figure.png");
		expect(note).not.toContain("Call quiz");
		expect(note).not.toContain("Call set_goal");
		expect(
			repairNote({
				userText: "Show me the paraboloid that lifts points to x3 = r^2 with a separating plane.",
				assistantText: sketch,
				calledQuestion: false,
				calledGoal: false,
				calledFigure: true,
			}),
		).toBeNull();
	});
});
