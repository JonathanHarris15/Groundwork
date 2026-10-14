import { describe, expect, it } from "vitest";
import { AnthropicEventParser, parseToolInput } from "../src/account/anthropic-stream";

function frame(event: unknown): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

describe("Anthropic event stream", () => {
	it("emits the first text delta before the rest of the message arrives", () => {
		const parser = new AnthropicEventParser();
		const early = parser.push(
			frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
				frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
		);
		expect(early).toEqual([{ type: "text", text: "Hi" }]);
		const rest = parser.push(
			frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } }) +
				frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
				frame({ type: "message_stop" }),
		);
		expect(rest[0]).toEqual({ type: "text", text: " there" });
		expect(rest.at(-1)).toMatchObject({ type: "done", result: { stopReason: "end_turn", usage: { output: 3 } } });
	});

	it("assembles a tool call from input_json_delta and keeps thinking out of the text", () => {
		const parser = new AnthropicEventParser();
		const pieces = parser.push(
			[
				frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
				frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the definition." } }),
				frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
				frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "quiz" } }),
				frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"question\":" } }),
				frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"What is a limit?\"}" } }),
				frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }),
				frame({ type: "message_stop" }),
			].join(""),
		);
		expect(pieces.filter((piece) => piece.type === "text")).toEqual([]);
		const done = pieces.find((piece) => piece.type === "done");
		expect(done).toMatchObject({
			type: "done",
			result: {
				stopReason: "tool_use",
				content: [
					{ type: "thinking", thinking: "Check the definition.", signature: "sig" },
					{ type: "tool_use", id: "toolu_1", name: "quiz", input: { question: "What is a limit?" } },
				],
			},
		});
	});

	it("parses a string tool input when the stream sent no json delta", () => {
		expect(parseToolInput("", "{\"a\":1}")).toEqual({ a: 1 });
		expect(parseToolInput("{\"b\":2}", { a: 1 })).toEqual({ b: 2 });
		expect(parseToolInput("", { a: 1 })).toEqual({ a: 1 });
	});
});
