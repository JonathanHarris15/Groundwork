import { describe, expect, it } from "vitest";
import { filesUnderFolderRoots } from "../src/vault-scope";

describe("filesUnderFolderRoots", () => {
	it("walks only the configured read folders", () => {
		const notes = { path: "notes/a.pdf", extension: "pdf", stat: { mtime: 1 } };
		const other = { path: "private/secret.pdf", extension: "pdf", stat: { mtime: 2 } };
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					if (path === "notes") return { children: [notes] };
					if (path === "private") return { children: [other] };
					return null;
				},
			},
		};
		const files = filesUnderFolderRoots(app as never, ["notes"]);
		expect(files.map((f) => f.path)).toEqual(["notes/a.pdf"]);
	});
});
