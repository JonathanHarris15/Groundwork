import { describe, expect, it } from "vitest";
import {
	courseForTutor,
	courseTeachingText,
	groundCourse,
	mergeCourse,
	parseCourseGrounding,
	quizMethodGap,
	type SourceDoc,
} from "../src/course-grounding";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";
import type { PreparedQuiz } from "../src/quiz";

const DAY = "2026-10-22";

const SLIDES = `--- slide 4 ---
Integration by parts
We always choose u by LIATE.
Tabular integration is an alternate method, differentiating one column and integrating the other.
`;

const OTHER = `--- slide 2 ---
Integration by parts
For integration by parts we always use the tabular method, differentiating one column and integrating the other column completely.
`;

function doc(path: string, text: string): SourceDoc {
	return { path, name: path.split("/").pop() ?? path, text };
}

describe("course grounding", () => {
	it("teaches and quizzes the professor's method when the slides prefer one of two", () => {
		const grounded = groundCourse("Integration by parts", [doc("resources/Lecture 7.pptx", SLIDES)], undefined, DAY);
		expect(grounded.rejected).toEqual([]);
		expect(grounded.grounding.method.preferred?.toLowerCase()).toContain("liate");
		expect(grounded.grounding.method.alternates.join(" ").toLowerCase()).toContain("tabular");
		expect(grounded.grounding.excerpts.some((excerpt) => excerpt.quote.includes("LIATE"))).toBe(true);
		expect(grounded.grounding.excerpts[0]?.provenance).toMatch(/Lecture 7\.pptx, slide 4/);
		expect(grounded.grounding.excerpts[0]?.imported).toBe(DAY);

		const teach = courseTeachingText(grounded.grounding);
		expect(teach).toContain("Preferred method:");
		expect(teach).toContain("LIATE");
		expect(teach).toMatch(/Teach this method/);

		const tabular = "Use tabular integration. Differentiate one column and integrate the other.";
		expect(quizMethodGap(tabular, grounded.grounding)).toMatch(/preferred method/i);
		const preferred = "Choose u by LIATE, then differentiate u and integrate dv.";
		expect(quizMethodGap(preferred, grounded.grounding)).toBeNull();
		expect(courseForTutor(grounded.grounding).preferredMethod).toMatch(/LIATE/);
	});

	it("keeps both methods and does not force one when the sources disagree", () => {
		const left = groundCourse("Integration by parts", [doc("resources/Lecture 7.pptx", SLIDES)], undefined, DAY);
		const right = groundCourse("Integration by parts", [doc("resources/Lecture 8.pptx", OTHER)], undefined, DAY);
		const merged = mergeCourse(left.grounding, right.grounding);
		expect(merged.method.conflict).toMatch(/disagree/i);
		expect(merged.method.preferred).toBeUndefined();
		expect(merged.excerpts.length).toBeGreaterThan(1);
		expect(quizMethodGap("Either method is fine.", merged)).toBeNull();
		expect(courseTeachingText(merged)).toMatch(/Name both methods/);
	});

	it("rejects a fabricated quote, keeps an existing concept with no course section, and still teaches after the file is deleted", async () => {
		const io = new MemoryVaultIO();
		io.files.set("resources/Lecture 7.pptx.md", SLIDES);
		const store = new KnowledgeStore(io, { now: () => new Date("2026-10-22T15:00:00Z") });
		await store.ensureLayout();
		await store.upsertConcept({ title: "Integration by parts", summary: "A way to integrate a product." });
		const before = await store.resolve("Integration by parts");
		expect(parseCourseGrounding(before!.body).excerpts).toEqual([]);

		await expect(
			store.upsertConcept({
				title: "Integration by parts",
				course: { excerpts: [{ quote: "We never use LIATE under any circumstance.", path: "resources/Lecture 7.pptx.md" }] },
			}),
		).rejects.toThrow(/Rejected a quote that is not in the source text/);

		await store.setGoal(
			{
				title: "Calculus midterm",
				targets: ["Integration by parts"],
				sources: ["resources/Lecture 7.pptx.md"],
				nodes: [
					{
						title: "Integration by parts",
						course: {
							excerpts: [{ quote: "We always choose u by LIATE.", path: "resources/Lecture 7.pptx.md", provenance: "Lecture 7.pptx, slide 4" }],
							preferredMethod: "Choose u by LIATE before differentiating.",
							alternates: ["Tabular integration, differentiating one column and integrating the other."],
						},
					},
				],
			},
			{ judgments: "off" },
		);
		const stored = await store.resolve("Integration by parts");
		expect(stored!.body).toContain("## From your course");
		expect(stored!.body).toContain("We always choose u by LIATE.");
		expect(stored!.body).not.toMatch(/resources\//);
		expect(stored!.body).not.toMatch(/\[\[[^\]]*\]\]/);

		await io.remove("resources/Lecture 7.pptx.md");
		expect(await io.exists("resources/Lecture 7.pptx.md")).toBe(false);
		const after = await store.resolve("Integration by parts");
		expect(after!.body).toContain("We always choose u by LIATE.");
		const read = await toolByName("get_concepts")!.run({ concepts: ["Integration by parts"] }, { store });
		expect(read.text).toContain("LIATE");
		expect(read.text).toContain("Preferred method");

		const goal = await toolByName("get_goal")!.run({ goal: "Calculus midterm" }, { store });
		expect(goal.text).toContain("LIATE");

		const missed = await toolByName("quiz")!.run(
			{
				concept: "Integration by parts",
				question: "Integrate x e^x with tabular integration.",
				solution: "Differentiate one column and integrate the other.",
				answer: "tabular",
				options: [
					{ label: "Tabular integration", value: "tabular" },
					{ label: "LIATE", value: "liate" },
				],
				correctAnswer: "tabular",
				explanation: "Tabular integration differentiates one column.",
				difficulty: 3,
			},
			{ store, ui: { quiz: async () => null, ask: async () => null } },
		);
		expect(missed.isError).toBe(true);
		expect(missed.text).toMatch(/LIATE/);

		const seen: PreparedQuiz[] = [];
		const ui: ToolUI = {
			quiz: async (quiz) => {
				seen.push(quiz);
				return { dontKnow: false, selected: ["liate"] };
			},
			ask: async () => null,
		};
		const graded = await toolByName("quiz")!.run(
			{
				concept: "Integration by parts",
				question: "Which factor do we choose as u, by LIATE?",
				solution: "Choose u by LIATE, then differentiate u.",
				answer: "the logarithmic factor",
				options: [
					{ label: "the logarithmic factor", value: "liate" },
					{ label: "the exponential factor", value: "exp" },
				],
				correctAnswer: "liate",
				explanation: "We choose u by LIATE before differentiating.",
				difficulty: 3,
			},
			{ store, ui },
		);
		expect(graded.isError).toBeFalsy();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.courseBrief).toMatch(/LIATE/);
		expect(graded.text).toMatch(/Preferred method/);
		expect(await store.resolve("Integration by parts")).toBeTruthy();
	});
});
