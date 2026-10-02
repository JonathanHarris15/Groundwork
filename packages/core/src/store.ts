import { assertAbstractConcept, assertConceptOmitsSources, sourceBoundConceptReason } from "./concept-title";
import {
	blueprintToGoalInput,
	buildExamBlueprint,
	classifyMaterial,
	formatExamPlanMarkdown,
	materialFromVaultFile,
	type ExamBlueprint,
	type MaterialKind,
	type MaterialSource,
} from "./exam";
import { analyzeGoal, findCycle, goalMermaid, isBuilt, targetsServed, type GoalAnalysis, type GraphNode } from "./graph";
import { buildSchedule, daysBetween, defaultDue, parseIsoDate, resolveWeights, weightedReadiness } from "./goal-plan";
import { ensureDir, type VaultIO } from "./io";
import {
	demoteHeadings,
	getSection,
	parseNote,
	safeFileName,
	serializeNote,
	setSection,
	slugify,
	unwikilink,
	wikilink,
} from "./markdown";
import { pickReadyStep, refineGoalInput, resolveForEvidence, type ResolvedConcept } from "./judgments";
import { type JevClient } from "./jev";
import { computeStats, describeEdge, emptyStats, isDue, type ConceptStats, type Evidence } from "./model";

export const PATHS = {
	concepts: "concepts",
	goals: "goals",
	exams: "exams",
	tests: "tests",
	sessions: "sessions",
	learner: "learner.md",
	data: ".groundwork",
	evidence: ".groundwork/evidence",
	chats: ".groundwork/chats",
	focus: ".groundwork/focus.json",
	/** Notes the learner writes in Settings. Not `learner.md`. */
	tutorContext: ".groundwork/tutor-context.md",
} as const;

export interface Concept {
	id: string;
	title: string;
	path: string;
	domain?: string;
	aliases: string[];
	prerequisites: string[];
	body: string;
	stats: ConceptStats;
}

export interface ConceptInput {
	title: string;
	domain?: string;
	aliases?: string[];
	/** Titles (or [[links]]) of concepts this one directly depends on. */
	prerequisites?: string[];
	/** When false (default), new prerequisites are merged with existing ones. */
	replacePrerequisites?: boolean;
	summary?: string;
	unconditionalTruths?: string;
	connections?: string;
	misconceptions?: string;
	notes?: string;
}

export type GoalStatus = "active" | "paused" | "done";

export interface GoalChoice {
	id: string;
	title: string;
	status: GoalStatus;
	/** Concepts on this goal that are not built yet. */
	left: number;
}

export interface WorkingGoal {
	id: string;
	title: string;
	left: number;
	status: GoalStatus;
	/** YYYY-MM-DD, when the goal has a deadline. */
	due?: string;
	/** Days from today until `due`. Negative when the deadline has passed. */
	daysLeft?: number;
}

/** Dropdown label, e.g. "427 exam → 10 concepts left". */
/** A saved conversation. The chat file may hold more fields than these; callers that resume a chat keep them. */
export interface StoredChat {
	id: string;
	title: string;
	created: string;
	updated: string;
	notePath?: string;
}

export function goalChoiceLabel(choice: Pick<GoalChoice, "title" | "left" | "status">): string {
	const left = choice.left === 1 ? "1 concept left" : `${choice.left} concepts left`;
	return `${choice.title} → ${left}${choice.status === "paused" ? " (paused)" : ""}`;
}

export interface Goal {
	id: string;
	title: string;
	path: string;
	status: GoalStatus;
	/**
	 * Concepts this goal is made of that are not built yet.
	 * A target is a concept the learner has not built to (not solid at the depth this goal requires).
	 */
	targets: string[];
	/** Concepts this goal is made of that are already built. */
	built: string[];
	nodes: string[];
	created?: string;
	/** Deadline, YYYY-MM-DD. The goals calendar is this date. */
	due?: string;
	/**
	 * Explicit exam weight by concept id, as a percent.
	 * Missing concepts share whatever is left; an empty map means an even split.
	 */
	weights: Record<string, number>;
	objective?: string;
	body: string;
	/** Concept id → exam-required quiz difficulty (1–5). */
	requiredLevels: Record<string, number>;
	examPlan?: string;
	/** Vault files this goal draws on. Concepts never store these. */
	sources: string[];
}

export interface GoalInput {
	title: string;
	/** Optional context. The goal itself is `targets`, not this sentence. */
	objective?: string;
	why?: string;
	approach?: string;
	/**
	 * Concepts this goal is made of. Each must be a node.
	 * Ones the learner already holds are recorded as built; the rest are the targets.
	 * `target` is the old single-sink field, accepted only when `targets` is omitted.
	 */
	targets?: string[];
	target?: string;
	nodes: Array<{ title: string; prerequisites?: string[]; summary?: string; domain?: string; requiredLevel?: number; aliases?: string[] }>;
	status?: GoalStatus;
	/** Deadline as YYYY-MM-DD. Omit it and a new goal is due in 14 days. */
	due?: string;
	/** How much of the goal each concept is worth, as percents. Titles the goal does not name are ignored. */
	weights?: Array<{ title: string; weight: number }>;
	examPlan?: string;
	/** Vault paths of the files this goal draws on. Allowed here, never on a concept. */
	sources?: string[];
}

/** The one next thing worth studying. */
export interface StudyStep {
	action: "build" | "review" | "repair";
	concept: string;
	goal?: string;
	why: string;
}

export interface IngestExamInput {
	title?: string;
	why?: string;
	userText?: string;
	/** Vault paths of attached or existing files. */
	files?: string[];
	/** Extra text the model extracted (e.g. from a compressed PDF it read). */
	materials?: Array<{ name: string; text: string; kind?: MaterialKind; path?: string }>;
	createGoal?: boolean;
}

export interface GoalReport {
	goal: Goal;
	nodes: Array<GraphNode & { edge: string; nextReview?: string; openMisconceptions: string[]; floor?: number; role: "target" | "built" | "path" }>;
	analysis: GoalAnalysis;
	mermaid: string;
	/** Best next step on this goal, when it still has open targets. */
	next?: StudyStep;
	/** Concept renames and prerequisite edits from a judgment pass. Empty when none ran. */
	judgmentNotes?: string[];
}

export interface StoreOptions {
	now?: () => Date;
	device?: string;
	/** Called after any memory write so the host can save it to the account. */
	onChange?: (paths: string[]) => void;
	/** Semantic judgments. Absent means the vault behaves as it does without a model. */
	judgments?: JevClient;
	/**
	 * Optional Obsidian folders the learner picked as extra context.
	 * Defaults to `io`, so a store with one filesystem keeps reading and writing there.
	 */
	context?: VaultIO;
}

export class KnowledgeStore {
	private index: Map<string, Concept> | null = null;
	private readonly now: () => Date;

	constructor(
		readonly io: VaultIO,
		private readonly opts: StoreOptions = {},
	) {
		this.now = opts.now ?? (() => new Date());
	}

	invalidate(): void {
		this.index = null;
	}

	/** Vault folders used as extra context. The memory itself is `io`. */
	get context(): VaultIO {
		return this.opts.context ?? this.io;
	}

	judgments(): JevClient | undefined {
		return this.opts.judgments;
	}

	useJudgments(client: JevClient | undefined): void {
		this.opts.judgments = client;
	}

	/** Exact title or alias, otherwise a same-concept judgment against concepts already in the vault. */
	resolveForEvidence(ref: string, text?: string): Promise<ResolvedConcept | undefined> {
		return resolveForEvidence(this, ref, text);
	}

	private changed(...paths: string[]): void {
		this.opts.onChange?.(paths);
	}

	async ensureLayout(): Promise<void> {
		for (const dir of [PATHS.concepts, PATHS.goals, PATHS.exams, PATHS.sessions, PATHS.data, PATHS.evidence, PATHS.chats]) {
			await ensureDir(this.io, dir);
		}
		if (!(await this.io.exists(PATHS.learner))) {
			await this.io.write(PATHS.learner, DEFAULT_LEARNER_PROFILE);
		}
	}

	// ── concepts ──────────────────────────────────────────────────────────

	async concepts(): Promise<Map<string, Concept>> {
		if (this.index) return this.index;
		const index = new Map<string, Concept>();
		if (await this.io.exists(PATHS.concepts)) {
			for (const path of await listMarkdown(this.io, PATHS.concepts)) {
				const concept = await this.readConcept(path);
				if (concept) index.set(concept.id, concept);
			}
		}
		this.index = index;
		return index;
	}

	private async readConcept(path: string): Promise<Concept | null> {
		const { frontmatter: fm, body } = parseNote(await this.io.read(path));
		const fileTitle = path.split("/").pop()!.replace(/\.md$/, "");
		const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fileTitle;
		const id = slugify(title);
		if (!id) return null;
		const prereqs = asStringList(fm.prerequisites).map((p) => slugify(unwikilink(p))).filter(Boolean);
		return {
			id,
			title,
			path,
			domain: typeof fm.domain === "string" ? fm.domain : undefined,
			aliases: asStringList(fm.aliases),
			prerequisites: [...new Set(prereqs)],
			body,
			stats: computeStats(await this.evidenceFor(id), this.now()),
		};
	}

	async resolve(ref: string): Promise<Concept | undefined> {
		const index = await this.concepts();
		const id = slugify(unwikilink(ref));
		if (index.has(id)) return index.get(id);
		for (const c of index.values()) {
			if (c.aliases.some((a) => slugify(a) === id)) return c;
		}
		return undefined;
	}

	async requireConcept(ref: string): Promise<Concept> {
		const c = await this.resolve(ref);
		if (!c) throw new Error(`Unknown concept "${ref}". Create it with upsert_concept first.`);
		return c;
	}

	async upsertConcept(input: ConceptInput): Promise<{ concept: Concept; created: boolean; createdPrerequisites: string[] }> {
		const title = unwikilink(input.title).trim();
		if (!slugify(title)) throw new Error("Concept title must contain letters or numbers.");
		assertAbstractConcept(title);
		for (const alias of input.aliases ?? []) assertAbstractConcept(alias);
		for (const raw of input.prerequisites ?? []) {
			const ref = unwikilink(raw).trim();
			if (slugify(ref)) assertAbstractConcept(ref);
		}
		assertConceptOmitsSources(
			[input.summary, input.unconditionalTruths, input.connections, input.misconceptions, input.notes].filter((s): s is string => !!s?.trim()).join("\n"),
		);
		const existing = await this.resolve(title);

		const createdPrerequisites: string[] = [];
		const prereqIds: string[] = [];
		for (const raw of input.prerequisites ?? []) {
			const ref = unwikilink(raw);
			if (!slugify(ref)) continue;
			let p = await this.resolve(ref);
			if (!p) {
				p = (await this.writeNewConcept({ title: ref, domain: input.domain })).concept;
				createdPrerequisites.push(p.title);
			}
			prereqIds.push(p.id);
		}

		const id = existing?.id ?? slugify(title);
		const merged = input.replacePrerequisites || !existing ? prereqIds : [...existing.prerequisites, ...prereqIds];
		const prerequisites = [...new Set(merged)].filter((p) => p !== id);
		await this.assertAcyclic(id, prerequisites);

		if (!existing) {
			const res = await this.writeNewConcept({ ...input, title }, prerequisites);
			return { ...res, createdPrerequisites };
		}

		const { frontmatter, body: oldBody } = parseNote(await this.io.read(existing.path));
		let body = applySections(oldBody, input);
		const index = await this.concepts();
		frontmatter.prerequisites = prerequisites.map((p) => wikilink(index.get(p)?.title ?? p));
		if (input.domain) frontmatter.domain = input.domain;
		if (input.aliases?.length) frontmatter.aliases = [...new Set([...asStringList(frontmatter.aliases), ...input.aliases])];
		body = body.replace(/^\n+/, "");
		await this.io.write(existing.path, serializeNote(frontmatter, body));
		this.invalidate();
		this.changed(existing.path);
		return { concept: await this.requireConcept(existing.id), created: false, createdPrerequisites };
	}

	private async writeNewConcept(input: ConceptInput, prereqIds: string[] = []): Promise<{ concept: Concept; created: boolean }> {
		await ensureDir(this.io, PATHS.concepts);
		const title = input.title.trim();
		const index = await this.concepts();
		const path = await this.uniquePath(PATHS.concepts, safeFileName(title));
		const stats = emptyStats();
		const fm = {
			title,
			type: "concept",
			domain: input.domain,
			aliases: input.aliases?.length ? input.aliases : undefined,
			prerequisites: prereqIds.map((p) => wikilink(index.get(p)?.title ?? p)),
			...statsFrontmatter(stats),
			tags: ["groundwork/concept"],
		};
		let body = `# ${title}\n`;
		body = applySections(body, input);
		await this.io.write(path, serializeNote(fm, body));
		this.invalidate();
		this.changed(path);
		return { concept: await this.requireConcept(title), created: true };
	}

	private async uniquePath(dir: string, base: string): Promise<string> {
		let candidate = `${dir}/${base}.md`;
		for (let i = 2; await this.io.exists(candidate); i++) candidate = `${dir}/${base} ${i}.md`;
		return candidate;
	}

	private async assertAcyclic(id: string, prerequisites: string[]): Promise<void> {
		const index = await this.concepts();
		const edges = new Map<string, string[]>();
		for (const c of index.values()) edges.set(c.id, c.prerequisites);
		edges.set(id, prerequisites);
		const cycle = findCycle(edges);
		if (cycle) {
			const names = cycle.map((c) => index.get(c)?.title ?? c);
			throw new Error(`That would create a dependency cycle: ${names.join(" → ")}. Prerequisites must form a DAG.`);
		}
	}

	async dependents(id: string): Promise<Concept[]> {
		return [...(await this.concepts()).values()].filter((c) => c.prerequisites.includes(id));
	}

	// ── evidence ──────────────────────────────────────────────────────────

	private evidencePath(id: string): string {
		return `${PATHS.evidence}/${id}.jsonl`;
	}

	async evidenceFor(id: string): Promise<Evidence[]> {
		const path = this.evidencePath(id);
		if (!(await this.io.exists(path))) return [];
		const out: Evidence[] = [];
		for (const line of (await this.io.read(path)).split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// A conflicted or truncated line is skipped rather than poisoning the replay.
			}
		}
		return out;
	}

	async recordEvidence(
		conceptRef: string,
		ev: Omit<Evidence, "ts" | "concept"> & { ts?: string },
	): Promise<{ concept: Concept; before: ConceptStats; after: ConceptStats }> {
		const concept = await this.requireConcept(conceptRef);
		const before = concept.stats;
		const event: Evidence = {
			...ev,
			ts: ev.ts ?? this.now().toISOString(),
			concept: concept.id,
			device: ev.device ?? this.opts.device,
		};
		await ensureDir(this.io, PATHS.evidence);
		await this.io.append(this.evidencePath(concept.id), `${JSON.stringify(event)}\n`);
		const after = await this.refreshConcept(concept.id);
		await this.refreshGoalsContaining(concept.id);
		return { concept: (await this.requireConcept(concept.id))!, before, after };
	}

	/** Recomputes a concept's stats from evidence and rewrites its generated frontmatter and history. */
	async refreshConcept(id: string): Promise<ConceptStats> {
		const concept = await this.requireConcept(id);
		const evidence = await this.evidenceFor(concept.id);
		const stats = computeStats(evidence, this.now());
		const { frontmatter, body } = parseNote(await this.io.read(concept.path));
		Object.assign(frontmatter, statsFrontmatter(stats));
		const newBody = evidence.length ? setSection(body, "Quiz history", historyTable(evidence)) : body;
		await this.io.write(concept.path, serializeNote(frontmatter, newBody));
		this.invalidate();
		this.changed(concept.path, this.evidencePath(concept.id));
		return stats;
	}

	/** Rebuild every derived view. Run after a git merge brings in evidence from another machine. */
	async recomputeAll(): Promise<void> {
		this.invalidate();
		for (const c of (await this.concepts()).values()) {
			if ((await this.evidenceFor(c.id)).length) await this.refreshConcept(c.id);
		}
		for (const g of await this.goals()) await this.renderGoal(g.id);
	}

	async dueReviews(limit = 10): Promise<Concept[]> {
		const now = this.now();
		return [...(await this.concepts()).values()]
			.filter((c) => isDue(c.stats, now))
			.sort((a, b) => (a.stats.nextReview ?? "").localeCompare(b.stats.nextReview ?? ""))
			.slice(0, limit);
	}

	// ── goals ─────────────────────────────────────────────────────────────

	async goals(): Promise<Goal[]> {
		if (!(await this.io.exists(PATHS.goals))) return [];
		const out: Goal[] = [];
		for (const path of await listMarkdown(this.io, PATHS.goals)) {
			const { frontmatter: fm, body } = parseNote(await this.io.read(path));
			const fileTitle = path.split("/").pop()!.replace(/\.md$/, "");
			const title = typeof fm.title === "string" ? fm.title : fileTitle;
			const shape = readGoalShape(fm);
			out.push({
				id: slugify(title),
				title,
				path,
				status: (["active", "paused", "done"].includes(fm.status as string) ? fm.status : "active") as GoalStatus,
				targets: shape.targets,
				built: shape.built,
				nodes: asStringList(fm.nodes).map((n) => slugify(unwikilink(n))),
				created: typeof fm.created === "string" ? fm.created : undefined,
				due: parseIsoDate(fm.due),
				weights: readWeights(fm.weights),
				objective: getSection(body, "Objective"),
				body,
				requiredLevels: shape.requiredLevels,
				examPlan: typeof fm.exam === "string" ? unwikilink(fm.exam) : undefined,
				sources: asStringList(fm.sources).map((s) => unwikilink(s)).filter(Boolean),
			});
		}
		return out;
	}

	async resolveGoal(ref: string): Promise<Goal | undefined> {
		const id = slugify(unwikilink(ref));
		return (await this.goals()).find((g) => g.id === id);
	}

	async setGoal(input: GoalInput, opts?: { judgments?: "tutor" | "proposed" | "off" }): Promise<GoalReport> {
		const mode = opts?.judgments ?? "tutor";
		let notes: string[] = [];
		if (mode !== "off") {
			const refined = await refineGoalInput(this, input, mode);
			input = refined.input;
			notes = refined.notes;
		}
		const named = goalTargetTitles(input);
		if (!named.length) throw new Error("A goal is made of targets: name at least one concept that has not been built yet.");
		for (const title of [...named, ...input.nodes.flatMap((n) => [n.title, ...(n.prerequisites ?? [])])]) assertAbstractConcept(title);
		for (const node of input.nodes) if (node.summary) assertConceptOmitsSources(node.summary);
		const judged = mode !== "off" && !!this.judgments();
		const inThisGoal = new Set(input.nodes.map((n) => slugify(unwikilink(n.title))));
		const nodeTitles = new Map<string, string>();
		for (const node of input.nodes) {
			let prerequisites = node.prerequisites;
			let replacePrerequisites = false;
			if (judged) {
				const existing = await this.resolve(node.title);
				const index = await this.concepts();
				const outside = (existing?.prerequisites ?? []).filter((id) => !inThisGoal.has(id)).map((id) => index.get(id)?.title ?? id);
				prerequisites = [...outside, ...(node.prerequisites ?? [])];
				replacePrerequisites = true;
			}
			await this.upsertConcept({
				title: node.title,
				prerequisites,
				replacePrerequisites,
				summary: node.summary,
				domain: node.domain,
				aliases: node.aliases?.filter((alias) => !sourceBoundConceptReason(alias)),
			});
			const c = await this.requireConcept(node.title);
			nodeTitles.set(c.id, c.title);
			for (const p of node.prerequisites ?? []) {
				const pc = await this.requireConcept(p);
				nodeTitles.set(pc.id, pc.title);
			}
		}
		const missing: string[] = [];
		const scopeTitles: string[] = [];
		const seen = new Set<string>();
		for (const title of named) {
			const c = await this.resolve(title);
			if (!c || !nodeTitles.has(c.id)) {
				missing.push(title);
				continue;
			}
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			scopeTitles.push(c.title);
		}
		if (missing.length) throw new Error(`Every target must be a concept on this goal. Not on the graph: ${missing.join(", ")}.`);
		const existingForScope = await this.resolveGoal(input.title);
		if (existingForScope) {
			const index = await this.concepts();
			for (const id of existingForScope.built) {
				if (seen.has(id) || !nodeTitles.has(id)) continue;
				seen.add(id);
				scopeTitles.push(index.get(id)?.title ?? nodeTitles.get(id)!);
			}
		}

		const requiredLevels: Record<string, number> = {};
		for (const node of input.nodes) {
			if (!node.requiredLevel) continue;
			const c = await this.requireConcept(node.title);
			requiredLevels[c.id] = clampLevel(node.requiredLevel);
		}
		const required = Object.fromEntries(
			[...nodeTitles.entries()].filter(([id]) => requiredLevels[id]).map(([id, title]) => [title, requiredLevels[id]]),
		);
		const weightByTitle: Record<string, number> = {};
		if (input.weights?.length) {
			for (const entry of input.weights) {
				const concept = await this.resolve(entry.title);
				if (!concept || !nodeTitles.has(concept.id) || !(entry.weight > 0)) continue;
				weightByTitle[concept.title] = entry.weight;
			}
		}

		await ensureDir(this.io, PATHS.goals);
		const existing = await this.resolveGoal(input.title);
		const path = existing?.path ?? (await this.uniquePath(PATHS.goals, safeFileName(input.title)));
		const prior = existing ? parseNote(await this.io.read(path)) : { frontmatter: {}, body: `# ${input.title}\n` };
		const sourceList = normalizeSources(input.sources ?? existing?.sources ?? []);
		let body = prior.body;
		const generated = ["Sources", "Targets", "Built", "Dependency map"];
		if (sourceList.length || input.sources) {
			body = setSection(
				body,
				"Sources",
				sourceList.length
					? ["Files this goal draws on. The concepts stay reusable without these files.", "", ...sourceList.map((s) => `- ${wikilink(s)}`)].join("\n")
					: "No source files are attached to this goal.",
				["Targets", "Built", "Dependency map"],
			);
		}
		if (input.objective) body = setSection(body, "Objective", demoteHeadings(input.objective), generated);
		if (input.why) body = setSection(body, "Why", demoteHeadings(input.why), generated);
		if (input.approach) body = setSection(body, "Approach", demoteHeadings(input.approach), generated);
		const created = existing?.created ?? (typeof prior.frontmatter.created === "string" ? prior.frontmatter.created : undefined) ?? this.now().toISOString().slice(0, 10);
		const due = parseIsoDate(input.due) ?? existing?.due ?? parseIsoDate(prior.frontmatter.due) ?? defaultDue(created.slice(0, 10));
		const fm: Record<string, unknown> = {
			...prior.frontmatter,
			title: input.title,
			type: "goal",
			status: input.status ?? existing?.status ?? "active",
			created,
			due,
			weights: Object.keys(weightByTitle).length ? weightByTitle : prior.frontmatter.weights,
			targets: scopeTitles.map(wikilink),
			nodes: [...nodeTitles.values()].map(wikilink),
			required: Object.keys(required).length ? required : undefined,
			exam: input.examPlan ? wikilink(input.examPlan) : existing?.examPlan ? wikilink(existing.examPlan) : prior.frontmatter.exam,
			sources: sourceList.length ? sourceList.map(wikilink) : undefined,
			tags: ["groundwork/goal"],
		};
		delete fm.target;
		delete fm.built;
		await this.io.write(path, serializeNote(fm, body));
		this.changed(path);
		const report = await this.renderGoal(slugify(input.title));
		return notes.length ? { ...report, judgmentNotes: notes } : report;
	}

	async setGoalDue(ref: string, due: string): Promise<Goal> {
		const goal = await this.resolveGoal(ref);
		if (!goal) throw new Error(`Unknown goal "${ref}".`);
		const iso = parseIsoDate(due);
		if (!iso) throw new Error("A due date is a calendar day, like 2026-10-14.");
		const { frontmatter, body } = parseNote(await this.io.read(goal.path));
		frontmatter.due = iso;
		await this.io.write(goal.path, serializeNote(frontmatter, body));
		this.changed(goal.path);
		return { ...goal, due: iso };
	}

	/** Replace the explicit weights. Concepts left out go back to sharing what remains. */
	async setGoalWeights(ref: string, weights: Array<{ title: string; weight: number }>): Promise<Goal> {
		const goal = await this.resolveGoal(ref);
		if (!goal) throw new Error(`Unknown goal "${ref}".`);
		const byTitle: Record<string, number> = {};
		for (const entry of weights) {
			const concept = await this.resolve(entry.title);
			if (!concept || !(entry.weight > 0)) continue;
			if (!goal.nodes.includes(concept.id) && !goal.targets.includes(concept.id) && !goal.built.includes(concept.id)) continue;
			byTitle[concept.title] = entry.weight;
		}
		const { frontmatter, body } = parseNote(await this.io.read(goal.path));
		frontmatter.weights = Object.keys(byTitle).length ? byTitle : undefined;
		await this.io.write(goal.path, serializeNote(frontmatter, body));
		this.changed(goal.path);
		return { ...goal, weights: readWeights(frontmatter.weights) };
	}

	/**
	 * Deadline, weights, and how the calendar should read.
	 * Weights always sum to 100. A goal with no explicit weights is split evenly.
	 */
	async goalTiming(report: GoalReport): Promise<{
		weights: Record<string, number>;
		readiness: number;
		schedule: ReturnType<typeof buildSchedule>;
	}> {
		const today = this.now().toISOString().slice(0, 10);
		const ids = report.nodes.map((node) => node.id);
		const weights = resolveWeights(ids.length ? ids : [...report.goal.targets, ...report.goal.built], report.goal.weights, report.goal.requiredLevels);
		const built = new Set(report.goal.built);
		const readiness = weightedReadiness(report.nodes, weights, (id) => built.has(id));
		const studied = await this.studyDates(ids);
		return {
			weights,
			readiness,
			schedule: buildSchedule({
				start: report.goal.created,
				due: report.goal.due,
				today,
				studied,
				readiness,
				status: report.goal.status,
			}),
		};
	}

	/** Calendar days, YYYY-MM-DD, on which any of these concepts has quiz evidence. */
	async studyDates(conceptIds: string[]): Promise<string[]> {
		const days = new Set<string>();
		for (const id of conceptIds) {
			for (const event of await this.evidenceFor(id)) {
				const day = parseIsoDate(event.ts);
				if (day) days.add(day);
			}
		}
		return [...days].sort();
	}

	async setGoalStatus(ref: string, status: GoalStatus): Promise<Goal> {
		const goal = await this.resolveGoal(ref);
		if (!goal) throw new Error(`Unknown goal "${ref}".`);
		const { frontmatter, body } = parseNote(await this.io.read(goal.path));
		frontmatter.status = status;
		await this.io.write(goal.path, serializeNote(frontmatter, body));
		this.changed(goal.path);
		return { ...goal, status };
	}

	/** Goals the learner can pin in the dropdown, with how many concepts are still unbuilt. */
	async goalChoices(): Promise<GoalChoice[]> {
		const out: GoalChoice[] = [];
		for (const g of await this.goals()) {
			if (g.status === "done") continue;
			const report = await this.goalReport(g.id);
			if (report.goal.status === "done") continue;
			if (report.goal.targets.length === 0 && report.goal.built.length > 0) continue;
			out.push({
				id: g.id,
				title: g.title,
				status: g.status,
				left: report.goal.targets.length,
			});
		}
		return out.sort((a, b) => Number(a.status === "paused") - Number(b.status === "paused") || a.title.localeCompare(b.title));
	}

	/** The goal pinned in the dropdown, or null when the learner left it on "you choose". */
	async workingGoal(): Promise<WorkingGoal | null> {
		const title = await this.readFocusTitle();
		if (!title) return null;
		const goal = await this.resolveGoal(title);
		const report = goal && goal.status !== "done" ? await this.goalReport(goal.id) : null;
		const open = report && !(report.goal.targets.length === 0 && report.goal.built.length > 0) && report.goal.status !== "done";
		if (!goal || !report || !open) {
			await this.setWorkingGoal(null);
			return null;
		}
		const today = this.now().toISOString().slice(0, 10);
		return {
			id: goal.id,
			title: goal.title,
			left: report.goal.targets.length,
			status: goal.status,
			due: goal.due,
			daysLeft: goal.due ? daysBetween(today, goal.due) : undefined,
		};
	}

	/** Pin a goal, or pass null / "you choose" to clear the pin. A paused goal is resumed. */
	async setWorkingGoal(ref: string | null): Promise<WorkingGoal | null> {
		const cleared = !ref || /^you choose$/i.test(ref.trim());
		await ensureDir(this.io, PATHS.data);
		if (cleared) {
			await this.io.write(PATHS.focus, `${JSON.stringify({ goal: null })}\n`);
			this.changed(PATHS.focus);
			return null;
		}
		let goal = await this.resolveGoal(ref);
		if (!goal) throw new Error(`Unknown goal "${ref}".`);
		if (goal.status === "paused") goal = await this.setGoalStatus(goal.id, "active");
		if (goal.status === "done") throw new Error(`"${goal.title}" is already done.`);
		await this.io.write(PATHS.focus, `${JSON.stringify({ goal: goal.title })}\n`);
		this.changed(PATHS.focus);
		return this.workingGoal();
	}

	/**
	 * Fold duplicate goals into one. The kept goal gains the others' concepts.
	 * The others are marked done and point at the kept goal. A pin on a folded
	 * goal moves to the kept one.
	 */
	async mergeGoals(keepRef: string, dropRefs: string[]): Promise<GoalReport> {
		const keep = await this.resolveGoal(keepRef);
		if (!keep) throw new Error(`Unknown goal "${keepRef}".`);
		const drops: Goal[] = [];
		for (const ref of dropRefs) {
			const goal = await this.resolveGoal(ref);
			if (!goal) throw new Error(`Unknown goal "${ref}".`);
			if (goal.id === keep.id || drops.some((d) => d.id === goal.id)) continue;
			drops.push(goal);
		}
		if (!drops.length) throw new Error("Name a different goal to merge in.");

		const index = await this.concepts();
		const nodeIds = new Set<string>([...keep.nodes, ...drops.flatMap((d) => d.nodes)]);
		const scopeIds = new Set<string>([...keep.targets, ...keep.built, ...drops.flatMap((d) => [...d.targets, ...d.built])]);
		for (const id of scopeIds) nodeIds.add(id);
		const nodes: GoalInput["nodes"] = [];
		for (const id of nodeIds) {
			const concept = index.get(id);
			if (!concept) continue;
			const levels = [keep.requiredLevels[id], ...drops.map((d) => d.requiredLevels[id])].filter((n): n is number => !!n);
			nodes.push({
				title: concept.title,
				prerequisites: concept.prerequisites.map((p) => index.get(p)?.title).filter((t): t is string => !!t),
				...(levels.length ? { requiredLevel: Math.max(...levels) } : {}),
			});
		}
		const targets = [...scopeIds].map((id) => index.get(id)?.title).filter((t): t is string => !!t);
		if (!targets.length) throw new Error("Those goals have no concepts to merge.");
		const sources = [...keep.sources, ...drops.flatMap((d) => d.sources)];
		const weights = Object.entries(keep.weights)
			.map(([id, weight]) => ({ title: index.get(id)?.title ?? id, weight }))
			.filter((entry) => entry.weight > 0);

		const report = await this.setGoal({
			title: keep.title,
			objective: keep.objective,
			targets,
			nodes,
			examPlan: keep.examPlan,
			due: keep.due,
			...(weights.length ? { weights } : {}),
			...(sources.length ? { sources } : {}),
			status: keep.status === "paused" ? "paused" : "active",
		});
		const mergedFrom = drops.map((d) => `- [[${d.title}]]`).join("\n");
		const keptNote = parseNote(await this.io.read(report.goal.path));
		await this.io.write(
			report.goal.path,
			serializeNote(keptNote.frontmatter, setSection(keptNote.body, "Merged from", mergedFrom, ["Targets", "Built", "Dependency map"])),
		);
		this.changed(report.goal.path);

		const pinned = await this.readFocusTitle();
		for (const drop of drops) {
			await this.setGoalStatus(drop.id, "done");
			const note = parseNote(await this.io.read(drop.path));
			await this.io.write(
				drop.path,
				serializeNote(note.frontmatter, setSection(note.body, "Merged", `Merged into [[${keep.title}]].`, ["Targets", "Built", "Dependency map"])),
			);
			this.changed(drop.path);
		}
		if (pinned && drops.some((d) => d.id === slugify(unwikilink(pinned)) || d.title === pinned)) {
			await this.setWorkingGoal(keep.title);
		}
		return this.goalReport(keep.title);
	}

	private async readFocusTitle(): Promise<string | null> {
		if (!(await this.io.exists(PATHS.focus))) return null;
		try {
			const parsed = JSON.parse(await this.io.read(PATHS.focus)) as { goal?: unknown };
			return typeof parsed.goal === "string" && parsed.goal.trim() ? parsed.goal.trim() : null;
		} catch {
			return null;
		}
	}

	/**
	 * Library operations. The panel calls these instead of opening vault files,
	 * so a cloud backend can implement the same interface later.
	 */
	async listChats(): Promise<StoredChat[]> {
		if (!(await this.io.exists(PATHS.chats))) return [];
		const out: StoredChat[] = [];
		for (const file of (await this.io.list(PATHS.chats)).files) {
			if (!file.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await this.io.read(file)) as Partial<StoredChat>;
				if (!parsed || typeof parsed.id !== "string") continue;
				out.push(parsed as StoredChat);
			} catch {
				// ignore unreadable chat files
			}
		}
		return out.sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
	}

	/** Removes the conversation and its session transcript. Concepts and evidence stay. */
	async deleteChat(id: string): Promise<void> {
		if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) throw new Error("Unknown conversation.");
		const removed: string[] = [];
		const notePaths = new Set<string>();
		if (await this.io.exists(PATHS.chats)) {
			for (const file of (await this.io.list(PATHS.chats)).files) {
				if (!file.endsWith(".json")) continue;
				let match = file === `${PATHS.chats}/${id}.json`;
				try {
					const parsed = JSON.parse(await this.io.read(file)) as { id?: string; notePath?: string };
					if (parsed.id === id) match = true;
					if (match && typeof parsed.notePath === "string" && parsed.notePath && !parsed.notePath.includes("..")) notePaths.add(parsed.notePath);
				} catch {
					// still remove a file whose name is this conversation
				}
				if (!match) continue;
				await this.io.remove(file);
				removed.push(file);
			}
		}
		if (await this.io.exists(PATHS.sessions)) {
			for (const path of await listMarkdown(this.io, PATHS.sessions)) {
				try {
					const { frontmatter } = parseNote(await this.io.read(path));
					if (frontmatter.chat === id) notePaths.add(path);
				} catch {
					// skip unreadable notes
				}
			}
		}
		for (const path of notePaths) {
			if (!(await this.io.exists(path))) continue;
			await this.io.remove(path);
			removed.push(path);
		}
		if (removed.length) this.changed(...removed);
	}

	/**
	 * Removes the concept note and its quiz evidence, and drops it from other concepts' prerequisites and from goals.
	 * Goals that named it keep their other concepts and any source files.
	 */
	async deleteConcept(ref: string): Promise<void> {
		const concept = await this.resolve(ref);
		if (!concept) throw new Error(`Unknown concept "${ref}".`);
		const touched: string[] = [];

		for (const other of (await this.concepts()).values()) {
			if (!other.prerequisites.includes(concept.id)) continue;
			const { frontmatter, body } = parseNote(await this.io.read(other.path));
			const next = other.prerequisites.filter((p) => p !== concept.id);
			if (next.length) {
				const index = await this.concepts();
				frontmatter.prerequisites = next.map((p) => wikilink(index.get(p)?.title ?? p));
			} else delete frontmatter.prerequisites;
			await this.io.write(other.path, serializeNote(frontmatter, body));
			touched.push(other.path);
		}

		const affectedGoals: string[] = [];
		for (const goal of await this.goals()) {
			const mentioned = goal.nodes.includes(concept.id) || goal.targets.includes(concept.id) || goal.built.includes(concept.id) || concept.id in goal.requiredLevels;
			if (!mentioned) continue;
			const { frontmatter, body } = parseNote(await this.io.read(goal.path));
			const nodes = dropWikilinks(frontmatter.nodes, concept.id);
			const built = dropWikilinks(frontmatter.built, concept.id);
			frontmatter.nodes = nodes.length ? nodes : undefined;
			frontmatter.built = built.length ? built : undefined;
			if (frontmatter.targets && typeof frontmatter.targets === "object" && !Array.isArray(frontmatter.targets)) {
				frontmatter.targets = dropRequiredKey(frontmatter.targets, concept.id);
			} else {
				const targets = dropWikilinks(frontmatter.targets, concept.id);
				frontmatter.targets = targets.length ? targets : undefined;
			}
			if (frontmatter.required && typeof frontmatter.required === "object") frontmatter.required = dropRequiredKey(frontmatter.required, concept.id);
			if (typeof frontmatter.target === "string" && slugify(unwikilink(frontmatter.target)) === concept.id) delete frontmatter.target;
			await this.io.write(goal.path, serializeNote(frontmatter, body));
			touched.push(goal.path);
			affectedGoals.push(goal.id);
		}

		const evidence = this.evidencePath(concept.id);
		if (await this.io.exists(evidence)) {
			await this.io.remove(evidence);
			touched.push(evidence);
		}
		await this.io.remove(concept.path);
		touched.push(concept.path);
		this.invalidate();
		if (touched.length) this.changed(...touched);
		for (const id of affectedGoals) await this.renderGoal(id);
	}

	/** Removes the goal note only. Concepts and evidence are shared, so they stay. Clears the pin when it was this goal. */
	async deleteGoal(ref: string): Promise<void> {
		const goal = await this.resolveGoal(ref);
		if (!goal) throw new Error(`Unknown goal "${ref}".`);
		const pin = await this.readFocusTitle();
		await this.io.remove(goal.path);
		this.changed(goal.path);
		if (pin && (slugify(unwikilink(pin)) === goal.id || pin === goal.title)) await this.setWorkingGoal(null);
	}

	/**
	 * Deletes goals, concepts, chats, session notes, exam plans, practice tests,
	 * quiz evidence, the working-goal pin, and extra tutor notes, then restores
	 * `learner.md`. Leaves `resources/` and vault config in place.
	 */
	async resetVault(): Promise<void> {
		const removed: string[] = [];
		for (const dir of [PATHS.concepts, PATHS.goals, PATHS.exams, PATHS.tests, PATHS.sessions, PATHS.evidence, PATHS.chats]) {
			for (const file of await listAllFiles(this.io, dir)) {
				if (file.endsWith(".gitkeep")) continue;
				await this.io.remove(file);
				removed.push(file);
			}
		}
		for (const file of [PATHS.focus, PATHS.tutorContext]) {
			if (!(await this.io.exists(file))) continue;
			await this.io.remove(file);
			removed.push(file);
		}
		await this.io.write(PATHS.learner, DEFAULT_LEARNER_PROFILE);
		removed.push(PATHS.learner);
		this.invalidate();
		this.changed(...removed);
	}

	/** Extra notes the learner wrote for the tutor. Empty when they have not written any. */
	async tutorContext(): Promise<string> {
		if (!(await this.io.exists(PATHS.tutorContext))) return "";
		return (await this.io.read(PATHS.tutorContext)).trim();
	}

	/** Saves extra tutor context, or removes it when the text is blank. Does not touch `learner.md`. */
	async setTutorContext(text: string): Promise<string> {
		const value = text.trim();
		if (!value) {
			if (await this.io.exists(PATHS.tutorContext)) {
				await this.io.remove(PATHS.tutorContext);
				this.changed(PATHS.tutorContext);
			}
			return "";
		}
		await ensureDir(this.io, PATHS.data);
		await this.io.write(PATHS.tutorContext, `${value}\n`);
		this.changed(PATHS.tutorContext);
		return value;
	}

	async ingestExamMaterials(input: IngestExamInput): Promise<{ blueprint: ExamBlueprint; planPath?: string; goal?: GoalReport }> {
		const loaded: MaterialSource[] = [];
		for (const path of input.files ?? []) {
			try {
				loaded.push(await materialFromVaultFile(this.io, path));
			} catch {
				loaded.push({ name: path, path, kind: "unknown", text: "" });
			}
		}
		for (const m of input.materials ?? []) {
			loaded.push({
				name: m.name,
				path: m.path,
				kind: m.kind ?? classifyMaterial(m.name, m.text),
				text: m.text,
			});
		}
		const blueprint = buildExamBlueprint(loaded, { title: input.title, userText: input.userText });
		let planPath: string | undefined;
		if (blueprint.topics.length) {
			await ensureDir(this.io, PATHS.exams);
			const existing = await this.resolveExamPlan(blueprint.title);
			planPath = existing ?? (await this.uniquePath(PATHS.exams, safeFileName(blueprint.title)));
			const prior = existing ? parseNote(await this.io.read(existing)) : { frontmatter: {}, body: "" };
			const fm = {
				...prior.frontmatter,
				title: blueprint.title,
				type: "exam",
				kind: blueprint.examKind,
				materials: blueprint.materials.map((m) => (m.path ? wikilink(m.path) : m.name)),
				tags: ["groundwork/exam"],
			};
			await this.writeFile(planPath, serializeNote(fm, formatExamPlanMarkdown(blueprint)));
		}
		let goal: GoalReport | undefined;
		if (input.createGoal !== false && blueprint.topics.length) {
			const gi = blueprintToGoalInput(blueprint, loaded, input.why);
			if (planPath) gi.examPlan = blueprint.title;
			const refined = await refineGoalInput(this, gi, "proposed");
			goal = await this.setGoal(refined.input, { judgments: "off" });
			if (refined.notes.length) goal = { ...goal, judgmentNotes: refined.notes };
		}
		return { blueprint, planPath, goal };
	}

	async resolveExamPlan(ref: string): Promise<string | undefined> {
		const id = slugify(unwikilink(ref));
		if (!(await this.io.exists(PATHS.exams))) return undefined;
		for (const path of await listMarkdown(this.io, PATHS.exams)) {
			const { frontmatter } = parseNote(await this.io.read(path));
			const title = typeof frontmatter.title === "string" ? frontmatter.title : path.split("/").pop()!.replace(/\.md$/, "");
			if (slugify(title) === id) return path;
		}
		return undefined;
	}

	async examPlans(): Promise<Array<{ title: string; path: string; kind?: string }>> {
		if (!(await this.io.exists(PATHS.exams))) return [];
		const out = [];
		for (const path of await listMarkdown(this.io, PATHS.exams)) {
			const { frontmatter } = parseNote(await this.io.read(path));
			const title = typeof frontmatter.title === "string" ? frontmatter.title : path.split("/").pop()!.replace(/\.md$/, "");
			out.push({ title, path, kind: typeof frontmatter.kind === "string" ? frontmatter.kind : undefined });
		}
		return out;
	}

	/** Saved practice-test evaluations, newest first. */
	async practiceTests(): Promise<Array<{ title: string; path: string; date?: string; score?: string; weakest?: string[] }>> {
		if (!(await this.io.exists(PATHS.tests))) return [];
		const out = [];
		for (const path of await listMarkdown(this.io, PATHS.tests)) {
			const { frontmatter: fm } = parseNote(await this.io.read(path));
			out.push({
				title: typeof fm.title === "string" ? fm.title : path.split("/").pop()!.replace(/\.md$/, ""),
				path,
				date: typeof fm.date === "string" ? fm.date : undefined,
				score: typeof fm.score === "string" ? fm.score : undefined,
				weakest: asStringList(fm.weakest).map(unwikilink),
			});
		}
		return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.path.localeCompare(a.path));
	}

	async goalReport(ref: string): Promise<GoalReport> {
		const stored = await this.resolveGoal(ref);
		if (!stored) throw new Error(`Unknown goal "${ref}".`);
		const index = await this.concepts();
		const classified = classifyScope(stored, index);
		const goal: Goal = { ...stored, targets: classified.targets, built: classified.built };
		const inGoal = new Set(goal.nodes);
		const open = new Set(goal.targets);
		const built = new Set(goal.built);
		const nodes = goal.nodes
			.map((id) => index.get(id))
			.filter((c): c is Concept => !!c)
			.map((c) => ({
				id: c.id,
				title: c.title,
				prerequisites: c.prerequisites.filter((p) => inGoal.has(p)),
				status: c.stats.status,
				current: c.stats.current,
				edge: describeEdge(c.stats),
				nextReview: c.stats.nextReview,
				openMisconceptions: c.stats.openMisconceptions,
				floor: c.stats.floor,
				role: (open.has(c.id) ? "target" : built.has(c.id) ? "built" : "path") as "target" | "built" | "path",
			}));
		const report: GoalReport = {
			goal,
			nodes,
			analysis: analyzeGoal(nodes, (n) => isBuilt(n.status, nodes.find((x) => x.id === n.id)?.floor, goal.requiredLevels[n.id])),
			mermaid: goalMermaid(nodes, goal.targets, goal.built),
		};
		report.next = bestGoalStep(report);
		return report;
	}

	/** Regenerates the goal note: open targets, what is already built, and the map. */
	async renderGoal(ref: string): Promise<GoalReport> {
		const report = await this.goalReport(ref);
		let goal = report.goal;
		const scope = goal.targets.length + goal.built.length;
		if (goal.status === "active" && scope > 0 && goal.targets.length === 0) goal = { ...goal, status: "done" };
		const { frontmatter, body } = parseNote(await this.io.read(goal.path));
		const name = (id: string) => report.nodes.find((n) => n.id === id)?.title ?? id;
		frontmatter.status = goal.status;
		frontmatter.progress = describeGoalProgress(goal);
		frontmatter.targets = goal.targets.length ? goal.targets.map((id) => wikilink(name(id))) : undefined;
		frontmatter.built = goal.built.length ? goal.built.map((id) => wikilink(name(id))) : undefined;
		const required: Record<string, number> = {};
		for (const [id, level] of Object.entries(goal.requiredLevels)) required[name(id)] = level;
		frontmatter.required = Object.keys(required).length ? required : undefined;
		delete frontmatter.target;

		const { analysis, mermaid } = report;
		const lines = [
			"```mermaid",
			mermaid,
			"```",
			"",
			"> [!info] Legend",
			"> Hexagons are targets (not built yet). Rounded nodes are targets already built. Rectangles are steps on the way. Arrows point from a prerequisite to what it unlocks. Green = solid, amber = shaky, orange = learning, purple = rusty (review due), grey = not assessed yet.",
			"",
			`### Progress — ${describeGoalProgress(goal)}`,
			"",
			"| Concept | Role | Status | Now | Edge | Need |",
			"| --- | --- | --- | --- | --- | --- |",
			...analysis.order.map((n) => {
				const r = report.nodes.find((x) => x.id === n.id)!;
				const pct = n.status === "unassessed" ? "—" : `${Math.round(n.current * 100)}%`;
				const need = goal.requiredLevels[n.id] ? `d${goal.requiredLevels[n.id]}` : "—";
				return `| [[${n.title}]] | ${r.role} | ${n.status} | ${pct} | ${r.edge} | ${need} |`;
			}),
			"",
			goal.targets.length === 0
				? "**Ready to learn next:** nothing — every target is built."
				: analysis.frontier.length
					? `**Ready to learn next:** ${analysis.frontier.map((n) => `[[${n.title}]]`).join(", ")}`
					: "**Ready to learn next:** nothing is ready — a prerequisite is still in the way.",
		];
		let nextBody = setSection(body, "Targets", targetsSection(report, goal), ["Targets", "Built", "Dependency map"]);
		nextBody = setSection(nextBody, "Built", builtSection(report, goal), ["Dependency map"]);
		nextBody = setSection(nextBody, "Dependency map", lines.join("\n"));
		await this.io.write(goal.path, serializeNote(frontmatter, nextBody));
		this.changed(goal.path);
		return { ...report, goal };
	}

	/**
	 * The single best next concept: an open target that is ready, otherwise the
	 * step that unblocks one, otherwise a due review (goal-path first).
	 */
	async studyNext(): Promise<StudyStep | null> {
		const ranked: Array<{ rank: number; step: StudyStep }> = [];
		const active = (await this.goals()).filter((g) => g.status === "active");
		const reports: GoalReport[] = [];
		for (const g of active) reports.push(await this.goalReport(g.id));
		for (const report of reports) ranked.push(...rankGoalSteps(report));
		const goalOf = new Map<string, string>();
		for (const report of reports) for (const n of report.nodes) if (!goalOf.has(n.id)) goalOf.set(n.id, report.goal.title);
		const seen = new Set(ranked.map((r) => r.step.concept));
		for (const c of await this.dueReviews(8)) {
			if (seen.has(c.title)) continue;
			const goal = goalOf.get(c.id);
			ranked.push({
				rank: goal ? 4 : 5,
				step: {
					action: "review",
					concept: c.title,
					goal,
					why: goal ? `${c.title} is due for review, and “${goal}” builds on it.` : `${c.title} is due for review.`,
				},
			});
			seen.add(c.title);
		}
		if (!ranked.length) {
			for (const c of (await this.concepts()).values()) {
				if (!c.stats.openMisconceptions.length) continue;
				ranked.push({
					rank: 6,
					step: {
						action: "repair",
						concept: c.title,
						why: `${c.title} still carries a wrong belief (${c.stats.openMisconceptions[0]}).`,
					},
				});
				break;
			}
		}
		ranked.sort((a, b) => a.rank - b.rank);
		if (!ranked.length) return null;
		const top = ranked.filter((r) => r.rank === ranked[0].rank).map((r) => r.step);
		return (await pickReadyStep(this.judgments(), top)) ?? ranked[0].step;
	}

	/** The ready step on this goal. When several share the top rank, a judgment may choose among them. */
	async chooseNext(report: GoalReport): Promise<StudyStep | undefined> {
		const ranked = rankGoalSteps(report).sort((a, b) => a.rank - b.rank);
		if (!ranked.length) return undefined;
		const top = ranked.filter((r) => r.rank === ranked[0].rank).map((r) => r.step);
		return pickReadyStep(this.judgments(), top, report.goal.objective);
	}

	private async refreshGoalsContaining(id: string): Promise<void> {
		for (const g of await this.goals()) if (g.nodes.includes(id)) await this.renderGoal(g.id);
	}

	// ── learner profile ──────────────────────────────────────────────────

	async profile(): Promise<string> {
		if (!(await this.io.exists(PATHS.learner))) return DEFAULT_LEARNER_PROFILE;
		return this.io.read(PATHS.learner);
	}

	async updateProfile(section: string, content: string, mode: "append" | "replace"): Promise<string> {
		const text = await this.profile();
		const { frontmatter, body } = parseNote(text);
		const existing = getSection(body, section) ?? "";
		const next = mode === "append" && existing ? `${existing}\n${content.trim()}` : content;
		const newBody = setSection(body, section, next);
		const out = Object.keys(frontmatter).length ? serializeNote(frontmatter, newBody) : newBody;
		await this.io.write(PATHS.learner, out);
		this.changed(PATHS.learner);
		return getSection(newBody, section) ?? "";
	}

	/** Replaces `learner.md`. A blank edit restores the default profile. */
	async setProfile(text: string): Promise<string> {
		const value = text.replace(/\s+$/, "");
		const out = value ? `${value}\n` : DEFAULT_LEARNER_PROFILE;
		await this.io.write(PATHS.learner, out);
		this.changed(PATHS.learner);
		return out;
	}

	// ── search / overview ───────────────────────────────────────────────

	async search(query: string, limit = 12): Promise<Array<{ kind: "concept" | "goal" | "exam"; title: string; score: number; concept?: Concept }>> {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) return [];
		const scored: Array<{ kind: "concept" | "goal" | "exam"; title: string; score: number; concept?: Concept }> = [];
		const score = (title: string, text: string) => {
			const t = title.toLowerCase();
			const b = text.toLowerCase();
			let s = 0;
			for (const term of terms) {
				if (t.includes(term)) s += 5;
				if (b.includes(term)) s += 1;
			}
			return s;
		};
		for (const c of (await this.concepts()).values()) {
			const s = score([c.title, ...c.aliases, c.domain ?? ""].join(" "), c.body);
			if (s > 0) scored.push({ kind: "concept", title: c.title, score: s, concept: c });
		}
		for (const g of await this.goals()) {
			const s = score(g.title, g.body);
			if (s > 0) scored.push({ kind: "goal", title: g.title, score: s });
		}
		for (const e of await this.examPlans()) {
			const body = await this.io.read(e.path);
			const s = score(e.title, body);
			if (s > 0) scored.push({ kind: "exam", title: e.title, score: s });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	async overview() {
		const concepts = [...(await this.concepts()).values()];
		const counts: Record<string, number> = { solid: 0, shaky: 0, learning: 0, rusty: 0, unassessed: 0 };
		for (const c of concepts) counts[c.stats.status]++;
		const goals = await this.goals();
		const active = [];
		const otherGoals: Array<{ title: string; status: GoalStatus }> = [];
		for (const g of goals) {
			if (g.status === "paused") {
				otherGoals.push({ title: g.title, status: "paused" });
				continue;
			}
			if (g.status === "done") {
				otherGoals.push({ title: g.title, status: "done" });
				continue;
			}
			const r = await this.goalReport(g.id);
			const complete = r.goal.targets.length === 0 && r.goal.built.length > 0;
			if (complete) {
				otherGoals.push({ title: g.title, status: "done" });
				continue;
			}
			const titleOf = (id: string) => r.nodes.find((n) => n.id === id)?.title ?? id;
			active.push({
				title: g.title,
				objective: g.objective,
				sources: g.sources,
				targets: r.goal.targets.map(titleOf),
				built: r.goal.built.map(titleOf),
				progress: describeGoalProgress(r.goal),
				next: r.analysis.frontier.map((n) => n.title),
			});
		}
		const recent = concepts
			.filter((c) => c.stats.lastEvidence)
			.sort((a, b) => (b.stats.lastEvidence ?? "").localeCompare(a.stats.lastEvidence ?? ""))
			.slice(0, 8);
		return {
			profile: await this.profile(),
			tutorContext: await this.tutorContext(),
			conceptCount: concepts.length,
			counts,
			activeGoals: active,
			otherGoals,
			workingGoal: await this.workingGoal(),
			nextUp: await this.studyNext(),
			dueReviews: (await this.dueReviews(10)).map(conceptSummary),
			recentlyPracticed: recent.map(conceptSummary),
			openMisconceptions: concepts
				.filter((c) => c.stats.openMisconceptions.length)
				.map((c) => ({ concept: c.title, misconceptions: c.stats.openMisconceptions })),
			examPlans: await this.examPlans(),
			practiceTests: (await this.practiceTests()).slice(0, 5),
		};
	}

	// ── sessions ─────────────────────────────────────────────────────────

	async sessionNotePath(title: string, date: Date = this.now()): Promise<string> {
		await ensureDir(this.io, PATHS.sessions);
		return this.uniquePath(PATHS.sessions, safeFileName(`${date.toISOString().slice(0, 10)} ${title}`));
	}

	async writeFile(path: string, content: string): Promise<void> {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir) await ensureDir(this.io, dir);
		await this.io.write(path, content);
		this.changed(path);
	}
}

export function conceptSummary(c: Concept) {
	return {
		title: c.title,
		status: c.stats.status,
		now: c.stats.attempts ? `${Math.round(c.stats.current * 100)}%` : "unassessed",
		edge: describeEdge(c.stats),
		lastPracticed: c.stats.lastEvidence?.slice(0, 10),
		nextReview: c.stats.nextReview?.slice(0, 10),
	};
}

function statsFrontmatter(stats: ConceptStats) {
	return {
		status: stats.status,
		now: stats.attempts ? Math.round(stats.current * 100) : null,
		mastery: stats.attempts ? Math.round(stats.mastery * 100) : null,
		attempts: stats.attempts,
		last_practiced: stats.lastEvidence?.slice(0, 10) ?? null,
		next_review: stats.nextReview?.slice(0, 10) ?? null,
		edge: describeEdge(stats),
		misconceptions: stats.openMisconceptions.length ? stats.openMisconceptions : undefined,
	};
}

function applySections(body: string, input: ConceptInput): string {
	let out = body;
	const set = (heading: string, content?: string) => {
		if (content) out = setSection(out, heading, demoteHeadings(content), ["Quiz history"]);
	};
	set("Summary", input.summary);
	set("Unconditional truths", input.unconditionalTruths);
	set("How it connects", input.connections);
	set("Misconceptions to watch", input.misconceptions);
	set("Notes", input.notes);
	return out;
}

function historyTable(evidence: Evidence[]): string {
	const icon = { correct: "✅", partial: "🟡", incorrect: "❌", dont_know: "❔" } as const;
	const rows = [...evidence]
		.sort((a, b) => b.ts.localeCompare(a.ts))
		.slice(0, 15)
		.map((e) => {
			const q = (e.question ?? e.note ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 140);
			const miss = e.misconception ? ` — *${e.misconception.replace(/\|/g, "\\|")}*` : "";
			return `| ${e.ts.slice(0, 10)} | ${icon[e.outcome]}${e.slip ? " slip" : ""} | d${e.difficulty} ${e.kind} | ${q}${miss} |`;
		});
	return ["| Date | | Level | Question |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

async function listMarkdown(io: VaultIO, dir: string): Promise<string[]> {
	const out: string[] = [];
	const { files, folders } = await io.list(dir);
	for (const f of files) if (f.endsWith(".md")) out.push(f);
	for (const sub of folders) out.push(...(await listMarkdown(io, sub)));
	return out.sort();
}

async function listAllFiles(io: VaultIO, dir: string): Promise<string[]> {
	if (!(await io.exists(dir))) return [];
	const out: string[] = [];
	const { files, folders } = await io.list(dir);
	out.push(...files);
	for (const sub of folders) out.push(...(await listAllFiles(io, sub)));
	return out;
}

function asStringList(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string" && v.trim()) return [v];
	return [];
}

function normalizeSources(sources: string[]): string[] {
	const out: string[] = [];
	for (const raw of sources) {
		const s = unwikilink(raw).trim();
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

function dropWikilinks(v: unknown, id: string): string[] {
	return asStringList(v).filter((item) => slugify(unwikilink(item)) !== id);
}

function dropRequiredKey(v: unknown, id: string): Record<string, number> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, number> = {};
	for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
		if (slugify(unwikilink(k)) === id) continue;
		const level = typeof n === "number" ? n : Number(n);
		if (Number.isFinite(level)) out[k] = level;
	}
	return Object.keys(out).length ? out : undefined;
}

export function describeGoalProgress(goal: Pick<Goal, "targets" | "built">): string {
	const total = goal.targets.length + goal.built.length;
	if (!total) return "no targets";
	return `${goal.built.length}/${total} targets built`;
}

function goalTargetTitles(input: GoalInput): string[] {
	const listed = (input.targets ?? []).map((t) => t.trim()).filter(Boolean);
	if (listed.length) return listed;
	if (input.target?.trim()) return [input.target.trim()];
	return [];
}

/** New notes store targets as a list. Older notes stored one `target` and a level map under `targets`. */
function readWeights(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const weight = typeof raw === "number" ? raw : Number(raw);
		const id = slugify(unwikilink(key));
		if (id && Number.isFinite(weight) && weight > 0) out[id] = weight;
	}
	return out;
}

function readGoalShape(fm: Record<string, unknown>): { targets: string[]; built: string[]; requiredLevels: Record<string, number> } {
	const built = asStringList(fm.built).map((n) => slugify(unwikilink(n))).filter(Boolean);
	const field = fm.targets;
	const legacyLevels = !!field && typeof field === "object" && !Array.isArray(field);
	const requiredLevels = parseRequiredLevels(legacyLevels ? field : fm.required);
	let targets = legacyLevels ? [] : asStringList(field).map((n) => slugify(unwikilink(n))).filter(Boolean);
	if (!targets.length && !built.length && typeof fm.target === "string") {
		const id = slugify(unwikilink(fm.target));
		if (id) targets = [id];
	}
	return { targets, built, requiredLevels };
}

function classifyScope(goal: Goal, index: Map<string, Concept>): { targets: string[]; built: string[] } {
	const scope = [...new Set([...goal.targets, ...goal.built])];
	if (goal.status === "done") return { targets: [], built: scope };
	const targets: string[] = [];
	const built: string[] = [];
	for (const id of scope) {
		const c = index.get(id);
		if (c && isBuilt(c.stats.status, c.stats.floor, goal.requiredLevels[id])) built.push(id);
		else targets.push(id);
	}
	return { targets, built };
}

function conceptBullet(report: GoalReport, id: string): string {
	const n = report.nodes.find((x) => x.id === id);
	if (!n) return `- [[${id}]]`;
	const pct = n.status === "unassessed" ? "not assessed" : `${Math.round(n.current * 100)}%`;
	const need = report.goal.requiredLevels[id] ? `, need d${report.goal.requiredLevels[id]}` : "";
	return `- [[${n.title}]] — ${n.status}, ${pct}${need}. ${n.edge}.`;
}

function targetsSection(report: GoalReport, goal: Goal): string {
	if (!goal.targets.length) return "Every target has been built.";
	return ["These are the concepts this goal is made of that are not built yet.", "", ...goal.targets.map((id) => conceptBullet(report, id))].join("\n");
}

function builtSection(report: GoalReport, goal: Goal): string {
	if (!goal.built.length) return "Nothing on this goal is built yet.";
	return goal.built.map((id) => conceptBullet(report, id)).join("\n");
}

function rankGoalSteps(report: GoalReport): Array<{ rank: number; step: StudyStep }> {
	const open = new Set(report.goal.targets);
	if (!open.size) return [];
	const byId = new Map(report.nodes.map((n) => [n.id, n]));
	const out: Array<{ rank: number; step: StudyStep }> = [];
	for (const n of report.analysis.frontier) {
		const served = targetsServed(n.id, report.nodes, open);
		if (!served.length) continue;
		const node = byId.get(n.id)!;
		const viaNames = served.filter((id) => id !== n.id).map((id) => byId.get(id)?.title ?? id);
		const via = viaNames.length ? ` on the way to ${viaNames.join(", ")}` : "";
		const need = report.goal.requiredLevels[n.id];
		const depth = need ? ` Needs level ${need}.` : "";
		if (node.openMisconceptions.length) {
			out.push({
				rank: 0,
				step: {
					action: "repair",
					concept: n.title,
					goal: report.goal.title,
					why: `${n.title} still carries a wrong belief (${node.openMisconceptions[0]})${via}.`,
				},
			});
		} else if (n.status === "rusty") {
			out.push({
				rank: 1,
				step: {
					action: "review",
					concept: n.title,
					goal: report.goal.title,
					why: open.has(n.id) ? `${n.title} is a target of this goal, and it has faded.` : `${n.title} has faded${via}. Review it before building on it.`,
				},
			});
		} else if (open.has(n.id)) {
			out.push({
				rank: 2,
				step: {
					action: "build",
					concept: n.title,
					goal: report.goal.title,
					why: `${n.title} is a target, and what it depends on is in place.${depth}`,
				},
			});
		} else {
			out.push({
				rank: 3,
				step: {
					action: "build",
					concept: n.title,
					goal: report.goal.title,
					why: `${n.title} is the next step${via}.${depth}`,
				},
			});
		}
	}
	return out;
}

function bestGoalStep(report: GoalReport): StudyStep | undefined {
	const ranked = rankGoalSteps(report).sort((a, b) => a.rank - b.rank);
	return ranked[0]?.step;
}

function parseRequiredLevels(v: unknown): Record<string, number> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: Record<string, number> = {};
	for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
		const level = typeof n === "number" ? n : Number(n);
		if (Number.isFinite(level)) out[slugify(unwikilink(k))] = clampLevel(level);
	}
	return out;
}

function clampLevel(n: number): number {
	return Math.min(5, Math.max(1, Math.round(n)));
}

export const DEFAULT_LEARNER_PROFILE = `# Learner profile

The tutor reads this at the start of every session and may append to it. Edit freely.

## Background

(What you already know well, your field, the kinds of math you're comfortable with.)

## How I learn best

- Build from unconditional truths; show me how I could have discovered each step.
- Teach me forward, one concept at a time toward the goal, with a quick check on each new step.
- Mention careless slips, but don't treat them as gaps.

## Observations

`;
