import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { responseFromNodeStream } from "../src/platform-fetch";

describe("platform fetch streaming", () => {
	it("yields the first chunk before the node response ends", async () => {
		const source = new PassThrough();
		const incoming = source as unknown as IncomingMessage;
		incoming.headers = { "content-type": "text/event-stream" };
		incoming.statusCode = 200;
		incoming.statusMessage = "OK";
		const response = responseFromNodeStream(incoming);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		source.write("data: hello\n\n");
		const first = await reader.read();
		expect(decoder.decode(first.value)).toContain("hello");
		let ended = false;
		const rest = reader.read().then((chunk) => {
			ended = true;
			return decoder.decode(chunk.value);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ended).toBe(false);
		source.end("data: done\n\n");
		expect(await rest).toContain("done");
	});
});
