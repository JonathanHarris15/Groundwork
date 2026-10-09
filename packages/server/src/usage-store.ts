import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Firestore } from "firebase-admin/firestore";
import {
	isUsageFeature,
	type UsageDayRow,
	type UsageEventRow,
	type UsageFeature,
	type UsageLedgerRow,
	type UsageModel,
	type UsagePlan,
} from "@groundwork/core";
import { openFirestore } from "./firestore";

export interface UsageStore {
	add(row: UsageDayRow): Promise<void>;
	listDays(): Promise<UsageDayRow[]>;
	raiseLedger(row: UsageLedgerRow): Promise<void>;
	listLedgers(): Promise<UsageLedgerRow[]>;
	addEvent(event: UsageEventRow): Promise<void>;
	listEvents(): Promise<UsageEventRow[]>;
}

interface Bucket {
	calls: number;
	costUsd: number;
	chargedUsd: number;
	inputTokens: number;
	outputTokens: number;
}

interface DayDoc {
	uid: string;
	day: string;
	buckets: Record<string, Bucket>;
}

interface FileDb {
	days: Record<string, DayDoc>;
	ledgers: Record<string, UsageLedgerRow>;
	events: UsageEventRow[];
}

function emptyDb(): FileDb {
	return { days: {}, ledgers: {}, events: [] };
}

function bucketKey(row: Pick<UsageDayRow, "plan" | "model" | "feature">): string {
	return `${row.plan}|${row.model}|${row.feature}`;
}

function roundUsd(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

function addBucket(doc: DayDoc, row: UsageDayRow): void {
	const key = bucketKey(row);
	const prev = doc.buckets[key] ?? { calls: 0, costUsd: 0, chargedUsd: 0, inputTokens: 0, outputTokens: 0 };
	doc.buckets[key] = {
		calls: prev.calls + row.calls,
		costUsd: roundUsd(prev.costUsd + row.costUsd),
		chargedUsd: roundUsd(prev.chargedUsd + row.chargedUsd),
		inputTokens: prev.inputTokens + row.inputTokens,
		outputTokens: prev.outputTokens + row.outputTokens,
	};
}

function expandDays(docs: DayDoc[]): UsageDayRow[] {
	const rows: UsageDayRow[] = [];
	for (const doc of docs) {
		for (const [key, bucket] of Object.entries(doc.buckets ?? {})) {
			const parsed = parseBucketKey(key);
			if (!parsed) continue;
			rows.push({ uid: doc.uid, day: doc.day, ...parsed, ...bucket });
		}
	}
	return rows;
}

function parseBucketKey(key: string): { plan: UsagePlan; model: UsageModel; feature: UsageFeature } | null {
	const [plan, model, feature] = key.split("|");
	if (!isPlan(plan) || !isModel(model) || !isUsageFeature(feature)) return null;
	return { plan, model, feature };
}

function isPlan(value: string | undefined): value is UsagePlan {
	return value === "free" || value === "byom" || value === "included" || value === "none";
}

function isModel(value: string | undefined): value is UsageModel {
	return value === "light" || value === "heavy" || value === "unknown";
}

function isLedger(value: unknown): value is UsageLedgerRow {
	if (!value || typeof value !== "object") return false;
	const row = value as UsageLedgerRow;
	return typeof row.uid === "string" && typeof row.period === "string" && isPlan(row.plan) && typeof row.costUsd === "number" && typeof row.chargedUsd === "number";
}

function isEvent(value: unknown): value is UsageEventRow {
	if (!value || typeof value !== "object") return false;
	const row = value as UsageEventRow;
	return typeof row.uid === "string" && typeof row.at === "string" && (row.kind === "checkout" || row.kind === "upgraded") && (row.plan === "byom" || row.plan === "included");
}

function raise(prev: UsageLedgerRow | undefined, row: UsageLedgerRow): UsageLedgerRow {
	return {
		uid: row.uid,
		period: row.period,
		plan: row.plan,
		costUsd: roundUsd(Math.max(prev?.costUsd ?? 0, row.costUsd)),
		chargedUsd: roundUsd(Math.max(prev?.chargedUsd ?? 0, row.chargedUsd)),
	};
}

/** In-memory rollups for tests and a server started without a database. */
export class MemoryUsageStore implements UsageStore {
	private readonly days = new Map<string, DayDoc>();
	private readonly ledgers = new Map<string, UsageLedgerRow>();
	private readonly events: UsageEventRow[] = [];

	async add(row: UsageDayRow): Promise<void> {
		const id = `${row.uid}_${row.day}`;
		const doc = this.days.get(id) ?? { uid: row.uid, day: row.day, buckets: {} };
		addBucket(doc, row);
		this.days.set(id, doc);
	}

	async listDays(): Promise<UsageDayRow[]> {
		return expandDays([...this.days.values()]);
	}

	async raiseLedger(row: UsageLedgerRow): Promise<void> {
		const id = `${row.uid}_${row.period}_${row.plan}`;
		this.ledgers.set(id, raise(this.ledgers.get(id), row));
	}

	async listLedgers(): Promise<UsageLedgerRow[]> {
		return [...this.ledgers.values()];
	}

	async addEvent(event: UsageEventRow): Promise<void> {
		this.events.push(event);
	}

	async listEvents(): Promise<UsageEventRow[]> {
		return [...this.events];
	}
}

/** Usage rollups beside the local account file. Counts and costs only. */
export class FileUsageStore implements UsageStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async add(row: UsageDayRow): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			const id = `${row.uid}_${row.day}`;
			const doc = db.days[id] ?? { uid: row.uid, day: row.day, buckets: {} };
			addBucket(doc, row);
			db.days[id] = doc;
			await this.save(db);
		});
	}

	async listDays(): Promise<UsageDayRow[]> {
		const db = await this.load();
		return expandDays(Object.values(db.days));
	}

	async raiseLedger(row: UsageLedgerRow): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			const id = `${row.uid}_${row.period}_${row.plan}`;
			const prev = db.ledgers[id];
			db.ledgers[id] = raise(isLedger(prev) ? prev : undefined, row);
			await this.save(db);
		});
	}

	async listLedgers(): Promise<UsageLedgerRow[]> {
		const db = await this.load();
		return Object.values(db.ledgers).filter(isLedger);
	}

	async addEvent(event: UsageEventRow): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			db.events.push(event);
			await this.save(db);
		});
	}

	async listEvents(): Promise<UsageEventRow[]> {
		const db = await this.load();
		return db.events.filter(isEvent);
	}

	private async enqueue(fn: () => Promise<void>): Promise<void> {
		const run = this.queue.then(fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	private async load(): Promise<FileDb> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (!parsed || typeof parsed !== "object") return emptyDb();
			const raw = parsed as Partial<FileDb>;
			return {
				days: raw.days && typeof raw.days === "object" ? raw.days : {},
				ledgers: raw.ledgers && typeof raw.ledgers === "object" ? raw.ledgers : {},
				events: Array.isArray(raw.events) ? raw.events.filter(isEvent) : [],
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
			throw err;
		}
	}

	private async save(db: FileDb): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db));
		await rename(tmp, this.file);
	}
}

/**
 * Daily usage rollups in Firestore. One document per user per UTC day.
 * Single-field reads only, so no composite index is required.
 * The browser never reads these collections. Admin SDK only.
 */
export class FirestoreUsageStore implements UsageStore {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async add(row: UsageDayRow): Promise<void> {
		const db = this.firestore();
		const ref = db.collection("usageDays").doc(`${row.uid}_${row.day}`);
		await db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const doc = dayFrom(snap.data(), row.uid, row.day);
			addBucket(doc, row);
			tx.set(ref, doc);
		});
	}

	async listDays(): Promise<UsageDayRow[]> {
		const snap = await this.firestore().collection("usageDays").get();
		const docs: DayDoc[] = [];
		for (const doc of snap.docs) {
			const data: unknown = doc.data();
			const parsed = dayFrom(data, "", "");
			if (parsed.uid && parsed.day) docs.push(parsed);
		}
		return expandDays(docs);
	}

	async raiseLedger(row: UsageLedgerRow): Promise<void> {
		const db = this.firestore();
		const ref = db.collection("usageLedgers").doc(`${row.uid}_${row.period}_${row.plan}`);
		await db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const data: unknown = snap.data();
			tx.set(ref, raise(isLedger(data) ? data : undefined, row));
		});
	}

	async listLedgers(): Promise<UsageLedgerRow[]> {
		const snap = await this.firestore().collection("usageLedgers").get();
		return snap.docs.map((doc) => doc.data()).filter(isLedger);
	}

	async addEvent(event: UsageEventRow): Promise<void> {
		await this.firestore().collection("usageEvents").add(event);
	}

	async listEvents(): Promise<UsageEventRow[]> {
		const snap = await this.firestore().collection("usageEvents").get();
		return snap.docs.map((doc) => doc.data()).filter(isEvent);
	}
}

function dayFrom(data: unknown, uid: string, day: string): DayDoc {
	const raw = data && typeof data === "object" ? (data as { uid?: unknown; day?: unknown; buckets?: unknown }) : {};
	const buckets: Record<string, Bucket> = {};
	if (raw.buckets && typeof raw.buckets === "object") {
		for (const [key, value] of Object.entries(raw.buckets)) {
			if (!value || typeof value !== "object") continue;
			const bucket = value as Partial<Bucket>;
			buckets[key] = {
				calls: numberOr(bucket.calls),
				costUsd: numberOr(bucket.costUsd),
				chargedUsd: numberOr(bucket.chargedUsd),
				inputTokens: numberOr(bucket.inputTokens),
				outputTokens: numberOr(bucket.outputTokens),
			};
		}
	}
	return {
		uid: typeof raw.uid === "string" ? raw.uid : uid,
		day: typeof raw.day === "string" ? raw.day : day,
		buckets,
	};
}

function numberOr(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
