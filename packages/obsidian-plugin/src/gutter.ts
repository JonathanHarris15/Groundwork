/** Wide enough for a left figure gutter beside the column. */
export const FIGURE_GUTTER_MIN = 860;
/** Wide enough for a right margin beside the column. */
export const MARGIN_GUTTER_MIN = 900;
/** Wide enough for a figure gutter and a margin at once. */
export const GUTTER_BOTH_MIN = 1180;

/** Which gutters sit beside the column. Narrow panes stack them under the passage. */
export function gutterFlags(width: number, figureCount: number, asideCount: number): { figures: boolean; margin: boolean } {
	const both = figureCount > 0 && asideCount > 0;
	return {
		figures: figureCount > 0 && width >= (both ? GUTTER_BOTH_MIN : FIGURE_GUTTER_MIN),
		margin: asideCount > 0 && width >= (both ? GUTTER_BOTH_MIN : MARGIN_GUTTER_MIN),
	};
}
