/**
 * The tutor stream the plugin reads. Text arrives as the model writes it.
 * The last event is the finished message, including any tool call.
 */

import type { ContentBlock } from "./types";
import type { ProviderResponse } from "./types";

export type TutorWireEvent =
	| { type: "text"; text: string }
	| { type: "done"; content: ContentBlock[]; stopReason: string; usage?: ProviderResponse["usage"] }
	| { type: "error"; error: string; code?: string; status?: number };

export function tutorEventLine(event: TutorWireEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export function pushTutorSse(buffer: string, chunk: string): { buffer: string; events: TutorWireEvent[] } {
	const combined = buffer + chunk;
	const parts = combined.split("\n\n");
	const rest = parts.pop() ?? "";
	const events: TutorWireEvent[] = [];
	for (const part of parts) {
		const data = part
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as TutorWireEvent;
			if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
		} catch {
			// A partial line is kept in the buffer. A bad event is skipped.
		}
	}
	return { buffer: rest, events };
}
