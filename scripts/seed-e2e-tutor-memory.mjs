#!/usr/bin/env node
/**
 * Seeds packages/server/data for local Obsidian E2E (uid "local").
 * Usage: node scripts/seed-e2e-tutor-memory.mjs [--empty]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryVaultIO, KnowledgeStore, knowledgeSnapshot, tutorMemoryFiles } from "@groundwork/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "packages/server/data");
const empty = process.argv.includes("--empty");
const fixedNow = () => new Date("2026-09-28T12:00:00Z");

async function seedMemory() {
	const io = new MemoryVaultIO();
	const store = new KnowledgeStore(io, { now: fixedNow, device: "e2e-obsidian" });
	await store.ensureLayout();
	if (!empty) {
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		await store.upsertConcept({ title: "Secant line", prerequisites: ["Slope of a line"] });
		await store.upsertConcept({ title: "Limit", summary: "What a sequence or function approaches." });
		await store.upsertConcept({ title: "Derivative", prerequisites: ["Secant line", "Limit"], summary: "Instantaneous rate of change." });
		for (const d of [2, 3, 4]) {
			await store.recordEvidence("Slope of a line", { outcome: "correct", difficulty: d, kind: "probe", question: "Slope?" });
		}
		const report = await store.setGoal({
			title: "Calculus fluency",
			objective: "Understand derivatives from first principles.",
			due: "2026-11-15",
			targets: ["Derivative"],
			nodes: [
				{ title: "Slope of a line" },
				{ title: "Secant line", prerequisites: ["Slope of a line"] },
				{ title: "Limit" },
				{ title: "Derivative", prerequisites: ["Secant line", "Limit"] },
			],
		});
		await store.setWorkingGoal(report.goal.title);
		const lib = {
			updatedAt: fixedNow().toISOString(),
			addFromTeachingNotes: true,
			decks: [
				{ id: "deck-calc", title: "Calculus fluency", goalId: report.goal.id, fileName: "Calculus-fluency.md" },
				{ id: "library", title: "Library" },
				{ id: "scratch", title: "Scratch pad" },
			],
			cards: [
				{
					id: "card-1",
					deckId: "deck-calc",
					concept: "Derivative",
					front: "What is $\\frac{d}{dx} x^2$?",
					back: "$2x$",
					createdAt: fixedNow().toISOString(),
					updatedAt: fixedNow().toISOString(),
					state: "review",
					due: fixedNow().toISOString(),
					intervalMinutes: 24 * 60,
					ease: 2.5,
					reps: 2,
					lapses: 0,
				},
				{
					id: "card-scratch",
					deckId: "scratch",
					concept: "Secant line",
					front: "What is a secant?",
					back: "A line.",
					createdAt: fixedNow().toISOString(),
					updatedAt: fixedNow().toISOString(),
					state: "new",
					due: fixedNow().toISOString(),
					intervalMinutes: 0,
					ease: 2.5,
					reps: 0,
					lapses: 0,
				},
			],
		};
		await io.write(".groundwork/flashcards.json", JSON.stringify(lib, null, 2));
		const chatId = "chat-e2e-seeded";
		const chatNow = new Date();
		const chat = {
			id: chatId,
			title: "Derivative intuition",
			created: new Date(chatNow.getTime() - 86_400_000).toISOString(),
			updated: chatNow.toISOString(),
			messages: [],
			items: [
				{ kind: "user", text: "Walk me through the derivative with a long example, code, and math." },
				{
					kind: "assistant",
					text: `Sure. A derivative measures instantaneous change.

\`\`\`python
def secant_slope(f, x, h):
    return (f(x + h) - f(x)) / h
\`\`\`

For $f(x)=x^2$, the secant slope approaches $2x$ as $h \\to 0$. That limit is the derivative.

$$\\frac{d}{dx} x^2 = 2x$$

This paragraph is intentionally long so narrow panes can be checked for clipping and squashed line lengths in the real Obsidian sidebar.`,
				},
			],
		};
		await io.write(`.groundwork/chats/${chatId}.json`, JSON.stringify(chat, null, 2));
	}
	const concepts = [...(await store.concepts()).values()];
	const goals = await store.goals();
	const updatedAt = fixedNow().toISOString();
	return {
		memory: { updatedAt, files: tutorMemoryFiles(io.files) },
		knowledge: knowledgeSnapshot(concepts, goals, updatedAt),
	};
}

async function seedAccounts() {
	return {
		users: {
			local: {
				plan: "included",
				period: "2026-10",
				spentUsd: 0,
				displayName: "E2E learner",
				email: "e2e@groundwork.test",
			},
		},
	};
}

async function main() {
	await mkdir(dataDir, { recursive: true });
	const record = await seedMemory();
	await writeFile(path.join(dataDir, "tutor-memory.json"), JSON.stringify({ users: { local: record } }, null, 2));
	await writeFile(path.join(dataDir, "accounts.json"), JSON.stringify(await seedAccounts(), null, 2));
	console.log(empty ? "Wrote empty local account + memory for E2E." : "Wrote seeded local account + memory for E2E.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
