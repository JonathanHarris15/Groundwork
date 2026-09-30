import { describe, expect, it } from "vitest";
import { demoteHeadings, getSection, setSection } from "../src/markdown";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";

describe("sections", () => {
	it("replaces a section in place and leaves the rest alone", () => {
		const body = "# T\n\n## A\n\nold\n\n## B\n\nkeep\n";
		const out = setSection(body, "A", "new");
		expect(getSection(out, "A")).toBe("new");
		expect(getSection(out, "B")).toBe("keep");
	});

	it("ignores ## lines inside code fences and $$ blocks", () => {
		const body = "## Map\n\n```mermaid\n## not a heading\n```\n\n$$\n## x\n$$\n\n## Next\n\nn\n";
		expect(getSection(body, "Map")).toContain("## not a heading");
		expect(getSection(setSection(body, "Map", "m"), "Next")).toBe("n");
	});

	it("inserts missing sections before generated ones", () => {
		const body = "# T\n\n## Quiz history\n\n| t |\n";
		const out = setSection(body, "Summary", "s", ["Quiz history"]);
		expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## Quiz history"));
	});

	it("demotes headings outside fences", () => {
		expect(demoteHeadings("## Plan\n```\n## keep\n```\n# Top")).toBe("#### Plan\n```\n## keep\n```\n### Top");
	});

	it("regenerating stats and goal maps is idempotent", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io, { now: () => new Date("2026-09-28T12:00:00Z") });
		await store.setGoal({ title: "G", objective: "## sneaky heading in objective", targets: ["B"], nodes: [{ title: "A" }, { title: "B", prerequisites: ["A"] }] });
		await store.recordEvidence("A", { outcome: "correct", difficulty: 3, kind: "check" });
		await store.recordEvidence("A", { outcome: "correct", difficulty: 4, kind: "check" });
		await store.upsertConcept({ title: "A", summary: "Added after history exists." });
		await store.recomputeAll();
		await store.recomputeAll();
		const concept = await io.read("concepts/A.md");
		const goal = await io.read("goals/G.md");
		expect(concept.match(/## Quiz history/g)).toHaveLength(1);
		expect(concept.indexOf("## Summary")).toBeLessThan(concept.indexOf("## Quiz history"));
		expect(goal.match(/## Dependency map/g)).toHaveLength(1);
		expect(goal.match(/```mermaid/g)).toHaveLength(1);
		expect(goal).toContain("#### sneaky heading");
		expect(goal).not.toContain("%%");
	});
});
