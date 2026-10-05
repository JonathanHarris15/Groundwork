import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Firestore } from "firebase-admin/firestore";
import { openFirestore } from "./firestore";
import { isUserKeyProvider, USER_KEY_PROVIDERS, type UserKeyProvider } from "@groundwork/core";

/** Provider keys for one account. The browser never receives the values. */
export type SecretRecord = Partial<Record<UserKeyProvider, string>>;

export interface SecretStore {
	read(uid: string): Promise<SecretRecord | null>;
	write(uid: string, keys: SecretRecord): Promise<void>;
	/** Read-modify-write so two provider keys saved at once cannot drop each other. */
	update(uid: string, change: (current: SecretRecord) => SecretRecord): Promise<void>;
}

export function serializeSecrets(keys: SecretRecord): Record<string, string> {
	const out: Record<string, string> = {};
	for (const provider of USER_KEY_PROVIDERS) {
		const key = keys[provider]?.trim();
		if (key) out[provider] = key;
	}
	return out;
}

export function parseSecrets(data: unknown): SecretRecord {
	if (!data || typeof data !== "object") return {};
	const raw = data as Record<string, unknown>;
	const keys: SecretRecord = {};
	for (const provider of USER_KEY_PROVIDERS) {
		const value = raw[provider];
		if (typeof value === "string" && value.trim()) keys[provider] = value.trim();
	}
	return keys;
}

interface FileDb {
	users: Record<string, Record<string, string>>;
}

/** Provider keys on disk so a restarted local server can still call the learner's model. */
export class FileSecretStore implements SecretStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async read(uid: string): Promise<SecretRecord | null> {
		const db = await this.load();
		const row = db.users[uid];
		if (!row) return null;
		const keys = parseSecrets(row);
		return Object.keys(keys).length ? keys : null;
	}

	async write(uid: string, keys: SecretRecord): Promise<void> {
		await this.update(uid, () => keys);
	}

	async update(uid: string, change: (current: SecretRecord) => SecretRecord): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			const next = serializeSecrets(change(parseSecrets(db.users[uid])));
			if (Object.keys(next).length) db.users[uid] = next;
			else delete db.users[uid];
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
 * Provider keys in Firestore, so any Cloud Run instance can run a bring-your-own-model tutor.
 * Admin SDK only. Responses still report which providers are saved, never the key.
 */
export class FirestoreSecretStore implements SecretStore {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async read(uid: string): Promise<SecretRecord | null> {
		const snap = await this.firestore().collection("secrets").doc(uid).get();
		if (!snap.exists) return null;
		const keys = parseSecrets(snap.data());
		return Object.keys(keys).length ? keys : null;
	}

	async write(uid: string, keys: SecretRecord): Promise<void> {
		await this.update(uid, () => keys);
	}

	async update(uid: string, change: (current: SecretRecord) => SecretRecord): Promise<void> {
		const db = this.firestore();
		const ref = db.collection("secrets").doc(uid);
		await db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const current = snap.exists ? parseSecrets(snap.data()) : {};
			const saved = serializeSecrets(change(current));
			if (Object.keys(saved).length) tx.set(ref, saved);
			else tx.delete(ref);
		});
	}
}

export function isStoredProvider(value: string): value is UserKeyProvider {
	return isUserKeyProvider(value);
}
