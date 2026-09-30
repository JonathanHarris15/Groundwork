import { describe, expect, it } from "vitest";
import { computeStats, predictCorrect, type Evidence } from "../src/model";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
const ev = (n: number, outcome: Evidence["outcome"], difficulty = 3, extra: Partial<Evidence> = {}): Evidence => ({
	ts: day(n),
	concept: "x",
	outcome,
	difficulty,
	kind: "check",
	...extra,
});

describe("computeStats", () => {
	it("is unassessed with no evidence", () => {
		expect(computeStats([]).status).toBe("unassessed");
	});

	it("rises with correct answers and falls with misses", () => {
		const up = computeStats([ev(0, "correct"), ev(1, "correct")], new Date(day(1)));
		const down = computeStats([ev(0, "incorrect"), ev(1, "incorrect")], new Date(day(1)));
		expect(up.mastery).toBeGreaterThan(0.7);
		expect(down.mastery).toBeLessThan(0.3);
	});

	it("barely counts a slip against the learner", () => {
		const clean = computeStats([ev(0, "correct"), ev(1, "correct")], new Date(day(1)));
		const slipped = computeStats([ev(0, "correct"), ev(1, "correct", 3, { slip: true })], new Date(day(1)));
		const missed = computeStats([ev(0, "correct"), ev(1, "partial")], new Date(day(1)));
		expect(slipped.ability).toBeLessThan(clean.ability);
		expect(slipped.ability).toBeGreaterThan(missed.ability);
		expect(clean.ability - slipped.ability).toBeLessThan((slipped.ability - missed.ability) / 3);
		expect(slipped.status).toBe(clean.status);
		expect(slipped.floor).toBe(3);
	});

	it("rewards hard questions more than easy ones", () => {
		const easy = computeStats([ev(0, "correct", 1)], new Date(day(0)));
		const hard = computeStats([ev(0, "correct", 5)], new Date(day(0)));
		expect(hard.ability).toBeGreaterThan(easy.ability);
	});

	it("brackets the edge between floor and ceiling", () => {
		const s = computeStats([ev(0, "correct", 2), ev(0.1, "correct", 3), ev(0.2, "incorrect", 4)], new Date(day(0.2)));
		expect(s.floor).toBe(3);
		expect(s.ceiling).toBe(4);
	});

	it("decays over time and becomes rusty", () => {
		const evidence = [ev(0, "correct", 4), ev(3, "correct", 4), ev(10, "correct", 5)];
		const fresh = computeStats(evidence, new Date(day(10)));
		const later = computeStats(evidence, new Date(day(400)));
		expect(fresh.status).toBe("solid");
		expect(later.status).toBe("rusty");
		expect(later.current).toBeLessThan(fresh.current);
		expect(Date.parse(fresh.nextReview!)).toBeGreaterThan(Date.parse(day(10)));
	});

	it("spaced practice grows memory more than cramming", () => {
		const crammed = computeStats([ev(0, "correct"), ev(0.01, "correct"), ev(0.02, "correct")], new Date(day(0.02)));
		const spaced = computeStats([ev(0, "correct"), ev(2, "correct"), ev(6, "correct")], new Date(day(6)));
		expect(spaced.halfLifeDays).toBeGreaterThan(crammed.halfLifeDays);
	});

	it("tracks and retires misconceptions", () => {
		const open = computeStats([ev(0, "incorrect", 3, { misconception: "confuses rise and run" })]);
		expect(open.openMisconceptions).toEqual(["confuses rise and run"]);
		const fixed = computeStats([ev(0, "incorrect", 3, { misconception: "confuses rise and run" }), ev(1, "correct", 3)]);
		expect(fixed.openMisconceptions).toEqual([]);
	});

	it("never flags a misconception for 'I don't know'", () => {
		const s = computeStats([ev(0, "dont_know", 3, { misconception: "should be ignored" })]);
		expect(s.openMisconceptions).toEqual([]);
		expect(s.mastery).toBeLessThan(0.5);
	});

	it("treats 'almost have it' as a softer miss than 'never seen this'", () => {
		const base = [ev(0, "correct", 2), ev(1, "correct", 3)];
		const never = computeStats([...base, ev(2, "dont_know", 4, { familiarity: 0 })], new Date(day(2)));
		const almost = computeStats([...base, ev(2, "dont_know", 4, { familiarity: 3 })], new Date(day(2)));
		expect(almost.ability).toBeGreaterThan(never.ability);
		expect(almost.halfLifeDays).toBeGreaterThan(never.halfLifeDays);
		expect(almost.ceiling).toBe(4);
		expect(almost.openMisconceptions).toEqual([]);
	});

	it("gives partial credit between a miss and a correct answer without raising the floor", () => {
		const at = new Date(day(0));
		const wrong = computeStats([ev(0, "incorrect", 3)], at);
		const partial = computeStats([ev(0, "partial", 3, { misconception: "drops the constant" })], at);
		const right = computeStats([ev(0, "correct", 3)], at);
		expect(partial.ability).toBeGreaterThan(wrong.ability);
		expect(partial.ability).toBeLessThan(right.ability);
		expect(partial.floor).toBeUndefined();
		expect(partial.ceiling).toBe(3);
		expect(partial.correct).toBe(0);
		expect(partial.openMisconceptions).toEqual(["drops the constant"]);
	});

	it("is order-independent (event sourcing)", () => {
		const a = [ev(0, "correct"), ev(1, "incorrect"), ev(2, "correct")];
		const now = new Date(day(3));
		expect(computeStats(a, now)).toEqual(computeStats([...a].reverse(), now));
	});

	it("predicts lower odds for harder questions", () => {
		const s = computeStats([ev(0, "correct"), ev(1, "correct")], new Date(day(1)));
		expect(predictCorrect(s, 5)).toBeLessThan(predictCorrect(s, 1));
	});
});
