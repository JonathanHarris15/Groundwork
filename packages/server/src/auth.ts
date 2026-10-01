import { getApps, initializeApp, applicationDefault, cert, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface Auth {
	/** Resolves the signed-in user. Local mode, before Firebase is attached, uses one shared id. */
	uid(authorization: string | undefined): Promise<string>;
	readonly firebase: boolean;
}

const LOCAL_UID = "local";

export function firebaseConfigured(): boolean {
	return !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
}

export function loadAuth(): Auth {
	if (!firebaseConfigured()) {
		return { firebase: false, async uid() { return LOCAL_UID; } };
	}
	const app = ensureApp();
	const auth = getAuth(app);
	return {
		firebase: true,
		async uid(authorization) {
			const match = authorization?.match(/^Bearer\s+(\S+)$/i);
			if (!match) throw Object.assign(new Error("Sign in required."), { status: 401 });
			const decoded = await auth.verifyIdToken(match[1]);
			return decoded.uid;
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
	return initializeApp({ credential: applicationDefault() });
}
