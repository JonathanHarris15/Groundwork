import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Firestore } from "firebase-admin/firestore";
import { openFirestore } from "./firestore";
import { type ConnectCodeStore, type StoredConnectCode } from "./connect-codes";

interface RateRow {
	times: number[];
}

function isRow(value: unknown): value is StoredConnectCode {
	if (!value || typeof value !== "object") return false;
	const row = value as StoredConnectCode;
	return typeof row.hash === "string" && typeof row.uid === "string" && typeof row.expiresAt === "number";
}

/** In-memory codes for tests and a server started without a database. */
export class MemoryConnectCodeStore implements ConnectCodeStore {
	private readonly codes = new Map<string, StoredConnectCode>();
	private readonly issues = new Map<string, number[]>();

	async insert(row: StoredConnectCode): Promise<void> {
		this.codes.set(row.hash, { ...row });
	}

	async take(hash: string, now: number): Promise<StoredConnectCode | "missing" | "used" | "expired"> {
		const row = this.codes.get(hash);
		if (!row) return "missing";
		if (row.usedAt) return "used";
		if (row.expiresAt <= now) return "expired";
		row.usedAt = now;
		return { ...row };
	}

	async recentIssues(uid: string, since: number): Promise<number> {
		return (this.issues.get(uid) ?? []).filter((at) => at > since).length;
	}

	async recordIssue(uid: string, at: number): Promise<void> {
		const times = this.issues.get(uid) ?? [];
		times.push(at);
		this.issues.set(uid, times);
	}
}

interface FileDb {
	codes: StoredConnectCode[];
	issues: Record<string, number[]>;
}

/** Codes on disk so a restarted local server can still redeem one. */
export class FileConnectCodeStore implements ConnectCodeStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async insert(row: StoredConnectCode): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			db.codes = db.codes.filter((item) => item.hash !== row.hash);
			db.codes.push(row);
			await this.save(db);
		});
	}

	async take(hash: string, now: number): Promise<StoredConnectCode | "missing" | "used" | "expired"> {
		let result: StoredConnectCode | "missing" | "used" | "expired" = "missing";
		await this.enqueue(async () => {
			const db = await this.load();
			const row = db.codes.find((item) => item.hash === hash);
			if (!row) {
				result = "missing";
				return;
			}
			if (row.usedAt) {
				result = "used";
				return;
			}
			if (row.expiresAt <= now) {
				result = "expired";
				return;
			}
			row.usedAt = now;
			result = { ...row };
			await this.save(db);
		});
		return result;
	}

	async recentIssues(uid: string, since: number): Promise<number> {
		const db = await this.load();
		return (db.issues[uid] ?? []).filter((at) => at > since).length;
	}

	async recordIssue(uid: string, at: number): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			const times = db.issues[uid] ?? [];
			times.push(at);
			db.issues[uid] = times.filter((time) => time > at - 60 * 60 * 1000);
			await this.save(db);
		});
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
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as FileDb;
			if (!parsed || typeof parsed !== "object") return { codes: [], issues: {} };
			return {
				codes: Array.isArray(parsed.codes) ? parsed.codes.filter(isRow) : [],
				issues: parsed.issues && typeof parsed.issues === "object" ? parsed.issues : {},
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { codes: [], issues: {} };
			throw e;
		}
	}

	private async save(db: FileDb): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db));
		await rename(tmp, this.file);
	}
}

/** One-time codes in Firestore. The document id is the hash, never the code. */
export class FirestoreConnectCodeStore implements ConnectCodeStore {
	constructor(private readonly db: Firestore = openFirestore()) {}

	async insert(row: StoredConnectCode): Promise<void> {
		await this.db.collection("connectCodes").doc(row.hash).set(row);
	}

	async take(hash: string, now: number): Promise<StoredConnectCode | "missing" | "used" | "expired"> {
		const ref = this.db.collection("connectCodes").doc(hash);
		return this.db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			if (!snap.exists) return "missing";
			const row = snap.data() as StoredConnectCode;
			if (row.usedAt) return "used";
			if (row.expiresAt <= now) return "expired";
			tx.update(ref, { usedAt: now });
			return { ...row, usedAt: now };
		});
	}

	async recentIssues(uid: string, since: number): Promise<number> {
		const snap = await this.db.collection("connectCodeRates").doc(uid).get();
		const times = (snap.data() as RateRow | undefined)?.times ?? [];
		return times.filter((at) => at > since).length;
	}

	async recordIssue(uid: string, at: number): Promise<void> {
		const ref = this.db.collection("connectCodeRates").doc(uid);
		await this.db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const times = ((snap.data() as RateRow | undefined)?.times ?? []).filter((time) => time > at - 60 * 60 * 1000);
			times.push(at);
			tx.set(ref, { times });
		});
	}
}
