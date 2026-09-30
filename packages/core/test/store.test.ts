import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { parseNote } from "../src/markdown";
import { goalChoiceLabel, KnowledgeStore } from "../src/store";
import { workingGoalNote } from "../src/prompt";
import { toolByName } from "../src/tools";

const fixedNow = () => new Date("2026-09-28T12:00:00Z");

function makeStore() {
	const io = new MemoryVaultIO();
	return { io, store: new KnowledgeStore(io, { now: fixedNow, device: "test" }) };
}

describe("KnowledgeStore", () => {
	it("creates concepts with wikilinked prerequisites and stubs", async () => {
		const { io, store } = makeStore();
		const { createdPrerequisites } = await store.upsertConcept({
			title: "Derivative",
			prerequisites: ["Limit", "[[Slope of a line]]"],
			summary: "Instantaneous rate of change.",
		});
		expect(createdPrerequisites.sort()).toEqual(["Limit", "Slope of a line"]);
		const note = parseNote(await io.read("concepts/Derivative.md"));
		expect(note.frontmatter.prerequisites).toEqual(["[[Limit]]", "[[Slope of a line]]"]);
		expect(note.frontmatter.status).toBe("unassessed");
		expect(note.body).toContain("## Summary");
		expect((await store.resolve("derivative"))?.prerequisites).toEqual(["limit", "slope-of-a-line"]);
	});

	it("rejects dependency cycles", async () => {
		const { store } = makeStore();
		await store.upsertConcept({ title: "B", prerequisites: ["A"] });
		await expect(store.upsertConcept({ title: "A", prerequisites: ["B"] })).rejects.toThrow(/cycle/);
	});

	it("merges prerequisites and preserves user edits outside generated regions", async () => {
		const { io, store } = makeStore();
		await store.upsertConcept({ title: "X", prerequisites: ["A"] });
		const text = await io.read("concepts/X.md");
		await io.write("concepts/X.md", text + "\nMy own scribbles.\n");
		store.invalidate();
		await store.upsertConcept({ title: "X", prerequisites: ["B"] });
		await store.recordEvidence("X", { outcome: "correct", difficulty: 3, kind: "check", question: "q?" });
		const after = await io.read("concepts/X.md");
		expect(after).toContain("My own scribbles.");
		expect(after).toContain("## Quiz history");
		expect((await store.resolve("X"))?.prerequisites).toEqual(["a", "b"]);
	});

	it("records evidence, updates stats, and re-renders goals", async () => {
		const { io, store } = makeStore();
		const report = await store.setGoal({
			title: "Understand the derivative",
			objective: "Derive d/dx x^2",
			targets: ["Derivative"],
			nodes: [
				{ title: "Slope of a line" },
				{ title: "Secant line", prerequisites: ["Slope of a line"] },
				{ title: "Limit" },
				{ title: "Derivative", prerequisites: ["Secant line", "Limit"] },
			],
		});
		expect(report.goal.targets).toEqual(["derivative"]);
		expect(report.goal.built).toEqual([]);
		expect(report.analysis.frontier.map((n) => n.title).sort()).toEqual(["Limit", "Slope of a line"]);
		expect(report.mermaid).toContain("graph BT");
		expect(report.mermaid).toContain("{{");

		for (const d of [2, 3, 4]) {
			await store.recordEvidence("Slope of a line", { outcome: "correct", difficulty: d, kind: "probe" });
		}
		const r2 = await store.goalReport("Understand the derivative");
		expect(r2.nodes.find((n) => n.title === "Slope of a line")?.status).toBe("solid");
		expect(r2.analysis.frontier.map((n) => n.title).sort()).toEqual(["Limit", "Secant line"]);

		const goalNote = await io.read("goals/Understand the derivative.md");
		expect(goalNote).toContain("0/1 targets built");
		expect(goalNote).toContain("## Targets");
		expect(goalNote).toContain("[[Derivative]]");
		expect(goalNote).toContain("```mermaid");
		expect(io.files.get(".groundwork/evidence/slope-of-a-line.jsonl")!.trim().split("\n")).toHaveLength(3);
	});

	it("keeps already-built concepts out of the open targets and finishes the goal when the last one is built", async () => {
		const { store } = makeStore();
		await store.upsertConcept({ title: "Limit" });
		for (const d of [2, 3, 4]) await store.recordEvidence("Limit", { outcome: "correct", difficulty: d, kind: "check" });
		const report = await store.setGoal({
			title: "Rates of change",
			targets: ["Limit", "Derivative"],
			nodes: [
				{ title: "Limit" },
				{ title: "Derivative", prerequisites: ["Limit"], requiredLevel: 3 },
			],
		});
		expect(report.goal.built).toEqual(["limit"]);
		expect(report.goal.targets).toEqual(["derivative"]);
		expect(report.goal.status).toBe("active");
		expect(report.next?.concept).toBe("Derivative");
		expect(report.next?.action).toBe("build");
		const overview = await toolByName("get_learner_overview")!.run({}, { store });
		expect(overview.text).not.toContain("nextUp");
		const suggestion = await toolByName("suggest_what_to_study")!.run({}, { store });
		expect(suggestion.text).toContain("Derivative");

		for (const d of [3, 4, 5]) await store.recordEvidence("Derivative", { outcome: "correct", difficulty: d, kind: "check" });
		const done = await store.goalReport("Rates of change");
		expect(done.goal.status).toBe("done");
		expect(done.goal.targets).toEqual([]);
		expect(done.goal.built.sort()).toEqual(["derivative", "limit"]);
		expect((await store.overview()).activeGoals).toEqual([]);
		expect(await store.studyNext()).toBeNull();
	});

	it("refuses a goal that is not made of concrete concepts", async () => {
		const { store } = makeStore();
		await expect(store.setGoal({ title: "Understand calculus", targets: [], nodes: [{ title: "Limit" }] })).rejects.toThrow(/targets/);
		await expect(store.setGoal({ title: "Off the graph", targets: ["Not a node"], nodes: [{ title: "Limit" }] })).rejects.toThrow(/Not a node/);
		expect([...(await store.concepts()).keys()]).not.toContain("not-a-node");
	});

	it("reads a legacy single-target goal and its level map", async () => {
		const { io, store } = makeStore();
		await io.write(
			"goals/Old.md",
			`---
title: Old
status: active
target: "[[Derivative]]"
targets:
  Derivative: 4
nodes:
  - "[[Limit]]"
  - "[[Derivative]]"
---
# Old
`,
		);
		const goal = await store.resolveGoal("Old");
		expect(goal?.targets).toEqual(["derivative"]);
		expect(goal?.requiredLevels.derivative).toBe(4);
		expect(goal?.built).toEqual([]);
	});

	it("does not treat a solid concept as built when the goal still needs a deeper level", async () => {
		const { store } = makeStore();
		await store.upsertConcept({ title: "Chain rule" });
		for (let i = 0; i < 4; i++) await store.recordEvidence("Chain rule", { outcome: "correct", difficulty: 3, kind: "check" });
		const held = await store.resolve("Chain rule");
		expect(held?.stats.status).toBe("solid");
		expect(held?.stats.floor).toBe(3);
		const report = await store.setGoal({
			title: "Midterm",
			targets: ["Chain rule"],
			nodes: [{ title: "Chain rule", requiredLevel: 4 }],
		});
		expect(report.goal.status).toBe("active");
		expect(report.goal.targets).toEqual(["chain-rule"]);
		expect(report.nodes[0]?.role).toBe("target");
	});

	it("overview reports goals, counts, and misconceptions", async () => {
		const { store } = makeStore();
		await store.ensureLayout();
		await store.upsertConcept({ title: "Limit" });
		await store.recordEvidence("Limit", { outcome: "incorrect", difficulty: 3, kind: "probe", misconception: "thinks the limit is f(a)" });
		const o = await store.overview();
		expect(o.conceptCount).toBe(1);
		expect(o.openMisconceptions[0].misconceptions).toEqual(["thinks the limit is f(a)"]);
		expect(o.profile).toContain("Learner profile");
	});

	it("pins a goal for the dropdown and merges a duplicate into it", async () => {
		const { io, store } = makeStore();
		await store.setGoal({ title: "427 exam", targets: ["Limit", "Derivative"], nodes: [{ title: "Limit" }, { title: "Derivative", prerequisites: ["Limit"] }] });
		await store.setGoal({ title: "Calc midterm", targets: ["Chain rule"], nodes: [{ title: "Chain rule" }] });
		expect(goalChoiceLabel({ title: "427 exam", left: 2, status: "active" })).toBe("427 exam → 2 concepts left");
		expect(await store.workingGoal()).toBeNull();
		expect(workingGoalNote(null)).toContain("you choose");

		const pinned = await store.setWorkingGoal("427 exam");
		expect(pinned?.title).toBe("427 exam");
		expect(pinned?.left).toBe(2);
		expect(workingGoalNote(pinned)).toContain("427 exam");
		expect(await io.read(".groundwork/focus.json")).toContain("427 exam");

		await store.setWorkingGoal("Calc midterm");
		const merged = await store.mergeGoals("427 exam", ["Calc midterm"]);
		expect(merged.goal.targets.sort()).toEqual(["chain-rule", "derivative", "limit"]);
		expect((await store.resolveGoal("Calc midterm"))?.status).toBe("done");
		expect(await io.read("goals/Calc midterm.md")).toContain("Merged into [[427 exam]]");
		expect((await store.workingGoal())?.title).toBe("427 exam");
		await store.setWorkingGoal("you choose");
		expect(await store.workingGoal()).toBeNull();
	});

	it("updates learner profile sections", async () => {
		const { store } = makeStore();
		await store.ensureLayout();
		await store.updateProfile("Observations", "- Prefers geometric intuition first.", "append");
		await store.updateProfile("Observations", "- Gets bored by long derivations.", "append");
		const p = await store.profile();
		expect(p).toContain("Prefers geometric intuition first.");
		expect(p).toContain("Gets bored by long derivations.");
	});
});
