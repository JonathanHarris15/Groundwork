import { describe, expect, it } from "vitest";
import {
	buildExamBlueprint,
	classifyMaterial,
	examPrepInstruction,
	extractPdfText,
	materialFromVaultFile,
	shouldAutoIngest,
} from "../src/exam";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

const HW = `# Homework 2 — Derivatives

1. Compute the derivative of f(x) = x^3.
2. Use the chain rule to differentiate sin(x^2).
3. Prove that the derivative of a constant is zero.

Show your work.
`;

const LECTURE = `# Lecture 4: The Chain Rule

## Definition
The chain rule says how to differentiate a composition.

## Examples
Compute a few compositions.
`;

const PRACTICE = `# Practice Midterm

Name:

1. (10 pts) Limits. Evaluate lim x->0 sin(x)/x.
2. (15 pts) Differentiate using the product rule.
3. (20 pts) Using the chain rule, find d/dx of e^{x^2}.
`;

function pdfWith(text: string): Uint8Array {
	const body = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
	const src = `%PDF-1.1\n1 0 obj << /Length ${body.length} >> stream\n${body}\nendstream\nendobj\n%%EOF\n`;
	return new TextEncoder().encode(src);
}

describe("exam material parsing", () => {
	it("classifies lectures, homeworks, study guides, and exams", () => {
		expect(classifyMaterial("HW2.pdf", "Homework 2")).toBe("homework");
		expect(classifyMaterial("Lecture 3 slides.pdf", "")).toBe("lecture");
		expect(classifyMaterial("calc-study-guide.md", "")).toBe("study_guide");
		expect(classifyMaterial("practice_exam.pdf", "Practice exam 100 points")).toBe("practice_exam");
		expect(classifyMaterial("Midterm.pdf", "Name:  Honor code")).toBe("exam");
	});

	it("pulls topics and required levels from homework + lecture + practice exam", () => {
		const plan = buildExamBlueprint(
			[
				{ name: "Lecture 4.md", kind: "lecture", text: LECTURE },
				{ name: "HW2.md", kind: "homework", text: HW },
				{ name: "practice midterm.md", kind: "practice_exam", text: PRACTICE },
			],
			{ userText: "help me prep for the midterm" },
		);
		expect(plan.examKind).toBe("midterm");
		const titles = plan.topics.map((t) => t.title.toLowerCase());
		expect(titles.some((t) => t.includes("chain rule"))).toBe(true);
		const chain = plan.topics.find((t) => /chain rule/i.test(t.title))!;
		expect(chain.requiredLevel).toBeGreaterThanOrEqual(3);
		expect(chain.sources.length).toBeGreaterThan(1);
		expect(plan.mustKnow.length).toBeGreaterThan(0);
		expect(examPrepInstruction(plan)).toContain("need level");
		expect(examPrepInstruction(plan)).toContain("sources");
	});

	it("drops document names and keeps the ideas inside them", () => {
		const plan = buildExamBlueprint([
			{
				name: "Lecture Note 1.pdf",
				kind: "lecture",
				text: "# Lecture Note 1 fluency\n\n# Linear functions\n\nA linear function preserves addition.\n\n# Practice Exam 1\n",
			},
		]);
		const titles = plan.topics.map((t) => t.title);
		expect(titles).toContain("Linear Functions");
		expect(titles.some((t) => /fluency|practice exam|lecture note/i.test(t))).toBe(false);
		expect(plan.notes.join("\n")).toMatch(/not made into concepts/);

		const empty = buildExamBlueprint([{ name: "Lecture Note 1.pdf", kind: "notes", text: "" }]);
		expect(empty.topics).toEqual([]);
		expect(empty.notes.join("\n")).toMatch(/not made into concepts/);
	});

	it("stores the lecture file on the goal and keeps it out of the concept note", async () => {
		const io = new MemoryVaultIO();
		io.files.set("resources/Lecture 4.md", LECTURE);
		const store = new KnowledgeStore(io);
		await store.ingestExamMaterials({ files: ["resources/Lecture 4.md"], createGoal: true });
		const concepts = [...(await store.concepts()).values()];
		expect(concepts.some((c) => /chain rule/i.test(c.title))).toBe(true);
		for (const concept of concepts) {
			expect(concept.title).not.toMatch(/lecture/i);
			expect(concept.body).not.toMatch(/lecture/i);
			expect(concept.body).not.toMatch(/resources\//i);
		}
		const goal = (await store.goals())[0];
		expect(goal.sources).toEqual(["resources/Lecture 4.md"]);
		expect(await io.read(goal.path)).toContain("[[resources/Lecture 4.md]]");
	});

	it("extracts text from a simple PDF so a homework file still yields topics", async () => {
		const io = new MemoryVaultIO();
		io.writeBinary("resources/HW1.pdf", pdfWith("Homework 1: Compute the derivative of x^2"));
		const src = await materialFromVaultFile(io, "resources/HW1.pdf");
		expect(src.kind).toBe("homework");
		expect(src.text).toMatch(/Compute the derivative/i);
		expect(extractPdfText(pdfWith("Practice exam Limits"))).toMatch(/Practice exam Limits/);
	});

	it("auto-ingests coursework files or an exam-prep message, not a lone unlabeled photo", () => {
		expect(shouldAutoIngest(["HW2.md"], "")).toBe(true);
		expect(shouldAutoIngest(["notes.png"], "prep me for the midterm")).toBe(true);
		expect(shouldAutoIngest(["vacation.png"], "what is this?")).toBe(false);
	});

	it("ingest_exam_materials writes an exam plan and a goal with required levels", async () => {
		const io = new MemoryVaultIO();
		io.files.set("resources/HW2.md", HW);
		io.files.set("resources/practice midterm.md", PRACTICE);
		const store = new KnowledgeStore(io);
		const r = await toolByName("ingest_exam_materials")!.run(
			{ files: ["resources/HW2.md", "resources/practice midterm.md"], userText: "midterm prep", createGoal: true },
			{ store },
		);
		expect(r.summary).toMatch(/Exam plan/);
		expect(r.text).toMatch(/requiredLevel/);
		const plans = await store.examPlans();
		expect(plans.length).toBe(1);
		const goal = (await store.goals())[0];
		expect(Object.keys(goal.requiredLevels).length).toBeGreaterThan(0);
		expect(goal.sources).toEqual(["resources/HW2.md", "resources/practice midterm.md"]);
		expect(goal.targets.length + goal.built.length).toBeGreaterThan(0);
		const concepts = [...(await store.concepts()).values()];
		expect(concepts.some((c) => c.title === goal.title)).toBe(false);
		const report = await store.goalReport(goal.title);
		expect(report.analysis.frontier.length).toBeGreaterThan(0);
		expect(report.goal.targets.length).toBeGreaterThan(0);
	});
});
