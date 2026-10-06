import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { AccountDirectory } from "./accounts";
import { FileAccountStore, FirestoreAccountStore } from "./account-store";
import { route } from "./app";
import { loadAuth } from "./auth";
import { loadBilling } from "./billing";
import { gradeWithJev, jevConfigured } from "./jev";
import { httpsRedirectTarget, isLocalHost, listenTarget } from "./listen";
import { MemoryDirectory } from "./memory";
import { FileTutorMemoryStore } from "./memory-file";
import { BestEffortStore, FirestoreTutorMemoryStore } from "./memory-firestore";
import { SecretDirectory } from "./secrets";
import { FileSecretStore, FirestoreSecretStore } from "./secret-store";
import { readSite } from "./static";

const { port, host } = listenTarget();
const auth = loadAuth();
const accountFile = process.env.GROUNDWORK_ACCOUNT_FILE ?? path.resolve(process.cwd(), "data/accounts.json");
const accounts = new AccountDirectory(auth.firebase ? new FirestoreAccountStore() : new FileAccountStore(accountFile));
const memoryFile = process.env.GROUNDWORK_MEMORY_FILE ?? path.resolve(process.cwd(), "data/tutor-memory.json");
const memoryStore = auth.firebase ? new BestEffortStore(new FirestoreTutorMemoryStore()) : new FileTutorMemoryStore(memoryFile);

const deps = {
	auth,
	accounts,
	secrets: new SecretDirectory(auth.firebase ? new FirestoreSecretStore() : new FileSecretStore(process.env.GROUNDWORK_SECRETS_FILE ?? path.resolve(process.cwd(), "data/secrets.json"))),
	billing: loadBilling(accounts),
	jev: jevConfigured(),
	memory: new MemoryDirectory(memoryStore),
	grade: gradeWithJev,
	openRouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
	fetchImpl: fetch,
};

const server = createServer((req, res) => {
	void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const method = req.method ?? "GET";
	const forwarded = header(req, "x-forwarded-proto");
	const https = httpsRedirectTarget(forwarded, header(req, "x-forwarded-host") || header(req, "host"), req.url);
	if (https) {
		res.writeHead(308, { location: https });
		res.end();
		return;
	}
	if (method === "OPTIONS") {
		writeHead(res, 204, "text/plain");
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (method === "GET") {
		const site = readSite(url.pathname);
		if (site) {
			writeHead(res, 200, site.type);
			res.end(site.body);
			return;
		}
		if (!url.pathname.startsWith("/v1/") && url.pathname !== "/health") {
			const notFound = readSite("/404.html");
			if (notFound) {
				writeHead(res, 404, notFound.type);
				res.end(notFound.body);
				return;
			}
		}
	}
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	const origin = header(req, "origin") || process.env.GROUNDWORK_PUBLIC_URL || `http://127.0.0.1:${port}`;
	if (url.pathname === "/v1/stripe/webhook") {
		const result = await route(method, url.pathname, null, deps, undefined, { origin, rawBody: raw, stripeSignature: header(req, "stripe-signature") });
		send(res, result.status, result.json);
		return;
	}
	let body: unknown = null;
	if (raw.length > 12_000_000) {
		send(res, 413, { error: "That upload is too large." });
		return;
	}
	if (raw) {
		try {
			body = JSON.parse(raw);
		} catch {
			send(res, 400, { error: "Send JSON." });
			return;
		}
	}
	const result = await route(method, url.pathname, body, deps, header(req, "authorization"), {
		origin,
		attribution: header(req, "x-groundwork-attribution"),
		sessionId: url.searchParams.get("session_id") ?? undefined,
	});
	send(res, result.status, result.json);
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function writeHead(res: ServerResponse, status: number, type: string, length?: number): void {
	res.writeHead(status, {
		"content-type": type,
		...(length !== undefined ? { "content-length": length } : {}),
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "authorization, content-type, stripe-signature",
		"access-control-allow-methods": "GET, POST, PUT, OPTIONS",
	});
}

function send(res: ServerResponse, status: number, json: unknown): void {
	const payload = JSON.stringify(json);
	writeHead(res, status, "application/json; charset=utf-8", Buffer.byteLength(payload));
	res.end(payload);
}

if (!isLocalHost(host) && !deps.auth.firebase) {
	console.error("Refusing to listen on a public address until Firebase auth is configured.");
	process.exit(1);
}

server.listen(port, host, () => {
	const billing = deps.billing.configured ? "on" : "waiting for Stripe keys";
	const firebase = deps.auth.firebase ? "on" : "waiting for a service account";
	const models = deps.openRouterKey ? "on" : "waiting for OPENROUTER_API_KEY";
	console.log(`Groundwork on http://${host}:${port} (jev ${deps.jev ? "on" : "off"}, models ${models}, firebase ${firebase}, billing ${billing})`);
});
