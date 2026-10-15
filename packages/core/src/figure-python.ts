import { sanitizeSvg } from "./figure-svg";
import { bytesToBase64, sniffBytes } from "./figure-net";
import { asUnknown } from "./unknown";

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
	files: Map<string, Uint8Array>;
}

/** Runs one script and returns the figure file it wrote. */
export type PythonSpawn = (source: string, signal?: AbortSignal) => Promise<PythonRun>;

const OUTPUTS = ["figure.svg", "figure.png", "figure.gif", "figure.webp"] as const;
const RUN_MS = 20_000;
const LOAD_MS = 90_000;
/** Shown on the figure card when the runtime cannot start. */
export const FIGURE_DRAW_RETRY = "The figure didn't draw. Try again.";
/** Pyodide build pinned for the plugin worker and the Node tests. */
export const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";

const LOADER_FAILURE = /node:url|dynamically imported module/i;
const SANDBOX_PROBE = /pypdf|PyPDF2|pdfminer|pdfplumber|pymupdf|pikepdf|pyodide|No module named|\blistdir\b|\/home\//i;

/** Card and tool copy when a figure fails. Loader errors and sandbox probes stay off the screen. */
export function figureFailureMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message.trim() : typeof err === "string" ? err.trim() : "";
	if (!raw || LOADER_FAILURE.test(raw)) return FIGURE_DRAW_RETRY;
	if (SANDBOX_PROBE.test(raw)) return "The figure sandbox cannot read vault files. Use read_vault_file.";
	if (/read_vault_file/i.test(raw)) return raw;
	if (/\btry again\b/i.test(raw)) return raw;
	return `${raw} Try again.`;
}

const PREPARE = `
import os
os.environ.clear()
os.makedirs("/tmp", exist_ok=True)
os.environ["HOME"] = "/tmp"
os.environ["MPLCONFIGDIR"] = "/tmp"
for _name in ("figure.svg", "figure.png", "figure.gif", "figure.webp"):
    try:
        os.remove(_name)
    except FileNotFoundError:
        pass
`;

const COLLECT = `
import importlib
_os = importlib.import_module("os")
_b64 = importlib.import_module("base64")
_json = importlib.import_module("json")
_found = {}
for _name in ("figure.svg", "figure.png", "figure.gif", "figure.webp"):
    if _os.path.isfile(_name):
        _fd = _os.open(_name, _os.O_RDONLY)
        _parts = []
        while True:
            _chunk = _os.read(_fd, 65536)
            if not _chunk:
                break
            _parts.append(_chunk)
        _os.close(_fd)
        _found[_name] = _b64.b64encode(b"".join(_parts)).decode("ascii")
_found_json = _json.dumps(_found)
_found_json
`;

interface PyodideLike {
	runPython(code: string): unknown;
	setStdout(options: { batched: (output: string) => void }): void;
	setStderr(options: { batched: (output: string) => void }): void;
	loadPackagesFromImports(code: string): Promise<unknown>;
}

/**
 * The worker source. Pyodide runs in the tutor window, so the program stays on
 * the learner's computer. Groundwork does not send it to a server. The runtime
 * is fetched from a pinned build the first time a figure needs Python.
 */
export const PYTHON_WORKER_SOURCE = `
// Obsidian's renderer is Electron. Pyodide treats process.versions.node as Node
// and then loads node:url through a dynamic import, which the renderer fetches as a URL and cannot load.
function useBrowserRuntime() {
  var proc = typeof process === "object" && process ? process : null;
  if (!proc || !proc.versions || typeof proc.versions.node !== "string") return;
  try { proc.browser = true; } catch (err) {}
  try { proc.type = "renderer"; } catch (err) {}
  try { Object.defineProperty(proc, "browser", { configurable: true, value: true }); } catch (err) {}
  try { Object.defineProperty(proc, "type", { configurable: true, value: "renderer" }); } catch (err) {}
  if (proc.browser === true && proc.type === "renderer") return;
  if (proc.versions && typeof proc.versions.node === "string") {
    try { delete proc.versions.node; } catch (err) {}
    try { Object.defineProperty(proc.versions, "node", { configurable: true, value: undefined }); } catch (err) {}
  }
  if (proc.browser === true && proc.type === "renderer") return;
  if (!(proc.versions && typeof proc.versions.node === "string")) return;
  try {
    Object.defineProperty(globalThis, "process", {
      configurable: true,
      writable: true,
      value: { browser: true, type: "renderer", env: {}, versions: {} },
    });
  } catch (err) {}
}
useBrowserRuntime();
let py = null;
function clip(current, chunk) {
  const text = String(chunk);
  if (current.length >= 8000) return current;
  return current + text.slice(0, 8000 - current.length);
}
self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "load") {
      useBrowserRuntime();
      importScripts(String(msg.indexURL || "") + "pyodide.js");
      py = await loadPyodide({ indexURL: msg.indexURL });
      self.postMessage({ type: "ready" });
      return;
    }
    if (!py || msg.type !== "run") return;
    let stdout = "";
    let stderr = "";
    py.setStdout({ batched: (chunk) => { stdout = clip(stdout, chunk); } });
    py.setStderr({ batched: (chunk) => { stderr = clip(stderr, chunk); } });
    py.runPython(${JSON.stringify(PREPARE)});
    try { await py.loadPackagesFromImports(String(msg.source || "")); }
    catch (loadErr) { stderr = clip(stderr, (loadErr && loadErr.message) || loadErr); }
    self.postMessage({ type: "exec" });
    let code = 0;
    try { py.runPython(String(msg.source || "")); }
    catch (runErr) {
      code = 1;
      stderr = clip(stderr, (runErr && runErr.message) || runErr);
    }
    let files = {};
    try { files = JSON.parse(String(py.runPython(${JSON.stringify(COLLECT)}) || "{}")); }
    catch (readErr) { stderr = clip(stderr, (readErr && readErr.message) || readErr); }
    self.postMessage({ type: "done", code: code, stdout: stdout, stderr: stderr, files: files });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
`;

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
		throw new Error(detail ? `Python did not write figure.svg, figure.png, figure.gif, or figure.webp. ${detail}` : "Python did not write figure.svg, figure.png, figure.gif, or figure.webp.");
	}
	return mediaFrom(produced);
}

export function mediaFrom(bytes: Uint8Array): { svg: string; media?: FigureMedia } {
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

/** Shared by the Node runtime. The worker carries the same prepare and collect steps. */
export async function runOnPyodide(py: PyodideLike, source: string): Promise<PythonRun> {
	let stdout = "";
	let stderr = "";
	const take = (current: string, chunk: string) => (current.length >= 8_000 ? current : current + chunk.slice(0, 8_000 - current.length));
	py.setStdout({ batched: (chunk) => {
		stdout = take(stdout, chunk);
	} });
	py.setStderr({ batched: (chunk) => {
		stderr = take(stderr, chunk);
	} });
	py.runPython(PREPARE);
	try {
		await py.loadPackagesFromImports(source);
	} catch (err) {
		stderr = take(stderr, err instanceof Error ? err.message : String(err));
	}
	let code = 0;
	try {
		py.runPython(source);
	} catch (err) {
		code = 1;
		stderr = take(stderr, err instanceof Error ? err.message : String(err));
	}
	const files = new Map<string, Uint8Array>();
	try {
		const raw = py.runPython(COLLECT);
		const rawText = typeof raw === "string" && raw ? raw : "{}";
		const parsedRaw = asUnknown(JSON.parse(rawText));
		const parsed = parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw) ? parsedRaw as Record<string, unknown> : {};
		for (const name of OUTPUTS) {
			const encoded = parsed[name];
			if (typeof encoded !== "string" || !encoded) continue;
			const bytes = decode64(encoded);
			if (bytes.byteLength) files.set(name, bytes);
		}
	} catch (err) {
		stderr = take(stderr, err instanceof Error ? err.message : String(err));
	}
	return { code, stdout, stderr, timedOut: false, files };
}

async function defaultPythonSpawn(source: string, signal?: AbortSignal): Promise<PythonRun> {
	if (signal?.aborted) return { code: null, stdout: "", stderr: "", timedOut: true, files: new Map() };
	if (typeof Worker === "function" && typeof document !== "undefined") return browserSpawn(source, signal);
	throw new Error("Python figures run in the Obsidian window.");
}

let workerTail: Promise<void> = Promise.resolve();
let workerBox: { worker: Worker } | null = null;

function browserSpawn(source: string, signal?: AbortSignal): Promise<PythonRun> {
	const run = workerTail.then(() => runInBrowserWorker(source, signal));
	workerTail = run.then(() => undefined, () => undefined);
	return run;
}

async function runInBrowserWorker(source: string, signal?: AbortSignal): Promise<PythonRun> {
	const worker = await browserWorker();
	return new Promise((resolve, reject) => {
		let execTimer = 0;
		let settled = false;
		const finish = (run: PythonRun) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(overall);
			window.clearTimeout(execTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve(run);
		};
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(overall);
			window.clearTimeout(execTimer);
			signal?.removeEventListener("abort", onAbort);
			dropWorker();
			reject(err instanceof Error ? err : new Error(FIGURE_DRAW_RETRY));
		};
		const stop = () => {
			dropWorker();
			finish({ code: null, stdout: "", stderr: "", timedOut: true, files: new Map() });
		};
		const overall = window.setTimeout(stop, LOAD_MS);
		const onAbort = () => stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; message?: string; code?: number | null; stdout?: string; stderr?: string; files?: Record<string, string> };
			if (data?.type === "exec") {
				window.clearTimeout(execTimer);
				execTimer = window.setTimeout(stop, RUN_MS);
				return;
			}
			if (data?.type === "error") {
				fail(new Error(figureFailureMessage(data.message || FIGURE_DRAW_RETRY)));
				return;
			}
			if (data?.type !== "done") return;
			const files = new Map<string, Uint8Array>();
			for (const name of OUTPUTS) {
				const encoded = data.files?.[name];
				if (!encoded) continue;
				const bytes = decode64(encoded);
				if (bytes.byteLength) files.set(name, bytes);
			}
			finish({
				code: data.code ?? null,
				stdout: data.stdout ?? "",
				stderr: data.stderr ?? "",
				timedOut: false,
				files,
			});
		};
		worker.onerror = () => fail(new Error(FIGURE_DRAW_RETRY));
		worker.postMessage({ type: "run", source });
	});
}

function browserWorker(): Promise<Worker> {
	if (workerBox) return Promise.resolve(workerBox.worker);
	const blob = new Blob([PYTHON_WORKER_SOURCE], { type: "text/javascript" });
	const url = URL.createObjectURL(blob);
	const worker = new Worker(url);
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			worker.terminate();
			URL.revokeObjectURL(url);
			reject(new Error(FIGURE_DRAW_RETRY));
		}, LOAD_MS);
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; message?: string };
			if (data?.type === "ready") {
				window.clearTimeout(timer);
				URL.revokeObjectURL(url);
				workerBox = { worker };
				resolve(worker);
				return;
			}
			if (data?.type === "error") {
				window.clearTimeout(timer);
				worker.terminate();
				URL.revokeObjectURL(url);
				reject(new Error(figureFailureMessage(data.message || FIGURE_DRAW_RETRY)));
			}
		};
		worker.onerror = () => {
			window.clearTimeout(timer);
			URL.revokeObjectURL(url);
			reject(new Error(FIGURE_DRAW_RETRY));
		};
		worker.postMessage({ type: "load", indexURL: PYODIDE_INDEX });
	});
}

function dropWorker(): void {
	workerBox?.worker.terminate();
	workerBox = null;
}

function decode64(encoded: string): Uint8Array {
	const bin = atob(encoded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}
