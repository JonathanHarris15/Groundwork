import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { parseNote } from "../src/markdown";
import { DEFAULT_LEARNER_PROFILE, describeConceptProgress, describeGoalProgress, goalChoiceLabel, KnowledgeStore } from "../src/store";
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
		expect(goalNote).toContain("1 of 4 concepts solid");
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

	it("deletes a conversation and its session note, and leaves concepts alone", async () => {
		const { io, store } = makeStore();
		await store.upsertConcept({ title: "Limit" });
		await store.writeFile(
			".groundwork/chats/chat-1.json",
			JSON.stringify({
				id: "chat-1",
				title: "Limits",
				created: "2026-09-01T00:00:00.000Z",
				updated: "2026-09-02T00:00:00.000Z",
				notePath: "sessions/2026-09-01 Limits.md",
				messages: [],
				items: [],
			}),
		);
		await store.writeFile("sessions/2026-09-01 Limits.md", "---\ntype: session\nchat: chat-1\n---\n# Limits\n");
		await store.writeFile(
			".groundwork/chats/chat-9.json",
			JSON.stringify({ id: "chat-9", title: "Old", created: "2026-08-01T00:00:00.000Z", updated: "2026-08-02T00:00:00.000Z" }),
		);
		await store.writeFile("sessions/orphan.md", "---\nchat: chat-9\n---\n# Old\n");
		await store.writeFile("sessions/other.md", "---\nchat: chat-2\n---\n# Other\n");

		expect((await store.listChats()).map((c) => c.id)).toEqual(["chat-1", "chat-9"]);
		await store.deleteChat("chat-1");
		await store.deleteChat("chat-9");
		expect(await io.exists(".groundwork/chats/chat-1.json")).toBe(false);
		expect(await io.exists(".groundwork/chats/chat-9.json")).toBe(false);
		expect(await io.exists("sessions/2026-09-01 Limits.md")).toBe(false);
		expect(await io.exists("sessions/orphan.md")).toBe(false);
		expect(await io.exists("sessions/other.md")).toBe(true);
		expect(await store.resolve("Limit")).toBeTruthy();
		await store.deleteChat("chat-1");
	});

	it("deletes a goal without its concepts, and keeps tutor context off the learner profile", async () => {
		const { io, store } = makeStore();
		await store.ensureLayout();
		await store.setGoal({ title: "427 exam", targets: ["Limit"], nodes: [{ title: "Limit" }] });
		await store.setWorkingGoal("427 exam");
		await store.setTutorContext("I have a formula sheet.");
		expect((await store.overview()).tutorContext).toContain("formula sheet");
		const overview = await toolByName("get_learner_overview")!.run({}, { store });
		expect(overview.text).toContain("formula sheet");
		expect(overview.text).not.toContain("nextUp");

		await store.deleteGoal("427 exam");
		expect(await store.resolveGoal("427 exam")).toBeUndefined();
		expect(await store.resolve("Limit")).toBeTruthy();
		expect(await store.workingGoal()).toBeNull();
		expect(await io.read(".groundwork/focus.json")).not.toContain("427 exam");
		expect(await store.profile()).not.toContain("formula sheet");

		await store.setTutorContext("   ");
		expect(await store.tutorContext()).toBe("");
		expect(await io.exists(".groundwork/tutor-context.md")).toBe(false);
	});

	it("keeps concepts abstract, lets goals name the source, and deletes a concept", async () => {
		const { io, store } = makeStore();
		await expect(store.upsertConcept({ title: "Lecture Note 1 fluency" })).rejects.toThrow(/cannot be a concept/);
		await expect(store.upsertConcept({ title: "Practice Exam 1" })).rejects.toThrow(/cannot be a concept/);
		await expect(store.upsertConcept({ title: "Practice Exam 1 Solutions" })).rejects.toThrow(/cannot be a concept/);
		await expect(store.upsertConcept({ title: "Prepare for HV 25H exam" })).rejects.toThrow(/cannot be a concept/);
		await expect(store.upsertConcept({ title: "Linear functions", aliases: ["Lecture Note 1"] })).rejects.toThrow(/cannot be a concept/);
		await expect(
			store.upsertConcept({ title: "Matrix inverse", connections: "See [[resources/Lecture Note 1.pdf]]." }),
		).rejects.toThrow(/source document/);
		await expect(
			store.setGoal({
				title: "Lecture 1 note fluency",
				targets: ["Lecture Note 1 fluency"],
				nodes: [{ title: "Lecture Note 1 fluency" }],
			}),
		).rejects.toThrow(/cannot be a concept/);
		expect([...(await store.concepts()).keys()]).toEqual([]);

		for (const title of ["Linear functions", "Affine compositions", "Final value theorem", "Series solutions"]) {
			await store.upsertConcept({ title });
		}
		const report = await store.setGoal({
			title: "Lecture 1 note fluency",
			sources: ["resources/Lecture Note 1.pdf"],
			targets: ["Linear functions", "Affine compositions"],
			nodes: [
				{ title: "Linear functions" },
				{ title: "Affine compositions", prerequisites: ["Linear functions"], requiredLevel: 3 },
			],
		});
		expect(report.goal.sources).toEqual(["resources/Lecture Note 1.pdf"]);
		expect(report.goal.targets.sort()).toEqual(["affine-compositions", "linear-functions"]);
		const goalNote = await io.read(report.goal.path);
		expect(goalNote).toContain("[[resources/Lecture Note 1.pdf]]");
		expect(goalNote).toContain("## Sources");

		await store.recordEvidence("Linear functions", { outcome: "incorrect", difficulty: 2, kind: "probe", question: "Is f(x)=x^2 linear?" });
		expect(await io.exists(".groundwork/evidence/linear-functions.jsonl")).toBe(true);
		await store.deleteConcept("Linear functions");
		expect(await store.resolve("Linear functions")).toBeUndefined();
		expect(await io.exists("concepts/Linear functions.md")).toBe(false);
		expect(await io.exists(".groundwork/evidence/linear-functions.jsonl")).toBe(false);
		expect((await store.resolve("Affine compositions"))?.prerequisites).toEqual([]);
		const goal = await store.resolveGoal("Lecture 1 note fluency");
		expect(goal?.nodes).not.toContain("linear-functions");
		expect(goal?.targets).not.toContain("linear-functions");
		expect(goal?.sources).toEqual(["resources/Lecture Note 1.pdf"]);
		const after = await io.read(goal!.path);
		expect(after).toContain("[[resources/Lecture Note 1.pdf]]");
		expect(after).not.toContain("[[Linear functions]]");
		expect(after).toContain("[[Affine compositions]]");
		await expect(store.deleteConcept("Linear functions")).rejects.toThrow(/Unknown concept/);
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

	it("saves the learner file and resets the learning vault without touching resources", async () => {
		const { io, store } = makeStore();
		await store.ensureLayout();
		await store.setProfile("# Learner profile\n\n## Background\n\nI know calculus.\n");
		expect(await store.profile()).toContain("I know calculus.");
		await store.setProfile("   ");
		expect(await store.profile()).toBe(DEFAULT_LEARNER_PROFILE);

		await store.setProfile("# Learner profile\n\n## Background\n\nPhysics.\n");
		await store.setTutorContext("Exam on Friday.");
		await store.setGoal({ title: "427 exam", targets: ["Limit"], nodes: [{ title: "Limit" }] });
		await store.setWorkingGoal("427 exam");
		await store.recordEvidence("Limit", { outcome: "incorrect", difficulty: 2, kind: "probe", question: "What is a limit?" });
		await store.writeFile("concepts/.gitkeep", "");
		await store.writeFile("exams/Midterm.md", "# Midterm\n");
		await store.writeFile("tests/2026-09-01 Midterm.md", "# Score\n");
		await store.writeFile(
			".groundwork/chats/chat-1.json",
			JSON.stringify({ id: "chat-1", title: "Limits", created: "2026-09-01T00:00:00.000Z", updated: "2026-09-02T00:00:00.000Z", notePath: "sessions/2026-09-01 Limits.md" }),
		);
		await store.writeFile("sessions/2026-09-01 Limits.md", "---\nchat: chat-1\n---\n# Limits\n");
		await store.writeFile("resources/Lecture 1.pdf", "pdf");
		await store.writeFile("README.md", "# keep\n");

		await store.resetVault();

		expect([...(await store.concepts()).keys()]).toEqual([]);
		expect(await store.goals()).toEqual([]);
		expect(await store.listChats()).toEqual([]);
		expect(await store.workingGoal()).toBeNull();
		expect(await store.tutorContext()).toBe("");
		expect(await store.profile()).toBe(DEFAULT_LEARNER_PROFILE);
		expect(await io.exists(".groundwork/evidence/limit.jsonl")).toBe(false);
		expect(await io.exists(".groundwork/focus.json")).toBe(false);
		expect(await io.exists(".groundwork/tutor-context.md")).toBe(false);
		expect(await io.exists("exams/Midterm.md")).toBe(false);
		expect(await io.exists("tests/2026-09-01 Midterm.md")).toBe(false);
		expect(await io.exists("sessions/2026-09-01 Limits.md")).toBe(false);
		expect(await io.exists(".groundwork/chats/chat-1.json")).toBe(false);
		expect(await io.exists("concepts/.gitkeep")).toBe(true);
		expect(await io.read("resources/Lecture 1.pdf")).toBe("pdf");
		expect(await io.read("README.md")).toBe("# keep\n");
	});
});

describe("goal progress wording", () => {
	it("counts solid concepts in the goal, including one the goal has already built", () => {
		expect(
			describeGoalProgress([
				{ status: "solid", role: "built" },
				{ status: "rusty", role: "built" },
				{ status: "learning", role: "path" },
				{ status: "unassessed", role: "target" },
			]),
		).toBe("2 of 4 concepts solid");
		expect(describeGoalProgress([])).toBe("no concepts");
		expect(describeConceptProgress(4, 14)).toBe("4 of 14 concepts solid");
	});

	it("uses that sentence on the goal note and the working-goal chip", async () => {
		const { store } = makeStore();
		await store.setGoal({
			title: "Rates",
			targets: ["Limit"],
			nodes: [{ title: "Limit" }],
		});
		const pinned = await toolByName("set_working_goal")!.run({ goal: "Rates" }, { store });
		expect(pinned.summary).toBe("Working on “Rates”");
		expect(pinned.summary).not.toMatch(/dropdown/i);
		const cleared = await toolByName("set_working_goal")!.run({ goal: "you choose" }, { store });
		expect(cleared.summary).toBe("No goal pinned");
	});
});
