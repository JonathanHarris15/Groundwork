/** Steps the website Open Obsidian handoff runs after saving the refresh token. */
export async function afterWebsiteHandoff(
	refresh: string,
	hooks: {
		saveToken: (token: string) => void;
		finishLink: () => Promise<void>;
	},
): Promise<void> {
	const trimmed = refresh.trim();
	if (trimmed) hooks.saveToken(trimmed);
	await hooks.finishLink();
}
