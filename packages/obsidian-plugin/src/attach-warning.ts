/** Composer copy when a file is attached before any read folder exists. */

export const MISSING_READ_FOLDER_TITLE = "Add a folder the tutor can read";

export const MISSING_READ_FOLDER_DETAIL =
	"Attached files are saved in that folder so the tutor can open them. Open Settings, go to Vault folders, and add one under “Folders the tutor can read”.";

export function missingReadFolderNotice(): string {
	return `${MISSING_READ_FOLDER_TITLE}. ${MISSING_READ_FOLDER_DETAIL}`;
}

/** Thrown when a send tries to save an upload and no read folder is set. */
export class MissingReadFolderError extends Error {
	constructor() {
		super(missingReadFolderNotice());
		this.name = "MissingReadFolderError";
	}
}
