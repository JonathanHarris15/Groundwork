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

/** Shown when the HTTP stream ends before a done event (proxy idle timeout, client disconnect). */
export const TUTOR_STREAM_TRUNCATED = "Stream closed before completion.";

/** SSE comment lines keep Hosting and other proxies from closing an idle tutor stream. */
export const TUTOR_SSE_KEEPALIVE_MS = 15_000;

export function tutorSseKeepaliveLine(): string {
	return ": keepalive\n\n";
}

export function isTruncatedTutorStream(message: string): boolean {
	const raw = message.replace(/\s+/g, " ").trim();
	if (!raw) return false;
	return (
		raw === TUTOR_STREAM_TRUNCATED ||
		/stream closed before completion/i.test(raw) ||
		/tutor stream ended before the reply finished/i.test(raw)
	);
}

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
