#!/usr/bin/env node
/**
 * Seeds a Calc 1 final vault for the college practice-test captures.
 * Writes tmp/calc-capture/tutor-memory.json and accounts.json for uid "local".
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryVaultIO, KnowledgeStore, knowledgeSnapshot, tutorMemoryFiles } from "@groundwork/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp/calc-capture");
const now = new Date();
const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();

const nodes = [
	{ title: "Algebra", summary: "Manipulating expressions and equations." },
	{ title: "Functions", prerequisites: ["Algebra"], summary: "A rule that assigns one output to each input." },
	{ title: "Slope of a line", prerequisites: ["Functions"], summary: "Rise over run between two points on a line." },
	{ title: "Average rate of change", prerequisites: ["Slope of a line"], summary: "The slope of the line through two points on a curve." },
	{ title: "Limits", prerequisites: ["Average rate of change"], summary: "The value a function approaches as the input approaches a point." },
	{ title: "Derivative definition", prerequisites: ["Limits"], summary: "The limit of average rates as the two points meet." },
	{ title: "Power rule", prerequisites: ["Derivative definition"], summary: "The derivative of x^n is n x^{n-1}." },
	{ title: "Product rule", prerequisites: ["Power rule"], summary: "The derivative of a product is each factor times the other's derivative." },
	{ title: "Chain rule", prerequisites: ["Power rule"], summary: "The derivative of an outer function times the derivative of the inner function." },
	{ title: "Derivative of sine", prerequisites: ["Power rule"], summary: "The derivative of sin x is cos x." },
	{ title: "Quotient rule", prerequisites: ["Product rule"], summary: "The derivative of a quotient." },
];

async function solid(store, title) {
	await store.recordEvidence(title, { outcome: "correct", difficulty: 5, kind: "check", question: title, ts: ago(2) });
	await store.recordEvidence(title, { outcome: "correct", difficulty: 5, kind: "check", question: title, ts: ago(0.2) });
}

async function seedMemory() {
	const io = new MemoryVaultIO();
	const store = new KnowledgeStore(io, { now: () => now, device: "calc-capture" });
	await store.ensureLayout();
	for (const node of nodes) await store.upsertConcept(node);
	for (const title of ["Algebra", "Functions", "Slope of a line", "Average rate of change"]) await solid(store, title);
	await store.recordEvidence("Limits", { outcome: "correct", difficulty: 5, kind: "check", question: "Limits", ts: ago(50) });
	await store.recordEvidence("Limits", { outcome: "correct", difficulty: 5, kind: "check", question: "Limits", ts: ago(49.9) });
	await store.recordEvidence("Derivative definition", { outcome: "correct", difficulty: 3, kind: "check", question: "Derivative definition", ts: ago(0.1) });
	await store.recordEvidence("Power rule", { outcome: "incorrect", difficulty: 3, kind: "check", question: "Power rule", ts: ago(0.1) });
	const report = await store.setGoal(
		{
			title: "Calc 1 final",
			objective: "Be ready for the Calc 1 final on derivatives.",
			due: "2026-12-09",
			targets: ["Chain rule", "Derivative of sine", "Quotient rule"],
			nodes,
		},
		{ judgments: "off" },
	);
	await store.setWorkingGoal(report.goal.title);
	const concepts = [...(await store.concepts()).values()];
	const goals = await store.goals();
	const timing = await store.goalTiming(report);
	const summary = {
		due: report.goal.due,
		daysLeft: timing.schedule?.daysLeft,
		pace: timing.schedule?.pace,
		readiness: Math.round(timing.readiness * 100),
		next: report.next?.concept ?? null,
		concepts: concepts
			.map((c) => ({ title: c.title, status: c.stats.status, current: c.stats.current, attempts: c.stats.attempts }))
			.sort((a, b) => a.title.localeCompare(b.title)),
	};
	return {
		record: {
			memory: { updatedAt: now.toISOString(), files: tutorMemoryFiles(io.files) },
			knowledge: knowledgeSnapshot(concepts, goals, now.toISOString()),
		},
		summary,
	};
}

async function main() {
	await mkdir(outDir, { recursive: true });
	const { record, summary } = await seedMemory();
	await writeFile(path.join(outDir, "tutor-memory.json"), JSON.stringify({ users: { local: record } }, null, 2));
	await writeFile(
		path.join(outDir, "accounts.json"),
		JSON.stringify(
			{
				users: {
					local: {
						plan: "included",
						period: "2026-10",
						spentUsd: 0,
						displayName: "Learner",
						email: "learner@groundwork.test",
					},
				},
			},
			null,
			2,
		),
	);
	await writeFile(path.join(outDir, "seed-summary.json"), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
