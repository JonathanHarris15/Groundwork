import { describe, expect, it } from "vitest";
import { MISSING_READ_FOLDER_DETAIL, MISSING_READ_FOLDER_TITLE, MissingReadFolderError, missingReadFolderNotice } from "../src/attach-warning";

describe("missing read folder warning", () => {
	it("names the settings path and the control the learner has to fill in", () => {
		const notice = missingReadFolderNotice();
		expect(notice.startsWith(MISSING_READ_FOLDER_TITLE)).toBe(true);
		expect(notice).toContain(MISSING_READ_FOLDER_DETAIL);
		expect(notice).toContain("Settings");
		expect(notice).toContain("Vault folders");
		expect(notice).toContain("Folders the tutor can read");
		expect(notice).toContain("saved in that folder");
	});

	it("uses that same sentence when a send is blocked", () => {
		const err = new MissingReadFolderError();
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("MissingReadFolderError");
		expect(err.message).toBe(missingReadFolderNotice());
	});
});
