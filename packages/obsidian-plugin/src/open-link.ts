const SIGNAL_PATH = /^\/v1\/obsidian-opened\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/signal$/i;

/** Accept only the website's open-ack URL, so a crafted obsidian:// link cannot make the plugin request an arbitrary host path. */
export function groundworkOpenedSignal(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password) return null;
	if (!SIGNAL_PATH.test(url.pathname)) return null;
	return url.toString();
}
