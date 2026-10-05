import {
	buildConceptMap,
	conceptCompletion,
	formatDue,
	masteryVisual,
	sessionEstimate,
	type ConceptMapModel,
	type GoalSchedule,
	type MapSourceNode,
} from "@groundwork/core";
import type { GoalReport, StudyStep } from "@groundwork/core";

export interface GoalConceptRow {
	id: string;
	title: string;
	weight: number;
	complete: number;
	state: string;
	color: string;
	ghost: boolean;
	next: boolean;
	known: boolean;
	action: "start" | "quiz" | "learn" | "known";
}

export interface GoalBoardView {
	id: string;
	title: string;
	status: "active" | "paused" | "done";
	due?: string;
	daysLeft?: number;
	pace: "ahead" | "on-pace" | "behind" | "done" | "unset";
	readiness: number;
	knownCount: number;
	conceptCount: number;
	studiedDays: number;
	elapsedDays: number;
	startLabel: string;
	dueLabel: string;
	days: GoalSchedule["days"];
	concepts: GoalConceptRow[];
	nextTitle?: string;
	nextAfter?: string;
	shaky: string[];
	heaviest?: { title: string; weight: number };
	sessions: number;
	inPlace: number;
	total: number;
	map: ConceptMapModel;
}

const COLOR: Record<string, string> = {
	known: "#3CC56F",
	learning: "#45A9F0",
	shaky: "#F7A93E",
	rusty: "#9d8cf0",
	ghost: "#8b8e94",
	goal: "#F0565B",
	beyond: "#5f6268",
	dim: "#5f6268",
};

export function toBoard(
	report: GoalReport,
	timing: { weights: Record<string, number>; readiness: number; schedule: GoalSchedule | null },
	next?: StudyStep,
	outside: MapSourceNode[] = [],
): GoalBoardView {
	const built = new Set(report.goal.built);
	const nextNode = report.nodes.find((node) => node.title === next?.concept);
	const sources: MapSourceNode[] = [
		...report.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			prerequisites: node.prerequisites,
			status: node.status,
			current: node.current,
			inGoal: true,
			role: node.role,
		})),
		...outside,
	];
	const map = buildConceptMap({
		goalTitle: report.goal.title,
		dueLabel: report.goal.due ? formatDue(report.goal.due) : undefined,
		nodes: sources,
		weights: timing.weights,
		nextId: nextNode?.id,
		builtIds: built,
	});
	const drawn = new Map(map.nodes.map((node) => [node.id, node]));
	const concepts: GoalConceptRow[] = report.nodes
		.map((node) => {
			const builtInGoal = built.has(node.id);
			const visual = masteryVisual(node.status, builtInGoal);
			const isNext = node.id === nextNode?.id && visual !== "known";
			const known = visual === "known";
			const ghost = visual === "ghost";
			let action: GoalConceptRow["action"] = "learn";
			if (known) action = "known";
			else if (isNext) action = "start";
			else if (visual === "shaky" || visual === "rusty") action = "quiz";
			const state = known
				? "Solid"
				: isNext && ghost
					? "Ghost · next"
					: isNext
						? "Next"
						: ghost
							? "Ghost"
							: visual === "shaky"
								? "Shaky"
								: visual === "rusty"
									? "Rusty"
									: visual === "learning"
										? "Learning"
										: node.status;
			return {
				id: node.id,
				title: node.title,
				weight: timing.weights[node.id] ?? 0,
				complete: Math.round(conceptCompletion(node.status, node.current, built.has(node.id)) * 100),
				state,
				color: COLOR[visual] ?? COLOR.learning,
				ghost,
				next: isNext,
				known,
				action,
			};
		})
		.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
	const shaky = concepts.filter((row) => row.state === "shaky" || row.state === "rusty").map((row) => row.title);
	const heaviest = concepts.filter((row) => !row.known).sort((a, b) => b.weight - a.weight)[0];
	const after = map.steps.find((step) => step.visual === "ghost" && step.id !== nextNode?.id);
	const schedule = timing.schedule;
	return {
		id: report.goal.id,
		title: report.goal.title,
		status: report.goal.status,
		due: report.goal.due,
		daysLeft: schedule?.daysLeft,
		pace: schedule?.pace ?? "unset",
		readiness: timing.readiness,
		knownCount: map.inPlace,
		conceptCount: map.total,
		studiedDays: schedule?.studiedDays ?? 0,
		elapsedDays: schedule?.elapsedDays ?? 0,
		startLabel: schedule ? formatDue(schedule.start) : "",
		dueLabel: schedule ? formatDue(schedule.due, true) : "",
		days: schedule?.days ?? [],
		concepts,
		nextTitle: next?.concept,
		nextAfter: after && after.title !== next?.concept ? after.title : undefined,
		shaky,
		heaviest: heaviest && !heaviest.known ? { title: heaviest.title, weight: Math.round(heaviest.weight) } : undefined,
		sessions: sessionEstimate(concepts.filter((row) => !row.known).length),
		inPlace: map.inPlace,
		total: map.total,
		map,
	};
}

export function paceLabel(pace: GoalBoardView["pace"]): string {
	if (pace === "ahead") return "Ahead";
	if (pace === "behind") return "Behind";
	if (pace === "done") return "Ready";
	if (pace === "unset") return "Set a date";
	return "On pace";
}
