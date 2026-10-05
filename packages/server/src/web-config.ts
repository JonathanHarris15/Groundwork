import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Public values the account site needs. Nothing in here is a secret. */
export interface WebConfig {
	firebase: { apiKey: string; authDomain: string; projectId: string } | null;
	billing: boolean;
	/** True when the API accepts requests without Firebase. Never set on production Cloud Run. */
	localDev: boolean;
}

export function webConfig(billing: boolean, firebaseAdmin: boolean): WebConfig {
	if (process.env.GROUNDWORK_E2E?.trim()) {
		const localDev = !firebaseAdmin && !process.env.K_SERVICE?.trim();
		return { firebase: null, billing, localDev };
	}
	const file = readWebConfig();
	const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || file?.apiKey;
	const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || file?.authDomain;
	const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || file?.projectId;
	const firebase = apiKey && authDomain && projectId ? { apiKey, authDomain, projectId } : null;
	// Two gates: no Firebase Admin (production Cloud Run always has it) and not a managed Cloud Run revision (K_SERVICE).
	const localDev = !firebaseAdmin && !process.env.K_SERVICE?.trim();
	return { firebase, billing, localDev };
}

function readWebConfig(): { apiKey: string; authDomain: string; projectId: string } | null {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [path.resolve(here, "../firebase-web.json"), path.resolve(process.cwd(), "packages/server/firebase-web.json")];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { apiKey?: unknown; authDomain?: unknown; projectId?: unknown };
		if (typeof parsed.apiKey === "string" && typeof parsed.authDomain === "string" && typeof parsed.projectId === "string") {
			return { apiKey: parsed.apiKey, authDomain: parsed.authDomain, projectId: parsed.projectId };
		}
	}
	return null;
}
