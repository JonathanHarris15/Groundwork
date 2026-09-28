import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { parseNote } from "../src/markdown";
import { KnowledgeStore } from "../src/store";

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
			target: "Derivative",
			nodes: [
				{ title: "Slope of a line" },
				{ title: "Secant line", prerequisites: ["Slope of a line"] },
				{ title: "Limit" },
				{ title: "Derivative", prerequisites: ["Secant line", "Limit"] },
			],
		});
		expect(report.analysis.frontier.map((n) => n.title).sort()).toEqual(["Limit", "Slope of a line"]);
		expect(report.mermaid).toContain("graph BT");

		for (const d of [2, 3, 4]) {
			await store.recordEvidence("Slope of a line", { outcome: "correct", difficulty: d, kind: "probe" });
		}
		const r2 = await store.goalReport("Understand the derivative");
		expect(r2.nodes.find((n) => n.title === "Slope of a line")?.status).toBe("solid");
		expect(r2.analysis.frontier.map((n) => n.title).sort()).toEqual(["Limit", "Secant line"]);

		const goalNote = await io.read("goals/Understand the derivative.md");
		expect(goalNote).toContain("1/4 solid");
		expect(goalNote).toContain("```mermaid");
		expect(io.files.get(".groundwork/evidence/slope-of-a-line.jsonl")!.trim().split("\n")).toHaveLength(3);
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
