import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemoryPurchaseLedger,
	deliverPurchase,
	measurementCollectUrl,
	purchaseHit,
	purchasePayload,
	type CheckoutPurchaseInput,
} from "../src/ga4-purchase";
import { loadGa4PurchaseReporter } from "../src/ga4-purchase-runtime";
import type { FetchLike } from "../src/platform-fetch";

const SECRET = "test-mp-secret-value";
const MEASUREMENT = "G-F4236HGZSM";

function session(over: Partial<CheckoutPurchaseInput> = {}): CheckoutPurchaseInput {
	return {
		id: "cs_live_abc",
		status: "complete",
		payment_status: "paid",
		amount_total: 2000,
		currency: "usd",
		metadata: { uid: "ada", plan: "included", ga_client_id: "123.456", ga_session_id: "1700000001", gclid: "CjwKCtestclick" },
		client_reference_id: "ada",
		...over,
	};
}

function fakeFetch(status = 204): FetchLike & { calls: Array<{ url: string; body: string }> } {
	const calls: Array<{ url: string; body: string }> = [];
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
		if (status >= 500) return Promise.resolve(new Response("no", { status }));
		return Promise.resolve(new Response(null, { status }));
	};
	return Object.assign(fetchImpl, { calls });
}

describe("GA4 purchase from Checkout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses amount_total, including zero, and never the list price", () => {
		expect(purchaseHit(session())?.valueUsd).toBe(20);
		expect(purchaseHit(session({ amount_total: 0, payment_status: "no_payment_required", metadata: { plan: "included", uid: "ada" } }))?.valueUsd).toBe(0);
		expect(purchaseHit(session({ amount_total: 1500, metadata: { plan: "included" } }))?.valueUsd).toBe(15);
		expect(purchaseHit(session({ amount_total: null }))).toBeNull();
		expect(purchaseHit(session({ amount_total: -1 }))).toBeNull();
		expect(purchaseHit(session({ id: "sub_123" }))).toBeNull();
		expect(purchaseHit(session({ id: "{CHECKOUT_SESSION_ID}" }))).toBeNull();
		expect(purchaseHit(session({ status: "open" }))).toBeNull();
		expect(purchaseHit(session({ status: "expired" }))).toBeNull();
		expect(purchaseHit(session({ payment_status: "unpaid" }))).toBeNull();
		expect(purchaseHit(session({ currency: "eur" }))).toBeNull();
		expect(purchaseHit(session({ currency: null }))).toBeNull();
		const denied = purchaseHit(session({ metadata: { ga_consent: "denied", plan: "included", uid: "ada" } }));
		expect(denied).toBeNull();
	});

	it("sends the Stripe total once per session and keeps the API secret out of errors", async () => {
		const ledger = new MemoryPurchaseLedger();
		const fetchImpl = fakeFetch();
		await expect(deliverPurchase(session({ amount_total: 0, payment_status: "no_payment_required" }), {
			measurementId: MEASUREMENT,
			apiSecret: SECRET,
			ledger,
			fetchImpl,
		})).resolves.toBe("sent");
		await expect(deliverPurchase(session({ amount_total: 0, payment_status: "no_payment_required" }), {
			measurementId: MEASUREMENT,
			apiSecret: SECRET,
			ledger,
			fetchImpl,
		})).resolves.toBe("duplicate");
		expect(fetchImpl.calls).toHaveLength(1);
		const call = fetchImpl.calls[0];
		expect(call?.url).toBe(measurementCollectUrl(MEASUREMENT, SECRET));
		const body = JSON.parse(call?.body ?? "{}") as { client_id: string; events: Array<{ name: string; params: { value: number; transaction_id: string; currency: string } }> };
		expect(body.client_id).toBe("123.456");
		expect(body.events[0]?.name).toBe("purchase");
		expect(body.events[0]?.params).toMatchObject({
			transaction_id: "cs_live_abc",
			value: 0,
			currency: "USD",
			session_id: 1700000001,
			gclid: "CjwKCtestclick",
		});
		expect(body.events[0]?.params).not.toMatchObject({ value: 20 });

		const failing = fakeFetch(503);
		const fresh = new MemoryPurchaseLedger();
		await expect(deliverPurchase(session(), { measurementId: MEASUREMENT, apiSecret: SECRET, ledger: fresh, fetchImpl: failing })).rejects.toThrow(
			/returned 503/,
		);
		await expect(fresh.has("cs_live_abc")).resolves.toBe(false);
		const thrown = await deliverPurchase(session(), {
			measurementId: MEASUREMENT,
			apiSecret: SECRET,
			ledger: fresh,
			fetchImpl: () => Promise.reject(new Error(`boom ${SECRET}`)),
		}).catch((err: unknown) => err);
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).not.toContain(SECRET);
		expect((thrown as Error).message).not.toContain("mp/collect");
	});

	it("does not call Google when the secret or the measurement id is missing", async () => {
		const ledger = new MemoryPurchaseLedger();
		const fetchImpl = fakeFetch();
		await expect(deliverPurchase(session(), { measurementId: MEASUREMENT, apiSecret: null, ledger, fetchImpl })).resolves.toBe("unconfigured");
		await expect(deliverPurchase(session(), { measurementId: null, apiSecret: SECRET, ledger, fetchImpl })).resolves.toBe("unconfigured");
		expect(fetchImpl.calls).toHaveLength(0);
		await expect(ledger.has("cs_live_abc")).resolves.toBe(false);
	});

	it("uses a stable fallback client id when checkout did not capture one", () => {
		const hit = purchaseHit(session({ metadata: { uid: "ada", plan: "byom" } }));
		expect(hit?.clientId).toMatch(/^\d+\.1$/);
		expect(hit?.plan).toBe("byom");
		const payload = purchasePayload(hit!);
		expect(payload.events[0]?.params.items).toEqual([{ item_id: "byom", item_name: "Bring your own model", price: 20, quantity: 1 }]);
		expect(purchaseHit(session({ metadata: { uid: "ada", plan: "byom" } }))?.clientId).toBe(hit?.clientId);
	});

	it("stays silent off Cloud Run, and warns once without the secret on Cloud Run", async () => {
		const fetchImpl = fakeFetch();
		const off = loadGa4PurchaseReporter({ GA4_API_SECRET: SECRET, GA4_MEASUREMENT_ID: MEASUREMENT }, fetchImpl, new MemoryPurchaseLedger());
		await off.report(session());
		expect(fetchImpl.calls).toHaveLength(0);

		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
			errors.push(String(message));
		});
		const on = loadGa4PurchaseReporter(
			{ K_SERVICE: "groundwork", GA4_MEASUREMENT_ID: MEASUREMENT },
			fetchImpl,
			new MemoryPurchaseLedger(),
		);
		await on.report(session());
		await on.report(session({ id: "cs_live_other" }));
		expect(fetchImpl.calls).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).not.toContain(SECRET);
		expect(errors[0]).toContain("GA4_API_SECRET");
	});

	it("posts from Cloud Run when the secret is set, and does not repeat a session", async () => {
		const fetchImpl = fakeFetch();
		const ledger = new MemoryPurchaseLedger();
		const reporter = loadGa4PurchaseReporter(
			{ K_SERVICE: "groundwork", GA4_API_SECRET: SECRET, GA4_MEASUREMENT_ID: MEASUREMENT },
			fetchImpl,
			ledger,
		);
		await reporter.report(session({ amount_total: 500, metadata: { uid: "ada", plan: "byom", ga_client_id: "9.8" } }));
		await reporter.report(session({ amount_total: 500, metadata: { uid: "ada", plan: "byom", ga_client_id: "9.8" } }));
		expect(fetchImpl.calls).toHaveLength(1);
		const body = JSON.parse(fetchImpl.calls[0]?.body ?? "{}") as { events: Array<{ params: { value: number } }> };
		expect(body.events[0]?.params.value).toBe(5);
	});

	it("keeps purchase off the browser bundle", () => {
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
		const app = readFileSync(path.join(root, "packages/server/public/app.js"), "utf8");
		const browser = readFileSync(path.join(root, "packages/server/src/browser-tracking.ts"), "utf8");
		const events = readFileSync(path.join(root, "packages/server/src/ga4-events.ts"), "utf8");
		expect(app).not.toContain("notePurchase");
		expect(app).not.toContain("checkout-amount");
		expect(app).not.toContain("purchaseValue");
		expect(browser).not.toContain("emitPurchase");
		expect(browser).not.toContain("gw-purchases");
		expect(events).not.toContain("purchaseValue");
		expect(events).not.toContain("emitPurchase");
	});
});
