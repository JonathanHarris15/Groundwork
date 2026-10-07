const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre";

/** The lesson text a highlight attaches to. Assistant prose sits under the avatar row. */
export function passageOf(turn: HTMLElement): HTMLElement {
	const direct = turn.querySelector(":scope > .gw-msg, :scope > .gw-card");
	if (direct instanceof HTMLElement) return direct;
	const nested = turn.querySelector(":scope > .gw-msg-row .gw-msg, :scope > .gw-msg-row .gw-card");
	if (nested instanceof HTMLElement) return nested;
	return turn;
}

/**
 * A drag that starts or ends in the margin stays on the paragraph that was
 * highlighted, instead of snapping to the top of the turn.
 */
export function clampSelection(range: Range, turn: HTMLElement): void {
	const body = passageOf(turn);
	const startIn = body.contains(range.startContainer);
	const endIn = body.contains(range.endContainer);
	if (startIn && endIn) return;
	if (!startIn && endIn) {
		range.setStart(blockOf(range.endContainer, body), 0);
		return;
	}
	if (startIn && !endIn) {
		const block = blockOf(range.startContainer, body);
		range.setEnd(block, block.childNodes.length);
		return;
	}
	const anchor = turn.contains(range.endContainer) ? range.endContainer : range.startContainer;
	const block = blockOf(anchor, body);
	if (block !== body) {
		range.selectNodeContents(block);
		return;
	}
	range.selectNodeContents(body);
}

function blockOf(node: Node, body: HTMLElement): HTMLElement {
	const el = node.instanceOf(Element) ? node : node.parentElement;
	const block = el?.closest(BLOCK);
	if (block instanceof HTMLElement && body.contains(block)) return block;
	return body;
}
