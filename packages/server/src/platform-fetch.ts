import { nodeHttpsClient } from "@groundwork/core";

/** Node HTTPS in the shape of `fetch`. The name `fetch` is reserved for Obsidian's `requestUrl`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function platformFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	const body = typeof init?.body === "string" ? init.body : undefined;
	const res = await nodeHttpsClient(url, { method: init?.method, headers, body, signal: init?.signal ?? undefined });
	const text = await res.text();
	return new Response(text, { status: res.status, statusText: res.statusText });
}
