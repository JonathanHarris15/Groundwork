import { describe, expect, it } from "vitest";
import { knowledgeSnapshot, layoutConceptMap, parseKnowledgeSnapshot, presentForWebsite } from "../src/account";

const concepts = [
	{ id: "limit", title: "Limit", prerequisites: [], domain: "calculus", stats: { status: "solid" as const, current: 0.91 }, body: "private note about the learner" },
	{ id: "derivative", title: "Derivative", prerequisites: ["limit", "missing"], stats: { status: "learning" as const, current: 0.4 }, body: "quiz: what is f'(x)?" },
	{ id: "chain-rule", title: "Chain rule", prerequisites: ["derivative"], stats: { status: "unassessed" as const, current: 0 }, body: "" },
];

describe("knowledge snapshot", () => {
	it("keeps the map and drops private note text", () => {
		const goals = [{ title: "The derivative", status: "active" as const, targets: ["derivative", "chain-rule"], built: ["limit"], objective: "secret goal notes" }];
		const snap = knowledgeSnapshot(concepts, goals, "2026-10-02T00:00:00.000Z");
		const json = JSON.stringify(snap);
		expect(json).not.toContain("private note");
		expect(json).not.toContain("f'(x)");
		expect(json).not.toContain("secret goal");
		expect(snap.concepts.find((c) => c.id === "derivative")?.prerequisites).toEqual(["limit"]);
		expect(snap.counts).toMatchObject({ solid: 1, learning: 1, unassessed: 1 });
		expect(snap.goals[0]).toEqual({ title: "The derivative", status: "active", built: 1, open: 2 });
	});

	it("round-trips through the parser", () => {
		const snap = knowledgeSnapshot(concepts, [], "2026-10-02T00:00:00.000Z");
		expect(parseKnowledgeSnapshot(snap)).toEqual(snap);
	});

	it("rejects an unknown status", () => {
		expect(() => parseKnowledgeSnapshot({ concepts: [{ id: "a", title: "A", status: "genius", current: 1, prerequisites: [] }] })).toThrow(/status/);
	});
});

describe("website profile", () => {
	it("never includes a dollar sign or a quota of given versus left", () => {
		const snap = knowledgeSnapshot(
			[
				{ id: "price", title: "Cost $5", prerequisites: [], domain: "$ calc", stats: { status: "solid", current: 0.5 } },
				{ id: "limit", title: "Limit", prerequisites: ["price"], stats: { status: "learning", current: 0.2 } },
			],
			[{ title: "Budget $10", status: "active", targets: ["limit"], built: ["price"] }],
			"2026-10-02T00:00:00.000Z",
		);
		const view = presentForWebsite({
			user: { id: "1", email: "ada@$example.com", handle: "ada", displayName: "Ada $ Lovelace" },
			updatedAt: snap.updatedAt,
			map: layoutConceptMap(snap.concepts),
			goals: snap.goals,
			counts: snap.counts,
		});
		const json = JSON.stringify(view);
		expect(json).not.toContain("$");
		expect(json).not.toMatch(/"built"|"open"|"current"|"quota"/);
		expect(view.user.displayName).toBe("Ada Lovelace");
		expect(view.goals[0]).toEqual({ title: "Budget 10", status: "active" });
		expect(view.map.nodes.find((n) => n.id === "price")?.title).toBe("Cost 5");
	});
});

describe("concept map layout", () => {
	it("places prerequisites below the concepts that depend on them", () => {
		const snap = knowledgeSnapshot(concepts, [], "2026-10-02T00:00:00.000Z");
		const map = layoutConceptMap(snap.concepts);
		const y = (id: string) => map.nodes.find((n) => n.id === id)!.y;
		expect(y("limit")).toBeGreaterThan(y("derivative"));
		expect(y("derivative")).toBeGreaterThan(y("chain-rule"));
		expect(map.edges).toEqual([
			{ from: "derivative", to: "chain-rule" },
			{ from: "limit", to: "derivative" },
		]);
		const spots = map.nodes.map((n) => `${n.x},${n.y}`);
		expect(new Set(spots).size).toBe(spots.length);
		for (const n of map.nodes) {
			expect(n.x).toBeGreaterThan(40);
			expect(n.x).toBeLessThan(map.width - 150);
		}
	});

	it("survives a cycle", () => {
		const map = layoutConceptMap([
			{ id: "a", title: "A", prerequisites: ["b"], status: "shaky", current: 0.5 },
			{ id: "b", title: "B", prerequisites: ["a"], status: "shaky", current: 0.5 },
		]);
		expect(map.nodes).toHaveLength(2);
		expect(map.edges).toHaveLength(2);
	});
});
