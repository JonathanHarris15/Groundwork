import type { App, TAbstractFile, TFile, TFolder } from "obsidian";

/** Lists vault files under the given folder roots without scanning unrelated paths. */
export function filesUnderFolderRoots(app: App, roots: readonly string[]): TFile[] {
	const out: TFile[] = [];
	const vault = app.vault;
	for (const root of roots) {
		const trimmed = root.trim().replace(/^\/+|\/+$/g, "");
		if (!trimmed) continue;
		const node = vault.getAbstractFileByPath(trimmed);
		if (!node) continue;
		const kids = (node as TFolder).children;
		if (Array.isArray(kids)) walkFolder(node as TFolder, out);
		else if (isVaultFile(node)) out.push(node);
	}
	return out;
}

function walkFolder(folder: TFolder, out: TFile[]): void {
	for (const child of folder.children) collectFile(child, out);
}

function collectFile(node: TAbstractFile, out: TFile[]): void {
	const kids = (node as TFolder).children;
	if (Array.isArray(kids)) {
		for (const child of kids) collectFile(child, out);
		return;
	}
	if (isVaultFile(node)) out.push(node);
}

function isVaultFile(node: TAbstractFile): node is TFile {
	return !Array.isArray((node as TFolder).children) && "extension" in node;
}
