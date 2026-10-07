import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { asUnknown } from "./unknown";

/** A small response shape. `Response` from tests satisfies it, and so does Obsidian's `requestUrl`. */
export interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
	body: { getReader(): HttpReader } | null;
}

export interface HttpReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

export interface HttpInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	/** Stop reading once the body passes this many bytes. */
	maxBytes?: number;
	/** Public-figure fetches pass "manual" so each redirect can be checked. Node https does not follow redirects. */
	redirect?: "manual" | "follow" | "error";
}

export type HttpClient = (url: string, init?: HttpInit) => Promise<HttpResponse>;

let installed: HttpClient | null = null;

/** The Obsidian plugin installs `requestUrl` here. Tests and the CLI use Node's https client. */
export function setHttpClient(next: HttpClient | null): void {
	installed = next;
}

export function httpClient(): HttpClient {
	return installed ?? nodeHttpsClient;
}

/** HTTPS only, and redirects are not followed. Public-figure fetches check each hop themselves. */
export function nodeHttpsClient(url: string, init: HttpInit = {}): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch (err) {
			reject(err instanceof Error ? err : new Error("That is not a web address."));
			return;
		}
		if (target.protocol !== "https:") {
			reject(new Error("Only https requests are supported."));
			return;
		}
		const req = httpsRequest(
			target,
			{ method: init.method ?? "GET", headers: init.headers, signal: init.signal },
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				let total = 0;
				const cap = init.maxBytes;
				res.on("data", (chunk: Buffer) => {
					total += chunk.byteLength;
					if (cap !== undefined && total > cap) {
						res.destroy();
						reject(new Error(`That response is too large. The limit is ${cap} bytes.`));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					const buf = Buffer.concat(chunks);
					const status = res.statusCode ?? 0;
					const headerBag = res.headers;
					resolve({
						ok: status >= 200 && status < 300,
						status,
						statusText: res.statusMessage ?? "",
						headers: {
							get(name: string) {
								const value = headerBag[name.toLowerCase()];
								if (Array.isArray(value)) return value.join(", ");
								return value ?? null;
							},
						},
						text: () => Promise.resolve(buf.toString("utf8")),
						json: () => Promise.resolve(asUnknown(JSON.parse(buf.toString("utf8")))),
						arrayBuffer: () => {
							const copy = new Uint8Array(buf.byteLength);
							copy.set(buf);
							return Promise.resolve(copy.buffer);
						},
						body: null,
					});
				});
				res.on("error", (err) => reject(err instanceof Error ? err : new Error("The request failed.")));
			},
		);
		req.on("error", (err) => reject(err instanceof Error ? err : new Error("The request failed.")));
		if (init.body !== undefined) req.write(init.body);
		req.end();
	});
}
