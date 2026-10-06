const WINDOW_MS = 60_000;
const MAX_IN_WINDOW = 30;

const hits = new Map<string, number[]>();

/** Drop timestamps outside the window so a busy key does not grow forever. */
function recent(key: string, now: number): number[] {
	const kept = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	hits.set(key, kept);
	return kept;
}

/**
 * Checkout amount is a public read that calls Stripe.
 * One IP gets a short burst, then 429 until the window slides.
 */
export function allowCheckoutAmount(ip: string, now = Date.now()): boolean {
	const key = ip.trim() || "unknown";
	const seen = recent(key, now);
	if (seen.length >= MAX_IN_WINDOW) return false;
	seen.push(now);
	return true;
}

export function resetCheckoutAmountLimits(): void {
	hits.clear();
}