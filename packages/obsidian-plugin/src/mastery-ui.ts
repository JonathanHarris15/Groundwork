import { MASTERY_LABEL, masteryTone, type ConceptStatus, type MapTone } from "@groundwork/core";

/**
 * Mastery marks shared by the hub, Library, Goals, quiz cards, the map legend, and the path panel.
 * Every color comes from the `--gw-tone-*` tokens in styles.css, keyed by `data-tone`.
 */
export function toneLabel(tone: MapTone): string {
	return tone === "goal" ? "Goal" : MASTERY_LABEL[tone];
}

export function masteryPill(parent: HTMLElement, tone: MapTone, text = toneLabel(tone)): HTMLElement {
	return toned(parent, "span", "gw-status", tone, text);
}

export function statusPill(parent: HTMLElement, status: ConceptStatus, built = false): HTMLElement {
	return masteryPill(parent, masteryTone(status, built));
}

/** Filled disc, or a dashed ring for a concept not started — the same marks the map draws. */
export function masteryDot(parent: HTMLElement, tone: MapTone): HTMLElement {
	return toned(parent, "i", "gw-tone-dot", tone);
}

export function setTone(el: HTMLElement, tone: MapTone): void {
	el.dataset.tone = tone;
}

function toned(parent: HTMLElement, tag: "span" | "i", cls: string, tone: MapTone, text?: string): HTMLElement {
	const node = parent.ownerDocument.createElement(tag);
	node.className = cls;
	node.dataset.tone = tone;
	if (text != null) node.textContent = text;
	parent.append(node);
	return node;
}
