import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AccountDirectory } from "./accounts";
import { route } from "./app";
import { loadAuth } from "./auth";
import { loadBilling } from "./billing";
import { gradeWithJev, jevConfigured } from "./jev";
import { isLocalHost, listenTarget } from "./listen";
import { MemoryDirectory } from "./memory";
import { SecretDirectory } from "./secrets";
import { readSite } from "./static";

const { port, host } = listenTarget();
const accounts = new AccountDirectory();

const deps = {
	auth: loadAuth(),
	accounts,
	secrets: new SecretDirectory(),
	billing: loadBilling(accounts),
	jev: jevConfigured(),
	memory: new MemoryDirectory(),
	grade: gradeWithJev,
	openRouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
	fetchImpl: fetch,
};

const server = createServer((req, res) => {
	void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const method = req.method ?? "GET";
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
	const result = await route(method, url.pathname, body, deps, header(req, "authorization"), { origin });
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
