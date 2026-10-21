import http, { createServer, type IncomingMessage, type Server } from "node:http";
import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, TOOLS, tutorWireBody, usageFeatureFromThread, type ChatMessage, type ContentBlock } from "@groundwork/core";
import { messagesForAnthropic } from "../../core/src/account/anthropic-messages";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { jsonBodyError, JSON_BODY_LIMIT_BYTES, readRawBody } from "../src/json-body";
import { MemoryDirectory } from "../src/memory";
import { SecretDirectory } from "../src/secrets";

/**
 * The plugin posts this shape to /v1/tutor/complete. A pasted screenshot is small.
 * Lecture decks already in the session were sent again as base64 on every later turn,
 * and that is what crossed the 12 MB body check.
 */
const SLIDE = "LECTURESLIDEBYTES";
const CURRENT = "CURRENTSLIDEBYTES";
const QUESTION = "Help me answer these questions in light of the lecture slides";

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([head, body, sum]);
}

/** About 125 KB: a tiny truecolor PNG plus an ancillary chunk the decoder ignores. */
function screenshotPng(): Buffer {
	const width = 8;
	const height = 8;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const row = y * (1 + width * 3);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const i = row + 1 + x * 3;
			raw[i] = 20;
			raw[i + 1] = 40;
			raw[i + 2] = 80;
		}
	}
	const overhead = 8 + chunk("IHDR", ihdr).length + chunk("IDAT", deflateSync(raw)).length + chunk("IEND", Buffer.alloc(0)).length + 12;
	const extra = Buffer.alloc(Math.max(0, 125 * 1024 - overhead), 7);
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("prIv", extra), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function slide(path: string, marker: string, copies: number): ContentBlock[] {
	return [
		{ type: "text", text: `File: ${path}` },
		{ type: "document", source: { type: "base64", media_type: "application/pdf", data: marker.repeat(copies) }, title: path },
	];
}

function longSession(image: string): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (let i = 0; i < 12; i++) {
		messages.push({ role: "user", content: `In lecture ${i + 1}, which step of the epsilon proof is the definition?` });
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `The definition says the outputs stay close once the inputs are close enough. ${"Work the next line yourself. ".repeat(30)}` }],
		});
	}
	for (let n = 1; n <= 4; n++) {
		const path = `courses/Lecture ${n} slides.pdf`;
		messages.push({ role: "user", content: [...slide(path, SLIDE, 200_000), { type: "text", text: `Use ${path} for the next problem.` }] });
		messages.push({ role: "assistant", content: [{ type: "text", text: `I have ${path} open and will use its definitions.` }] });
	}
	messages.push({
		role: "user",
		content: [
			{ type: "text", text: "File: resources/Pasted image.png" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: image } },
			...slide("courses/Lecture 12 slides.pdf", CURRENT, 1_100_000),
			{ type: "text", text: QUESTION },
		],
	});
	return messages;
}

function wire(messages: ChatMessage[]): string {
	const tools = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
	return tutorWireBody({
		system: buildSystemPrompt(),
		messages,
		tools,
		maxTokens: 8192,
		feature: usageFeatureFromThread(messages),
	});
}

function deps(): { server: ServerDeps; calls: Array<{ body: Record<string, unknown> }> } {
	const calls: Array<{ body: Record<string, unknown> }> = [];
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		return new Response(
			JSON.stringify({
				content: [{ type: "text", text: "Start from the definition on the slide, then use the screenshot." }],
				stop_reason: "end_turn",
				usage: { input_tokens: 800, output_tokens: 40 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	const auth: Auth = { firebase: false, async uid() { return { uid: "local", email: "ada@example.com", name: "Ada" }; }, async revokeRefreshTokens() {} };
	const billing: Billing = {
		configured: false,
		async checkout() { throw new Error("no"); },
		async portal() { throw new Error("no"); },
		async applyEvent() { throw new Error("no"); },
	};
	return {
		calls,
		server: {
			auth,
			accounts: new AccountDirectory(),
			secrets: new SecretDirectory(),
			billing,
			jev: true,
			memory: new MemoryDirectory(),
			async grade() { return []; },
			async selectContext() { return []; },
			openRouterKey: "sk-or-test",
			fetchImpl,
		},
	};
}

function listen(): Promise<{ port: number; close: () => Promise<void> }> {
	const server: Server = createServer(async (req, res) => {
		const buf = await readRawBody(req);
		const tooBig = jsonBodyError(buf.byteLength);
		const status = tooBig?.status ?? 200;
		const json = tooBig ? { error: tooBig.error } : { ok: true, bytes: buf.byteLength };
		const payload = Buffer.from(JSON.stringify(json));
		res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
		res.end(payload);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				port,
				close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
			});
		});
	});
}

function post(port: number, body: string | Buffer): Promise<{ status: number; json: { error?: string; ok?: boolean } }> {
	return new Promise((resolve, reject) => {
		const payload = typeof body === "string" ? Buffer.from(body) : body;
		const req = http.request(
			{ hostname: "127.0.0.1", port, method: "POST", path: "/v1/tutor/complete", headers: { "content-type": "application/json", "content-length": payload.length } },
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as { error?: string; ok?: boolean }) : {} });
				});
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

describe("tutor upload size", () => {
	it("sends a 125KB screenshot on a long Heavy session without the lecture bytes", async () => {
		const png = screenshotPng();
		expect(png.byteLength).toBeGreaterThan(120 * 1024);
		expect(png.byteLength).toBeLessThan(130 * 1024);
		const image = png.toString("base64");
		const history = longSession(image);
		const raw = wire(history);
		expect(Buffer.byteLength(raw)).toBeGreaterThan(12_000_000);

		const sent = messagesForAnthropic(history);
		const payload = wire(sent);
		expect(Buffer.byteLength(payload)).toBeLessThan(12_000_000);
		expect(payload).not.toContain(SLIDE);
		expect(payload).not.toContain(CURRENT);
		expect(payload).toContain(image.slice(0, 80));
		expect(payload).toContain(QUESTION);
		expect(payload).toContain("Already read courses/Lecture 1 slides.pdf");
		expect(payload).toContain("courses/Lecture 12 slides.pdf was left out of this request");

		const gate = await listen();
		try {
			const accepted = await post(gate.port, payload);
			expect(accepted.status).toBe(200);
			expect(accepted.json.ok).toBe(true);
			const huge = Buffer.alloc(JSON_BODY_LIMIT_BYTES + 1, 0x78);
			const rejected = await post(gate.port, huge);
			expect(rejected.status).toBe(413);
			expect(rejected.json.error).toBe("That upload is too large. The limit is 30 MB.");
		} finally {
			await gate.close();
		}

		const { server, calls } = deps();
		await server.accounts.setPlan("local", "included");
		await server.accounts.setTutorWeight("local", "heavy");
		const result = await route("POST", "/v1/tutor/complete", JSON.parse(payload) as unknown, server);
		expect(result.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.model).toBe("google/gemini-3.5-flash");
		const upstream = JSON.stringify(calls[0]?.body);
		expect(upstream).toContain(image.slice(0, 80));
		expect(upstream).not.toContain(SLIDE);
		expect(upstream).not.toContain(CURRENT);
		expect(JSON.stringify(result.json)).not.toMatch(/hostedCreditUsd|creditUsd|remainingUsd/);
	}, 30_000);
});
