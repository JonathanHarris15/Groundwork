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

	it("descends after a miss instead of re-teaching, then climbs back to the original question", async () => {
		const first = await ask(q("Derivative", 4, "Differentiate x^3 from the definition"), { dontKnow: true, selected: [], familiarity: 0 });
		expect(first).toContain("do NOT re-teach yet");
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

	it("stops descending after several misses and states the basics directly", async () => {
		await ask(q("Derivative", 5), wrong);
		await ask(q("Derivative", 4), wrong);
		await ask(q("Limit", 3), wrong);
		const text = await ask(q("Limit", 2), wrong);
		expect(text).toContain("Stop descending");
	});

	it("pushes probes up sharply when there is no ceiling yet", async () => {
		const text = await ask(q("Limit", 2), right);
		expect(text).toContain("no ceiling found yet on Limit");
		expect(text).toContain("jump to d4");
	});
});
