import { beforeEach, describe, expect, it } from "vitest";
import { clearLadder, ladderFor } from "../src/diagnose";
import { MemoryVaultIO } from "../src/io";
import type { QuizInput, QuizResponse } from "../src/quiz";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";

const session = { id: "diag" };

function q(concept: string, difficulty: number, question = `${concept} question at d${difficulty}`): QuizInput {
	return {
		concept,
		question,
		options: [
			{ label: "right", value: "r" },
			{ label: "wrong", value: "w", misconception: `confuses ${concept}` },
		],
		correctAnswer: "r",
		explanation: "because",
		difficulty,
		kind: "probe",
	};
}

describe("diagnose down, build up", () => {
	let store: KnowledgeStore;
	let next: QuizResponse;
	const ui: ToolUI = {
		async quiz() {
			return next;
		},
		async ask() {
			return { selected: [] };
		},
	};
	const ask = async (input: QuizInput, response: QuizResponse) => {
		next = response;
		return (await toolByName("quiz")!.run(input, { store, ui, session })).text;
	};
	const right = { dontKnow: false, selected: ["r"] };
	const wrong = { dontKnow: false, selected: ["w"] };

	beforeEach(async () => {
		clearLadder(session.id);
		store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.upsertConcept({ title: "Limit" });
		await store.upsertConcept({ title: "Secant line" });
		await store.upsertConcept({ title: "Derivative", prerequisites: ["Limit", "Secant line"] });
	});

	it("while probing, descends briefly after a miss, then climbs back to the original question", async () => {
		const first = await ask(q("Derivative", 4, "Differentiate x^3 from the definition"), { dontKnow: true, selected: [], familiarity: 0 });
		expect(first).toContain("sat above their frontier");
		expect(first).toContain("I've never seen this");
		expect(first).toMatch(/prerequisites, weakest first: Limit \(unassessed\), Secant line \(unassessed\)/);

		const second = await ask(q("Limit", 2), wrong);
		expect(second).toContain("still above their frontier");
		expect(second).toContain("confuses Limit");
		expect(ladderFor(session.id)!.missed.map((r) => r.concept)).toEqual(["Derivative", "Limit"]);

		const floor = await ask(q("Limit", 1), right);
		expect(floor).toContain("floor found: they hold Limit at d1");
		expect(floor).toContain("Next rung up: Limit at d2");

		const rung = await ask(q("Limit", 2), right);
		expect(rung).toContain("rung climbed");
		expect(rung).toContain("Next rung up: Derivative at d4");
		expect(rung).toContain("Differentiate x^3 from the definition");

		const back = await ask(q("Derivative", 4), right);
		expect(back).toContain("gap closed");
		expect(ladderFor(session.id)).toBeUndefined();
	});

	it("treats 'almost have it' as a retrieval problem: cue, don't drop to prerequisites", async () => {
		const text = await ask(q("Derivative", 3), { dontKnow: true, selected: [], familiarity: 3 });
		expect(text).toContain("Very familiar, I almost have it");
		expect(text).toContain("retrieval cue");
		expect(text).toContain("d2");
		expect(text).not.toContain("drop below it");
	});

	it("teaches the rung that breaks while climbing, in a smaller step", async () => {
		await ask(q("Derivative", 4), wrong);
		await ask(q("Secant line", 2), right);
		const broke = await ask(q("Derivative", 3), wrong);
		expect(broke).toContain("this rung is where it breaks now");
		expect(broke).toContain("They hold Secant line at d2; they miss Derivative at d3");
	});

	it("stops asking after three misses and teaches the basics directly", async () => {
		await ask(q("Derivative", 5), wrong);
		await ask(q("Derivative", 4), wrong);
		const text = await ask(q("Limit", 3), wrong);
		expect(text).toContain("Stop asking");
		expect(text).toContain("teach forward from it");
	});

	it("pushes probes up sharply when there is no ceiling yet", async () => {
		const text = await ask(q("Limit", 2), right);
		expect(text).toContain("no ceiling found yet on Limit");
		expect(text).toContain("Jump to d4");
	});

	it("re-teaches a missed check instead of starting a quiz descent", async () => {
		const text = await ask(check("Derivative", 3), wrong);
		expect(text).toContain("keep teaching forward");
		expect(text).toContain("teach this step again from a different angle");
		expect(text).toContain("confuses Derivative");
		expect(ladderFor(session.id)).toBeUndefined();

		const after = await ask(check("Derivative", 3), right);
		expect(after).toContain("landed after re-teaching");
		expect(after).toContain("Continue forward");
	});

	it("names solid prerequisites as the ground to re-teach from", async () => {
		await store.recordEvidence("Limit", { outcome: "correct", difficulty: 4, kind: "check" });
		await store.recordEvidence("Limit", { outcome: "correct", difficulty: 4, kind: "check" });
		const text = await ask(check("Derivative", 3), wrong);
		expect(text).toContain("They already hold Limit");
	});

	it("only looks underneath after a second miss on the same step, and stays on the goal's path", async () => {
		await ask(check("Derivative", 3), wrong);
		const second = await ask(check("Derivative", 3), wrong);
		expect(second).toContain("second miss on Derivative");
		expect(second).toContain("one quick question");
		expect(second).toContain("goal actually needs");
		expect(ladderFor(session.id)!.missed.map((r) => r.concept)).toEqual(["Derivative"]);
	});

	it("says nothing extra after a passed check, so teaching simply moves on", async () => {
		expect(await ask(check("Derivative", 3), right)).not.toContain("Next move");
	});
});

function check(concept: string, difficulty: number): QuizInput {
	return { ...q(concept, difficulty), kind: "check" };
}
