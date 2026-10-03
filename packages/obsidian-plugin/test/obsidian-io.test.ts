import { describe, expect, it } from "vitest";
import { ObsidianVaultIO } from "../src/obsidian-io";

class MockAdapter {
	private readonly dirs = new Set<string>();
	private readonly files = new Map<string, string>();

	async read(path: string): Promise<string> {
		const v = this.files.get(path);
		if (v === undefined) throw new Error(`ENOENT ${path}`);
		return v;
	}
	async readBinary(): Promise<ArrayBuffer> {
		throw new Error("not used");
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}
	async exists(path: string): Promise<boolean> {
		return this.dirs.has(path) || this.files.has(path);
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path ? `${path}/` : "";
		const files: string[] = [];
		const folders = new Set<string>();
		for (const key of [...this.files.keys(), ...this.dirs.keys()]) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push(key);
			else folders.add(prefix + rest.slice(0, slash));
		}
		return { files, folders: [...folders] };
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.dirs.delete(path);
	}
}

describe("ObsidianVaultIO", () => {
	it("creates nested parent folders before writing", async () => {
		const adapter = new MockAdapter();
		const io = new ObsidianVaultIO(adapter as never);
		await io.write("submissions/homework/essay.md", "Hello\n");
		expect(await adapter.exists("submissions")).toBe(true);
		expect(await adapter.exists("submissions/homework")).toBe(true);
		expect(await adapter.read("submissions/homework/essay.md")).toBe("Hello\n");
	});
});
