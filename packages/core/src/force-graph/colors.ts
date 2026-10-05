import type { ConceptStatus } from "../model";

/** Status fills aligned with the plugin map and Mermaid goal maps. */
export const STATUS_COLORS: Record<ConceptStatus, string> = {
	solid: "#3CC56F",
	shaky: "#F7A93E",
	learning: "#45A9F0",
	rusty: "#9d8cf0",
	unassessed: "#6b6f76",
};

export const MAP_VISUAL_COLORS: Record<string, string> = {
	known: "#3CC56F",
	learning: "#45A9F0",
	shaky: "#F7A93E",
	rusty: "#9d8cf0",
	ghost: "#8b8e94",
	goal: "#F0565B",
	beyond: "#5f6268",
	dim: "#5f6268",
};
