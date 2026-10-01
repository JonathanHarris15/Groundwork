import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AccountDirectory } from "./accounts";
import { route } from "./app";
import { loadAuth } from "./auth";
import { gradeWithJev, jevConfigured } from "./jev";
import { SecretDirectory } from "./secrets";

const port = Number(process.env.GROUNDWORK_PORT ?? 8787);
const host = process.env.GROUNDWORK_HOST ?? "127.0.0.1";

const deps = {
	auth: loadAuth(),
	accounts: new AccountDirectory(),
	secrets: new SecretDirectory(),
	jev: jevConfigured(),
	grade: gradeWithJev,
};

const server = createServer((req, res) => {
	void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	let body: unknown = null;
	if (raw) {
		try {
			body = JSON.parse(raw);
		} catch {
			send(res, 400, { error: "Send JSON." });
			return;
		}
	}
	const result = await route(req.method ?? "GET", url.pathname, body, deps, req.headers.authorization);
	send(res, result.status, result.json);
}

function send(res: ServerResponse, status: number, json: unknown): void {
	const payload = JSON.stringify(json);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

server.listen(port, host, () => {
	console.log(`Groundwork account server on http://${host}:${port} (jev ${deps.jev ? "on" : "off"}, firebase ${deps.auth.firebase ? "on" : "waiting for a service account"})`);
});
