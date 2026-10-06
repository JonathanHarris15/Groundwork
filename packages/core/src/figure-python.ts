import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeSvg } from "./figure-svg";
import { bytesToBase64, sniffBytes } from "./figure-net";

export interface FigureMedia {
	mime: string;
	base64: string;
	width?: number;
	height?: number;
}

export interface PythonRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	files: Map<string, Buffer>;
}

/** Runs one script in an empty directory and returns the figure file it wrote. */
export type PythonSpawn = (source: string, signal?: AbortSignal) => Promise<PythonRun>;

const OUTPUTS = ["figure.svg", "figure.png", "figure.gif", "figure.webp"] as const;
const TIMEOUT_MS = 20_000;

export async function runPythonFigure(source: string, spawnImpl: PythonSpawn = defaultPythonSpawn, signal?: AbortSignal): Promise<{ svg: string; media?: FigureMedia }> {
	const text = source.replace(/^\uFEFF/, "");
	if (!text.trim() || text.length > 40_000) throw new Error("The Python program needs to be under 40,000 characters.");
	if (text.includes("\u0000")) throw new Error("The Python program has a null byte.");
	const run = await spawnImpl(text, signal);
	if (run.timedOut) throw new Error("The Python program ran longer than 20 seconds.");
	const produced = OUTPUTS.map((name) => run.files.get(name)).find((buf) => buf && buf.byteLength);
	if (!produced) {
		const stdout = run.stdout.trim();
		if (stdout.includes("<svg")) return { svg: sanitizeSvg(stdout) };
		const detail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
		if (/ENOENT|python3: not found|No such file/i.test(detail)) {
			throw new Error("Python is not installed on this computer. Draw an SVG, or use a public image.");
		}
		throw new Error(detail ? `Python did not write figure.svg, figure.png, figure.gif, or figure.webp. ${detail}` : "Python did not write figure.svg, figure.png, figure.gif, or figure.webp.");
	}
	return mediaFrom(produced);
}

export function mediaFrom(bytes: Buffer | Uint8Array): { svg: string; media?: FigureMedia } {
	const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const sniffed = sniffBytes(raw);
	if (sniffed.kind === "svg") {
		return { svg: sanitizeSvg(new TextDecoder().decode(raw)) };
	}
	if (sniffed.kind !== "raster") throw new Error("The program wrote a file that is not an image.");
	if (raw.byteLength > 200_000) throw new Error("The program's image is too large to save. Write a smaller figure.");
	return {
		svg: "",
		media: { mime: sniffed.mime, base64: bytesToBase64(raw), width: sniffed.width, height: sniffed.height },
	};
}

async function defaultPythonSpawn(source: string, signal?: AbortSignal): Promise<PythonRun> {
	const cwd = await mkdtemp(path.join(tmpdir(), "gw-figure-"));
	const files = new Map<string, Buffer>();
	try {
		await writeFile(path.join(cwd, "figure.py"), source, "utf8");
		const bin = process.env.GROUNDWORK_PYTHON?.trim() || "python3";
		const run = await execPython(bin, cwd, signal);
		for (const name of OUTPUTS) {
			try {
				files.set(name, await readFile(path.join(cwd, name)));
			} catch {
				/* the script may have written a different one */
			}
		}
		return { ...run, files };
	} catch (err) {
		const message = (err as NodeJS.ErrnoException).code === "ENOENT" ? "python3: not found" : (err as Error).message;
		return { code: null, stdout: "", stderr: message, timedOut: false, files };
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function execPython(bin: string, cwd: string, signal?: AbortSignal): Promise<Omit<PythonRun, "files">> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(bin, ["-I", "figure.py"], {
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				LANG: process.env.LANG || "C.UTF-8",
				HOME: cwd,
				TMPDIR: cwd,
				MPLCONFIGDIR: cwd,
				PYTHONUNBUFFERED: "1",
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONNOUSERSITE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);
		const stop = () => {
			timedOut = true;
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", stop, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < 8_000) stdout += chunk.slice(0, 8_000 - stdout.length);
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 8_000) stderr += chunk.slice(0, 8_000 - stderr.length);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve({ code: null, stdout, stderr: err.message, timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}
