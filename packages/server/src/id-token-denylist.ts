import { asUnknown } from "@groundwork/core";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Firestore, type Timestamp } from "firebase-admin/firestore";
import { openFirestore, usesRuntimeFirestore } from "./firestore";

function firebaseAdminConfigured(env: NodeJS.ProcessEnv): boolean {
	return !!(env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
}

/** Claims needed to reject a still-valid Firebase ID token after sign-out or session revoke. */
export interface RevokedTokenClaims {
	uid: string;
	jti?: string;
	/** Issued-at, seconds since epoch (Firebase `auth_time` or JWT `iat`). */
	iat: number;
	/** Expiry, seconds since epoch. Used to TTL per-jti rows. */
	exp?: number;
}

export interface IdTokenDenylist {
	/** Record that tokens from this session must not be honored until they expire naturally in clients. */
	revoke(claims: RevokedTokenClaims): Promise<void>;
	isRevoked(claims: RevokedTokenClaims): Promise<boolean>;
}

const noopDenylist: IdTokenDenylist = {
	async revoke() {},
	async isRevoked() {
		return false;
	},
};

export function loadIdTokenDenylist(env: NodeJS.ProcessEnv = process.env): IdTokenDenylist {
	if (!firebaseAdminConfigured(env)) return noopDenylist;
	if (usesRuntimeFirestore(env)) return new FirestoreIdTokenDenylist();
	const file = env.GROUNDWORK_ID_TOKEN_DENYLIST_FILE?.trim() || path.resolve(process.cwd(), "data/id-token-denylist.json");
	return new FileIdTokenDenylist(file);
}

/**
 * Reject ID tokens issued before the latest refresh-token revoke for this uid,
 * and any token whose `jti` was explicitly denied (covers the signing-out device).
 */
export function tokenIsRevoked(claims: RevokedTokenClaims, revokedAfter: number | undefined, deniedJtis: ReadonlySet<string>): boolean {
	if (claims.jti && deniedJtis.has(claims.jti)) return true;
	if (revokedAfter !== undefined && claims.iat <= revokedAfter) return true;
	return false;
}

interface FileDb {
	revokedAfter: Record<string, number>;
	jti: Record<string, number>;
}

export class FileIdTokenDenylist implements IdTokenDenylist {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async revoke(claims: RevokedTokenClaims): Promise<void> {
		await this.mutate((db) => applyRevoke(db, claims));
	}

	async isRevoked(claims: RevokedTokenClaims): Promise<boolean> {
		const db = await this.load();
		prune(db);
		return tokenIsRevoked(claims, db.revokedAfter[claims.uid], new Set(Object.keys(db.jti)));
	}

	private async mutate(change: (db: FileDb) => void): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.load();
			change(db);
			prune(db);
			await this.save(db);
		});
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(task, task);
		return this.queue;
	}

	private async load(): Promise<FileDb> {
		try {
			const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<FileDb>;
			return {
				revokedAfter: raw.revokedAfter && typeof raw.revokedAfter === "object" ? { ...raw.revokedAfter } : {},
				jti: raw.jti && typeof raw.jti === "object" ? { ...raw.jti } : {},
			};
		} catch {
			return { revokedAfter: {}, jti: {} };
		}
	}

	private async save(db: FileDb): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db), "utf8");
		await rename(tmp, this.file);
	}
}

export class FirestoreIdTokenDenylist implements IdTokenDenylist {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async revoke(claims: RevokedTokenClaims): Promise<void> {
		const db = this.firestore();
		const now = Math.floor(Date.now() / 1000);
		const batch = db.batch();
		const sessionRef = db.collection("authSessions").doc(claims.uid);
		batch.set(
			sessionRef,
			{ revokedAfter: now },
			{ merge: true },
		);
		if (claims.jti) {
			const exp = claims.exp ?? claims.iat + 3600;
			batch.set(db.collection("authRevokedJti").doc(claims.jti), {
				uid: claims.uid,
				exp,
				expiresAt: Timestamp.fromMillis(exp * 1000),
			});
		}
		await batch.commit();
	}

	async isRevoked(claims: RevokedTokenClaims): Promise<boolean> {
		const db = this.firestore();
		const [session, jti] = await Promise.all([
			db.collection("authSessions").doc(claims.uid).get(),
			claims.jti ? db.collection("authRevokedJti").doc(claims.jti).get() : Promise.resolve(null),
		]);
		const data = session.exists ? asUnknown(session.data()) : undefined;
		const revokedAfter = data && typeof data === "object" && "revokedAfter" in data ? data.revokedAfter : undefined;
		const deniedJtis = jti?.exists ? new Set([claims.jti!]) : new Set<string>();
		return tokenIsRevoked(claims, typeof revokedAfter === "number" ? revokedAfter : undefined, deniedJtis);
	}
}

function applyRevoke(db: FileDb, claims: RevokedTokenClaims): void {
	const now = Math.floor(Date.now() / 1000);
	db.revokedAfter[claims.uid] = Math.max(db.revokedAfter[claims.uid] ?? 0, now);
	if (claims.jti) db.jti[claims.jti] = claims.exp ?? claims.iat + 3600;
}

function prune(db: FileDb): void {
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, exp] of Object.entries(db.jti)) {
		if (exp <= now) delete db.jti[jti];
	}
}
