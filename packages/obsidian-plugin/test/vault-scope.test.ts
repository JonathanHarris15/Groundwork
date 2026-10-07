import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import { filesUnderFolderRoots } from "../src/vault-scope";

describe("filesUnderFolderRoots", () => {
	it("walks only the configured read folders", () => {
		const notes = Object.assign(new TFile("notes/a.pdf"), { extension: "pdf", stat: { mtime: 1, ctime: 0, size: 1 } });
		const other = Object.assign(new TFile("private/secret.pdf"), { extension: "pdf", stat: { mtime: 2, ctime: 0, size: 1 } });
		const notesFolder = new TFolder("notes");
		notesFolder.children = [notes];
		const privateFolder = new TFolder("private");
		privateFolder.children = [other];
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					if (path === "notes") return notesFolder;
					if (path === "private") return privateFolder;
					return null;
				},
			},
		};
		const files = filesUnderFolderRoots(app as never, ["notes"]);
		expect(files.map((f) => f.path)).toEqual(["notes/a.pdf"]);
	});
});
