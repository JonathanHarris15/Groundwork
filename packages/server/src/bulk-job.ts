import { randomBytes } from "node:crypto";
import { type Firestore } from "firebase-admin/firestore";
import {
	buildingProgress,
	planShards,
	readingProgress,
	type BulkFile,
	type BulkImportResult,
	type BulkProgress,
	type ExtractedConcept,
} from "@groundwork/core";
import { openFirestore } from "./firestore";

/**
 * A running claim older than this can be taken again.
 * One model call can outlive the website proxy. Cloud Run keeps that request
 * (the service timeout is 300s) and writes the shard when it finishes.
 * Reclaiming sooner would run the same shard twice and charge it twice.
 */
export const BULK_JOB_STALE_MS = 330_000;

export interface BulkShardRecord {
	fileIndexes: number[];
	status: "queued" | "running" | "done";
	claimId: number;
	claimedAt: number;
	concepts: ExtractedConcept[];
	usage: { input: number; output: number };
}

export interface BulkJobRecord {
	id: string;
	uid: string;
	userText: string;
	title?: string;
	paths: string[];
	startedAt: number;
	shards: BulkShardRecord[];
	mergeStatus: "queued" | "running" | "done";
	mergeClaimId: number;
	mergeClaimedAt: number;
	status: "open" | "done" | "error";
	error?: string;
	result?: BulkImportResult;
}

export type BulkClaim =
	| { kind: "shard"; index: number; claimId: number }
	| { kind: "merge"; claimId: number }
	| { kind: "wait" }
	| { kind: "done" }
	| { kind: "error"; error: string };

export function newBulkJob(input: { id: string; uid: string; userText: string; title?: string; files: BulkFile[] }): BulkJobRecord {
	let cursor = 0;
	const shards = planShards(input.files).map((group) => {
		const fileIndexes = group.map(() => cursor++);
		return { fileIndexes, status: "queued" as const, claimId: 0, claimedAt: 0, concepts: [] as ExtractedConcept[], usage: { input: 0, output: 0 } };
	});
	return {
		id: input.id,
		uid: input.uid,
		userText: input.userText,
		...(input.title ? { title: input.title } : {}),
		paths: input.files.map((file) => file.path),
		startedAt: Date.now(),
		shards,
		mergeStatus: "queued",
		mergeClaimId: 0,
		mergeClaimedAt: 0,
		status: "open",
	};
}

export function bulkJobProgress(job: BulkJobRecord): BulkProgress {
	const total = job.paths.length;
	if (job.shards.every((shard) => shard.status === "done")) return buildingProgress(total);
	const done = job.shards.filter((shard) => shard.status === "done").reduce((sum, shard) => sum + shard.fileIndexes.length, 0);
	return readingProgress(done, total);
}

export function claimJob(job: BulkJobRecord, now: number, staleMs = BULK_JOB_STALE_MS): { job: BulkJobRecord; claim: BulkClaim } {
	if (job.status === "error") return { job, claim: { kind: "error", error: job.error || "The bulk import did not finish." } };
	if (job.status === "done" && job.result) return { job, claim: { kind: "done" } };
	const stale = (at: number, status: string) => status === "running" && at > 0 && now - at >= staleMs;
	const next = structuredClone(job);
	const shardIndex = next.shards.findIndex((shard) => shard.status === "queued" || stale(shard.claimedAt, shard.status));
	if (shardIndex >= 0) {
		const shard = next.shards[shardIndex];
		if (!shard) return { job: next, claim: { kind: "wait" } };
		shard.status = "running";
		shard.claimId += 1;
		shard.claimedAt = now;
		return { job: next, claim: { kind: "shard", index: shardIndex, claimId: shard.claimId } };
	}
	if (next.shards.some((shard) => shard.status === "running")) return { job, claim: { kind: "wait" } };
	if (next.mergeStatus === "done" && next.result) {
		next.status = "done";
		return { job: next, claim: { kind: "done" } };
	}
	if (next.mergeStatus === "queued" || stale(next.mergeClaimedAt, next.mergeStatus)) {
		next.mergeStatus = "running";
		next.mergeClaimId += 1;
		next.mergeClaimedAt = now;
		return { job: next, claim: { kind: "merge", claimId: next.mergeClaimId } };
	}
	return { job, claim: { kind: "wait" } };
}

export function finishShard(
	job: BulkJobRecord,
	index: number,
	claimId: number,
	concepts: ExtractedConcept[],
	usage: { input: number; output: number } = { input: 0, output: 0 },
): BulkJobRecord {
	const shard = job.shards[index];
	if (!shard || shard.claimId !== claimId || job.status !== "open") return job;
	const next = structuredClone(job);
	const target = next.shards[index];
	if (!target) return job;
	target.status = "done";
	target.concepts = concepts;
	target.usage = { input: usage.input, output: usage.output };
	return next;
}

/** A failed model call only fails the job while this claim still owns the step. */
export function failOwnedShard(job: BulkJobRecord, index: number, claimId: number, message: string): BulkJobRecord {
	const shard = job.shards[index];
	if (!shard || shard.claimId !== claimId || job.status !== "open") return job;
	return failJob(job, message);
}

export function failOwnedMerge(job: BulkJobRecord, claimId: number, message: string): BulkJobRecord {
	if (job.mergeClaimId !== claimId || job.status !== "open" || job.mergeStatus !== "running") return job;
	return failJob(job, message);
}

export function finishMerge(job: BulkJobRecord, claimId: number, result: BulkImportResult): BulkJobRecord {
	if (job.mergeClaimId !== claimId || job.status !== "open") return job;
	const next = structuredClone(job);
	next.mergeStatus = "done";
	next.status = "done";
	next.result = result;
	return next;
}

export function failJob(job: BulkJobRecord, message: string): BulkJobRecord {
	if (job.status === "done") return job;
	const next = structuredClone(job);
	next.status = "error";
	next.error = message;
	return next;
}

export function newJobId(): string {
	return randomBytes(16).toString("hex");
}

export interface ClaimedBulkJob {
	job: BulkJobRecord;
	claim: BulkClaim;
}

export interface BulkJobStore {
	create(input: { uid: string; userText: string; title?: string; files: BulkFile[] }): Promise<BulkJobRecord>;
	claim(id: string, uid: string, now: number): Promise<ClaimedBulkJob | null>;
	files(id: string, indexes: number[]): Promise<BulkFile[]>;
	finishShard(id: string, index: number, claimId: number, concepts: ExtractedConcept[], usage: { input: number; output: number }): Promise<BulkJobRecord | null>;
	finishMerge(id: string, claimId: number, result: BulkImportResult): Promise<BulkJobRecord | null>;
	failShard(id: string, index: number, claimId: number, message: string): Promise<void>;
	failMerge(id: string, claimId: number, message: string): Promise<void>;
}

interface StoredJob {
	job: BulkJobRecord;
	files: BulkFile[];
}

export class MemoryBulkJobStore implements BulkJobStore {
	private readonly jobs = new Map<string, StoredJob>();
	private tail: Promise<void> = Promise.resolve();

	private lock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async create(input: { uid: string; userText: string; title?: string; files: BulkFile[] }): Promise<BulkJobRecord> {
		const job = newBulkJob({ ...input, id: newJobId() });
		this.jobs.set(job.id, { job, files: input.files.map((file) => ({ ...file })) });
		return job;
	}

	async claim(id: string, uid: string, now: number): Promise<ClaimedBulkJob | null> {
		return this.lock(async () => {
			const stored = this.owned(id, uid);
			if (!stored) return null;
			const claimed = claimJob(stored.job, now);
			stored.job = claimed.job;
			return claimed;
		});
	}

	async files(id: string, indexes: number[]): Promise<BulkFile[]> {
		const stored = this.jobs.get(id);
		if (!stored) return [];
		return indexes.map((index) => stored.files[index]).filter((file): file is BulkFile => !!file);
	}

	async finishShard(id: string, index: number, claimId: number, concepts: ExtractedConcept[], usage: { input: number; output: number }): Promise<BulkJobRecord | null> {
		return this.lock(async () => {
			const stored = this.jobs.get(id);
			if (!stored) return null;
			stored.job = finishShard(stored.job, index, claimId, concepts, usage);
			return stored.job;
		});
	}

	async finishMerge(id: string, claimId: number, result: BulkImportResult): Promise<BulkJobRecord | null> {
		return this.lock(async () => {
			const stored = this.jobs.get(id);
			if (!stored) return null;
			stored.job = finishMerge(stored.job, claimId, result);
			return stored.job;
		});
	}

	async failShard(id: string, index: number, claimId: number, message: string): Promise<void> {
		await this.lock(async () => {
			const stored = this.jobs.get(id);
			if (!stored) return;
			stored.job = failOwnedShard(stored.job, index, claimId, message);
		});
	}

	async failMerge(id: string, claimId: number, message: string): Promise<void> {
		await this.lock(async () => {
			const stored = this.jobs.get(id);
			if (!stored) return;
			stored.job = failOwnedMerge(stored.job, claimId, message);
		});
	}

	private owned(id: string, uid: string): StoredJob | null {
		const stored = this.jobs.get(id);
		if (!stored || stored.job.uid !== uid) return null;
		return stored;
	}
}

const JOBS = "bulkJobs";

/** Jobs survive the next request, including one that Firebase Hosting already closed. */
export class FirestoreBulkJobStore implements BulkJobStore {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async create(input: { uid: string; userText: string; title?: string; files: BulkFile[] }): Promise<BulkJobRecord> {
		const job = newBulkJob({ ...input, id: newJobId() });
		const db = this.firestore();
		const batch = db.batch();
		batch.set(db.collection(JOBS).doc(job.id), plain(job));
		input.files.forEach((file, index) => {
			batch.set(db.collection(JOBS).doc(job.id).collection("files").doc(String(index)), {
				path: file.path,
				name: file.name,
				text: file.text,
			});
		});
		await batch.commit();
		return job;
	}

	async claim(id: string, uid: string, now: number): Promise<ClaimedBulkJob | null> {
		const ref = this.firestore().collection(JOBS).doc(id);
		return this.firestore().runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const job = snap.exists ? jobFrom(snap.data(), id) : null;
			if (!job || job.uid !== uid) return null;
			const claimed = claimJob(job, now);
			tx.set(ref, plain(claimed.job));
			return claimed;
		});
	}

	async files(id: string, indexes: number[]): Promise<BulkFile[]> {
		const parent = this.firestore().collection(JOBS).doc(id).collection("files");
		const snaps = await Promise.all(indexes.map((index) => parent.doc(String(index)).get()));
		const files: BulkFile[] = [];
		for (const snap of snaps) {
			const data = snap.data() as { path?: unknown; name?: unknown; text?: unknown } | undefined;
			if (!data || typeof data.path !== "string" || typeof data.text !== "string") continue;
			files.push({ path: data.path, name: typeof data.name === "string" ? data.name : data.path, text: data.text });
		}
		return files;
	}

	async finishShard(id: string, index: number, claimId: number, concepts: ExtractedConcept[], usage: { input: number; output: number }): Promise<BulkJobRecord | null> {
		return this.update(id, (job) => finishShard(job, index, claimId, concepts, usage));
	}

	async finishMerge(id: string, claimId: number, result: BulkImportResult): Promise<BulkJobRecord | null> {
		return this.update(id, (job) => finishMerge(job, claimId, result));
	}

	async failShard(id: string, index: number, claimId: number, message: string): Promise<void> {
		await this.update(id, (job) => failOwnedShard(job, index, claimId, message));
	}

	async failMerge(id: string, claimId: number, message: string): Promise<void> {
		await this.update(id, (job) => failOwnedMerge(job, claimId, message));
	}

	private async update(id: string, change: (job: BulkJobRecord) => BulkJobRecord): Promise<BulkJobRecord | null> {
		const ref = this.firestore().collection(JOBS).doc(id);
		return this.firestore().runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const job = snap.exists ? jobFrom(snap.data(), id) : null;
			if (!job) return null;
			const next = change(job);
			tx.set(ref, plain(next));
			return next;
		});
	}
}

function usageFrom(value: unknown): { input: number; output: number } {
	if (!value || typeof value !== "object") return { input: 0, output: 0 };
	const raw = value as { input?: unknown; output?: unknown };
	return {
		input: typeof raw.input === "number" ? raw.input : 0,
		output: typeof raw.output === "number" ? raw.output : 0,
	};
}

function plain(job: BulkJobRecord): Record<string, unknown> {
	return JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
}

function jobFrom(value: unknown, id: string): BulkJobRecord | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<BulkJobRecord>;
	if (typeof raw.uid !== "string" || !Array.isArray(raw.paths) || !Array.isArray(raw.shards)) return null;
	const shards: BulkShardRecord[] = [];
	for (const shard of raw.shards) {
		if (!shard || typeof shard !== "object") return null;
		const row = shard as Partial<BulkShardRecord>;
		if (!Array.isArray(row.fileIndexes) || (row.status !== "queued" && row.status !== "running" && row.status !== "done")) return null;
		shards.push({
			fileIndexes: row.fileIndexes.filter((index): index is number => typeof index === "number"),
			status: row.status,
			claimId: typeof row.claimId === "number" ? row.claimId : 0,
			claimedAt: typeof row.claimedAt === "number" ? row.claimedAt : 0,
			concepts: Array.isArray(row.concepts) ? row.concepts : [],
			usage: usageFrom(row.usage),
		});
	}
	const mergeStatus = raw.mergeStatus === "running" || raw.mergeStatus === "done" ? raw.mergeStatus : "queued";
	const status = raw.status === "done" || raw.status === "error" ? raw.status : "open";
	return {
		id,
		uid: raw.uid,
		userText: typeof raw.userText === "string" ? raw.userText : "",
		...(typeof raw.title === "string" ? { title: raw.title } : {}),
		paths: raw.paths.filter((path): path is string => typeof path === "string"),
		startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
		shards,
		mergeStatus,
		mergeClaimId: typeof raw.mergeClaimId === "number" ? raw.mergeClaimId : 0,
		mergeClaimedAt: typeof raw.mergeClaimedAt === "number" ? raw.mergeClaimedAt : 0,
		status,
		...(typeof raw.error === "string" ? { error: raw.error } : {}),
		...(raw.result ? { result: raw.result } : {}),
	};
}
