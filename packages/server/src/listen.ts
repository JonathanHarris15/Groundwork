export function listenTarget(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
	const port = Number(env.PORT ?? env.GROUNDWORK_PORT ?? 8787);
	const host = env.GROUNDWORK_HOST ?? (env.PORT ? "0.0.0.0" : "127.0.0.1");
	return { host, port };
}

/** Loopback is the local account server. Anything else is reachable beyond this machine. */
export function isLocalHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
