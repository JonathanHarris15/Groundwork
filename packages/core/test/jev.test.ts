import { describe, expect, it } from "vitest";
import { recordQuizAnswer } from "../src/grading";
import { dropCycles } from "../src/judgments";
import { decideAlignment, decideGrade, keepEdge, type JevClient } from "../src/jev";
import { MemoryVaultIO } from "../src/io";
import { prepareQuiz } from "../src/quiz";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

describe("judgment routing", () => {
	it("merges one confident same-concept score and refuses an ambiguous pair", () => {
		expect(
			decideAlignment([
				{ id: "chain-rule", title: "Chain rule", score: 1.9, confidence: 0.91 },
				{ id: "product-rule", title: "Product rule", score: 0.2, confidence: 0.8 },
			]),
		).toMatchObject({ action: "same", id: "chain-rule" });

		expect(
			decideAlignment([
				{ id: "a", title: "A", score: 1.8, confidence: 0.8 },
				{ id: "b", title: "B", score: 1.7, confidence: 0.75 },
			]).action,
		).toBe("related");

		expect(decideAlignment([{ id: "a", title: "A", score: 0.2, confidence: 0.9 }]).action).toBe("new");
	});

	it("labels a written answer only when the score is concentrated", () => {
		expect(decideGrade(2.1, 0.8)).toEqual({ outcome: "correct", slip: true });
		expect(decideGrade(3, 0.9)).toEqual({ outcome: "correct", slip: false });
		expect(decideGrade(1.1, 0.7)).toEqual({ outcome: "partial", slip: false });
		expect(decideGrade(0.2, 0.8)).toEqual({ outcome: "incorrect", slip: false });
		expect(decideGrade(3, 0.4)).toBeNull();
	});

	it("keeps a tutor edge unless the vote is a confident no, and adds a candidate only when sure", () => {
		expect(keepEdge({ child: "Derivative", parent: "Limit", source: "stated", yes: 0.5 }, "tutor")).toBe(true);
		expect(keepEdge({ child: "Derivative", parent: "Limit", source: "stated", yes: 0.2 }, "tutor")).toBe(false);
		expect(keepEdge({ child: "Derivative", parent: "Limit", source: "stated", yes: 0.5 }, "proposed")).toBe(false);
		expect(keepEdge({ child: "Derivative", parent: "Limit", source: "stated", yes: 0.7 }, "proposed")).toBe(true);
		expect(keepEdge({ child: "Derivative", parent: "Slope", source: "candidate", yes: 0.9 }, "tutor")).toBe(true);
		expect(keepEdge({ child: "Derivative", parent: "Slope", source: "candidate", yes: 0.7 }, "tutor")).toBe(false);
	});

	it("drops an edge that would cycle, candidates first", () => {
		const notes: string[] = [];
		const kept = dropCycles(
			[
				{ child: "A", parent: "B", source: "stated", yes: 0.9 },
				{ child: "B", parent: "A", source: "candidate", yes: 0.95 },
			],
			notes,
		);
		expect(kept.map((e) => `${e.parent}→${e.child}`)).toEqual(["B→A"]);
		expect(notes[0]).toMatch(/acyclic/);
	});
});

function scripted(reply: (id: string) => { score?: number; confidence?: number; noul?: number; choice?: string }): JevClient {
	return {
		async ask(_state, questions) {
			const out: Record<string, { score?: number; confidence?: number; noul?: number; choice?: string }> = {};
			for (const id of Object.keys(questions)) out[id] = reply(id);
			return out;
		},
	};
}

describe("Jev on the vault", () => {
	it("attaches a new name to an existing concept and drops a prerequisite that is not direct", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: {
				async ask(state, questions) {
					const idea = (state as { idea?: { title?: string } }).idea?.title ?? "";
					const out: Record<string, { score?: number; confidence?: number; noul?: number }> = {};
					for (const id of Object.keys(questions)) {
						if (id.startsWith("c")) out[id] = idea.includes("composition") ? { score: 1.92, confidence: 0.9 } : { score: 0.1, confidence: 0.9 };
						else out[id] = { noul: 0.05 };
					}
					return out;
				},
			},
		});
		await store.upsertConcept({ title: "Chain rule", summary: "Derivative of a composition." });
		const report = await store.setGoal({
			title: "Derivatives",
			targets: ["derivatives of compositions"],
			nodes: [
				{ title: "derivatives of compositions", summary: "How to differentiate f(g(x)).", prerequisites: ["Linear algebra"] },
				{ title: "Linear algebra", summary: "Vectors and matrices." },
			],
		});
		expect(report.judgmentNotes?.join("\n")).toMatch(/Matched “derivatives of compositions” to \[\[Chain rule\]\]/);
		expect(report.judgmentNotes?.join("\n")).toMatch(/Dropped prerequisite Linear algebra → Chain rule/);
		const chain = await store.resolve("Chain rule");
		expect(chain?.aliases).toContain("derivatives of compositions");
		expect(chain?.prerequisites).not.toContain("linear-algebra");
		expect(report.goal.targets.map((id) => id)).toContain("chain-rule");
	});

	it("does not invent a prerequisite on a tutor-written graph", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: scripted(() => ({ noul: 0.99 })),
		});
		const report = await store.setGoal({
			title: "Series",
			targets: ["Power series"],
			nodes: [{ title: "Power series" }, { title: "Power rule" }],
		});
		expect(report.judgmentNotes ?? []).toEqual([]);
		expect((await store.resolve("Power series"))?.prerequisites ?? []).toEqual([]);
		expect((await store.resolve("Power rule"))?.prerequisites ?? []).toEqual([]);
	});

	it("adds one direct prerequisite and drops the edge that would cycle back", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: scripted(() => ({ noul: 0.96 })),
		});
		const report = await store.setGoal(
			{
				title: "Series",
				targets: ["Power series"],
				nodes: [{ title: "Power series" }, { title: "Power rule" }],
			},
			{ judgments: "proposed" },
		);
		const notes = report.judgmentNotes?.join("\n") ?? "";
		expect(notes).toMatch(/Added prerequisite/);
		expect(notes).toMatch(/acyclic/);
		const series = (await store.resolve("Power series"))?.prerequisites ?? [];
		const rule = (await store.resolve("Power rule"))?.prerequisites ?? [];
		expect(series.includes("power-rule") !== rule.includes("power-series")).toBe(true);
	});

	it("records a quiz against the matched concept", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: scripted(() => ({ score: 1.9, confidence: 0.88 })),
		});
		await store.upsertConcept({ title: "Chain rule", summary: "Derivative of a composition." });
		const quiz = toolByName("quiz")!;
		const result = await quiz.run(
			{
				concept: "differentiating a composition",
				question: "What rule differentiates f(g(x))?",
				explanation: "The chain rule.",
				difficulty: 2,
				options: [
					{ label: "Chain rule", value: "a" },
					{ label: "Product rule", value: "b" },
				],
				correctAnswer: "a",
			},
			{
				store,
				ui: { quiz: async () => ({ dontKnow: false, selected: ["a"] }), ask: async () => null },
			},
		);
		expect(result.text).toMatch(/Matched “differentiating a composition” to \[\[Chain rule\]\]/);
		expect((await store.resolve("Chain rule"))?.stats.attempts).toBe(1);
	});

	it("records Jev's label for a written answer when it disagrees with the tutor", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: scripted(() => ({ score: 2.05, confidence: 0.86 })),
		});
		await store.upsertConcept({ title: "Chain rule" });
		const quiz = prepareQuiz({
			concept: "Chain rule",
			question: "Differentiate sin(x^2).",
			format: "free",
			referenceAnswer: "2x cos(x^2)",
			explanation: "Chain rule.",
			difficulty: 3,
		});
		const outcome = await recordQuizAnswer(store, quiz, { dontKnow: false, selected: [], text: "2x cos(x^2) but I dropped the sign" }, undefined, {
			outcome: "incorrect",
			feedback: "Wrong.",
		});
		expect(outcome.grade.slip).toBe(true);
		expect(outcome.grade.outcome).toBe("correct");
		expect(outcome.judgmentNote).toMatch(/slip/);
		expect((await store.resolve("Chain rule"))?.stats.openMisconceptions).toEqual([]);
	});

	it("names the missing prerequisite and leaves the others alone", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO(), {
			judgments: scripted((id) => (id === "pick" ? { choice: "o1", confidence: 0.8 } : {})),
		});
		await store.upsertConcept({ title: "Limit" });
		await store.upsertConcept({ title: "Slope of a line" });
		await store.upsertConcept({ title: "Derivative", prerequisites: ["Limit", "Slope of a line"] });
		const quiz = prepareQuiz({
			concept: "Derivative",
			question: "What is the derivative of x^2 at 3?",
			explanation: "6.",
			difficulty: 3,
			kind: "probe",
			options: [
				{ label: "6", value: "a" },
				{ label: "9", value: "b", misconception: "plugged in" },
			],
			correctAnswer: "a",
		});
		const outcome = await recordQuizAnswer(store, quiz, { dontKnow: false, selected: ["b"] });
		expect(outcome.guidance).toMatch(/missing piece is Slope of a line/i);
	});
});
