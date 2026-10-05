import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";
import {
	buildConceptMap,
	unbuiltGoalLeafIds,
	buildSchedule,
	defaultDue,
	parseIsoDate,
	resolveWeights,
	weightedReadiness,
	type MapSourceNode,
} from "../src/goal-plan";

const fixedNow = () => new Date("2026-09-28T12:00:00Z");

function makeStore() {
	const io = new MemoryVaultIO();
	return { io, store: new KnowledgeStore(io, { now: fixedNow, device: "test" }) };
}

describe("goal dates and weights", () => {
	it("rejects a due date that is not a real day", () => {
		expect(parseIsoDate("2026-10-14")).toBe("2026-10-14");
		expect(parseIsoDate("2026-10-14T18:00:00Z")).toBe("2026-10-14");
		expect(parseIsoDate("Oct 14")).toBeUndefined();
		expect(parseIsoDate("2026-02-31")).toBeUndefined();
	});

	it("gives a new goal a due date and keeps weights on the note", async () => {
		const { io, store } = makeStore();
		const report = await store.setGoal({
			title: "Exam 2",
			due: "2026-10-14",
			targets: ["Bayes"],
			nodes: [
				{ title: "Base rates" },
				{ title: "Bayes", prerequisites: ["Base rates"] },
			],
			weights: [
				{ title: "Bayes", weight: 70 },
				{ title: "Base rates", weight: 30 },
			],
		});
		expect(report.goal.due).toBe("2026-10-14");
		expect(report.goal.weights.bayes).toBe(70);
		expect(report.goal.weights["base-rates"]).toBe(30);
		expect(await io.read("goals/Exam 2.md")).toContain("due: 2026-10-14");

		const again = await store.setGoal({
			title: "Exam 2",
			targets: ["Bayes"],
			nodes: [
				{ title: "Base rates" },
				{ title: "Bayes", prerequisites: ["Base rates"] },
			],
		});
		expect(again.goal.due).toBe("2026-10-14");
		expect(again.goal.weights.bayes).toBe(70);

		await store.setGoalDue("Exam 2", "2026-11-02");
		expect((await store.resolveGoal("Exam 2"))?.due).toBe("2026-11-02");
		await expect(store.setGoalDue("Exam 2", "next week")).rejects.toThrow(/calendar day/);
	});

	it("defaults a missing deadline to 14 days after the goal is created", async () => {
		const { store } = makeStore();
		const report = await store.setGoal({
			title: "Problem set 5",
			targets: ["Variance"],
			nodes: [{ title: "Variance" }],
		});
		expect(report.goal.created).toBe("2026-09-28");
		expect(report.goal.due).toBe(defaultDue("2026-09-28"));
		expect(report.goal.due).toBe("2026-10-12");
	});

	it("splits weight evenly until a syllabus says otherwise", () => {
		const even = resolveWeights(["a", "b", "c"], {});
		expect(Object.values(even).reduce((sum, n) => sum + n, 0)).toBeCloseTo(100);
		expect(even.a).toBeCloseTo(100 / 3);
		const mixed = resolveWeights(["a", "b", "c"], { a: 40 });
		expect(mixed.a).toBeCloseTo(40);
		expect(mixed.b).toBeCloseTo(30);
		expect(mixed.c).toBeCloseTo(30);
	});

	it("tells the tutor the deadline, the pace, and the weights", async () => {
		const { store } = makeStore();
		await store.setGoal({
			title: "Exam 2",
			due: "2026-10-14",
			targets: ["Bayes"],
			nodes: [{ title: "Bayes" }],
			weights: [{ title: "Bayes", weight: 100 }],
		});
		const result = await toolByName("get_goal")!.run({ goal: "Exam 2" }, { store });
		expect(result.text).toContain('"due": "2026-10-14"');
		expect(result.text).toContain('"daysLeft": 16');
		expect(result.text).toContain("Bayes");
	});
});

describe("goal calendar", () => {
	it("marks studied days, today, the last two days, and the exam", () => {
		const schedule = buildSchedule({
			start: "2026-09-22",
			due: "2026-10-14",
			today: "2026-10-02",
			studied: ["2026-09-22", "2026-09-23", "2026-09-24", "2026-10-02"],
			readiness: 0.43,
			status: "active",
		});
		expect(schedule).not.toBeNull();
		expect(schedule!.daysLeft).toBe(12);
		expect(schedule!.days[0]).toEqual({ date: "2026-09-22", kind: "studied" });
		expect(schedule!.days.find((day) => day.date === "2026-09-25")?.kind).toBe("missed");
		expect(schedule!.days.find((day) => day.date === "2026-10-02")?.kind).toBe("today");
		expect(schedule!.days.find((day) => day.date === "2026-10-12")?.kind).toBe("focus");
		expect(schedule!.days.find((day) => day.date === "2026-10-13")?.kind).toBe("focus");
		expect(schedule!.days.at(-1)?.kind).toBe("due");
		expect(schedule!.studiedDays).toBe(4);
		expect(schedule!.pace).toBe("on-pace");
	});

	it("calls the pace behind when time has passed and little is known", () => {
		const schedule = buildSchedule({
			start: "2026-09-01",
			due: "2026-10-01",
			today: "2026-09-28",
			readiness: 0.1,
			status: "active",
		});
		expect(schedule!.pace).toBe("behind");
		expect(weightedReadiness([{ id: "a", status: "unassessed", current: 0 }], { a: 100 }, () => false)).toBe(0);
	});
});

describe("concept map", () => {
	const nodes: MapSourceNode[] = [
		{ id: "spaces", title: "Sample spaces", prerequisites: [], status: "solid", current: 0.9, inGoal: true, role: "built" },
		{ id: "conditional", title: "Conditional probability", prerequisites: ["spaces"], status: "solid", current: 0.9, inGoal: true, role: "built" },
		{ id: "total", title: "Law of total probability", prerequisites: ["spaces", "conditional"], status: "unassessed", current: 0, inGoal: true, role: "target" },
		{ id: "prior", title: "Prior and posterior", prerequisites: ["total"], status: "unassessed", current: 0, inGoal: true, role: "target" },
		{ id: "bayes", title: "Bayes' theorem", prerequisites: ["prior"], status: "learning", current: 0.2, inGoal: true, role: "target" },
		{ id: "testing", title: "Medical testing", prerequisites: ["bayes"], status: "unassessed", current: 0, inGoal: false },
		{ id: "counting", title: "Counting", prerequisites: [], status: "solid", current: 0.8, inGoal: false },
	];

	it("draws the goal, numbers the ghosts, and keeps a concept that unlocks later", () => {
		const map = buildConceptMap({
			goalTitle: "Exam 2",
			dueLabel: "Oct 14",
			nodes,
			weights: { bayes: 40 },
			scope: "path",
			showGhosts: true,
			nextId: "total",
			builtIds: ["spaces", "conditional"],
		});
		expect(map.goalNodeId).toBe("bayes");
		expect(map.nodes.find((node) => node.id === "bayes")?.visual).toBe("goal");
		expect(map.nodes.find((node) => node.id === "bayes")?.subtitle).toContain("Exam 2");
		expect(map.nodes.find((node) => node.id === "total")?.step).toBe(1);
		expect(map.nodes.find((node) => node.id === "total")?.next).toBe(true);
		expect(map.nodes.some((node) => node.id === "counting")).toBe(true);
		expect(map.nodes.find((node) => node.id === "counting")?.visual).toBe("dim");
		expect(map.steps.at(-1)?.id).toBe("bayes");
		expect(map.edges.every((edge) => map.nodes.some((node) => node.id === edge.from) && map.nodes.some((node) => node.id === edge.to))).toBe(true);
	});

	it("marks unbuilt goal leaves red and brightens ascent edges", () => {
		const map = buildConceptMap({
			goalTitle: "Exam 2",
			nodes,
			weights: { bayes: 40 },
			builtIds: ["spaces", "conditional"],
			nextId: "total",
		});
		expect(map.nodes.find((node) => node.id === "bayes")?.visual).toBe("goal");
		const leaves = unbuiltGoalLeafIds(nodes, new Set(["spaces", "conditional"]));
		expect(leaves.has("bayes")).toBe(true);
		expect(map.nodes.find((node) => node.id === "prior")?.visual).not.toBe("target");
		expect(map.edges.some((edge) => edge.from === "prior" && edge.to === "bayes" && edge.kind === "built")).toBe(true);
	});

	it("keeps off-goal vault concepts on the map, dimmed", () => {
		const map = buildConceptMap({
			goalTitle: "Exam 2",
			nodes,
			builtIds: ["spaces", "conditional"],
		});
		expect(map.nodes.some((node) => node.visual === "ghost")).toBe(true);
		expect(map.nodes.find((node) => node.id === "counting")?.visual).toBe("dim");
		const goal = map.nodes.find((node) => node.id === "bayes")!;
		const base = map.nodes.find((node) => node.id === "spaces")!;
		expect(goal.y).toBeLessThan(base.y);
	});
});
