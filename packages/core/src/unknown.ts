/** Turns `JSON.parse` and other `any` results into `unknown` without an unsafe assignment. */
export function asUnknown(value: unknown): unknown {
	return value;
}

export function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** A JSON object, or null. `JSON.parse` is `any`; this is the boundary. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	const parsed = asUnknown(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}
