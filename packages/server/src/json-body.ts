import { type IncomingMessage } from "node:http";
import { JSON_BODY_LIMIT_BYTES, uploadTooLargeError } from "@groundwork/core";

export { JSON_BODY_LIMIT_BYTES, uploadTooLargeError };

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(asBuffer(chunk));
	return Buffer.concat(chunks);
}

function asBuffer(chunk: unknown): Buffer {
	if (typeof chunk === "string") return Buffer.from(chunk);
	if (Buffer.isBuffer(chunk)) return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk);
	throw new Error("Unexpected request chunk.");
}

export function jsonBodyError(byteLength: number): { status: number; error: string } | null {
	if (byteLength > JSON_BODY_LIMIT_BYTES) return { status: 413, error: uploadTooLargeError() };
	return null;
}
