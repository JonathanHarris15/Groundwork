#!/usr/bin/env node
/** Populate a vault directory with concepts + a pinned goal for concept-map graph screenshots. */
import { KnowledgeStore } from "@groundwork/core";
import { NodeVaultIO } from "@groundwork/core/node";

const vault = process.argv[2];
if (!vault) {
	console.error("Usage: seed-obsidian-graph-vault.mjs <vault-path>");
	process.exit(1);
}

const io = new NodeVaultIO(vault);
const store = new KnowledgeStore(io, { now: () => new Date("2026-10-01T12:00:00Z"), device: "e2e" });
await store.ensureLayout();

const chains = [
	{ domain: "Calculus", titles: ["Limits", "Continuity", "Derivative", "Product rule", "Chain rule", "Implicit differentiation"] },
	{ domain: "Linear algebra", titles: ["Vectors", "Dot product", "Matrices", "Row reduction", "Eigenvalues"] },
	{ domain: "Probability", titles: ["Sample space", "Conditional probability", "Bayes rule", "Expectation", "Variance"] },
];

for (const chain of chains) {
	let prev = null;
	for (const title of chain.titles) {
		await store.upsertConcept({
			title,
			domain: chain.domain,
			prerequisites: prev ? [prev] : [],
		});
		prev = title;
	}
}

const report = await store.setGoal({
	title: "Midterm fluency",
	targets: ["Chain rule", "Eigenvalues", "Bayes rule"],
	nodes: [
		{ title: "Limits" },
		{ title: "Continuity", prerequisites: ["Limits"] },
		{ title: "Derivative", prerequisites: ["Continuity"] },
		{ title: "Product rule", prerequisites: ["Derivative"] },
		{ title: "Chain rule", prerequisites: ["Product rule"], requiredLevel: 3 },
		{ title: "Vectors" },
		{ title: "Matrices", prerequisites: ["Vectors"] },
		{ title: "Eigenvalues", prerequisites: ["Matrices"], requiredLevel: 3 },
		{ title: "Sample space" },
		{ title: "Bayes rule", prerequisites: ["Conditional probability"], requiredLevel: 3 },
	],
});
await store.setWorkingGoal(report.goal.id);
console.log(`Seeded ${(await store.concepts()).size} concepts and goal "${report.goal.title}" in ${vault}`);
