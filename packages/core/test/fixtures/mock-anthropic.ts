import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

export interface MockRequest {
	system: unknown;
	messages: Array<{ role: string; content: any }>;
	tools: Array<{ name: string }>;
	model: string;
	stream: boolean;
}

/** Stands in for the Anthropic Messages API so the real Claude Code binary can run without an account. */
export async function startMockAnthropic(
	reply: (req: MockRequest) => MockBlock[],
	isMain: (req: MockRequest) => boolean = (req) => (req.tools ?? []).some((t) => t.name.startsWith("mcp__")),
	port = 0,
): Promise<{ url: string; requests: MockRequest[]; close(): Promise<void> }> {
	const requests: MockRequest[] = [];
	let n = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (!req.url?.startsWith("/v1/messages") || req.method !== "POST") {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not mocked" } }));
				return;
			}
			if (req.url.startsWith("/v1/messages/count_tokens")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ input_tokens: 100 }));
				return;
			}
			const parsed = JSON.parse(body) as MockRequest;
			const main = isMain(parsed);
			const blocks: MockBlock[] = main ? reply(parsed) : [{ type: "text", text: "Tutoring session" }];
			if (main) requests.push(parsed);
			const id = `msg_mock_${++n}`;
			const content = blocks.map((b, i) => (b.type === "text" ? b : { type: "tool_use", id: `toolu_mock_${n}_${i}`, name: b.name, input: b.input }));
			const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
			const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
			if (!parsed.stream) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id, type: "message", role: "assistant", model: parsed.model, content, stop_reason: stop, stop_sequence: null, usage }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			send("message_start", {
				type: "message_start",
				message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage },
			});
			content.forEach((b: any, index) => {
				if (b.type === "text") {
					send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					for (const piece of b.text.match(/[\s\S]{1,12}/g) ?? []) {
						send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
					}
				} else {
					send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
					send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
				}
				send("content_block_stop", { type: "content_block_stop", index });
			});
			send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
			send("message_stop", { type: "message_stop" });
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	const bound = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${bound}`,
		requests,
		close: () => new Promise((r) => server.close(() => r())),
	};
}

export function toolResults(req: MockRequest): string[] {
	const out: string[] = [];
	for (const m of req.messages) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b.type !== "tool_result") continue;
			const c = b.content;
			out.push(typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : "");
		}
	}
	return out;
}
