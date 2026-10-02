import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { KnowledgeSnapshot } from "@groundwork/core/account";

export interface UserRecord {
	id: string;
	email: string;
	handle: string;
	displayName: string;
	passwordHash: string;
	/** Latest token, kept so older files still resolve. Sessions live in `tokenHashes`. */
	tokenHash: string | null;
	/** Every live session (the site and the Obsidian plugin can be signed in together). */
	tokenHashes: string[];
	knowledge: KnowledgeSnapshot | null;
}

interface Database {
	users: UserRecord[];
}

export class AccountStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async register(input: { email: string; handle: string; displayName: string; passwordHash: string; tokenHash: string }): Promise<UserRecord> {
		return this.update((db) => {
			if (db.users.some((u) => u.email === input.email)) throw httpError(409, "An account with that email already exists.");
			let handle = input.handle;
			const taken = new Set(db.users.map((u) => u.handle));
			if (taken.has(handle)) {
				let n = 2;
				while (taken.has(`${handle}-${n}`)) n++;
				handle = `${handle}-${n}`;
			}
			const user: UserRecord = {
				id: randomBytes(8).toString("hex"),
				email: input.email,
				handle,
				displayName: input.displayName,
				passwordHash: input.passwordHash,
				tokenHash: input.tokenHash,
				tokenHashes: [input.tokenHash],
				knowledge: null,
			};
			db.users.push(user);
			return user;
		});
	}

	async byEmail(email: string): Promise<UserRecord | undefined> {
		return (await this.read()).users.find((u) => u.email === email);
	}

	async byTokenHash(tokenHash: string): Promise<UserRecord | undefined> {
		return (await this.read()).users.find((u) => sessionHashes(u).includes(tokenHash));
	}

	async byHandle(handle: string): Promise<UserRecord | undefined> {
		return (await this.read()).users.find((u) => u.handle === handle);
	}

	/** Adds a session. Existing sessions stay valid so the site and the plugin can both be signed in. */
	async addToken(id: string, tokenHash: string): Promise<void> {
		await this.update((db) => {
			const user = db.users.find((u) => u.id === id);
			if (!user) throw httpError(404, "Account not found.");
			const hashes = sessionHashes(user).filter((h) => h !== tokenHash);
			hashes.push(tokenHash);
			user.tokenHashes = hashes.slice(-8);
			user.tokenHash = tokenHash;
		});
	}

	/** Drops one session. Other devices stay signed in. */
	async removeToken(id: string, tokenHash: string): Promise<void> {
		await this.update((db) => {
			const user = db.users.find((u) => u.id === id);
			if (!user) throw httpError(404, "Account not found.");
			user.tokenHashes = sessionHashes(user).filter((h) => h !== tokenHash);
			user.tokenHash = user.tokenHashes.at(-1) ?? null;
		});
	}

	async setKnowledge(id: string, knowledge: KnowledgeSnapshot): Promise<void> {
		await this.update((db) => {
			const user = db.users.find((u) => u.id === id);
			if (!user) throw httpError(404, "Account not found.");
			user.knowledge = knowledge;
		});
	}

	private async update<T>(fn: (db: Database) => T): Promise<T> {
		let result!: T;
		const run = this.queue.then(async () => {
			const db = await this.read();
			result = fn(db);
			await this.write(db);
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
		return result;
	}

	private async read(): Promise<Database> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Database;
			if (!parsed || !Array.isArray(parsed.users)) return { users: [] };
			return parsed;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
			throw e;
		}
	}

	private async write(db: Database): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db));
		await rename(tmp, this.file);
	}
}

function sessionHashes(user: UserRecord): string[] {
	const hashes = Array.isArray(user.tokenHashes) ? user.tokenHashes.filter((h) => typeof h === "string") : [];
	if (user.tokenHash && !hashes.includes(user.tokenHash)) hashes.push(user.tokenHash);
	return hashes;
}

export function httpError(status: number, message: string): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}
