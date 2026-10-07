import { MASTERY_LABEL, masteryTone, type ConceptStatus, type MapTone } from "@groundwork/core";
import { appendSvgFragment } from "./svg-fragment";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Legend chip from the approved ads: dark disc, red ring, filled flag. */
const GOAL_MARK = `<circle cx="12" cy="12" r="10" fill="#2a1a1d" stroke="#E5484D" stroke-width="2"></circle><path d="M9 17V7h6l-1.4 2.5L15 12H9" fill="rgba(229,72,77,.35)" stroke="#E5484D" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>`;

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

/** Filled disc, a dashed ring when not started, or the goal's ring-and-flag — the same marks the map draws. */
export function masteryDot(parent: HTMLElement, tone: MapTone): HTMLElement {
	if (tone === "goal") return goalMark(parent);
	return toned(parent, "i", "gw-tone-dot", tone);
}

/** The legend's Goal chip: a dark disc, a red ring, and the filled flag. */
export function goalMark(parent: HTMLElement): HTMLElement {
	const doc = parent.ownerDocument;
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "gw-goal-mark");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.dataset.tone = "goal";
	appendSvgFragment(svg, GOAL_MARK);
	parent.append(svg);
	return svg as unknown as HTMLElement;
}

export function setTone(el: HTMLElement, tone: MapTone): void {
	el.dataset.tone = tone;
}

function toned(parent: HTMLElement, tag: "span" | "i", cls: string, tone: MapTone, text?: string): HTMLElement {
	const node = parent.ownerDocument.win.createEl(tag);
	node.className = cls;
	node.dataset.tone = tone;
	if (text != null) node.textContent = text;
	parent.append(node);
	return node;
}
