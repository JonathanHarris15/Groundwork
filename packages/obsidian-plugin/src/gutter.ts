/** The lesson column. Side padding is whatever is left; gutters use that padding and do not resize the column. */
export const COLUMN_MAX = 840;
/** A side card needs this much of the existing margin. Narrower panes stack under the passage. */
export const SIDE_ROOM_MIN = 140;

/** Empty margin on one side of the centered column, in pixels. */
export function sideRoom(width: number): number {
	if (!Number.isFinite(width) || width <= 0) return 0;
	const column = Math.min(COLUMN_MAX, width);
	return Math.max(0, (width - column) / 2);
}

/** Which gutters sit beside the column. They open only when the margin is already wide enough. */
export function gutterFlags(width: number, figureCount: number, asideCount: number): { figures: boolean; margin: boolean } {
	const fits = sideRoom(width) >= SIDE_ROOM_MIN;
	return {
		figures: figureCount > 0 && fits,
		margin: asideCount > 0 && fits,
	};
}

export interface MenuHost {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface MenuLine {
	left: number;
	top: number;
	width: number;
	bottom: number;
}

/** Places the highlight menu on one line of the selection, not at the top of the passage. */
export function menuPosition(host: MenuHost, line: MenuLine, menuWidth: number, menuHeight: number): { left: number; top: number } {
	const width = Math.max(1, menuWidth);
	const height = Math.max(1, menuHeight);
	const desired = line.left - host.left + line.width / 2 - width / 2;
	const maxLeft = Math.max(8, host.width - width - 8);
	const left = Math.min(Math.max(8, desired), maxLeft);
	const below = line.bottom - host.top + 6;
	const above = line.top - host.top - height - 6;
	let top = below;
	if (below + height > host.height && above >= 4) top = above;
	if (top < 4) top = 4;
	return { left, top };
}
