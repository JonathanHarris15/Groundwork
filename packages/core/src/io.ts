/**
 * Minimal filesystem surface the knowledge store needs. Paths are always
 * vault-relative and use forward slashes. Obsidian's `DataAdapter` already has
 * this shape, and `NodeVaultIO` implements it on top of `node:fs`.
 */
export interface VaultIO {
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	/** Lists direct children of a folder (vault-relative paths). */
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/** In-memory implementation used by tests and the demo provider. */
export class MemoryVaultIO implements VaultIO {
	readonly files = new Map<string, string>();
	readonly binaries = new Map<string, Uint8Array>();

	async read(path: string): Promise<string> {
		const v = this.files.get(path) ?? (this.binaries.has(path) ? new TextDecoder().decode(this.binaries.get(path)) : undefined);
		if (v === undefined) throw new Error(`ENOENT: ${path}`);
		return v;
	}
	async readBinary(path: string): Promise<ArrayBuffer> {
		const b = this.binaries.get(path) ?? (this.files.has(path) ? new TextEncoder().encode(this.files.get(path)) : undefined);
		if (!b) throw new Error(`ENOENT: ${path}`);
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	}
	writeBinary(path: string, data: Uint8Array): void {
		this.binaries.set(path, data);
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}
	async exists(path: string): Promise<boolean> {
		if (this.files.has(path) || this.binaries.has(path)) return true;
		const prefix = path.endsWith("/") ? path : `${path}/`;
		for (const k of this.paths()) if (k.startsWith(prefix)) return true;
		return false;
	}
	async mkdir(): Promise<void> {}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path === "" || path === "/" ? "" : path.endsWith("/") ? path : `${path}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const k of this.paths()) {
			if (!k.startsWith(prefix)) continue;
			const rest = k.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push(k);
			else folders.add(prefix + rest.slice(0, slash));
		}
		return { files, folders: [...folders] };
	}
	private paths(): string[] {
		return [...this.files.keys(), ...this.binaries.keys()];
	}
}

export async function ensureDir(io: VaultIO, path: string): Promise<void> {
	if (!(await io.exists(path))) await io.mkdir(path);
}
