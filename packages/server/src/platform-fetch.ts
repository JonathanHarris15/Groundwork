import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

/** Node HTTPS in the shape of `fetch`. The name `fetch` is reserved for Obsidian's `requestUrl`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function platformFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new Error("That is not a web address.");
	}
	if (target.protocol !== "https:") throw new Error("Only https requests are supported.");
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	const body = typeof init?.body === "string" ? init.body : undefined;
	return new Promise((resolve, reject) => {
		const req = httpsRequest(target, { method: init?.method ?? "GET", headers, signal: init?.signal ?? undefined }, (res) => {
			resolve(responseFromNodeStream(res));
		});
		req.on("error", (err) => reject(err instanceof Error ? err : new Error("The request failed.")));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** Headers arrive before the body, so a tutor stream can emit the first token while the model is still writing. */
export function responseFromNodeStream(res: IncomingMessage): Response {
	const headers = new Headers();
	for (const [key, value] of Object.entries(res.headers)) {
		if (value === undefined) continue;
		headers.set(key, Array.isArray(value) ? value.join(", ") : value);
	}
	const status = res.statusCode ?? 0;
	return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
		status,
		statusText: res.statusMessage ?? "",
		headers,
	});
}
