import { describe, expect, it } from "vitest";
import { knowledgeSnapshot, layoutConceptMap, parseKnowledgeSnapshot, presentForWebsite, presentGroundwork, refreshFirebaseSession } from "../src/account";
import { isUserKeyProvider, PLANS, USER_KEY_PROVIDERS } from "../src/account/plans";
import { choosePlan, emptyAccount, rememberProfile, setDisplayName, spendHosted, viewAccount } from "../src/account/usage";

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

	it("counts a concept after a quiz and a goal after it is finished", () => {
		const snap = knowledgeSnapshot(
			[
				{ id: "limit", title: "Limit", prerequisites: [], stats: { status: "solid", current: 0.9 } },
				{ id: "derivative", title: "Cost $5", prerequisites: ["limit"], stats: { status: "learning", current: 0.4 } },
				{ id: "chain", title: "Chain rule", prerequisites: ["derivative"], stats: { status: "unassessed", current: 0 } },
				{ id: "integral", title: "Integral", prerequisites: [], stats: { status: "rusty", current: 0.3 } },
			],
			[
				{ title: "The derivative", status: "done", targets: [], built: ["limit", "derivative"] },
				{ title: "Budget $10", status: "active", targets: ["integral"], built: [] },
				{ title: "Paused review", status: "paused", targets: ["chain"], built: [] },
			],
			"2026-10-02T00:00:00.000Z",
		);
		const view = presentGroundwork(snap);
		const json = JSON.stringify(view);
		expect(json).not.toContain("$");
		expect(json).not.toMatch(/"built"|"open"|"current"|"body"/);
		expect(view.concepts.map((c) => c.id)).toEqual(["derivative", "integral", "limit"]);
		expect(view.concepts.find((c) => c.id === "derivative")).toEqual({ id: "derivative", title: "Cost 5", status: "learning" });
		expect(view.goals).toEqual([{ title: "The derivative", status: "done" }]);
		expect(presentGroundwork(null)).toEqual({ updatedAt: null, concepts: [], goals: [] });
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

describe("website sign-in", () => {
	it("exchanges a refresh token for an id token", async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ id_token: "id-token", refresh_token: "next" }), { status: 200 });
		await expect(refreshFirebaseSession("old", "web-key", fetchImpl as typeof fetch)).resolves.toEqual({ idToken: "id-token", refreshToken: "next" });
	});

	it("reports an expired website session", async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "TOKEN_EXPIRED" } }), { status: 400 });
		await expect(refreshFirebaseSession("old", "web-key", fetchImpl as typeof fetch)).rejects.toThrow(/TOKEN_EXPIRED/);
	});
});

describe("plans", () => {
	it("gives the free plan $3 of hosted credit and keeps Jev off the key list", () => {
		expect(PLANS.free.hostedCreditUsd).toBe(3);
		expect(PLANS.free.priceUsdPerMonth).toBe(0);
		expect(PLANS.byom.priceUsdPerMonth).toBe(9);
		expect(PLANS.byom.hostedCreditUsd).toBe(0);
		expect(PLANS.byom.ownModel).toBe(true);
		expect(PLANS.included.priceUsdPerMonth).toBe(20);
		expect(PLANS.included.hostedCreditUsd).toBe(8);
		expect(USER_KEY_PROVIDERS).not.toContain("jev");
		expect(USER_KEY_PROVIDERS).not.toContain("typesafe");
		expect(isUserKeyProvider("openrouter")).toBe(true);
		expect(isUserKeyProvider("jev")).toBe(false);
	});
});

describe("hosted credit", () => {
	const now = new Date("2026-10-01T12:00:00Z");

	it("starts without a plan", () => {
		const view = viewAccount(emptyAccount("u", now), now);
		expect(view.needsPlan).toBe(true);
		expect(view.remainingUsd).toBe(0);
	});

	it("draws the free $3 and stops at the cap", () => {
		const chosen = choosePlan(emptyAccount("u", now), "free", now);
		const first = spendHosted(chosen, 1.25, now);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(viewAccount(first.account, now).remainingUsd).toBe(1.75);
		const over = spendHosted(first.account, 2, now);
		expect(over.ok).toBe(false);
		if (over.ok) return;
		expect(over.reason).toMatch(/used up/);
	});

	it("does not charge a bring-your-own-model account for hosted models", () => {
		const chosen = choosePlan(emptyAccount("u", now), "byom", now);
		const spent = spendHosted(chosen, 0.1, now);
		expect(spent.ok).toBe(false);
	});

	it("keeps a chosen display name when Google sends one later", () => {
		const named = setDisplayName(rememberProfile(emptyAccount("u", now), { email: "ada@example.com", name: "Ada" }), "Countess");
		const again = rememberProfile(named, { name: "Ada Lovelace" });
		expect(again.displayName).toBe("Countess");
		expect(again.email).toBe("ada@example.com");
		expect(viewAccount(again, now).hasBilling).toBe(false);
	});

	it("resets spend when the month changes", () => {
		const chosen = choosePlan(emptyAccount("u", now), "included", now);
		const spent = spendHosted(chosen, 8, now);
		expect(spent.ok).toBe(true);
		if (!spent.ok) return;
		const nextMonth = viewAccount(spent.account, new Date("2026-11-02T00:00:00Z"));
		expect(nextMonth.spentUsd).toBe(0);
		expect(nextMonth.remainingUsd).toBe(8);
	});
});
