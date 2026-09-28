import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { git, GitSync } from "../src/node/git";
import { NodeVaultIO } from "../src/node/fs-io";
import { scaffoldVault } from "../src/node/vault";
import { KnowledgeStore } from "../src/store";

async function sh(cwd: string, ...args: string[]) {
	const r = await git(cwd, args);
	if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

describe("GitSync across two machines", () => {
	it("merges offline quiz evidence from both machines and rebuilds stats", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "gw-git-"));
		const remote = path.join(tmp, "remote.git");
		const a = path.join(tmp, "laptop");
		const b = path.join(tmp, "desktop");
		await sh(tmp, "init", "--bare", "-b", "main", remote);
		await sh(tmp, "clone", remote, a);
		for (const d of [a]) {
			await sh(d, "config", "user.email", "t@example.com");
			await sh(d, "config", "user.name", "Test");
		}
		await scaffoldVault(a);
		const storeA = new KnowledgeStore(new NodeVaultIO(a), { device: "laptop" });
		await storeA.upsertConcept({ title: "Limit" });
		const syncA = new GitSync(a);
		expect((await syncA.sync()).pushed).toBe(true);

		await sh(tmp, "clone", remote, b);
		await sh(b, "config", "user.email", "t@example.com");
		await sh(b, "config", "user.name", "Test");
		const storeB = new KnowledgeStore(new NodeVaultIO(b), { device: "desktop" });
		const syncB = new GitSync(b);

		await storeA.recordEvidence("Limit", { outcome: "correct", difficulty: 3, kind: "check", ts: "2026-09-01T10:00:00Z" });
		await storeB.recordEvidence("Limit", { outcome: "incorrect", difficulty: 4, kind: "probe", ts: "2026-09-01T11:00:00Z" });

		await syncA.sync();
		const report = await syncB.sync(undefined, () => storeB.recomputeAll());
		expect(report.state === "synced" || report.state === "conflict-resolved").toBe(true);
		expect(report.incoming).toBe(true);

		storeB.invalidate();
		const limit = await storeB.requireConcept("Limit");
		expect(limit.stats.attempts).toBe(2);
		const note = await new NodeVaultIO(b).read(limit.path);
		expect(note).not.toContain("<<<<<<<");
		expect(note).toContain("attempts: 2");

		await syncA.sync(undefined, () => storeA.recomputeAll());
		storeA.invalidate();
		expect((await storeA.requireConcept("Limit")).stats.attempts).toBe(2);
	}, 30_000);
});
