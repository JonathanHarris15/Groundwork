import { describe, expect, it } from "vitest";
import type { ExtractedConcept } from "@groundwork/core";
import { claimJob, failOwnedShard, finishShard, newBulkJob } from "../src/bulk-job";

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
});
