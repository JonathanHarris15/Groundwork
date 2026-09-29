import { RESOURCES_DIR } from "./files";
import { DEFAULT_LEARNER_PROFILE, PATHS } from "./store";

export const PLUGIN_ID = "groundwork";

/** Files written into a brand-new knowledge vault. Existing files are never overwritten. */
export const VAULT_TEMPLATE: Record<string, string> = {
	"README.md": `# My knowledge vault

This is a **Groundwork** knowledge vault: a calibrated, persistent memory of what I understand. It is an Obsidian vault and a git repository at the same time, so the same memory follows me to every computer.

| Folder | What lives there |
| --- | --- |
| \`concepts/\` | One note per concept. \`prerequisites\` link to the concepts it depends on, so Obsidian's graph view shows the dependency graph. Status and strength are recalculated from quiz evidence. |
| \`goals/\` | Learning objectives, each with a dependency map colored by how well I know every node. |
| \`sessions/\` | Transcripts and summaries of tutoring sessions. |
| \`resources/\` | PDFs, slides, images, and notes I learn from. Files I attach in the tutor chat are saved here, and the tutor can open anything in it. |
| \`exams/\` | Syllabi parsed from those files: topics and the level each must be learned to. |
| \`learner.md\` | My background and how I learn best. The tutor reads it every session. |
| \`.groundwork/evidence/\` | Append-only quiz evidence (source of truth for all stats). |

Open the **Groundwork** panel from the ribbon (graduation cap) to talk to the tutor.
`,
	[PATHS.learner]: DEFAULT_LEARNER_PROFILE,
	[`${PATHS.concepts}/.gitkeep`]: "",
	[`${PATHS.goals}/.gitkeep`]: "",
	[`${PATHS.sessions}/.gitkeep`]: "",
	[`${PATHS.exams}/.gitkeep`]: "",
	[`${PATHS.evidence}/.gitkeep`]: "",
	[`${PATHS.chats}/.gitkeep`]: "",
	[`${RESOURCES_DIR}/.gitkeep`]: "",
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
