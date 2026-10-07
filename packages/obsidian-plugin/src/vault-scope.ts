import { TFolder, type App, type TAbstractFile, type TFile } from "obsidian";

/** Lists vault files under the given folder roots without scanning unrelated paths. */
export function filesUnderFolderRoots(app: App, roots: readonly string[]): TFile[] {
	const out: TFile[] = [];
	const vault = app.vault;
	for (const root of roots) {
		const trimmed = root.trim().replace(/^\/+|\/+$/g, "");
		if (!trimmed) continue;
		const node = vault.getAbstractFileByPath(trimmed);
		if (!node) continue;
		if (node instanceof TFolder) walkFolder(node, out);
		else if (isVaultFile(node)) out.push(node);
	}
	return out;
}

function walkFolder(folder: TFolder, out: TFile[]): void {
	for (const child of folder.children) collectFile(child, out);
}

function collectFile(node: TAbstractFile, out: TFile[]): void {
	if (node instanceof TFolder) {
		for (const child of node.children) collectFile(child, out);
		return;
	}
	if (isVaultFile(node)) out.push(node);
}

function isVaultFile(node: TAbstractFile): node is TFile {
	return !(node instanceof TFolder) && "extension" in node;
}
