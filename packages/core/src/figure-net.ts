import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nodeHttpsClient, type HttpInit, type HttpResponse } from "./http";

/** A raster the margin can hold, or a drawing small enough to save on the account. */
export const PUBLIC_IMAGE_BYTES = 200_000;
export const PUBLIC_TEXT_BYTES = 1_500_000;

const USER_AGENT = "GroundworkTutor/1.0 (educational; +https://groundworklearn.com)";

export interface PublicBody {
	finalUrl: string;
	contentType: string;
	bytes: Uint8Array;
	/** The response `Link` header, when the server sent one. */
	link?: string | null;
}

/**
 * How much readable text one fetch returns. A book chapter's HTML is mostly
 * the table of contents; the chapter itself starts far past a short raw clip.
 * One excerpt has to reach the section the learner asked about.
 */
export const PUBLIC_EXCERPT_CHARS = 48_000;

export interface PublicFetchDeps {
	fetch?: (url: string | URL, init?: HttpInit) => Promise<HttpResponse>;
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
	const fetchImpl = deps.fetch ?? ((url: string | URL, init?: HttpInit) => nodeHttpsClient(String(url), { ...init, maxBytes: (deps.maxBytes ?? PUBLIC_TEXT_BYTES) + 1 }));
	const resolve = deps.lookup ?? defaultLookup;
	let current = assertPublicHttpsUrl(raw);
	const maxBytes = deps.maxBytes ?? PUBLIC_TEXT_BYTES;
	for (let hop = 0; hop < 5; hop++) {
		await assertResolved(current, resolve);
		let response: HttpResponse;
		try {
			response = await fetchImpl(current, {
				method: "GET",
				redirect: "manual",
				signal: deps.signal,
				headers: { accept: "*/*", "user-agent": USER_AGENT },
			});
		} catch (err) {
			if (deps.signal?.aborted) throw err;
			throw new Error(`Could not reach that address. ${err instanceof Error ? err.message : "The request failed."}`);
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
		return { finalUrl: current.toString(), contentType, bytes, link: response.headers.get("link") };
	}
	throw new Error("The address redirected too many times.");
}

/** What the tutor should read back. Image bytes stay out of the prompt. */
export function describePublicBody(body: PublicBody, requestedUrl?: string): string {
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
	const raw = new TextDecoder().decode(body.bytes);
	const fragment = urlFragment(requestedUrl) ?? urlFragment(body.finalUrl);
	const readable = readableFrom(raw, body.contentType, fragment);
	const clipped = clipReadable(readable);
	const pages = hasNextPage(body.link) ? "\n\n[This is one page of a longer list. Do not walk the rest of the pages.]" : "";
	return `Public text from ${host} (${body.contentType || "unknown type"}, ${body.bytes.byteLength} bytes):\n${clipped.text}${clipped.note}${pages}`;
}

function urlFragment(raw: string | undefined): string | null {
	if (!raw) return null;
	try {
		const id = new URL(raw).hash.replace(/^#/, "");
		return id ? decodeURIComponent(id) : null;
	} catch {
		return null;
	}
}

function readableFrom(raw: string, contentType: string, fragment: string | null): string {
	if (!isHtml(contentType, raw)) return raw;
	const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, "");
	const body = dropChrome(stripped);
	const sliced = sliceAtFragment(body, fragment) ?? sliceMain(body) ?? body;
	return htmlToReadable(sliced);
}

/** The table of contents and site chrome sit in front of the chapter and name the GitHub repo. */
function dropChrome(html: string): string {
	return html
		.replace(/<head\b[\s\S]*?<\/head>/gi, "")
		.replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
		.replace(/<header\b[\s\S]*?<\/header>/gi, "")
		.replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
		.replace(/<aside\b[\s\S]*?<\/aside>/gi, "");
}

function isHtml(contentType: string, raw: string): boolean {
	if (/html/i.test(contentType)) return true;
	const head = raw.slice(0, 240).trimStart().toLowerCase();
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function sliceAtFragment(html: string, fragment: string | null): string | null {
	if (!fragment) return null;
	const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`id=["']${escaped}["']`, "i").exec(html);
	return match ? html.slice(tagStart(html, match.index)) : null;
}

function sliceMain(html: string): string | null {
	const patterns = [/class=["'][^"']*\bbook-body\b[^"']*["']/i, /<main\b/i, /role=["']main["']/i, /<article\b/i];
	let at = -1;
	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (match && (at < 0 || match.index < at)) at = match.index;
	}
	return at < 0 ? null : html.slice(tagStart(html, at));
}

function tagStart(html: string, index: number): number {
	const tag = html.lastIndexOf("<", index);
	return tag < 0 ? index : tag;
}

function htmlToReadable(html: string): string {
	const pres: string[] = [];
	let text = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => {
		const code = decodeEntities(block.replace(/<[^>]+>/g, ""));
		pres.push(code.replace(/\n{3,}/g, "\n\n").trim());
		return `\n\n@@PRE${pres.length - 1}@@\n\n`;
	});
	text = text.replace(/<h([1-3])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|section|article|li|tr|blockquote|h[1-6]|figcaption|header|footer|nav|main|aside|pre)>/gi, "\n");
	text = text.replace(/<[^>]+>/g, "");
	text = decodeEntities(text);
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+\n/g, "\n");
	text = text.replace(/[ \t]{2,}/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	text = text.replace(/@@PRE(\d+)@@/g, (_, index: string) => pres[Number(index)] ?? "");
	return text.trim();
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, value: string) => safeCodePoint(Number(value)))
		.replace(/&#x([0-9a-f]+);/gi, (_, value: string) => safeCodePoint(Number.parseInt(value, 16)));
}

function safeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

function clipReadable(text: string): { text: string; note: string } {
	if (text.length <= PUBLIC_EXCERPT_CHARS) return { text, note: "" };
	const omitted = text.length - PUBLIC_EXCERPT_CHARS;
	const later = laterHeadings(text.slice(PUBLIC_EXCERPT_CHARS));
	const sections = later.length ? ` Later sections: ${later.join("; ")}.` : "";
	return {
		text: text.slice(0, PUBLIC_EXCERPT_CHARS),
		note: `\n\n[This excerpt stops here. ${omitted.toLocaleString("en")} more characters from this page were left out. Fetching this URL again will not return the rest.${sections} Answer from this excerpt.]`,
	};
}

function laterHeadings(omitted: string): string[] {
	const found: string[] = [];
	for (const line of omitted.split("\n")) {
		const heading = /^#{1,3}\s+(\S.*)$/.exec(line.trim());
		if (!heading) continue;
		found.push(heading[1].trim());
		if (found.length === 8) break;
	}
	return found;
}

function hasNextPage(link: string | null | undefined): boolean {
	if (!link) return false;
	return /<[^>]+>;\s*rel="?next"?/i.test(link);
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

async function readAtMost(response: HttpResponse, maxBytes: number): Promise<Uint8Array> {
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
