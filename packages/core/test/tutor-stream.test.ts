import { describe, expect, it } from "vitest";
import { plainTutorError } from "../src/account/anthropic-messages";
import { GroundworkProvider } from "../src/agent/groundwork";
import {
	isTruncatedTutorStream,
	pushTutorSse,
	TUTOR_STREAM_TRUNCATED,
	tutorEventLine,
	tutorSseKeepaliveLine,
} from "../src/agent/tutor-events";

describe("tutor SSE wire format", () => {
	it("ignores keepalive comment lines", () => {
		const chunk = tutorSseKeepaliveLine() + tutorEventLine({ type: "text", text: "Hi" });
		const parsed = pushTutorSse("", chunk);
		expect(parsed.events).toEqual([{ type: "text", text: "Hi" }]);
	});

	it("recognises a truncated stream message", () => {
		expect(isTruncatedTutorStream(TUTOR_STREAM_TRUNCATED)).toBe(true);
		expect(isTruncatedTutorStream("The tutor stream ended before the reply finished.")).toBe(true);
		expect(plainTutorError(TUTOR_STREAM_TRUNCATED)).toContain("keep going");
	});
});

describe("GroundworkProvider truncated stream", () => {
	it("throws when the server closes before done", async () => {
		const provider = new GroundworkProvider({
			origin: "https://example.test",
			token: async () => "token",
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
				text: async () => tutorEventLine({ type: "text", text: "Partial" }),
				json: async () => ({}),
				arrayBuffer: async () => new ArrayBuffer(0),
				body: {
					getReader() {
						return {
							async cancel() {},
							async read() {
								return { done: true, value: undefined };
							},
						};
					},
				},
			}),
		});
		await expect(
			provider.complete({
				system: "Teach.",
				messages: [{ role: "user", content: "Hi" }],
				tools: [],
				onText() {},
			}),
		).rejects.toThrow(TUTOR_STREAM_TRUNCATED);
	});
});
