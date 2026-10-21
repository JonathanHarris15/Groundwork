import { describe, expect, it } from "vitest";
import type { ExtractedConcept } from "@groundwork/core";
import { BULK_JOB_TTL_MS, MemoryBulkJobStore, claimJob, failOwnedShard, finishMergeBatch, finishShard, newBulkJob } from "../src/bulk-job";

const concept: ExtractedConcept = { title: "Limit", prerequisites: [], sources: [{ path: "resources/a.md", locator: "section 1" }] };

function job() {
	return newBulkJob({
		id: "abc",
		uid: "ada",
		userText: "Help me learn all of these lectures",
		files: [1, 2, 3, 4].map((n) => ({ path: `resources/${n}.md`, name: `${n}.md`, text: "Limit" })),
	});
}

describe("bulk job claims", () => {
	it("claims one queued shard and ignores a finish from an older claim", () => {
		const first = claimJob(job(), 1_000);
		expect(first.claim).toEqual({ kind: "shard", index: 0, claimId: 1 });
		const stolen = claimJob(first.job, 1_000 + 330_000);
		expect(stolen.claim).toEqual({ kind: "shard", index: 0, claimId: 2 });
		const staleWrite = finishShard(stolen.job, 0, 1, [concept], { input: 5, output: 5 });
		expect(staleWrite.shards[0]?.status).toBe("running");
		expect(staleWrite.shards[0]?.concepts).toEqual([]);
		const current = finishShard(stolen.job, 0, 2, [concept], { input: 9, output: 4 });
		expect(current.shards[0]?.status).toBe("done");
		expect(current.shards[0]?.usage).toEqual({ input: 9, output: 4 });
		const failed = failOwnedShard(stolen.job, 0, 1, "The document read failed.");
		expect(failed.status).toBe("open");
	});

	it("waits while a fresh shard is running, then claims the merge", () => {
		const first = claimJob(job(), 1_000);
		const second = claimJob(first.job, 1_100);
		expect(second.claim.kind).toBe("shard");
		const waiting = claimJob(second.job, 1_200);
		expect(waiting.claim.kind).toBe("wait");
		let current = second.job;
		for (let index = 0; index < current.shards.length; index++) {
			const claim = current.shards[index];
			if (!claim || claim.status === "done") continue;
			current = finishShard(current, index, claim.claimId, [concept]);
		}
		const merge = claimJob(current, 2_000);
		expect(merge.claim.kind).toBe("merge");
		const again = claimJob(merge.job, 2_100);
		expect(again.claim.kind).toBe("wait");
	});

	it("walks a long concept list in short rename batches", () => {
		const base = newBulkJob({
			id: "abc",
			uid: "ada",
			userText: "Help me learn all of these lectures",
			files: [{ path: "resources/a.md", name: "a.md", text: "Limit" }],
		});
		const shard = base.shards[0];
		if (!shard) throw new Error("missing shard");
		shard.status = "done";
		shard.concepts = Array.from({ length: 25 }, (_, index) => ({
			title: `Quartz notion ${String(index).padStart(3, "0")}`,
			prerequisites: [],
			sources: [{ path: "resources/a.md", locator: "heading" }],
		}));
		const first = claimJob(base, 1_000);
		expect(first.claim).toMatchObject({ kind: "merge", from: 0, to: 20 });
		if (first.claim.kind !== "merge") return;
		const mid = finishMergeBatch(first.job, first.claim.claimId, [{ from: "Quartz notion 000", to: "Quartz notion 001" }]);
		expect(mid.mergeCursor).toBe(20);
		expect(mid.mergeStatus).toBe("queued");
		const second = claimJob(mid, 2_000);
		expect(second.claim).toMatchObject({ kind: "merge", from: 20, to: 25 });
		if (second.claim.kind !== "merge") return;
		const rest = finishMergeBatch(second.job, second.claim.claimId, []);
		const assemble = claimJob(rest, 3_000);
		expect(assemble.claim.kind).toBe("assemble");
	});

	it("drops file text when a shard finishes and deletes an expired job", async () => {
		const store = new MemoryBulkJobStore();
		const created = await store.create({
			uid: "ada",
			userText: "Help me learn all of these lectures",
			files: [
				{ path: "resources/a.md", name: "a.md", text: "x".repeat(1000) },
				{ path: "resources/b.md", name: "b.md", text: "y".repeat(1000) },
			],
		});
		const claimed = await store.claim(created.id, "ada", Date.now());
		expect(claimed?.claim.kind).toBe("shard");
		if (!claimed || claimed.claim.kind !== "shard") return;
		const indexes = claimed.job.shards[claimed.claim.index]?.fileIndexes ?? [];
		expect((await store.files(created.id, indexes)).some((file) => file.text.length === 1000)).toBe(true);
		await store.finishShard(created.id, claimed.claim.index, claimed.claim.claimId, [concept], { input: 1, output: 1 });
		expect(await store.files(created.id, indexes)).toEqual([]);
		await store.sweep(Date.now() + BULK_JOB_TTL_MS + 1);
		expect(await store.claim(created.id, "ada", Date.now())).toBeNull();
	});
});
