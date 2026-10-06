/**
 * Address used to rate-limit a public read.
 *
 * Cloud Run appends the IP of the proxy that connected to the container.
 * That last X-Forwarded-For entry is Google's own hop when the proxy is
 * Firebase Hosting. The client address Hosting recorded is the entry
 * immediately before it. Anything earlier is whatever the browser sent.
 *
 * One entry is not that chain, so a spoofed header cannot choose the key.
 */
export function clientAddress(forwarded: string | undefined, socketAddress?: string): string {
	const hops = (forwarded ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (hops.length >= 2) return hops[hops.length - 2] ?? "unknown";
	const socket = socketAddress?.trim();
	return socket || "unknown";
}
