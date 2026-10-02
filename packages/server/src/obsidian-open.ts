const TTL_MS = 2 * 60_000;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/v1\/obsidian-opened\/([0-9a-f-]{36})(\/signal)?$/i;

const openedUntil = new Map<string, number>();

function prune(now: number): void {
	for (const [nonce, until] of openedUntil) {
		if (until <= now) openedUntil.delete(nonce);
	}
}

/**
 * The website asks an installed plugin to GET the `/signal` path. The page then
 * reads the same nonce and skips the installer. No account token is required:
 * the nonce is the one-time capability, and the body is only `{ opened }`.
 */
export function obsidianOpen(method: string, path: string): { status: number; json: unknown } | null {
	const match = PATH.exec(path);
	if (!match) return null;
	const nonce = match[1].toLowerCase();
	if (!NONCE.test(nonce)) return { status: 400, json: { error: "Unknown open request." } };
	const now = Date.now();
	prune(now);
	const signal = Boolean(match[2]);
	if (signal) {
		if (method !== "GET" && method !== "POST") return { status: 404, json: { error: "Not found." } };
		openedUntil.set(nonce, now + TTL_MS);
		return { status: 200, json: { ok: true } };
	}
	if (method !== "GET") return { status: 404, json: { error: "Not found." } };
	const until = openedUntil.get(nonce);
	return { status: 200, json: { opened: typeof until === "number" && until > now } };
}
