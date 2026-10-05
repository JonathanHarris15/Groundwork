import { describe, expect, it } from "vitest";
import { knowledgeSnapshot, mergeTutorMemoryFiles, parseKnowledgeSnapshot, presentGroundwork, refreshFirebaseSession, tutorMemoryFiles } from "../src/account";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { layoutGroundworkGraph } from "../src/groundwork-graph";
import { isUserKeyProvider, PLANS, publicPlan, USER_KEY_PROVIDERS } from "../src/account/plans";
import { choosePlan, emptyAccount, presentAccount, rememberProfile, setDisplayName, spendHosted, viewAccount } from "../src/account/usage";

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
		expect(snap.goals[0]).toEqual({ title: "The derivative", status: "active", built: 1, open: 2, domain: "calculus" });
	});

	it("round-trips through the parser", () => {
		const snap = knowledgeSnapshot(concepts, [], "2026-10-02T00:00:00.000Z");
		expect(parseKnowledgeSnapshot(snap)).toEqual(snap);
	});

	it("rejects an unknown status", () => {
		expect(() => parseKnowledgeSnapshot({ concepts: [{ id: "a", title: "A", status: "genius", current: 1, prerequisites: [] }] })).toThrow(/status/);
	});

	it("keeps a long concept title the tutor can name", () => {
		const title = "The relationship between a secant line through two points and the derivative at a single point on the curve";
		const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		expect(id.length).toBeGreaterThan(80);
		const snap = parseKnowledgeSnapshot({
			concepts: [{ id, title, status: "unassessed", current: 0, prerequisites: [] }],
			goals: [],
		});
		expect(snap.concepts[0]?.id).toBe(id);
		expect(snap.concepts[0]?.title).toBe(title);
	});
});

describe("website profile", () => {
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
		expect(view.concepts.map((c) => c.id)).toEqual(["chain", "derivative", "integral", "limit"]);
		expect(view.concepts.find((c) => c.id === "chain")?.status).toBe("unassessed");
		expect(view.concepts.find((c) => c.id === "derivative")).toEqual({ id: "derivative", title: "Cost 5", status: "learning" });
		expect(view.goals).toEqual([{ title: "The derivative", status: "done", concepts: 2 }]);
		expect(view.graph.nodes.map((n) => n.id).sort()).toEqual(["chain", "derivative", "integral", "limit"]);
		expect(view.graph.edges).toEqual([
			{ from: "derivative", to: "chain", bridge: false },
			{ from: "limit", to: "derivative", bridge: false },
		]);
		expect(view.graph.nodes.every((n) => n.x >= 0 && n.x <= view.graph.width && n.y >= 0 && n.y <= view.graph.height)).toBe(true);
		expect(presentGroundwork(null)).toEqual({ updatedAt: null, concepts: [], goals: [], graph: { width: 0, height: 0, nodes: [], edges: [], legend: [] } });
	});
});

describe("groundwork graph", () => {
	it("clusters subjects and dashes the links between them", () => {
		const graph = layoutGroundworkGraph([
			{ id: "prior", title: "Prior and posterior", prerequisites: [], domain: "Bayes" },
			{ id: "conditional", title: "Conditional probability", prerequisites: ["prior"], domain: "Bayes" },
			{ id: "eigen", title: "Eigenvectors", prerequisites: ["conditional"], domain: "Linear algebra" },
			{ id: "basis", title: "Basis", prerequisites: ["eigen"], domain: "Linear algebra" },
		]);
		expect(graph.legend.map((item) => item.domain)).toEqual(["Bayes", "Linear algebra"]);
		expect(graph.edges.find((e) => e.from === "prior" && e.to === "conditional")?.bridge).toBe(false);
		expect(graph.edges.find((e) => e.from === "conditional" && e.to === "eigen")?.bridge).toBe(true);
		const bayes = graph.nodes.filter((n) => n.domain === "Bayes");
		const algebra = graph.nodes.filter((n) => n.domain === "Linear algebra");
		expect(Math.max(...bayes.map((n) => n.x))).toBeLessThan(Math.min(...algebra.map((n) => n.x)));
		expect(new Set(graph.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(graph.nodes.length);
		const labeled = graph.nodes.filter((n) => n.label).map((n) => n.id);
		expect(labeled).toContain("conditional");
		expect(labeled).toContain("eigen");
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

	it("rejects a non-JSON sign-in response", async () => {
		const fetchImpl = async () => new Response("not json", { status: 502 });
		await expect(refreshFirebaseSession("old", "web-key", fetchImpl as typeof fetch)).rejects.toThrow(/unreadable response/);
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

	it("publishes prices without the hosted allowance", () => {
		for (const plan of Object.values(PLANS)) {
			const shown = publicPlan(plan);
			expect(shown).not.toHaveProperty("hostedCreditUsd");
			expect(shown.summary).not.toMatch(/\$\d/);
			expect(JSON.stringify(shown)).not.toMatch(/creditUsd|hostedCredit/);
		}
		expect(publicPlan(PLANS.byom).priceUsdPerMonth).toBe(9);
		expect(publicPlan(PLANS.included).priceUsdPerMonth).toBe(20);
		const shown = presentAccount(viewAccount(choosePlan(emptyAccount("u"), "free")));
		expect(shown).not.toHaveProperty("creditUsd");
		expect(shown).not.toHaveProperty("remainingUsd");
		expect(shown).not.toHaveProperty("spentUsd");
		expect(shown.budgetUsed).toBe(0);
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

describe("tutor memory across devices", () => {
	it("keeps a file only one device added, and a delete only when the other side did not edit it", () => {
		const base = { "learner.md": "base", "concepts/Old.md": "old" };
		const merged = mergeTutorMemoryFiles(
			base,
			{ "learner.md": "base", "concepts/Old.md": "old", "concepts/Limit.md": "from the laptop" },
			{ "learner.md": "base", "concepts/Old.md": "old", "concepts/Integral.md": "from the phone" },
		);
		expect(merged).toEqual({
			"learner.md": "base",
			"concepts/Old.md": "old",
			"concepts/Limit.md": "from the laptop",
			"concepts/Integral.md": "from the phone",
		});
		const honored = mergeTutorMemoryFiles(base, { "learner.md": "base" }, { "learner.md": "base", "concepts/Old.md": "old" });
		expect(honored).toEqual({ "learner.md": "base" });
		const kept = mergeTutorMemoryFiles(base, { "learner.md": "base" }, { "learner.md": "base", "concepts/Old.md": "rewritten" });
		expect(kept["concepts/Old.md"]).toBe("rewritten");
	});

	it("lets the saving device win when both edited the same file, and takes the other device's edit otherwise", () => {
		const base = { "learner.md": "base", "concepts/Limit.md": "v1" };
		const localWins = mergeTutorMemoryFiles(base, { "learner.md": "laptop", "concepts/Limit.md": "v1" }, { "learner.md": "phone", "concepts/Limit.md": "v2" });
		expect(localWins["learner.md"]).toBe("laptop");
		expect(localWins["concepts/Limit.md"]).toBe("v2");
	});

	it("keeps a goal date and quiz evidence when the account files move to another device", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io, { now: () => new Date("2026-10-02T12:00:00.000Z") });
		await store.upsertConcept({ title: "Limit", summary: "The value a function approaches." });
		await store.setGoal({ title: "Exam", targets: ["Limit"], nodes: [{ title: "Limit" }], due: "2026-10-20" }, { judgments: "off" });
		await store.recordEvidence("limit", { outcome: "correct", difficulty: 2, kind: "check", question: "What is a limit?" });
		const files = tutorMemoryFiles(io.files);
		expect(Object.keys(files).some((path) => path.startsWith("goals/"))).toBe(true);
		expect(Object.keys(files).some((path) => path.startsWith(".groundwork/evidence/"))).toBe(true);
		const next = new MemoryVaultIO();
		for (const [path, content] of Object.entries(files)) next.files.set(path, content);
		const other = new KnowledgeStore(next, { now: () => new Date("2026-10-02T12:00:00.000Z") });
		expect((await other.goals())[0]?.due).toBe("2026-10-20");
		expect((await other.concepts()).get("limit")?.stats.attempts).toBe(1);
	});
});
