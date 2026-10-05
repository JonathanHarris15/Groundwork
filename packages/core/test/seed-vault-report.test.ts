import { describe, expect, it } from "vitest";
import { NodeVaultIO } from "../src/node/fs-io";
import { KnowledgeStore } from "../src/store";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("seeded obsidian vault", () => {
	it("loads a goal report for the concept map", async () => {
		const vault = path.join(root, "tmp/seed-check-vault");
		execSync(`rm -rf ${JSON.stringify(vault)}`);
		execSync(`npx -y tsx ${JSON.stringify(path.join(root, "scripts/seed-obsidian-graph-vault.mjs"))} ${JSON.stringify(vault)}`, {
			cwd: root,
		});
		const store = new KnowledgeStore(new NodeVaultIO(vault), { now: () => new Date("2026-10-01T12:00:00Z"), device: "test" });
		const goals = await store.goals();
		expect(goals.length).toBeGreaterThan(0);
		const report = await store.goalReport(goals[0]!.id);
		expect(report.nodes.length).toBeGreaterThan(3);
	});
});
