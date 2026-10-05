import { daysLeftPhrase } from "@groundwork/core";
import { paceLabel, type GoalBoardView } from "./goal-board";
import { appendSvgFragment } from "./svg-fragment";

export interface GoalsPaneHandlers {
	onSelect: (id: string) => void;
	onCreate: () => void;
	onDue: (id: string, due: string) => void;
	onWeight: (id: string, title: string, weight: number) => void;
	onOpen: (title: string, action: "start" | "quiz" | "learn") => void;
	onPractice: () => void;
	onMap: () => void;
	onDocs: () => void;
	onDelete: (id: string) => void;
}

export function renderGoalsPane(parent: HTMLElement, boards: GoalBoardView[], selectedId: string | null, handlers: GoalsPaneHandlers): void {
	parent.replaceChildren();
	const row = el(parent, "div", "gw-goals-row");
	const main = el(row, "div", "gw-goals");
	const tabs = el(main, "div", "gw-goal-tabs");
	if (!boards.length) {
		const empty = el(main, "div", "gw-map-empty");
		empty.append("No goals yet. A goal is the concepts you have not built, plus the day you want them built by.");
		const create = el(empty, "button", "gw-next-btn");
		create.type = "button";
		create.textContent = "New goal";
		create.addEventListener("click", handlers.onCreate);
		return;
	}
	for (const board of boards) {
		const tab = el(tabs, "button", `gw-goal-tab${board.id === selectedId ? " is-on" : ""}`);
		tab.type = "button";
		const dot = el(tab, "i", "gw-dot");
		dot.style.background = board.status === "done" ? "#3CC56F" : board.status === "paused" ? "#F7A93E" : "#F0565B";
		tab.append(board.title);
		if (board.daysLeft != null) el(tab, "span", "gw-goal-count", daysLeftPhrase(board.daysLeft).replace(" days", "d").replace(" day", "d"));
		tab.addEventListener("click", () => handlers.onSelect(board.id));
	}
	const create = el(tabs, "button", "gw-goal-tab is-new");
	create.type = "button";
	create.append(icon(create, `<path d="M12 5v14M5 12h14"></path>`), "New goal");
	create.addEventListener("click", handlers.onCreate);

	const board = boards.find((item) => item.id === selectedId) ?? boards[0];
	const hero = el(main, "div", "gw-goal-hero");
	const copy = el(hero, "div");
	const kicker = el(copy, "div", "gw-kicker");
	kicker.append(icon(kicker, `<path d="M5 21V4M5 4h11l-2 4 2 4H5"></path>`));
	kicker.append(board.due ? `Goal · due ${board.dueLabel}` : "Goal · needs a due date");
	el(copy, "div", "gw-goal-title", board.title);
	const days = el(copy, "div", "gw-days");
	if (board.daysLeft == null) {
		el(days, "span", "", "Set the day this is due.");
	} else if (board.daysLeft === 0) {
		el(days, "b", "", "Today");
		el(days, "span", `gw-pace is-${board.pace}`, paceLabel(board.pace));
	} else {
		el(days, "b", "", String(Math.abs(board.daysLeft)));
		el(days, "span", "", board.daysLeft < 0 ? "days overdue" : board.daysLeft === 1 ? "day left" : "days left");
		el(days, "span", `gw-pace is-${board.pace}`, paceLabel(board.pace));
	}
	const dateRow = el(copy, "label", "gw-due-field");
	dateRow.append("Due date");
	const date = el(dateRow, "input");
	date.type = "date";
	date.value = board.due ?? "";
	date.addEventListener("change", () => {
		if (date.value) handlers.onDue(board.id, date.value);
	});
	if (board.days.length) {
		const track = el(copy, "div", "gw-track");
		for (const day of board.days) {
			const cell = el(track, "i", `is-${day.kind}`);
			cell.title = `${day.date} · ${day.kind}`;
		}
		const legend = el(copy, "div", "gw-track-label");
		el(legend, "span", "", `Started ${board.startLabel}`);
		const today = el(legend, "span");
		el(today, "b", "", "Today");
		today.append(` · studied ${board.studiedDays} of ${board.elapsedDays} days`);
		el(legend, "span", "", "Last 2 days: highest weight only");
		el(legend, "b", "", "Exam");
	}

	const ring = el(hero, "div", "gw-ring");
	const pct = Math.round(board.readiness * 100);
	const circ = 2 * Math.PI * 52;
	const doc = ring.ownerDocument;
	const NS = "http://www.w3.org/2000/svg";
	const ringSvg = doc.createElementNS(NS, "svg");
	ringSvg.setAttribute("viewBox", "0 0 128 128");
	ringSvg.setAttribute("aria-hidden", "true");
	const track = doc.createElementNS(NS, "circle");
	track.setAttribute("cx", "64");
	track.setAttribute("cy", "64");
	track.setAttribute("r", "52");
	track.setAttribute("fill", "none");
	track.setAttribute("stroke", "#333");
	track.setAttribute("stroke-width", "10");
	const arc = doc.createElementNS(NS, "circle");
	arc.setAttribute("cx", "64");
	arc.setAttribute("cy", "64");
	arc.setAttribute("r", "52");
	arc.setAttribute("fill", "none");
	arc.setAttribute("stroke", "#3CC56F");
	arc.setAttribute("stroke-width", "10");
	arc.setAttribute("stroke-linecap", "round");
	arc.setAttribute("stroke-dasharray", `${(pct / 100) * circ} 999`);
	arc.setAttribute("transform", "rotate(-90 64 64)");
	const label = doc.createElementNS(NS, "text");
	label.setAttribute("x", "64");
	label.setAttribute("y", "70");
	label.setAttribute("text-anchor", "middle");
	label.textContent = `${pct}%`;
	ringSvg.append(track, arc, label);
	ring.append(ringSvg);
	el(ring, "div", "gw-ring-label", `ready, weighted by the goal\n${board.knownCount} of ${board.conceptCount} concepts known`);

	const list = el(main, "div", "gw-concept-list");
	const head = el(list, "div", "gw-concept-head");
	for (const label of ["Concept", "Weight", "Complete", "State", "Work on it"]) el(head, "span", "", label);
	for (const concept of board.concepts) {
		const line = el(list, "div", `gw-concept-row${concept.next ? " is-next" : ""}`);
		const name = el(line, "span", `gw-concept-name${concept.ghost ? " is-ghost" : ""}`);
		if (concept.ghost) el(name, "i", "gw-ghost-dot");
		else {
			const dot = el(name, "i", "gw-dot");
			dot.style.background = concept.color;
		}
		name.append(concept.title);
		const weight = el(line, "label", "gw-weight");
		const input = el(weight, "input");
		input.type = "number";
		input.min = "1";
		input.max = "100";
		input.step = "1";
		input.value = String(Math.max(1, Math.round(concept.weight)));
		input.setAttribute("aria-label", `Weight of ${concept.title}`);
		weight.append("%");
		input.addEventListener("change", () => {
			const next = Number(input.value);
			if (next > 0) handlers.onWeight(board.id, concept.title, next);
		});
		const bar = el(line, "span", "gw-complete");
		const track = el(bar, "span", "gw-complete-bar");
		const fill = el(track, "span");
		fill.style.width = `${concept.complete}%`;
		fill.style.background = concept.color;
		el(bar, "em", "", `${concept.complete}%`);
		el(line, "span", "gw-state", concept.state);
		const action = el(line, "button", `gw-row-action${concept.action === "start" ? " is-primary" : ""}${concept.action === "known" ? " is-done" : ""}`);
		action.type = "button";
		if (concept.action === "known") {
			action.append(icon(action, `<path d="M5 12l5 5 9-10"></path>`), "Known");
			action.disabled = true;
		} else if (concept.action === "start") {
			action.append("Start", icon(action, `<path d="M5 12h14M13 6l6 6-6 6"></path>`));
			action.addEventListener("click", () => handlers.onOpen(concept.title, "start"));
		} else if (concept.action === "quiz") {
			action.textContent = "Quiz me";
			action.addEventListener("click", () => handlers.onOpen(concept.title, "quiz"));
		} else {
			action.textContent = "Learn";
			action.addEventListener("click", () => handlers.onOpen(concept.title, "learn"));
		}
	}

	const side = el(row, "aside", "gw-side");
	const sideHead = el(side, "div", "gw-side-head");
	sideHead.textContent = "Work on this goal";
	const work = el(side, "div", "gw-work");
	option(work, true, "Continue the path", board.nextTitle ? `${board.nextTitle}${board.nextAfter ? `, then ${board.nextAfter}` : ""}` : "Nothing is waiting on this goal.", board.sessions ? "30m" : "", () => {
		if (board.nextTitle) handlers.onOpen(board.nextTitle, "start");
	});
	if (board.shaky.length) {
		option(work, false, "Quiz my shaky spots", `${board.shaky.slice(0, 2).join(" and ")}${board.shaky.length > 2 ? ` and ${board.shaky.length - 2} more` : ""}`, "10m", () => handlers.onOpen(board.shaky[0], "quiz"));
	}
	if (board.heaviest) {
		option(work, false, "Study the heaviest topic", `${board.heaviest.title} is ${board.heaviest.weight}% of this goal`, "35m", () => handlers.onOpen(board.heaviest!.title, "learn"));
	}
	option(work, false, "Practice exam", "Questions weighted like this goal", "45m", handlers.onPractice);
	option(work, false, "View on the concept map", "Opens the map with your goal on top and every concept visible", "", handlers.onMap);
	option(work, false, "Add prep docs", "Drop in a study guide to reweight the list", "", handlers.onDocs);
	el(work, "p", "gw-path-why", "Weights come from the goal. Leave them even and every concept counts the same. As the date gets close, the last two days are for the heaviest concepts.");
	const remove = el(work, "button", "gw-text-btn");
	remove.type = "button";
	remove.textContent = "Delete goal";
	remove.addEventListener("click", () => {
		if (remove.dataset.armed === "1") handlers.onDelete(board.id);
		else {
			remove.dataset.armed = "1";
			remove.textContent = "Delete goal?";
			window.setTimeout(() => {
				remove.dataset.armed = "";
				remove.textContent = "Delete goal";
			}, 3000);
		}
	});
}

function option(parent: HTMLElement, primary: boolean, title: string, detail: string, time: string, onClick: () => void): void {
	const button = el(parent, "button", `gw-option-card${primary ? " is-primary" : ""}`);
	button.type = "button";
	const text = el(button, "span");
	el(text, "b", "", title);
	el(text, "span", "", detail);
	if (time) el(button, "span", "gw-option-time", time);
	button.addEventListener("click", onClick);
}

function icon(parent: HTMLElement, fragment: string): SVGElement {
	const svg = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	appendSvgFragment(svg, fragment);
	return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = parent.ownerDocument.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	parent.append(node);
	return node;
}
