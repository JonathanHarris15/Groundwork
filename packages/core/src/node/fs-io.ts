import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { VaultIO } from "../io";

export class NodeVaultIO implements VaultIO {
	constructor(readonly root: string) {}

	private abs(p: string): string {
		const resolved = path.resolve(this.root, p);
		if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
			throw new Error(`Path escapes the vault: ${p}`);
		}
		return resolved;
	}

	async read(p: string): Promise<string> {
		return fs.readFile(this.abs(p), "utf8");
	}
	async readBinary(p: string): Promise<ArrayBuffer> {
		const b = await fs.readFile(this.abs(p));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	}
	async write(p: string, data: string): Promise<void> {
		await fs.mkdir(path.dirname(this.abs(p)), { recursive: true });
		await fs.writeFile(this.abs(p), data, "utf8");
	}
	async append(p: string, data: string): Promise<void> {
		await fs.mkdir(path.dirname(this.abs(p)), { recursive: true });
		await fs.appendFile(this.abs(p), data, "utf8");
	}
	async exists(p: string): Promise<boolean> {
		try {
			await fs.access(this.abs(p));
			return true;
		} catch {
			return false;
		}
	}
	async mkdir(p: string): Promise<void> {
		await fs.mkdir(this.abs(p), { recursive: true });
	}
	async remove(p: string): Promise<void> {
		try {
			await fs.unlink(this.abs(p));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	async list(p: string): Promise<{ files: string[]; folders: string[] }> {
		const entries = await fs.readdir(this.abs(p), { withFileTypes: true });
		const rel = (name: string) => (p ? `${p.replace(/\/$/, "")}/${name}` : name);
		return {
			files: entries.filter((e) => e.isFile()).map((e) => rel(e.name)),
			folders: entries.filter((e) => e.isDirectory()).map((e) => rel(e.name)),
		};
	}
}
