export function listenTarget(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
	const port = Number(env.PORT ?? env.GROUNDWORK_PORT ?? 8787);
	const host = env.GROUNDWORK_HOST ?? (env.PORT ? "0.0.0.0" : "127.0.0.1");
	return { host, port };
}

/** Loopback is the local account server. Anything else is reachable beyond this machine. */
export function isLocalHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Firebase Hosting already redirects HTTP to HTTPS. This covers a request that
 * reaches Cloud Run with `X-Forwarded-Proto: http`. Loopback is left alone.
 */
export function httpsRedirectTarget(proto: string | undefined, host: string | undefined, url: string | undefined): string | null {
	if (proto !== "http" || !host || !url) return null;
	const hostname = host.split(":")[0]?.toLowerCase() ?? "";
	if (isLocalHost(hostname)) return null;
	return `https://${host}${url.startsWith("/") ? url : `/${url}`}`;
}
