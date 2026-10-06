import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** A raster the margin can hold, or a drawing small enough to save on the account. */
export const PUBLIC_IMAGE_BYTES = 200_000;
export const PUBLIC_TEXT_BYTES = 1_500_000;

const USER_AGENT = "GroundworkTutor/1.0 (educational; +https://groundworklearn.com)";

export interface PublicBody {
	finalUrl: string;
	contentType: string;
	bytes: Uint8Array;
}

export interface PublicFetchDeps {
	fetch?: typeof fetch;
	lookup?: (hostname: string) => Promise<string[]>;
	signal?: AbortSignal;
	/** Stop reading once the body passes this many bytes. */
	maxBytes?: number;
}

/**
 * An https URL the tutor may read. Private, local, and link-local addresses
 * are refused, including a public name that resolves to one.
 */
export function assertPublicHttpsUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("That is not a web address.");
	}
	if (url.protocol !== "https:") throw new Error("Only a public https address can be fetched.");
	if (url.username || url.password) throw new Error("That address includes a password. Use a public URL.");
	if (url.port && url.port !== "443") throw new Error("Only the standard https port can be fetched.");
	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	if (!host) throw new Error("That address has no host.");
	if (isBlockedHost(host)) throw new Error("That address is not public.");
	if (isIP(host) && isPrivateAddress(host)) throw new Error("That address is not public.");
	return url;
}

export async function fetchPublic(raw: string, deps: PublicFetchDeps = {}): Promise<PublicBody> {
	const fetchImpl = deps.fetch ?? fetch;
	const resolve = deps.lookup ?? defaultLookup;
	let current = assertPublicHttpsUrl(raw);
	const maxBytes = deps.maxBytes ?? PUBLIC_TEXT_BYTES;
	for (let hop = 0; hop < 5; hop++) {
		await assertResolved(current, resolve);
		let response: Response;
		try {
			response = await fetchImpl(current, {
				method: "GET",
				redirect: "manual",
				signal: deps.signal,
				headers: { accept: "*/*", "user-agent": USER_AGENT },
			});
		} catch (err) {
			if (deps.signal?.aborted) throw err;
			throw new Error(`Could not reach that address. ${(err as Error).message}`);
		}
		if (response.status >= 300 && response.status < 400) {
			const loc = response.headers.get("location");
			if (!loc) throw new Error("The address redirected nowhere.");
			current = assertPublicHttpsUrl(new URL(loc, current).toString());
			continue;
		}
		if (!response.ok) throw new Error(`The address returned ${response.status}.`);
		const contentType = response.headers.get("content-type") ?? "";
		const advertised = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(advertised) && advertised > maxBytes) {
			throw new Error(`That response is ${advertised} bytes. The margin can hold ${maxBytes} bytes. Use a smaller file or a thumbnail.`);
		}
		const bytes = await readAtMost(response, maxBytes);
		return { finalUrl: current.toString(), contentType, bytes };
	}
	throw new Error("The address redirected too many times.");
}

/** What the tutor should read back. Image bytes stay out of the prompt. */
export function describePublicBody(body: PublicBody): string {
	const host = new URL(body.finalUrl).host;
	const sniffed = sniffBytes(body.bytes);
	if (sniffed.kind === "raster" || /^image\//i.test(body.contentType.split(";")[0] ?? "")) {
		const mime = sniffed.kind === "raster" ? sniffed.mime : body.contentType.split(";")[0].trim();
		if (body.bytes.byteLength > PUBLIC_IMAGE_BYTES && sniffed.kind === "raster") {
			return `Public image from ${host} is ${body.bytes.byteLength} bytes (${mime}), too large for the margin. Fetch a thumbnail under ${PUBLIC_IMAGE_BYTES} bytes, then pass that URL to show_figure as kind "image".`;
		}
		return `Public image from ${host}: ${body.bytes.byteLength} bytes, ${mime}. Pass this exact URL to show_figure as kind "image": ${body.finalUrl}`;
	}
	if (sniffed.kind === "svg") {
		return `Public SVG from ${host} (${body.bytes.byteLength} bytes). Pass this exact URL to show_figure as kind "image": ${body.finalUrl}`;
	}
	const text = new TextDecoder().decode(body.bytes);
	const clip = 12_000;
	const excerpt = text.length > clip ? `${text.slice(0, clip)}\n…[truncated]` : text;
	return `Public text from ${host} (${body.contentType || "unknown type"}, ${body.bytes.byteLength} bytes):\n${excerpt}`;
}

export function sniffBytes(bytes: Uint8Array): { kind: "raster"; mime: string; width?: number; height?: number } | { kind: "svg" } | { kind: "other" } {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		const width = bytes.length >= 24 ? readU32(bytes, 16) : undefined;
		const height = bytes.length >= 24 ? readU32(bytes, 20) : undefined;
		return { kind: "raster", mime: "image/png", width, height };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		const size = jpegSize(bytes);
		return { kind: "raster", mime: "image/jpeg", ...size };
	}
	if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return { kind: "raster", mime: "image/gif", width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
	}
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return { kind: "raster", mime: "image/webp", ...webpSize(bytes) };
	}
	const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 240))).trimStart();
	if (head.startsWith("<svg") || head.startsWith("<?xml")) return { kind: "svg" };
	return { kind: "other" };
}

export function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function isBlockedHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "metadata.google.internal" || host.endsWith(".internal")) return true;
	if (/^\d+$/.test(host)) return true;
	return false;
}

export function isPrivateAddress(ip: string): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return isPrivateAddress(mapped[1]);
	if (ip.includes(":")) {
		const head = Number.parseInt(ip.split(":")[0] || "0", 16);
		if (!Number.isFinite(head)) return true;
		if (ip === "::" || ip === "::1") return true;
		if (head >= 0xfe80 && head <= 0xfebf) return true;
		if (head >= 0xfc00 && head <= 0xfdff) return true;
		return false;
	}
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 255 && b === 255) return true;
	return false;
}

async function assertResolved(url: URL, resolve: (hostname: string) => Promise<string[]>): Promise<void> {
	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	if (isIP(host)) return;
	let addresses: string[];
	try {
		addresses = await resolve(host);
	} catch {
		throw new Error(`Could not look up ${host}.`);
	}
	if (!addresses.length) throw new Error(`Could not look up ${host}.`);
	if (addresses.some((ip) => isPrivateAddress(ip))) throw new Error("That address is not public.");
}

async function defaultLookup(hostname: string): Promise<string[]> {
	const records = await lookup(hostname, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

async function readAtMost(response: Response, maxBytes: number): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buf = new Uint8Array(await response.arrayBuffer());
		if (buf.byteLength > maxBytes) throw new Error(`That response is too large. The limit is ${maxBytes} bytes.`);
		return buf;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`That response is too large. The limit is ${maxBytes} bytes.`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function jpegSize(bytes: Uint8Array): { width?: number; height?: number } {
	let i = 2;
	while (i + 8 < bytes.length) {
		if (bytes[i] !== 0xff) break;
		const marker = bytes[i + 1];
		const size = (bytes[i + 2] << 8) | bytes[i + 3];
		if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
			return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
		}
		if (size < 2) break;
		i += 2 + size;
	}
	return {};
}

function webpSize(bytes: Uint8Array): { width?: number; height?: number } {
	if (bytes.length < 30) return {};
	const four = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (four === "VP8X") {
		return {
			width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
			height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
		};
	}
	return {};
}
