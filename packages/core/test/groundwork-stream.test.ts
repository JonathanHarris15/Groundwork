import { describe, expect, it } from "vitest";
import { GroundworkProvider } from "../src/agent/groundwork";
import { tutorEventLine } from "../src/agent/tutor-events";
import type { HttpResponse } from "../src/http";

function delayedStream(chunks: string[], gapMs: number, onSecond?: () => void): HttpResponse {
	let index = 0;
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
		text: async () => chunks.join(""),
		json: async () => ({}),
		arrayBuffer: async () => new ArrayBuffer(0),
		body: {
			getReader() {
				return {
					async cancel() {},
					async read() {
						if (index >= chunks.length) return { done: true, value: undefined };
						if (index > 0) {
							onSecond?.();
							await new Promise((resolve) => setTimeout(resolve, gapMs));
						}
						const value = new TextEncoder().encode(chunks[index++]!);
						return { done: false, value };
					},
				};
			},
		},
	};
}

describe("GroundworkProvider streaming", () => {
	it("delivers the first text event before the stream ends", async () => {
		let helloAt = 0;
		let secondAt = 0;
		const provider = new GroundworkProvider({
			origin: "https://example.test",
			token: async () => "token",
			fetchImpl: async () =>
				delayedStream(
					[
						tutorEventLine({ type: "text", text: "Hello" }),
						tutorEventLine({
							type: "done",
							content: [{ type: "text", text: "Hello there" }],
							stopReason: "end_turn",
							usage: { input: 3, output: 2 },
						}),
					],
					40,
					() => {
						secondAt = performance.now();
					},
				),
		});
		const result = await provider.complete({
			system: "Teach.",
			messages: [{ role: "user", content: "Hi" }],
			tools: [],
			onText(text) {
				if (text === "Hello") helloAt = performance.now();
			},
		});
		expect(helloAt).toBeGreaterThan(0);
		expect(secondAt).toBeGreaterThan(helloAt);
		expect(result.stopReason).toBe("end_turn");
		expect(result.content).toEqual([{ type: "text", text: "Hello there" }]);
		expect(result.usage).toEqual({ input: 3, output: 2 });
	});

	it("reads a JSON body when the server does not stream", async () => {
		const seen: string[] = [];
		const provider = new GroundworkProvider({
			origin: "https://example.test",
			token: async () => "token",
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
				text: async () => JSON.stringify({ content: [{ type: "text", text: "Buffered." }], stopReason: "end_turn", usage: { input: 1, output: 1 } }),
				json: async () => ({}),
				arrayBuffer: async () => new ArrayBuffer(0),
				body: null,
			}),
		});
		const result = await provider.complete({
			system: "Teach.",
			messages: [{ role: "user", content: "Hi" }],
			tools: [],
			onText(text) {
				seen.push(text);
			},
		});
		expect(seen).toEqual(["Buffered."]);
		expect(result.content).toEqual([{ type: "text", text: "Buffered." }]);
	});
});
