import { createHash, randomInt } from "node:crypto";
import { CONNECT_CODE_ALPHABET, CONNECT_CODE_LENGTH, CONNECT_CODE_TTL_MS, formatConnectCode, normalizeConnectCode } from "@groundwork/core";

const RATE_WINDOW_MS = CONNECT_CODE_TTL_MS;
const RATE_LIMIT = 10;

export interface StoredConnectCode {
	hash: string;
	uid: string;
	email: string;
	displayName: string;
	expiresAt: number;
	usedAt: number | null;
}

export interface ConnectCodeStore {
	insert(row: StoredConnectCode): Promise<void>;
	/** Marks a live code used. Returns the row, or why it cannot be used. */
	take(hash: string, now: number): Promise<StoredConnectCode | "missing" | "used" | "expired">;
	recentIssues(uid: string, since: number): Promise<number>;
	recordIssue(uid: string, at: number): Promise<void>;
}

export interface IssuedConnectCode {
	code: string;
	expiresAt: string;
}

export type RedeemedConnectCode =
	| { ok: true; uid: string; email: string; displayName: string }
	| { ok: false; status: 400 | 410; error: string };

export function hashConnectCode(compact: string): string {
	return createHash("sha256").update(compact).digest("hex");
}

function randomCode(): string {
	let out = "";
	for (let i = 0; i < CONNECT_CODE_LENGTH; i++) out += CONNECT_CODE_ALPHABET[randomInt(CONNECT_CODE_ALPHABET.length)];
	return out;
}

/**
 * One-time setup codes. The raw code is returned to the signed-in browser and
 * never written to the store. Redeem does not require a bearer token.
 */
export class ConnectCodeDirectory {
	constructor(
		private readonly store: ConnectCodeStore,
		private readonly clock: () => number = () => Date.now(),
		private readonly mint: () => string = randomCode,
	) {}

	async issue(uid: string, profile: { email?: string | null; displayName?: string | null }): Promise<IssuedConnectCode> {
		const now = this.clock();
		const recent = await this.store.recentIssues(uid, now - RATE_WINDOW_MS);
		if (recent >= RATE_LIMIT) {
			throw Object.assign(new Error("Too many codes. Wait a few minutes, then try again."), { status: 429 });
		}
		const compact = this.mint();
		const row: StoredConnectCode = {
			hash: hashConnectCode(compact),
			uid,
			email: profile.email?.trim() ?? "",
			displayName: profile.displayName?.trim() ?? "",
			expiresAt: now + CONNECT_CODE_TTL_MS,
			usedAt: null,
		};
		await this.store.recordIssue(uid, now);
		await this.store.insert(row);
		return { code: formatConnectCode(compact), expiresAt: new Date(row.expiresAt).toISOString() };
	}

	async redeem(raw: string): Promise<RedeemedConnectCode> {
		const compact = normalizeConnectCode(raw);
		if (!compact) return { ok: false, status: 400, error: "That code doesn't look right." };
		const taken = await this.store.take(hashConnectCode(compact), this.clock());
		if (taken === "missing") return { ok: false, status: 400, error: "That code doesn't work. Create a new one on the website." };
		if (taken === "used") return { ok: false, status: 410, error: "That code was already used. Create a new one on the website." };
		if (taken === "expired") return { ok: false, status: 410, error: "That code expired. Create a new one on the website." };
		return { ok: true, uid: taken.uid, email: taken.email, displayName: taken.displayName };
	}
}
