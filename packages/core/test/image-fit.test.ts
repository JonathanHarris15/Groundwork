import { crc32, deflateSync } from "node:zlib";
import { decode as decodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { TUTOR_IMAGE_MAX_EDGE, fitTutorImage } from "../src/image-fit";
import { loadVaultFile } from "../src/files";
import { MemoryVaultIO } from "../src/io";

const TINY = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([head, body, sum]);
}

function rgbPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const row = y * (1 + width * 3);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y);
			const i = row + 1 + x * 3;
			raw[i] = r;
			raw[i + 1] = g;
			raw[i + 2] = b;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("tutor image fit", () => {
	it("leaves a small screenshot byte-for-byte", () => {
		const fitted = fitTutorImage(TINY, "image/png");
		expect(fitted.mediaType).toBe("image/png");
		expect(Buffer.from(fitted.bytes)).toEqual(Buffer.from(TINY));
	});

	it("scales a wide PNG down to 1600px JPEG", () => {
		const png = rgbPng(2000, 40, (x, y) => [(x * 13 + y * 7) & 255, (x * 3 + y) & 255, (x + y * 11) & 255]);
		const fitted = fitTutorImage(png, "image/png");
		expect(fitted.mediaType).toBe("image/jpeg");
		const jpeg = decodeJpeg(fitted.bytes, { useTArray: true, formatAsRGBA: true });
		expect(jpeg.width).toBe(TUTOR_IMAGE_MAX_EDGE);
		expect(jpeg.height).toBe(32);
	});

	it("downscales before the per-image byte limit, and still refuses a non-image that is over it", async () => {
		const io = new MemoryVaultIO();
		const wide = rgbPng(1800, 20, (x, y) => [(x * 13 + y) & 255, 30, 90]);
		io.writeBinary("resources/board.png", wide);
		const loaded = await loadVaultFile(io, "resources/board.png");
		expect(loaded.mediaType).toBe("image/jpeg");
		expect(loaded.tooLarge).toBeUndefined();
		expect(loaded.data).toBeTruthy();
		const decoded = decodeJpeg(Buffer.from(loaded.data ?? "", "base64"), { useTArray: true, formatAsRGBA: true });
		expect(decoded.width).toBeLessThanOrEqual(TUTOR_IMAGE_MAX_EDGE);

		io.writeBinary("big.png", new Uint8Array(5 * 1024 * 1024 + 1));
		expect(await loadVaultFile(io, "big.png")).toMatchObject({ tooLarge: true, skipped: expect.stringMatching(/over the 5\.0 MB limit/) });
	});
});
