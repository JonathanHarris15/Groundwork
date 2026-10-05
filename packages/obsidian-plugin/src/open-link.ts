const SIGNAL_PATH = /^\/v1\/obsidian-opened\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/signal$/i;

/** Safe concept title from an obsidian://groundwork?concept=… deep link. */
export function parseGroundworkConcept(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const title = value.trim().replace(/\s+/g, " ");
	if (!title || title.length > 120) return null;
	if (/[\u0000-\u001f\u007f]/.test(title)) return null;
	return title;
}

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
