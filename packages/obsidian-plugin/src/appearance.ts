/** Obsidian follows the vault theme. Dark and Light are Groundwork's own palettes. */
export type GroundworkAppearance = "obsidian" | "dark" | "light";

export function appearanceFrom(data: { appearance?: unknown; siteTheme?: unknown }): GroundworkAppearance {
	if (data.appearance === "obsidian" || data.appearance === "dark" || data.appearance === "light") return data.appearance;
	if (data.siteTheme === true) return "dark";
	return "obsidian";
}
