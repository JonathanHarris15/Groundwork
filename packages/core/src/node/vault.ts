import { promises as fs } from "node:fs";
import * as path from "node:path";
import { VAULT_TEMPLATE } from "../template";

/** Write any missing template files. Never overwrites. Returns the files created. */
export async function scaffoldVault(dir: string): Promise<string[]> {
	const created: string[] = [];
	for (const [rel, content] of Object.entries(VAULT_TEMPLATE)) {
		const abs = path.join(dir, rel);
		try {
			await fs.access(abs);
			continue;
		} catch {
			// missing: create it
		}
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf8");
		created.push(rel);
	}
	return created;
}
