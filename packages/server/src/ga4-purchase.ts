import type { FetchLike } from "./platform-fetch";
import { cleanGaClientId, cleanGaSessionId, cleanGclid } from "./tracking";

/**
 * What the Stripe webhook knows about a Checkout Session.
 * Purchase value is `amount_total` in dollars. The list price is never used.
 */
export interface CheckoutPurchaseInput {
	id?: string | null;
	status?: string | null;
	payment_status?: string | null;
	amount_total?: number | null;
	currency?: string | null;
	metadata?: { [key: string]: string } | null;
	client_reference_id?: string | null;
}

export interface Ga4PurchaseHit {
	transactionId: string;
	valueUsd: number;
	clientId: string;
	userId: string | null;
	sessionId: string | null;
	gclid: string | null;
	plan: "byom" | "included" | null;
}

export interface PurchaseLedger {
	/** True when this Checkout Session's purchase was already accepted by GA4. */
	has(sessionId: string): Promise<boolean>;
	mark(sessionId: string, valueUsd: number): Promise<void>;
}

export interface CheckoutPurchaseReporter {
	report(session: CheckoutPurchaseInput): Promise<void>;
}

export const noopCheckoutPurchaseReporter: CheckoutPurchaseReporter = {
	async report() {},
};

/** In-process ledger for tests and for servers that are not on Cloud Run. */
export class MemoryPurchaseLedger implements PurchaseLedger {
	private readonly rows = new Map<string, number>();

	async has(sessionId: string): Promise<boolean> {
		return this.rows.has(sessionId);
	}

	async mark(sessionId: string, valueUsd: number): Promise<void> {
		this.rows.set(sessionId, valueUsd);
	}
}

export type PurchaseDelivery = "sent" | "duplicate" | "skipped" | "unconfigured";

/**
 * A purchase GA4 may record.
 * Only a finished Checkout Session (`cs_…`) whose payment is collected or not required.
 * `0` is a real total (a 100% off coupon). Anything else is skipped, including a missing total.
 */
export function purchaseHit(session: CheckoutPurchaseInput): Ga4PurchaseHit | null {
	const id = session.id?.trim() ?? "";
	if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
	if (session.status !== "complete") return null;
	if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return null;
	if (session.currency?.trim().toLowerCase() !== "usd") return null;
	if (session.metadata?.ga_consent === "denied") return null;
	const valueUsd = amountUsd(session.amount_total);
	if (valueUsd == null) return null;
	const meta = session.metadata ?? {};
	const plan = meta.plan === "byom" || meta.plan === "included" ? meta.plan : null;
	const captured = cleanGaClientId(meta.ga_client_id);
	return {
		transactionId: id,
		valueUsd,
		clientId: captured ?? fallbackClientId(id),
		userId: cleanUserId(meta.uid || session.client_reference_id),
		sessionId: cleanGaSessionId(meta.ga_session_id),
		gclid: cleanGclid(meta.gclid),
		plan,
	};
}

/** JSON body for the Measurement Protocol. `transaction_id` is the Checkout Session id. */
export function purchasePayload(hit: Ga4PurchaseHit): { client_id: string; user_id?: string; events: Array<{ name: "purchase"; params: Record<string, unknown> }> } {
	const params: Record<string, unknown> = {
		transaction_id: hit.transactionId,
		value: hit.valueUsd,
		currency: "USD",
		engagement_time_msec: 1,
	};
	if (hit.sessionId) {
		const sessionNumber = Number(hit.sessionId);
		if (Number.isSafeInteger(sessionNumber)) params.session_id = sessionNumber;
	}
	if (hit.gclid) params.gclid = hit.gclid;
	const item = itemFor(hit.plan, hit.valueUsd);
	if (item) params.items = [item];
	const body: { client_id: string; user_id?: string; events: Array<{ name: "purchase"; params: Record<string, unknown> }> } = {
		client_id: hit.clientId,
		events: [{ name: "purchase", params }],
	};
	if (hit.userId) body.user_id = hit.userId;
	return body;
}

export function measurementCollectUrl(measurementId: string, apiSecret: string): string {
	const url = new URL("https://www.google-analytics.com/mp/collect");
	url.searchParams.set("measurement_id", measurementId);
	url.searchParams.set("api_secret", apiSecret);
	return url.toString();
}

/**
 * Send one purchase. A second call for the same session does not send again.
 * Missing measurement id or API secret does not throw: billing must still complete.
 * A transport failure throws a message that does not include the API secret.
 */
export async function deliverPurchase(
	session: CheckoutPurchaseInput,
	opts: { measurementId: string | null; apiSecret: string | null; ledger: PurchaseLedger; fetchImpl: FetchLike },
): Promise<PurchaseDelivery> {
	const hit = purchaseHit(session);
	if (!hit) return "skipped";
	const measurementId = opts.measurementId?.trim() || null;
	const apiSecret = opts.apiSecret?.trim() || null;
	if (!measurementId || !apiSecret) return "unconfigured";
	if (await opts.ledger.has(hit.transactionId)) return "duplicate";
	await postMeasurement(measurementId, apiSecret, hit, opts.fetchImpl);
	await opts.ledger.mark(hit.transactionId, hit.valueUsd);
	return "sent";
}

async function postMeasurement(measurementId: string, apiSecret: string, hit: Ga4PurchaseHit, fetchImpl: FetchLike): Promise<void> {
	const url = measurementCollectUrl(measurementId, apiSecret);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(purchasePayload(hit)),
		});
	} catch {
		throw new Error("GA4 Measurement Protocol request failed.");
	}
	if (!response.ok) throw new Error(`GA4 Measurement Protocol returned ${response.status}.`);
}

function amountUsd(cents: number | null | undefined): number | null {
	if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return null;
	return cents / 100;
}

function cleanUserId(value: string | null | undefined): string | null {
	if (!value) return null;
	const id = value.trim();
	return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Stable per session so a webhook retry joins the same GA4 user when the browser id was not captured. */
function fallbackClientId(sessionId: string): string {
	let hash = 2166136261;
	for (const ch of sessionId) {
		hash ^= ch.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `${hash >>> 0}.1`;
}

function itemFor(plan: Ga4PurchaseHit["plan"], valueUsd: number): { item_id: string; item_name: string; price: number; quantity: number } | null {
	if (plan === "byom") return { item_id: "byom", item_name: "Bring your own model", price: valueUsd, quantity: 1 };
	if (plan === "included") return { item_id: "included", item_name: "Groundwork", price: valueUsd, quantity: 1 };
	return null;
}
