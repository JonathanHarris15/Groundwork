import { FirestorePurchaseLedger } from "./ga4-purchase-store";
import { deliverPurchase, type CheckoutPurchaseReporter, type PurchaseLedger } from "./ga4-purchase";
import { platformFetch, type FetchLike } from "./platform-fetch";
import { resolveMeasurementIds } from "./tracking";

/**
 * Sends purchases only on Cloud Run. A laptop, Playwright, or an agent server must not
 * post to the production Measurement Protocol endpoint, even if the secret is in the environment.
 * Until `GA4_API_SECRET` is set, a real checkout is not reported and the webhook still succeeds.
 */
export function loadGa4PurchaseReporter(
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl: FetchLike = platformFetch,
	ledger?: PurchaseLedger,
): CheckoutPurchaseReporter {
	if (!env.K_SERVICE?.trim()) return { async report() {} };
	const measurementId = resolveMeasurementIds({
		ga4: env.GA4_MEASUREMENT_ID,
		ads: env.GOOGLE_ADS_ID,
		production: true,
	}).ga4;
	const apiSecret = env.GA4_API_SECRET?.trim() || null;
	const store = ledger ?? new FirestorePurchaseLedger();
	let warned = false;
	return {
		async report(session) {
			const result = await deliverPurchase(session, { measurementId, apiSecret, ledger: store, fetchImpl });
			if (result === "unconfigured" && !warned) {
				warned = true;
				console.error("GA4 purchase was not sent. Set GA4_API_SECRET to the Measurement Protocol secret for this property.");
			}
		},
	};
}
