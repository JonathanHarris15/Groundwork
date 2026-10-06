/**
 * Rebuild responsive WebP and AVIF srcsets from the swappable captures.
 * Replace a png, then run: node packages/server/scripts/hero-image.mjs
 *
 * Home and /concept-map share public/hero/concept-map.png.
 * Feature pages use public/shots/{quiz,flashcards,exam-chat,exam-map,goals}.png.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
export const heroWidths = [480, 768, 1200];
export const shotNames = ["quiz", "flashcards", "exam-chat", "exam-map", "goals"];

async function writeSet(dir, name) {
	const src = path.join(dir, `${name}.png`);
	if (!existsSync(src)) throw new Error(`Missing swappable image: ${src}`);
	const outs = heroWidths.flatMap((width) => [path.join(dir, `${name}-${width}.webp`), path.join(dir, `${name}-${width}.avif`)]);
	const srcTime = statSync(src).mtimeMs;
	if (outs.every((file) => existsSync(file) && statSync(file).mtimeMs >= srcTime)) return;
	const { default: sharp } = await import("sharp");
	mkdirSync(dir, { recursive: true });
	const meta = await sharp(src).metadata();
	for (const width of heroWidths) {
		const resized = () => sharp(src).resize({ width, withoutEnlargement: true });
		await resized().webp({ quality: 76, effort: 5, smartSubsample: false }).toFile(path.join(dir, `${name}-${width}.webp`));
		await resized().avif({ quality: 48, effort: 5, chromaSubsampling: "4:4:4" }).toFile(path.join(dir, `${name}-${width}.avif`));
	}
	console.log(`${name} ${meta.width}x${meta.height} -> ${heroWidths.join(", ")} webp+avif`);
}

export async function writeHeroImages() {
	const dir = path.join(publicDir, "hero");
	await writeSet(dir, "concept-map");
	if (existsSync(path.join(dir, "concept-map-phone.png"))) await writeSet(dir, "concept-map-phone");
}

export async function writeShotImages() {
	const dir = path.join(publicDir, "shots");
	for (const name of shotNames) await writeSet(dir, name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await writeHeroImages();
	await writeShotImages();
}
