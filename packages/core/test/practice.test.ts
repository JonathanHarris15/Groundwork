import { beforeEach, describe, expect, it } from "vitest";
import { clearLadder, ladderFor } from "../src/diagnose";
import type { QuizOutcome } from "../src/grading";
import { MemoryVaultIO } from "../src/io";
import type { PracticeTestInput, PreparedTest, TestReport, TestResponse } from "../src/practice";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";

const session = { id: "practice" };

const testInput: PracticeTestInput = {
	title: "Derivatives practice",
	goal: "Understand the derivative",
	timeLimitMinutes: 20,
	questions: [
		{
			concept: "Slope of a line",
			question: "Slope through $(1,2)$ and $(3,8)$?",
			options: [
				{ label: "$3$", value: "three" },
				{ label: "$6$", value: "six", misconception: "forgets to divide by the run" },
			],
			correctAnswer: "three",
			explanation: "Rise over run.",
			difficulty: 2,
		},
		{
			concept: "Derivative",
			question: "Find $f'(x)$ for $f(x)=x^3$.",
			format: "free",
			referenceAnswer: "$3x^2$",
			explanation: "Power rule.",
			difficulty: 3,
		},
		{
			concept: "Derivative",
			question: "Find $f'(x)$ for $f(x)=\\sin(x^2)$.",
			format: "free",
			referenceAnswer: "$2x\\cos(x^2)$",
			explanation: "Chain rule.",
			difficulty: 4,
		},
		{
			concept: "Slope of a line",
			question: "Slope of a horizontal line?",
			options: [
				{ label: "$0$", value: "zero" },
				{ label: "undefined", value: "undef", misconception: "mixes up horizontal and vertical" },
			],
			correctAnswer: "zero",
			explanation: "No rise.",
			difficulty: 1,
		},
	],
};

describe("practice tests", () => {
	let store: KnowledgeStore;
	let io: MemoryVaultIO;
	let shown: PreparedTest | undefined;
	let graded: TestReport | undefined;
	let answer: (t: PreparedTest) => TestResponse;
	const ui: ToolUI = {
		async quiz() {
			return null;
		},
		async ask() {
			return { selected: [] };
		},
		async test(t) {
			shown = t;
			return answer(t);
		},
		testGraded(r) {
			graded = r;
		},
	};

	beforeEach(async () => {
		clearLadder(session.id);
		shown = graded = undefined;
		io = new MemoryVaultIO();
		store = new KnowledgeStore(io);
		await store.ensureLayout();
		await store.upsertConcept({ title: "Slope of a line" });
		await store.upsertConcept({ title: "Derivative", prerequisites: ["Slope of a line"] });
	});

	it("grades choice on submit, waits for the tutor on free response, then evaluates and seeds remediation", async () => {
		answer = (t) => ({
			answers: {
				[t.questions[0].id]: { dontKnow: false, selected: ["three"] },
				[t.questions[1].id]: { dontKnow: false, selected: [], text: "$3x^2$" },
				[t.questions[2].id]: { dontKnow: false, selected: [], text: "$\\cos(x^2)$" },
			},
			elapsedSeconds: 305,
		});
		const started = await toolByName("practice_test")!.run(testInput, { store, ui, session });
		expect(started.isError).toBeFalsy();
		expect(shown!.questions.map((q) => q.kind)).toEqual(["test", "test", "test", "test"]);
		expect(started.text).toContain("2 free-response answers still need your judgment");
		expect(started.text).toContain("Reference answer: $2x\\cos(x^2)$");
		expect(graded).toBeUndefined();
		expect((await store.resolve("Slope of a line"))!.stats.attempts).toBe(2);
		expect((await store.resolve("Derivative"))!.stats.attempts).toBe(0);

		const testId = /test_id "([^"]+)"/.exec(started.text)![1];
		const partly = await toolByName("grade_practice_test")!.run(
			{ test_id: testId, grades: [{ question: 2, outcome: "correct", feedback: "Right." }] },
			{ store, ui, session },
		);
		expect(partly.text).toContain("Still ungraded: question 3");
		expect(graded).toBeUndefined();

		const done = await toolByName("grade_practice_test")!.run(
			{ test_id: testId, grades: [{ question: 3, outcome: "partial", feedback: "Missing the inner derivative $2x$.", misconception: "forgets the chain rule" }] },
			{ store, ui, session },
		);
		expect(graded).toBeDefined();
		expect(graded!.earned).toBe(2.5);
		expect(graded!.possible).toBe(4);
		expect(graded!.results.map((r) => r.outcome)).toEqual(["correct", "correct", "partial", "dont_know"]);
		expect(graded!.results[3].response.note).toBe("Left blank");
		expect(graded!.byConcept.map((c) => [c.concept, c.earned])).toEqual([
			["Slope of a line", 1],
			["Derivative", 1.5],
		]);
		expect(done.text).toContain("2.5/4 (63%)");
		expect(done.text).toContain("teach forward from the first one they get right");
		expect(done.text).toContain("forgets the chain rule");

		const notePath = graded!.notePath!;
		expect(notePath).toMatch(/^tests\/\d{4}-\d{2}-\d{2} Derivatives practice\.md$/);
		const note = io.files.get(notePath)!;
		expect(note).toContain("score: 2.5/4");
		expect(note).toContain("[[Derivative]]");
		expect(note).toContain("**Model answer:**");
		expect(note).toContain("Missing the inner derivative");
		expect(note).toContain("5:05");

		expect((await store.resolve("Derivative"))!.stats.attempts).toBe(2);
		expect(ladderFor(session.id)!.missed[0]).toMatchObject({ concept: "Slope of a line", difficulty: 1, outcome: "dont_know" });

		const overview = await store.overview();
		expect(overview.practiceTests[0]).toMatchObject({ title: "Derivatives practice", score: "2.5/4", weakest: ["Slope of a line", "Derivative"] });

		expect((await toolByName("grade_practice_test")!.run({ test_id: testId, grades: [] }, { store, ui, session })).isError).toBe(true);
	});

	it("evaluates immediately when nothing needs a written grade", async () => {
		const choiceOnly = { ...testInput, questions: [testInput.questions[0], testInput.questions[3]] };
		answer = (t) => ({ answers: { [t.questions[0].id]: { dontKnow: false, selected: ["six"] }, [t.questions[1].id]: { dontKnow: true, selected: [], familiarity: 2 } } });
		const r = await toolByName("practice_test")!.run(choiceOnly, { store, ui, session });
		expect(graded!.percent).toBe(0);
		expect(r.text).toContain("forgets to divide by the run");
		expect(r.text).toContain("Rings a bell");
	});

	it("rejects unknown concepts and invalid questions up front", async () => {
		answer = () => ({ answers: {} });
		const unknown = await toolByName("practice_test")!.run({ ...testInput, questions: [{ ...testInput.questions[0], concept: "Nope" }] }, { store, ui, session });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toContain("Nope");
		await expect(
			toolByName("practice_test")!.run({ ...testInput, questions: [{ ...testInput.questions[1], referenceAnswer: "" }] }, { store, ui, session }),
		).rejects.toThrow(/Question 1: .*referenceAnswer/);
	});
});

describe("free-response quiz", () => {
	it("waits for grade_answer, then shows the grade on the card and records it", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Derivative" });
		const recorded: QuizOutcome[] = [];
		const ui: ToolUI = {
			async quiz() {
				return { dontKnow: false, selected: [], text: "$3x^2 + C$" };
			},
			quizRecorded: (o) => recorded.push(o),
			async ask() {
				return { selected: [] };
			},
		};
		const input = { concept: "Derivative", question: "Differentiate $x^3$", format: "free", referenceAnswer: "$3x^2$", explanation: "Power rule", difficulty: 3, kind: "check" };
		const submitted = await toolByName("quiz")!.run(input, { store, ui, session: { id: "free" } });
		expect(submitted.text).toContain("call grade_answer");
		expect(submitted.text).toContain("They wrote:\n$3x^2 + C$");
		expect(recorded).toEqual([]);
		expect((await store.resolve("Derivative"))!.stats.attempts).toBe(0);

		const quizId = /quiz_id "([^"]+)"/.exec(submitted.text)![1];
		const r = await toolByName("grade_answer")!.run(
			{ quiz_id: quizId, outcome: "partial", feedback: "Derivative is right; a derivative has no $+C$.", misconception: "adds a constant when differentiating" },
			{ store, ui, session: { id: "free" } },
		);
		expect(r.text).toContain("PARTLY CORRECTLY");
		expect(r.text).toContain("Next move");
		expect(recorded[0].grade.feedback).toContain("no $+C$");
		const c = (await store.resolve("Derivative"))!;
		expect(c.stats.attempts).toBe(1);
		expect(c.stats.openMisconceptions).toEqual(["adds a constant when differentiating"]);
		const evidence = await store.evidenceFor(c.id);
		expect(evidence[0]).toMatchObject({ outcome: "partial", response: "$3x^2 + C$" });

		expect((await toolByName("grade_answer")!.run({ quiz_id: quizId, outcome: "correct", feedback: "x" }, { store, ui })).isError).toBe(true);
	});

	it("records a slip as correct, without a misconception or a step back", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Algebra" });
		const ui: ToolUI = {
			async quiz() {
				return { dontKnow: false, selected: [], text: "$2x + 6 = 10 \\Rightarrow x = 3$" };
			},
			async ask() {
				return { selected: [] };
			},
		};
		const input = { concept: "Algebra", question: "Solve $2x + 6 = 10$", format: "free", referenceAnswer: "$x = 2$", explanation: "Subtract 6, divide by 2", difficulty: 2, kind: "check" };
		const submitted = await toolByName("quiz")!.run(input, { store, ui, session: { id: "slip" } });
		const quizId = /quiz_id "([^"]+)"/.exec(submitted.text)![1];
		const r = await toolByName("grade_answer")!.run(
			{ quiz_id: quizId, outcome: "partial", slip: true, feedback: "Right method; $10 - 6$ is $4$, so $x = 2$.", misconception: "cannot subtract" },
			{ store, ui, session: { id: "slip" } },
		);
		expect(r.text).toContain("with a slip");
		expect(r.text).toContain("move on");
		expect(r.text).not.toContain("teach this step again");
		const c = (await store.resolve("Algebra"))!;
		expect(c.stats.openMisconceptions).toEqual([]);
		expect(c.stats.floor).toBe(2);
		expect((await store.evidenceFor(c.id))[0]).toMatchObject({ outcome: "correct", slip: true });
		expect(await store.io.read(c.path)).toContain("✅ slip");
	});
});
