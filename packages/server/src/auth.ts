import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApps, initializeApp, applicationDefault, cert, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface Identity {
	uid: string;
	email?: string;
	name?: string;
}

export interface Auth {
	/** Resolves the signed-in user. Local mode, before Firebase is attached, uses one shared id. */
	uid(authorization: string | undefined): Promise<Identity>;
	/** Invalidates refresh tokens so Obsidian and other devices must sign in again. */
	revokeRefreshTokens(uid: string): Promise<void>;
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
	const auth = getAuth(app);
	return {
		firebase: true,
		async uid(authorization) {
			const match = authorization?.match(/^Bearer\s+(\S+)$/i);
			if (!match) throw Object.assign(new Error("Sign in required."), { status: 401 });
			const decoded = await auth.verifyIdToken(match[1]);
			const name = typeof decoded.name === "string" ? decoded.name : undefined;
			return { uid: decoded.uid, email: decoded.email, name };
		},
		async revokeRefreshTokens(uid) {
			await auth.revokeRefreshTokens(uid);
		},
	};
}

function ensureApp(): App {
	const existing = getApps()[0];
	if (existing) return existing;
	const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
	if (raw) {
		return initializeApp({ credential: cert(JSON.parse(raw) as Record<string, string>) });
	}
	const file = serviceAccountFile();
	if (file && file !== process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
		return initializeApp({ credential: cert(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) });
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
