import { inflateSync } from "node:zlib";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import type { ChatMessage, ContentBlock } from "./agent/types";

/** Longest edge sent to the model. A phone or laptop screenshot is scaled down to this. */
export const TUTOR_IMAGE_MAX_EDGE = 1600;
/** Already-small images stay byte-for-byte, so a 125 KB question list is not recompressed. */
export const TUTOR_IMAGE_KEEP_BYTES = 600 * 1024;
const JPEG_QUALITY = 82;

interface Raster {
	width: number;
	height: number;
	rgba: Uint8Array;
}

/**
 * Downscale and recompress a screenshot before it is base64'd into the tutor
 * request. PNG and JPEG are decoded here. Anything else is left as-is.
 * Returns the same byte array when the picture already fits.
 */
export function fitTutorImage(input: Uint8Array | ArrayBuffer, mediaType: string): { bytes: Uint8Array; mediaType: string } {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	let decoded: Raster | null = null;
	try {
		decoded = decodeRaster(bytes, mediaType);
	} catch {
		decoded = null;
	}
	if (!decoded) return { bytes, mediaType };
	const edge = Math.max(decoded.width, decoded.height);
	if (edge <= TUTOR_IMAGE_MAX_EDGE && bytes.byteLength <= TUTOR_IMAGE_KEEP_BYTES) return { bytes, mediaType };
	const scale = Math.min(1, TUTOR_IMAGE_MAX_EDGE / edge);
	const width = Math.max(1, Math.round(decoded.width * scale));
	const height = Math.max(1, Math.round(decoded.height * scale));
	const rgba = width === decoded.width && height === decoded.height ? decoded.rgba : resizeRGBA(decoded.rgba, decoded.width, decoded.height, width, height);
	let encoded: Uint8Array;
	try {
		encoded = encodeJpeg({ data: flattenOnWhite(rgba), width, height }, JPEG_QUALITY).data;
	} catch {
		return { bytes, mediaType };
	}
	if (encoded.byteLength >= bytes.byteLength && edge <= TUTOR_IMAGE_MAX_EDGE) return { bytes, mediaType };
	return { bytes: encoded, mediaType: "image/jpeg" };
}

/** Fit every image block on the wire. Old turns have already been replaced with a path. */
export function fitTutorMessageImages(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		let changed = false;
		const content = message.content.map((block) => {
			const next = fitBlock(block);
			if (next !== block) changed = true;
			return next;
		});
		return changed ? { role: message.role, content } : message;
	});
}

function fitBlock(block: ContentBlock): ContentBlock {
	if (block.type !== "image") return block;
	const source = block.source;
	if (!source || typeof source !== "object") return block;
	const fields = source as { type?: unknown; media_type?: unknown; data?: unknown };
	if (fields.type !== "base64" || typeof fields.media_type !== "string" || typeof fields.data !== "string" || !fields.data) return block;
	const bytes = decodeBase64(fields.data);
	const fitted = fitTutorImage(bytes, fields.media_type);
	if (fitted.bytes === bytes && fitted.mediaType === fields.media_type) return block;
	return { ...block, source: { type: "base64", media_type: fitted.mediaType, data: Buffer.from(fitted.bytes).toString("base64") } };
}

function decodeBase64(data: string): Uint8Array {
	return Uint8Array.from(Buffer.from(data, "base64"));
}

function decodeRaster(bytes: Uint8Array, mediaType: string): Raster | null {
	const type = mediaType.toLowerCase();
	if (type.includes("png") || isPng(bytes)) return decodePng(bytes);
	if (type.includes("jpeg") || type.includes("jpg") || isJpeg(bytes)) return decodeJpegRaster(bytes);
	return null;
}

function isPng(bytes: Uint8Array): boolean {
	return bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
}

function isJpeg(bytes: Uint8Array): boolean {
	return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function decodeJpegRaster(bytes: Uint8Array): Raster | null {
	const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
	if (!raw.width || !raw.height || raw.data.length < raw.width * raw.height * 4) return null;
	return { width: raw.width, height: raw.height, rgba: raw.data };
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function decodePng(bytes: Uint8Array): Raster | null {
	if (bytes.length < 8) return null;
	for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = -1;
	let palette: Uint8Array | null = null;
	let trns: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	let sawIhdr = false;
	while (offset + 8 <= bytes.length) {
		const length = readU32(bytes, offset);
		if (offset + 12 + length > bytes.length) return null;
		const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;
		if (type === "IHDR") {
			if (data.length < 13) return null;
			width = readU32(data, 0);
			height = readU32(data, 4);
			bitDepth = data[8] ?? 0;
			colorType = data[9] ?? -1;
			if ((data[10] ?? 1) !== 0 || (data[11] ?? 1) !== 0 || (data[12] ?? 1) !== 0) return null;
			if (bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType)) return null;
			if (width < 1 || height < 1 || width * height > 24_000_000) return null;
			sawIhdr = true;
		} else if (type === "PLTE") palette = data;
		else if (type === "tRNS") trns = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) return null;
	}
	if (!sawIhdr || !idat.length) return null;
	let inflated: Uint8Array;
	try {
		inflated = inflateSync(concatBytes(idat));
	} catch {
		return null;
	}
	const bpp = colorType === 0 || colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
	const raw = unfilter(inflated, width, height, bpp);
	if (!raw) return null;
	const rgba = toRgba(raw, width, height, colorType, palette, trns);
	if (!rgba) return null;
	return { width, height, rgba };
}

function unfilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
	const stride = width * bpp;
	if (data.length < height * (stride + 1)) return null;
	const out = new Uint8Array(height * stride);
	let i = 0;
	let o = 0;
	for (let y = 0; y < height; y++) {
		const filter = data[i++] ?? 0;
		if (filter > 4) return null;
		for (let x = 0; x < stride; x++) {
			const raw = data[i++] ?? 0;
			const left = x >= bpp ? (out[o - bpp] ?? 0) : 0;
			const up = y > 0 ? (out[o - stride] ?? 0) : 0;
			const upLeft = y > 0 && x >= bpp ? (out[o - stride - bpp] ?? 0) : 0;
			let val = raw;
			if (filter === 1) val = raw + left;
			else if (filter === 2) val = raw + up;
			else if (filter === 3) val = raw + Math.floor((left + up) / 2);
			else if (filter === 4) val = raw + paeth(left, up, upLeft);
			out[o++] = val & 255;
		}
	}
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

function toRgba(raw: Uint8Array, width: number, height: number, colorType: number, palette: Uint8Array | null, trns: Uint8Array | null): Uint8Array | null {
	const n = width * height;
	const rgba = new Uint8Array(n * 4);
	if (colorType === 2) {
		if (raw.length < n * 3) return null;
		for (let i = 0; i < n; i++) {
			rgba[i * 4] = raw[i * 3] ?? 0;
			rgba[i * 4 + 1] = raw[i * 3 + 1] ?? 0;
			rgba[i * 4 + 2] = raw[i * 3 + 2] ?? 0;
			rgba[i * 4 + 3] = 255;
		}
		return rgba;
	}
	if (colorType === 6) {
		if (raw.length < n * 4) return null;
		rgba.set(raw.subarray(0, n * 4));
		return rgba;
	}
	if (colorType === 0) {
		if (raw.length < n) return null;
		for (let i = 0; i < n; i++) {
			const gray = raw[i] ?? 0;
			rgba[i * 4] = gray;
			rgba[i * 4 + 1] = gray;
			rgba[i * 4 + 2] = gray;
			rgba[i * 4 + 3] = 255;
		}
		return rgba;
	}
	if (colorType === 4) {
		if (raw.length < n * 2) return null;
		for (let i = 0; i < n; i++) {
			const gray = raw[i * 2] ?? 0;
			rgba[i * 4] = gray;
			rgba[i * 4 + 1] = gray;
			rgba[i * 4 + 2] = gray;
			rgba[i * 4 + 3] = raw[i * 2 + 1] ?? 255;
		}
		return rgba;
	}
	if (colorType === 3) {
		if (!palette || raw.length < n) return null;
		for (let i = 0; i < n; i++) {
			const idx = raw[i] ?? 0;
			const p = idx * 3;
			if (p + 2 >= palette.length) return null;
			rgba[i * 4] = palette[p] ?? 0;
			rgba[i * 4 + 1] = palette[p + 1] ?? 0;
			rgba[i * 4 + 2] = palette[p + 2] ?? 0;
			rgba[i * 4 + 3] = trns && idx < trns.length ? (trns[idx] ?? 255) : 255;
		}
		return rgba;
	}
	return null;
}

function resizeRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
	const dst = new Uint8Array(dw * dh * 4);
	for (let y = 0; y < dh; y++) {
		const y0 = Math.floor((y * sh) / dh);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
		for (let x = 0; x < dw; x++) {
			const x0 = Math.floor((x * sw) / dw);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * sw + xx) * 4;
					r += src[i] ?? 0;
					g += src[i + 1] ?? 0;
					b += src[i + 2] ?? 0;
					a += src[i + 3] ?? 0;
					n++;
				}
			}
			const o = (y * dw + x) * 4;
			const div = n || 1;
			dst[o] = Math.round(r / div);
			dst[o + 1] = Math.round(g / div);
			dst[o + 2] = Math.round(b / div);
			dst[o + 3] = Math.round(a / div);
		}
	}
	return dst;
}

function flattenOnWhite(rgba: Uint8Array): Uint8Array {
	const out = new Uint8Array(rgba.length);
	for (let i = 0; i < rgba.length; i += 4) {
		const a = (rgba[i + 3] ?? 255) / 255;
		out[i] = Math.round((rgba[i] ?? 0) * a + 255 * (1 - a));
		out[i + 1] = Math.round((rgba[i + 1] ?? 0) * a + 255 * (1 - a));
		out[i + 2] = Math.round((rgba[i + 2] ?? 0) * a + 255 * (1 - a));
		out[i + 3] = 255;
	}
	return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) * 0x1000000 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
