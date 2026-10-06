/** How close to the bottom still counts as following the tutor. */
export const READER_FOLLOW_PX = 160;

export interface ScrollBox {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export function readerIsNearBottom(el: ScrollBox): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < READER_FOLLOW_PX;
}

/**
 * Chat scroll while a quiz can land below the passage the learner is reading.
 * While held, nothing moves the viewport — including a forced scroll to the bottom.
 */
export class ReaderFollow {
	held = false;
	private applying = false;

	hold(): void {
		this.held = true;
	}

	release(): void {
		this.held = false;
	}

	/** The learner moved the scroller. Programmatic updates do not count. */
	noteUserScroll(el: ScrollBox): void {
		if (this.applying) return;
		this.held = !readerIsNearBottom(el);
	}

	/** Move to the bottom only when the reader is following. */
	follow(el: ScrollBox, force = false): boolean {
		if (this.held) return false;
		if (!force && !readerIsNearBottom(el)) return false;
		this.applying = true;
		el.scrollTop = el.scrollHeight;
		this.applying = false;
		return true;
	}

	/**
	 * Insert a quiz (or anything else) and put the viewport back.
	 * Holds follow until the learner returns to the bottom or `release` runs.
	 */
	keepPlace(el: ScrollBox, insert: () => void): number {
		const top = el.scrollTop;
		this.held = true;
		this.applying = true;
		try {
			insert();
			el.scrollTop = top;
		} finally {
			this.applying = false;
		}
		return top;
	}

	/** Put the viewport back after a late layout, while the hold is still on. */
	restore(el: ScrollBox, top: number): void {
		if (!this.held) return;
		this.applying = true;
		el.scrollTop = top;
		this.applying = false;
	}
}
