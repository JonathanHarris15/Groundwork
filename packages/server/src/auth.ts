import { asUnknown } from "@groundwork/core";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApps, initializeApp, applicationDefault, cert, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { type IdTokenDenylist, loadIdTokenDenylist, type RevokedTokenClaims } from "./id-token-denylist";

export interface Identity {
	uid: string;
	email?: string;
	name?: string;
}

export interface Auth {
	/** Resolves the signed-in user. Local mode, before Firebase is attached, uses one shared id. */
	uid(authorization: string | undefined): Promise<Identity>;
	/** Invalidates refresh tokens and rejects still-valid ID tokens from that session. */
	revokeRefreshTokens(uid: string, authorization?: string): Promise<void>;
	readonly firebase: boolean;
}

const LOCAL_UID = "local";

export function firebaseConfigured(): boolean {
	return !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || serviceAccountFile());
}

export function loadAuth(): Auth {
	if (!firebaseConfigured()) {
		return {
			firebase: false,
			async uid() {
				return { uid: LOCAL_UID };
			},
			async revokeRefreshTokens() {
				/* local dev has no Firebase sessions to revoke */
			},
		};
	}
	const app = ensureApp();
	return createFirebaseAuth(getAuth(app), loadIdTokenDenylist());
}

export function createFirebaseAuth(auth: ReturnType<typeof getAuth>, denylist: IdTokenDenylist): Auth {
	return {
		firebase: true,
		async uid(authorization) {
			const decoded = await verifyBearer(auth, denylist, authorization);
			const name = typeof decoded.name === "string" ? decoded.name : undefined;
			return { uid: decoded.uid, email: decoded.email, name };
		},
		async revokeRefreshTokens(uid, authorization) {
			const claims = authorization ? await verifyBearer(auth, denylist, authorization).catch(() => null) : null;
			await auth.revokeRefreshTokens(uid);
			await denylist.revoke(claimsFromToken(claims ?? { uid, iat: Math.floor(Date.now() / 1000) }));
		},
	};
}

async function verifyBearer(auth: ReturnType<typeof getAuth>, denylist: ReturnType<typeof loadIdTokenDenylist>, authorization?: string): Promise<DecodedIdToken> {
	const match = authorization?.match(/^Bearer\s+(\S+)$/i);
	if (!match) throw Object.assign(new Error("Sign in required."), { status: 401 });
	const decoded = await auth.verifyIdToken(match[1]);
	if (await denylist.isRevoked(claimsFromToken(decoded))) {
		throw Object.assign(new Error("Sign in required."), { status: 401 });
	}
	return decoded;
}

function claimsFromToken(decoded: Pick<DecodedIdToken, "uid" | "jti" | "iat" | "exp" | "auth_time">): RevokedTokenClaims {
	const iat = typeof decoded.iat === "number" ? decoded.iat : typeof decoded.auth_time === "number" ? decoded.auth_time : Math.floor(Date.now() / 1000);
	const jti = typeof decoded.jti === "string" ? decoded.jti : undefined;
	return { uid: decoded.uid, jti, iat, exp: decoded.exp };
}

function ensureApp(): App {
	const existing = getApps()[0];
	if (existing) return existing;
	const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
	if (raw) {
		return initializeApp({ credential: cert(serviceAccountFrom(raw)) });
	}
	const file = serviceAccountFile();
	if (file && file !== process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
		return initializeApp({ credential: cert(serviceAccountFrom(readFileSync(file, "utf8"))) });
	}
	return initializeApp({ credential: applicationDefault() });
}

/** A gitignored key at the repo root, used when the env vars are unset. */
function serviceAccountFile(): string | undefined {
	const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
	if (explicit && existsSync(explicit)) return explicit;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(process.cwd(), "firebase-service-account.json"),
		path.resolve(here, "../../../firebase-service-account.json"),
	];
	return candidates.find((file) => existsSync(file));
}

function serviceAccountFrom(raw: string): Record<string, string> {
	const parsed = asUnknown(JSON.parse(raw));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Firebase service account is not an object.");
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
	return out;
}
