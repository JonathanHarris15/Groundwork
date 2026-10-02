import { DEFAULT_WRITE_FOLDERS } from "./access";
import { RESOURCES_DIR } from "./files";
import { DEFAULT_LEARNER_PROFILE, PATHS } from "./store";

export const PLUGIN_ID = "groundwork";

/** Files written into a brand-new knowledge vault. Existing files are never overwritten. */
export const VAULT_TEMPLATE: Record<string, string> = {
	"README.md": `# My knowledge vault

This is a **Groundwork** knowledge vault: a calibrated, persistent memory of what I understand. It is an Obsidian vault and a git repository at the same time, so the same memory follows me to every computer.

| Folder | What lives there |
| --- | --- |
| \`concepts/\` | One note per reusable idea (linear functions, the chain rule). A concept never names a lecture, homework, or exam. \`prerequisites\` link to the concepts it depends on. Status is recalculated from quiz evidence. |
| \`goals/\` | One note per goal. A goal can name a course or a file (Lecture 1 note fluency) and list those source documents. It is made of concepts, which stay useful for the next goal. |
| \`sessions/\` | Transcripts of tutoring sessions. Manage and delete them from the Library, on the Chats tab. |
| \`resources/\` | PDFs, slides, images, and notes I learn from. Files I attach in the tutor chat are saved here. The tutor reads only the folders chosen in Settings. Resetting the vault leaves this folder alone. |
| \`submissions/\` | Files to hand in. The tutor writes them here when I ask, and only into the write folders chosen in Settings. |
| \`exams/\` | Syllabi parsed from those files: topics and the level each must be learned to. |
| \`learner.md\` | My background and how I learn best. The tutor reads it every session and may update it. Edit it from Settings in the tutor panel, or open this note. |
| \`.groundwork/tutor-context.md\` | Extra notes I write for the tutor in Settings. Separate from \`learner.md\`; the tutor reads them and does not rewrite them. |
| \`.groundwork/evidence/\` | Append-only quiz evidence (source of truth for all stats). |

Open the **Groundwork** panel from the ribbon (graduation cap) to talk to the tutor. Goals, concepts, and past chats each have a tab in the Library. Settings in that panel holds the learner file, extra notes, a few preferences, and a way to reset the learning vault. The folders above are storage.
`,
	[PATHS.learner]: DEFAULT_LEARNER_PROFILE,
	[`${PATHS.concepts}/.gitkeep`]: "",
	[`${PATHS.goals}/.gitkeep`]: "",
	[`${PATHS.sessions}/.gitkeep`]: "",
	[`${PATHS.exams}/.gitkeep`]: "",
	[`${PATHS.evidence}/.gitkeep`]: "",
	[`${PATHS.chats}/.gitkeep`]: "",
	[`${RESOURCES_DIR}/.gitkeep`]: "",
	[`${DEFAULT_WRITE_FOLDERS[0]}/.gitkeep`]: "",
	".gitattributes": `# Evidence logs are append-only: merge both machines' lines instead of conflicting.
.groundwork/evidence/*.jsonl merge=union
`,
	".gitignore": `.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
`,
	".obsidian/app.json": JSON.stringify({ alwaysUpdateLinks: true, showFrontmatter: false, attachmentFolderPath: RESOURCES_DIR }, null, 2),
	".obsidian/community-plugins.json": JSON.stringify([PLUGIN_ID], null, 2),
	".obsidian/graph.json": JSON.stringify(
		{
			colorGroups: [
				{ query: "[status:solid]", color: { a: 1, rgb: 2062925 } },
				{ query: "[status:shaky]", color: { a: 1, rgb: 12040479 } },
				{ query: "[status:learning]", color: { a: 1, rgb: 12604961 } },
				{ query: "[status:rusty]", color: { a: 1, rgb: 7030465 } },
			],
			showTags: false,
			showAttachments: false,
			hideUnresolved: true,
		},
		null,
		2,
	),
};
