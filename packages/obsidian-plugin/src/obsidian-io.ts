import type { DataAdapter } from "obsidian";
import type { VaultIO } from "@groundwork/core";

/** Uses the raw adapter so hidden folders like `.groundwork/` are reachable. */
export class ObsidianVaultIO implements VaultIO {
	constructor(private readonly adapter: DataAdapter) {}

	read(path: string) {
		return this.adapter.read(path);
	}
	readBinary(path: string) {
		return this.adapter.readBinary(path);
	}
	async write(path: string, data: string) {
		await this.ensureParent(path);
		await this.adapter.write(path, data);
	}
	async append(path: string, data: string) {
		await this.ensureParent(path);
		if (await this.adapter.exists(path)) await this.adapter.append(path, data);
		else await this.adapter.write(path, data);
	}
	exists(path: string) {
		return this.adapter.exists(path);
	}
	async mkdir(path: string) {
		if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
	}
	list(path: string) {
		return this.adapter.list(path);
	}
	async remove(path: string) {
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}

	private async ensureParent(path: string) {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}
}
