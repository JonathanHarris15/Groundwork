/**
 * Minimal filesystem surface the knowledge store needs. Paths are always
 * vault-relative and use forward slashes. Obsidian's `DataAdapter` already has
 * this shape, and `NodeVaultIO` implements it on top of `node:fs`.
 */
export interface VaultIO {
	read(path: string): Promise<string>;
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

	async read(path: string): Promise<string> {
		const v = this.files.get(path);
		if (v === undefined) throw new Error(`ENOENT: ${path}`);
		return v;
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}
	async exists(path: string): Promise<boolean> {
		if (this.files.has(path)) return true;
		const prefix = path.endsWith("/") ? path : `${path}/`;
		for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
		return false;
	}
	async mkdir(): Promise<void> {}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path === "" || path === "/" ? "" : path.endsWith("/") ? path : `${path}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const k of this.files.keys()) {
			if (!k.startsWith(prefix)) continue;
			const rest = k.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push(k);
			else folders.add(prefix + rest.slice(0, slash));
		}
		return { files, folders: [...folders] };
	}
}

export async function ensureDir(io: VaultIO, path: string): Promise<void> {
	if (!(await io.exists(path))) await io.mkdir(path);
}
