import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { AccountDirectory } from "./accounts";
import { FileAccountStore, FirestoreAccountStore } from "./account-store";
import { route, type RouteResult } from "./app";
import { loadAuth } from "./auth";
import { loadBilling } from "./billing";
import { gradeWithJev, jevConfigured, selectContextWithJev } from "./jev";
import { clientAddress } from "./client-address";
import { httpsRedirectTarget, isLocalHost, listenTarget } from "./listen";
import { MemoryDirectory } from "./memory";
import { FileTutorMemoryStore } from "./memory-file";
import { BestEffortStore, FirestoreTutorMemoryStore } from "./memory-firestore";
import { SecretDirectory } from "./secrets";
import { FileSecretStore, FirestoreSecretStore } from "./secret-store";
import { platformFetch } from "./platform-fetch";
import { readSite } from "./static";
import { UsageDirectory } from "./usage";
import { FileUsageStore, FirestoreUsageStore } from "./usage-store";

const { port, host } = listenTarget();
const auth = loadAuth();
const accountFile = process.env.GROUNDWORK_ACCOUNT_FILE ?? path.resolve(process.cwd(), "data/accounts.json");
const usage = new UsageDirectory(auth.firebase ? new FirestoreUsageStore() : new FileUsageStore(process.env.GROUNDWORK_USAGE_FILE ?? path.resolve(process.cwd(), "data/usage.json")));
const accounts = new AccountDirectory(auth.firebase ? new FirestoreAccountStore() : new FileAccountStore(accountFile), {
	onPeriodClose: (record) => usage.noteSpend(record),
	onSpend: (record) => usage.noteSpend(record),
});
const memoryFile = process.env.GROUNDWORK_MEMORY_FILE ?? path.resolve(process.cwd(), "data/tutor-memory.json");
const memoryStore = auth.firebase ? new BestEffortStore(new FirestoreTutorMemoryStore()) : new FileTutorMemoryStore(memoryFile);

const deps = {
	auth,
	accounts,
	secrets: new SecretDirectory(auth.firebase ? new FirestoreSecretStore() : new FileSecretStore(process.env.GROUNDWORK_SECRETS_FILE ?? path.resolve(process.cwd(), "data/secrets.json"))),
	billing: loadBilling(accounts, {
		onUpgrade: async (uid, plan) => {
			await usage.recordEvent({ uid, at: new Date().toISOString(), kind: "upgraded", plan });
		},
	}),
	jev: jevConfigured(),
	memory: new MemoryDirectory(memoryStore),
	grade: gradeWithJev,
	selectContext: selectContextWithJev,
	openRouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
	fetchImpl: platformFetch,
	usage,
};

const server = createServer((req, res) => {
	void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const method = req.method ?? "GET";
	const head = method === "HEAD";
	const verb = head ? "GET" : method;
	const forwarded = header(req, "x-forwarded-proto");
	const https = httpsRedirectTarget(forwarded, header(req, "x-forwarded-host") || header(req, "host"), req.url);
	if (https) {
		res.writeHead(308, { location: https });
		res.end();
		return;
	}
	if (verb === "OPTIONS") {
		writeHead(res, 204, "text/plain", 0);
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (verb === "GET" && !isUsagePath(url.pathname)) {
		const site = readSite(url.pathname);
		if (site) {
			endBody(res, 200, site.type, site.body, head);
			return;
		}
		if (!url.pathname.startsWith("/v1/") && url.pathname !== "/health") {
			const notFound = readSite("/404.html");
			if (notFound) {
				endBody(res, 404, notFound.type, notFound.body, head);
				return;
			}
		}
	}
	const origin = header(req, "origin") || process.env.GROUNDWORK_PUBLIC_URL || `http://127.0.0.1:${port}`;
	const meta = {
		origin,
		attribution: header(req, "x-groundwork-attribution"),
		sessionId: url.searchParams.get("session_id") ?? undefined,
		ip: clientIp(req),
	};
	if (head) {
		const bearer = sessionBearer(req);
		const result = await route(verb, url.pathname, null, deps, bearer, meta);
		if (bearer && result.status < 400) result.headers = { ...result.headers, "set-cookie": sessionCookie(bearer, forwarded === "https") };
		send(res, result, true);
		return;
	}
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (url.pathname === "/v1/stripe/webhook") {
		const result = await route(verb, url.pathname, null, deps, undefined, { origin, rawBody: raw, stripeSignature: header(req, "stripe-signature") });
		send(res, result);
		return;
	}
	let body: unknown = null;
	if (raw.length > 12_000_000) {
		send(res, { status: 413, json: { error: "That upload is too large." } });
		return;
	}
	if (raw) {
		try {
			body = JSON.parse(raw);
		} catch {
			send(res, { status: 400, json: { error: "Send JSON." } });
			return;
		}
	}
	const bearer = sessionBearer(req);
	const result = await route(verb, url.pathname, body, deps, bearer, meta);
	if (bearer && result.status < 400) result.headers = { ...result.headers, "set-cookie": sessionCookie(bearer, forwarded === "https") };
	send(res, result, head);
}

function clientIp(req: IncomingMessage): string {
	return clientAddress(header(req, "x-forwarded-for"), req.socket.remoteAddress);
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function writeHead(res: ServerResponse, status: number, type: string, length?: number, extra: Record<string, string> = {}): void {
	res.writeHead(status, {
		"content-type": type,
		...(length !== undefined ? { "content-length": length } : {}),
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "authorization, content-type, stripe-signature",
		"access-control-allow-methods": "GET, HEAD, POST, PUT, OPTIONS",
		...extra,
	});
}

function endBody(res: ServerResponse, status: number, type: string, body: string | Buffer, head: boolean, extra: Record<string, string> = {}): void {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
	writeHead(res, status, type, payload.length, extra);
	if (head) res.end();
	else res.end(payload);
}

function isUsagePath(pathname: string): boolean {
	return pathname === "/admin/usage" || pathname === "/admin/usage.csv";
}

function sessionBearer(req: IncomingMessage): string | undefined {
	const authorization = header(req, "authorization");
	if (authorization) return authorization;
	const cookie = header(req, "cookie");
	const match = cookie?.match(/(?:^|;\s*)gw_id=([^;]+)/);
	if (!match?.[1]) return undefined;
	return `Bearer ${decodeURIComponent(match[1])}`;
}

function sessionCookie(authorization: string, secure: boolean): string {
	const token = authorization.replace(/^Bearer\s+/i, "");
	const parts = [`gw_id=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=3300"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

function send(res: ServerResponse, result: RouteResult, head = false): void {
	const extra = result.headers ?? {};
	if (result.text !== undefined) {
		const payload = Buffer.from(result.text);
		res.writeHead(result.status, {
			"content-type": result.type ?? "text/plain; charset=utf-8",
			"content-length": payload.length,
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "authorization, content-type, stripe-signature",
			"access-control-allow-methods": "GET, HEAD, POST, PUT, OPTIONS",
			...extra,
		});
		if (head) res.end();
		else res.end(payload);
		return;
	}
	endBody(res, result.status, "application/json; charset=utf-8", JSON.stringify(result.json), head, extra);
}

if (!isLocalHost(host) && !deps.auth.firebase) {
	console.error("Refusing to listen on a public address until Firebase auth is configured.");
	process.exit(1);
}

server.listen(port, host, () => {
	void usage.backfill(accounts, () => deps.billing.couponHolders?.() ?? Promise.resolve([])).catch((err: unknown) => {
		console.error("Could not backfill usage.", err);
	});
	const billing = deps.billing.configured ? "on" : "waiting for Stripe keys";
	const firebase = deps.auth.firebase ? "on" : "waiting for a service account";
	const models = deps.openRouterKey ? "on" : "waiting for OPENROUTER_API_KEY";
	process.stdout.write(`Groundwork on http://${host}:${port} (jev ${deps.jev ? "on" : "off"}, models ${models}, firebase ${firebase}, billing ${billing})\n`);
});
