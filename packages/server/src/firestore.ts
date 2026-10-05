import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Cloud Run sets K_SERVICE. The Firebase key on that service verifies sign-in
 * and is not allowed to read the database. The runtime service account is.
 * Local servers keep using the key that started the process.
 */
export function usesRuntimeFirestore(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.K_SERVICE?.trim());
}

/** Firestore for accounts, provider keys, and tutor memory. */
export function openFirestore(): Firestore {
	return getFirestore(firestoreApp());
}

function firestoreApp(): App {
	if (!usesRuntimeFirestore()) {
		const existing = getApps()[0];
		if (existing) return existing;
		return initializeApp();
	}
	const name = "groundwork-data";
	const named = getApps().find((app) => app.name === name);
	if (named) return named;
	const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
	return initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) }, name);
}
