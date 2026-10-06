import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Firestore } from "firebase-admin/firestore";
import { isPlanId, isUserKeyProvider, type AccountRecord } from "@groundwork/core";
import { attributionFromUnknown } from "./tracking";
import { openFirestore } from "./firestore";

/** Saved account so any server process can remember the plan and the profile. */
export interface AccountStore {
	read(uid: string): Promise<AccountRecord | null>;
	/** Read-modify-write. `change` sees the record currently stored, not a stale copy. */
	update(uid: string, change: (record: AccountRecord | null) => AccountRecord): Promise<AccountRecord>;
	findByCustomer(customerId: string): Promise<string | null>;
}

export function serializeAccount(record: AccountRecord): Record<string, unknown> {
	const out: Record<string, unknown> = {
		plan: record.plan,
		period: record.period,
		spentUsd: record.spentUsd,
	};
	if (record.displayName) out.displayName = record.displayName;
	if (record.email) out.email = record.email;
	if (record.stripeCustomerId) out.stripeCustomerId = record.stripeCustomerId;
	if (record.tutorVia) out.tutorVia = record.tutorVia;
	if (record.tutorProvider) out.tutorProvider = record.tutorProvider;
	if (record.obsidianConnectedAt) out.obsidianConnectedAt = record.obsidianConnectedAt;
	if (record.attribution) out.attribution = record.attribution;
	return out;
}

/** Accept a stored account. A missing or unreadable plan stays unset so the picker can show. */
export function parseStoredAccount(uid: string, data: unknown): AccountRecord | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	const period = typeof raw.period === "string" && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : new Date().toISOString().slice(0, 7);
	const spent = typeof raw.spentUsd === "number" && Number.isFinite(raw.spentUsd) && raw.spentUsd >= 0 ? raw.spentUsd : 0;
	const record: AccountRecord = {
		uid,
		plan: isPlanId(raw.plan) ? raw.plan : null,
		period,
		spentUsd: spent,
	};
	if (typeof raw.displayName === "string" && raw.displayName.trim()) record.displayName = raw.displayName.trim().slice(0, 80);
	if (typeof raw.email === "string" && raw.email.trim()) record.email = raw.email.trim();
	if (typeof raw.stripeCustomerId === "string" && raw.stripeCustomerId.trim()) record.stripeCustomerId = raw.stripeCustomerId.trim();
	if (raw.tutorVia === "claude" || raw.tutorVia === "key") record.tutorVia = raw.tutorVia;
	if (isUserKeyProvider(raw.tutorProvider)) record.tutorProvider = raw.tutorProvider;
	if (typeof raw.obsidianConnectedAt === "string" && raw.obsidianConnectedAt.trim()) record.obsidianConnectedAt = raw.obsidianConnectedAt.trim();
	const attribution = attributionFromUnknown(raw.attribution);
	if (attribution) record.attribution = attribution;
	return record;
}

interface FileDb {
	users: Record<string, Record<string, unknown>>;
}

/** Accounts on disk. One file, so a restarted local server still knows the plan. */
export class FileAccountStore implements AccountStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async read(uid: string): Promise<AccountRecord | null> {
		const db = await this.load();
		const row = db.users[uid];
		return row ? parseStoredAccount(uid, row) : null;
	}

	async update(uid: string, change: (record: AccountRecord | null) => AccountRecord): Promise<AccountRecord> {
		let next: AccountRecord | null = null;
		await this.enqueue(async () => {
			const db = await this.load();
			const current = db.users[uid] ? parseStoredAccount(uid, db.users[uid]) : null;
			next = change(current);
			db.users[uid] = serializeAccount(next);
			await this.save(db);
		});
		if (!next) throw new Error("Could not save the account.");
		return next;
	}

	async findByCustomer(customerId: string): Promise<string | null> {
		const db = await this.load();
		for (const [uid, row] of Object.entries(db.users)) {
			if (row.stripeCustomerId === customerId) return uid;
		}
		return null;
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
			if (!parsed || typeof parsed !== "object" || !parsed.users || typeof parsed.users !== "object") return { users: {} };
			return parsed;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { users: {} };
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

/**
 * Accounts in Firestore, so any Cloud Run instance remembers the plan.
 * Admin SDK only. The browser never reads this collection.
 */
export class FirestoreAccountStore implements AccountStore {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async read(uid: string): Promise<AccountRecord | null> {
		const snap = await this.firestore().collection("accounts").doc(uid).get();
		if (!snap.exists) return null;
		return parseStoredAccount(uid, snap.data());
	}

	async update(uid: string, change: (record: AccountRecord | null) => AccountRecord): Promise<AccountRecord> {
		const db = this.firestore();
		const ref = db.collection("accounts").doc(uid);
		return db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const current = snap.exists ? parseStoredAccount(uid, snap.data()) : null;
			const next = change(current);
			tx.set(ref, serializeAccount(next));
			return next;
		});
	}

	async findByCustomer(customerId: string): Promise<string | null> {
		const snap = await this.firestore().collection("accounts").where("stripeCustomerId", "==", customerId).limit(1).get();
		return snap.docs[0]?.id ?? null;
	}
}
