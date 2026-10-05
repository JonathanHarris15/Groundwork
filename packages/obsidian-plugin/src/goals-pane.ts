import { daysLeftPhrase, type StudyMove } from "@groundwork/core";
import { paceLabel, type GoalBoardView, type GoalConceptRow } from "./goal-board";
import { masteryDot, masteryPill, setTone } from "./mastery-ui";
import { appendSvgFragment } from "./svg-fragment";

export interface GoalsPaneHandlers {
	onSelect: (id: string) => void;
	/** Focus the Working on control when no goal is pinned. */
	onFocusWorkingGoal?: () => void;
	onCreate: () => void;
	onDue: (id: string, due: string) => void;
	onWeight: (id: string, title: string, weight: number) => void;
	onOpen: (title: string, move: StudyMove) => void;
	onPractice: () => void;
	onMap: () => void;
	onDocs: () => void;
	onDelete: (id: string) => void;
}

export function renderGoalsPane(parent: HTMLElement, boards: GoalBoardView[], selectedId: string | null, handlers: GoalsPaneHandlers): void {
	parent.replaceChildren();
	const row = el(parent, "div", "gw-goals-row");
	const main = el(row, "div", "gw-goals");
	if (!boards.length) {
		const empty = el(main, "div", "gw-map-empty");
		empty.append("No goals yet. A goal is the concepts you have not built, plus the day you want them built by.");
		const create = el(empty, "button", "gw-next-btn");
		create.type = "button";
		create.textContent = "New goal";
		create.addEventListener("click", handlers.onCreate);
		return;
	}
	if (boards.length > 1) {
		const tabs = el(main, "div", "gw-goal-tabs");
		for (const board of boards) {
			const tab = el(tabs, "button", `gw-goal-tab${board.id === selectedId ? " is-on" : ""}`);
			tab.type = "button";
			masteryDot(tab, board.status === "done" ? "solid" : board.status === "paused" ? "unstarted" : "goal");
			tab.append(board.title);
			if (board.status !== "active") el(tab, "span", "gw-goal-count", board.status === "done" ? "Done" : "Paused");
			if (board.daysLeft != null) el(tab, "span", "gw-goal-count", daysLeftPhrase(board.daysLeft).replace(" days", "d").replace(" day", "d"));
			tab.addEventListener("click", () => handlers.onSelect(board.id));
		}
		const create = el(tabs, "button", "gw-goal-tab is-new");
		create.type = "button";
		create.append(icon(create, `<path d="M12 5v14M5 12h14"></path>`), "New goal");
		create.addEventListener("click", handlers.onCreate);
	}

	if (!selectedId) {
		renderGoalsUnpinned(main, boards, handlers);
		return;
	}

	const board = boards.find((item) => item.id === selectedId);
	if (!board) {
		renderGoalsUnpinned(main, boards, handlers);
		return;
	}
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
	if (boards.length === 1) {
		const soloNew = el(copy, "button", "gw-text-btn gw-goal-solo-new");
		soloNew.type = "button";
		soloNew.textContent = "New goal";
		soloNew.addEventListener("click", handlers.onCreate);
	}
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
	track.setAttribute("class", "gw-ring-track");
	track.setAttribute("stroke-width", "10");
	const arc = doc.createElementNS(NS, "circle");
	arc.setAttribute("cx", "64");
	arc.setAttribute("cy", "64");
	arc.setAttribute("r", "52");
	arc.setAttribute("fill", "none");
	arc.setAttribute("class", "gw-ring-arc");
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
	el(ring, "div", "gw-ring-label", `ready, weighted by the goal\n${board.knownCount} of ${board.conceptCount} concepts solid`);

	const list = el(main, "div", "gw-concept-list");
	const head = el(list, "div", "gw-concept-head");
	for (const label of ["Concept", "Weight", "Complete", "State", "Work on it"]) el(head, "span", "", label);
	for (const concept of board.concepts) {
		const line = el(list, "div", `gw-concept-row${concept.next ? " is-next" : ""}`);
		const name = el(line, "span", `gw-concept-name${concept.tone === "unstarted" ? " is-unstarted" : ""}`);
		masteryDot(name, concept.tone);
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
		setTone(fill, concept.tone);
		fill.style.width = `${concept.complete}%`;
		el(bar, "em", "", `${concept.complete}%`);
		const state = el(line, "span", "gw-state");
		masteryPill(state, concept.tone, concept.state);
		rowAction(line, concept, handlers);
	}

	const side = el(row, "aside", "gw-side");
	const sideHead = el(side, "div", "gw-side-head");
	sideHead.textContent = "Work on this goal";
	const work = el(side, "div", "gw-work");
	const actions = el(work, "div", "gw-work-actions");
	const nextTitle = board.nextTitle;
	if (nextTitle) workOption(actions, true, "Continue the path", () => handlers.onOpen(nextTitle, "start"));
	if (board.shaky.length) {
		workOption(actions, false, board.shaky.length === 1 ? "Quiz my shaky spot" : "Quiz my shaky spots", () => handlers.onOpen(listTitles(board.shaky.slice(0, 3)), "quiz"));
	}
	const heaviest = board.heaviest;
	if (heaviest) workOption(actions, false, "Study the heaviest topic", () => handlers.onOpen(heaviest.title, "learn"));
	workOption(actions, !nextTitle, "Practice exam", handlers.onPractice);
	workOption(actions, false, "View on the concept map", handlers.onMap);
	workOption(actions, false, "Add prep docs", handlers.onDocs);
	const foot = el(work, "div", "gw-work-foot");
	const remove = el(foot, "button", "gw-text-btn gw-work-delete");
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

function renderGoalsUnpinned(main: HTMLElement, boards: GoalBoardView[], handlers: GoalsPaneHandlers): void {
	const empty = el(main, "div", "gw-map-empty gw-goals-unpinned");
	el(empty, "h2", "gw-goals-unpinned-title", "Select a goal to see its progress");
	const hint = el(empty, "p", "gw-goals-unpinned-hint");
	hint.textContent =
		boards.length > 1
			? "Choose a goal in Working on at the top, or pick a tab above."
			: "Pin your goal in Working on at the top to open its concept list and actions.";
	if (boards.length === 1) {
		const pin = el(empty, "button", "gw-next-btn");
		pin.type = "button";
		pin.textContent = `Work on: ${boards[0].title}`;
		pin.addEventListener("click", () => handlers.onSelect(boards[0].id));
	} else if (handlers.onFocusWorkingGoal) {
		const focus = el(empty, "button", "gw-next-btn");
		focus.type = "button";
		focus.textContent = "Choose in Working on";
		focus.addEventListener("click", handlers.onFocusWorkingGoal);
	}
	const create = el(empty, "button", "gw-text-btn");
	create.type = "button";
	create.textContent = "New goal";
	create.addEventListener("click", handlers.onCreate);
}

const ROW_ACTION: Record<StudyMove, { label: string; title: (concept: string) => string }> = {
	start: { label: "Start", title: (concept) => `Start ${concept} with the tutor` },
	learn: { label: "Learn", title: (concept) => `Keep learning ${concept}` },
	quiz: { label: "Quiz me", title: (concept) => `Quiz me on ${concept}` },
	review: { label: "Review", title: (concept) => `Known. Review ${concept} to keep it solid` },
};

function rowAction(line: HTMLElement, concept: GoalConceptRow, handlers: GoalsPaneHandlers): void {
	const move = concept.action;
	const action = el(line, "button", `gw-row-action${concept.next ? " is-primary" : ""}${move === "review" ? " is-known" : ""}`);
	action.type = "button";
	action.title = ROW_ACTION[move].title(concept.title);
	action.setAttribute("aria-label", ROW_ACTION[move].title(concept.title));
	if (move === "review") action.append(icon(action, `<path d="M5 12l5 5 9-10"></path>`), "Known");
	else if (move === "start") action.append("Start", icon(action, `<path d="M5 12h14M13 6l6 6-6 6"></path>`));
	else action.textContent = ROW_ACTION[move].label;
	action.addEventListener("click", () => handlers.onOpen(concept.title, move));
}

function listTitles(titles: string[]): string {
	if (titles.length <= 1) return titles[0] ?? "";
	return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

function workOption(parent: HTMLElement, primary: boolean, title: string, onClick: () => void): void {
	const button = el(parent, "button", `gw-work-btn${primary ? " is-primary" : ""}`);
	button.type = "button";
	button.textContent = title;
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
