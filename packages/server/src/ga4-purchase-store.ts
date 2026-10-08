import { type Firestore } from "firebase-admin/firestore";
import { openFirestore } from "./firestore";
import type { PurchaseLedger } from "./ga4-purchase";

const COLLECTION = "ga4Purchases";

/**
 * One document per Checkout Session, so any Cloud Run instance reports that purchase once.
 * Admin SDK only. The browser never reads this collection.
 */
export class FirestorePurchaseLedger implements PurchaseLedger {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async has(sessionId: string): Promise<boolean> {
		const snap = await this.firestore().collection(COLLECTION).doc(sessionId).get();
		return snap.exists;
	}

	async mark(sessionId: string, valueUsd: number): Promise<void> {
		try {
			await this.firestore().collection(COLLECTION).doc(sessionId).create({
				valueUsd,
				reportedAt: new Date().toISOString(),
			});
		} catch (err) {
			if (alreadyExists(err)) return;
			throw err;
		}
	}
}

function alreadyExists(err: unknown): boolean {
	if (typeof err !== "object" || err === null || !("code" in err)) return false;
	const code = (err as { code?: unknown }).code;
	return code === 6 || code === "already-exists";
}
