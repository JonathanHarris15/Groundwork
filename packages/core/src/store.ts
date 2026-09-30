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
}

/** Dropdown label, e.g. "427 exam → 10 concepts left". */
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
	objective?: string;
	body: string;
	/** Concept id → exam-required quiz difficulty (1–5). */
	requiredLevels: Record<string, number>;
	examPlan?: string;
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
	nodes: Array<{ title: string; prerequisites?: string[]; summary?: string; domain?: string; requiredLevel?: number }>;
	status?: GoalStatus;
	examPlan?: string;
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
}

export interface StoreOptions {
	now?: () => Date;
	device?: string;
	/** Called after any write so hosts can schedule a git sync. */
	onChange?: (paths: string[]) => void;
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
		const title = input.title.trim();
		if (!slugify(title)) throw new Error("Concept title must contain letters or numbers.");
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
				objective: getSection(body, "Objective"),
				body,
				requiredLevels: shape.requiredLevels,
				examPlan: typeof fm.exam === "string" ? unwikilink(fm.exam) : undefined,
			});
		}
		return out;
	}

	async resolveGoal(ref: string): Promise<Goal | undefined> {
		const id = slugify(unwikilink(ref));
		return (await this.goals()).find((g) => g.id === id);
	}

	async setGoal(input: GoalInput): Promise<GoalReport> {
		const named = goalTargetTitles(input);
		if (!named.length) throw new Error("A goal is made of targets: name at least one concept that has not been built yet.");
		const nodeTitles = new Map<string, string>();
		for (const node of input.nodes) {
			await this.upsertConcept({
				title: node.title,
				prerequisites: node.prerequisites,
				summary: node.summary,
				domain: node.domain,
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

		await ensureDir(this.io, PATHS.goals);
		const existing = await this.resolveGoal(input.title);
		const path = existing?.path ?? (await this.uniquePath(PATHS.goals, safeFileName(input.title)));
		const prior = existing ? parseNote(await this.io.read(path)) : { frontmatter: {}, body: `# ${input.title}\n` };
		let body = prior.body;
		const generated = ["Targets", "Built", "Dependency map"];
		if (input.objective) body = setSection(body, "Objective", demoteHeadings(input.objective), generated);
		if (input.why) body = setSection(body, "Why", demoteHeadings(input.why), generated);
		if (input.approach) body = setSection(body, "Approach", demoteHeadings(input.approach), generated);
		const fm: Record<string, unknown> = {
			...prior.frontmatter,
			title: input.title,
			type: "goal",
			status: input.status ?? existing?.status ?? "active",
			created: existing?.created ?? this.now().toISOString().slice(0, 10),
			targets: scopeTitles.map(wikilink),
			nodes: [...nodeTitles.values()].map(wikilink),
			required: Object.keys(required).length ? required : undefined,
			exam: input.examPlan ? wikilink(input.examPlan) : existing?.examPlan ? wikilink(existing.examPlan) : prior.frontmatter.exam,
			tags: ["groundwork/goal"],
		};
		delete fm.target;
		delete fm.built;
		await this.io.write(path, serializeNote(fm, body));
		this.changed(path);
		return this.renderGoal(slugify(input.title));
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
		return { id: goal.id, title: goal.title, left: report.goal.targets.length, status: goal.status };
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

		const report = await this.setGoal({
			title: keep.title,
			objective: keep.objective,
			targets,
			nodes,
			examPlan: keep.examPlan,
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
			goal = await this.setGoal(gi);
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
		return ranked[0]?.step ?? null;
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

function asStringList(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string" && v.trim()) return [v];
	return [];
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
