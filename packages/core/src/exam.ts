import { basename, loadVaultFile, type VaultFile } from "./files";
import { slugify } from "./markdown";
import type { VaultIO } from "./io";
import type { GoalInput } from "./store";

export type MaterialKind = "lecture" | "homework" | "study_guide" | "practice_exam" | "exam" | "notes" | "unknown";

export interface MaterialSource {
	name: string;
	path?: string;
	kind: MaterialKind;
	text: string;
}

export interface ExamTopic {
	title: string;
	ideas: string[];
	/** Quiz difficulty 1–5 the exam appears to require. */
	requiredLevel: number;
	sources: string[];
	evidence: string[];
}

export interface ExamBlueprint {
	title: string;
	courseGuess?: string;
	examKind: "practice" | "midterm" | "final" | "quiz" | "unspecified";
	materials: Array<{ name: string; kind: MaterialKind; path?: string; topicCount: number; excerpt: string }>;
	topics: ExamTopic[];
	/** Titles that show up on an exam, practice exam, or study guide — the ones that must be exam-ready. */
	mustKnow: string[];
	notes: string[];
}

export function classifyMaterial(name: string, text = ""): MaterialKind {
	const s = `${name} ${text.slice(0, 800)}`.toLowerCase();
	if (/\b(study[\s_-]*guide|review[\s_-]*sheet|cheat[\s_-]*sheet|formula[\s_-]*sheet)\b/.test(s)) return "study_guide";
	if (/\b(practice|sample|mock)\s*(exam|midterm|final|test|quiz)\b/.test(s) || /\bexam\s*(prep|practice|review)\b/.test(s)) return "practice_exam";
	if (/\b(midterm|final\s+exam|in[- ]class\s+exam)\b/.test(s) || (/\bexam\b/.test(s) && /\b(points?|pts\.?|name:|honor\s+code)\b/.test(s))) return "exam";
	if (/\b(homework|problem\s+set|pset|assignment|worksheet)\b/.test(s) || /\bhw\s*\d+\b/.test(s)) return "homework";
	if (/\b(lecture|slides?|deck|week\s*\d+)\b/.test(s)) return "lecture";
	if (/\b(notes?|handout|reading)\b/.test(s)) return "notes";
	if (/\b(exam|midterm|final|quiz)\b/.test(s)) return /\bpractice|sample|mock\b/.test(s) ? "practice_exam" : "exam";
	return "unknown";
}

export function looksLikeCoursework(name: string, text = ""): boolean {
	const kind = classifyMaterial(name, text);
	if (kind !== "unknown") return true;
	return /\b(problem\s+\d+|q\s*\d+|compute|prove|differentiate|evaluate|define|theorem|chapter)\b/i.test(`${name}\n${text.slice(0, 1500)}`);
}

export function shouldAutoIngest(names: string[], userText = ""): boolean {
	if (/\b(exam|midterm|final|quiz|homework|pset|study\s*guide|prep(?:are|ping)?)\b/i.test(userText)) return names.length > 0;
	const coursework = names.filter((n) => looksLikeCoursework(n));
	return coursework.length > 0;
}

const LEVEL_WORDS: Array<{ re: RegExp; level: number }> = [
	{ re: /\b(prove|derive|design|show that|if and only if|counterexample)\b/i, level: 5 },
	{ re: /\b(combine|multi[- ]step|hence|therefore|using both|and then)\b/i, level: 4 },
	{ re: /\b(compute|evaluate|differentiate|integrate|solve|apply|find|simplify|calculate)\b/i, level: 3 },
	{ re: /\b(define|state|what is|list|name the|identify)\b/i, level: 2 },
];

const KIND_FLOOR: Record<MaterialKind, number> = {
	lecture: 2,
	notes: 2,
	homework: 3,
	study_guide: 3,
	practice_exam: 4,
	exam: 4,
	unknown: 2,
};

export function inferLevel(kind: MaterialKind, text: string): number {
	let level = KIND_FLOOR[kind];
	for (const { re, level: n } of LEVEL_WORDS) if (re.test(text)) level = Math.max(level, n);
	if ((text.match(/\([a-z]\)/gi) ?? []).length >= 3) level = Math.max(level, 4);
	return Math.min(5, level) as number;
}

const STOP = new Set(
	"a an the of to in on for and or vs via with from into over under using use used how what which that this these those your you we i problem question part pts points pt homework hw lecture chapter section week exam midterm final quiz practice sample compute find evaluate prove show define state name list identify solve apply calculate differentiate integrate simplify given let consider".split(
		" ",
	),
);

export function normalizeTopicTitle(raw: string): string {
	let s = raw
		.replace(/!?\[\[([^\]|#]+)[^\]]*\]\]/g, "$1")
		.replace(/[*_`#]+/g, " ")
		.replace(/\$\$[\s\S]+?\$\$/g, " ")
		.replace(/\$[^$]+\$/g, " ")
		.replace(/^\s*(problem|question|q|ex(ercise)?|part|item)\s*[\d.]+\s*[:.)-]?\s*/i, "")
		.replace(/^\s*(lecture|chapter|section|week|unit|homework|hw|assignment)\s*\d*\s*[:.—-]?\s*/i, "")
		.replace(/^\s*\d+[.)]\s*/, "")
		.replace(/\(\s*\d+\s*(pts?|points?)\s*\)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	s = s.replace(/[.:;]+$/g, "").trim();
	if (s.length > 72) {
		const cut = s.slice(0, 72);
		s = cut.replace(/\s+\S*$/, "") || cut;
	}
	if (!s) return "";
	return s.replace(/\b\w+/g, (w) => (w.length <= 2 && w !== "of" ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));
}

interface RawHit {
	title: string;
	idea?: string;
	evidence: string;
	source: string;
	kind: MaterialKind;
	level: number;
}

function addHit(hits: RawHit[], source: string, kind: MaterialKind, rawTitle: string, evidence: string, idea?: string): void {
	const title = normalizeTopicTitle(rawTitle);
	if (title.length < 3 || STOP.has(title.toLowerCase())) return;
	if (/^(true|false|yes|no|explain|answer)$/i.test(title)) return;
	hits.push({ title, idea, evidence: evidence.trim().slice(0, 220), source, kind, level: inferLevel(kind, `${rawTitle}\n${evidence}`) });
}

export function extractHits(material: MaterialSource): RawHit[] {
	const hits: RawHit[] = [];
	const { name, kind, text } = material;
	const lines = text.replace(/\r\n/g, "\n").split("\n");

	for (const line of lines) {
		const t = line.trim();
		if (!t || t.length > 240) continue;
		const heading = /^(#{1,3})\s+(.+)/.exec(t);
		if (heading) {
			addHit(hits, name, kind, heading[2], t);
			continue;
		}
		const labeled = /^(?:lecture|chapter|section|week|unit|topic|theme)\s*\d*\s*[:.—-]\s*(.+)/i.exec(t);
		if (labeled) {
			addHit(hits, name, kind, labeled[1], t);
			continue;
		}
		const problem = /^(?:problem|question|q|ex(?:ercise)?)\s*(\d+[a-z]?)\s*[:.)]\s*(.+)/i.exec(t);
		if (problem) {
			const rest = problem[2];
			const titled = /^([^.]{3,60})\.\s+(.+)/.exec(rest);
			if (titled && /[A-Za-z]{3}/.test(titled[1]) && !/^(let|given|consider|suppose|a |the |if )/i.test(titled[1])) {
				addHit(hits, name, kind, titled[1], t, titled[2]);
			} else {
				const topic = topicFromPrompt(rest);
				if (topic) addHit(hits, name, kind, topic, t, rest);
			}
			continue;
		}
		const numbered = /^(\d+)[.)]\s+(.+)/.exec(t);
		if (numbered && numbered[2].length > 8) {
			const topic = topicFromPrompt(numbered[2]);
			if (topic) addHit(hits, name, kind, topic, t, numbered[2]);
		}
	}

	if (!hits.length) {
		const topic = topicFromPrompt(text.slice(0, 400)) || normalizeTopicTitle(name.replace(/\.[a-z0-9]+$/i, ""));
		if (topic) addHit(hits, name, kind, topic, text.slice(0, 160));
	}
	return hits;
}

const PROMPT_RES: Array<RegExp> = [
	/\b(?:the\s+)?([A-Za-z][A-Za-z0-9]+(?:\s+[A-Za-z][A-Za-z0-9]+){0,3}\s+(?:rule|theorem|test|method|principle|formula|equation|limit|derivative|integral|matrix|distribution))\b/i,
	/\b(?:using|apply(?:ing)?|use)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9\s-]{2,40}?)\s+to\b/i,
	/\b(?:compute|evaluate|find|calculate|differentiate|integrate|prove|derive|define|state)\s+(?:the\s+)?(.{3,50}?)(?:\s+of\b|[.?!]|$)/i,
];

function topicFromPrompt(prompt: string): string {
	const clean = prompt.replace(/\$[^$]+\$/g, " ").replace(/\s+/g, " ").trim();
	for (const re of PROMPT_RES) {
		const m = re.exec(clean);
		if (m?.[1]) {
			const title = normalizeTopicTitle(m[1]);
			if (title.split(" ").length <= 6 && title.length >= 4) return title;
		}
	}
	return "";
}

function tokens(title: string): Set<string> {
	return new Set(
		title
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2 && !STOP.has(t)),
	);
}

function similar(a: string, b: string): boolean {
	if (slugify(a) === slugify(b)) return true;
	const A = tokens(a);
	const B = tokens(b);
	if (!A.size || !B.size) return false;
	let overlap = 0;
	for (const t of A) if (B.has(t)) overlap++;
	return overlap >= Math.min(A.size, B.size) && overlap / Math.max(A.size, B.size) >= 0.6;
}

export function mergeTopics(hits: RawHit[]): ExamTopic[] {
	const groups: RawHit[][] = [];
	for (const hit of hits) {
		const g = groups.find((xs) => similar(xs[0].title, hit.title));
		if (g) g.push(hit);
		else groups.push([hit]);
	}
	return groups
		.map((g) => {
			const examish = g.filter((h) => h.kind === "exam" || h.kind === "practice_exam" || h.kind === "study_guide");
			const preferred = examish[0] ?? g[0];
			const ideas = [...new Set(g.map((h) => h.idea).filter((x): x is string => !!x))].slice(0, 6);
			return {
				title: preferred.title,
				ideas,
				requiredLevel: Math.max(...g.map((h) => h.level)),
				sources: [...new Set(g.map((h) => h.source))],
				evidence: [...new Set(g.map((h) => h.evidence))].slice(0, 5),
			};
		})
		.sort((a, b) => b.requiredLevel - a.requiredLevel || a.title.localeCompare(b.title));
}

function examKindOf(materials: MaterialSource[], userText = ""): ExamBlueprint["examKind"] {
	const blob = `${userText} ${materials.map((m) => m.name).join(" ")}`.toLowerCase();
	if (/\bfinal\b/.test(blob)) return "final";
	if (/\bmidterm\b/.test(blob)) return "midterm";
	if (/\bquiz\b/.test(blob)) return "quiz";
	if (materials.some((m) => m.kind === "practice_exam")) return "practice";
	return "unspecified";
}

function guessCourse(materials: MaterialSource[]): string | undefined {
	for (const m of materials) {
		const line = m.text.split("\n").find((l) => /[A-Za-z]{3}/.test(l));
		const head = (line ?? m.name).replace(/\.[a-z0-9]+$/i, "");
		const course = /\b([A-Z]{2,6}\s*-?\s*\d{2,4}[A-Z]?)\b/.exec(head);
		if (course) return course[1].replace(/\s+/g, " ");
	}
	return undefined;
}

export function buildExamBlueprint(materials: MaterialSource[], opts: { title?: string; userText?: string } = {}): ExamBlueprint {
	const hits = materials.flatMap(extractHits);
	const topics = mergeTopics(hits);
	const examSources = new Set(materials.filter((m) => m.kind === "exam" || m.kind === "practice_exam" || m.kind === "study_guide").map((m) => m.name));
	const mustKnow = topics.filter((t) => t.sources.some((s) => examSources.has(s)) || t.requiredLevel >= 4).map((t) => t.title);
	const kind = examKindOf(materials, opts.userText);
	const courseGuess = guessCourse(materials);
	const label = kind === "unspecified" ? "exam" : kind.replace("_", " ");
	const title = opts.title?.trim() || (courseGuess ? `Prepare for ${courseGuess} ${label}` : `Prepare for the ${label}`);
	const notes: string[] = [];
	if (materials.some((m) => !m.text.trim())) notes.push("Some files had no extractable text (image or compressed PDF). Open them with read_vault_file and refine this plan.");
	if (!topics.length) notes.push("No topics could be parsed automatically. Read the files and name the concepts yourself.");
	return {
		title,
		courseGuess,
		examKind: kind,
		materials: materials.map((m) => ({
			name: m.name,
			kind: m.kind,
			path: m.path,
			topicCount: topics.filter((t) => t.sources.includes(m.name)).length,
			excerpt: m.text.replace(/\s+/g, " ").trim().slice(0, 280),
		})),
		topics,
		mustKnow: mustKnow.length ? mustKnow : topics.map((t) => t.title),
		notes,
	};
}

function topicPrereqs(topic: ExamTopic, all: ExamTopic[], materials: MaterialSource[]): string[] {
	const byName = new Map(materials.map((m) => [m.name, m]));
	const related = all.filter((other) => {
		if (other.title === topic.title) return false;
		const A = tokens(topic.title);
		const B = tokens(other.title);
		let overlap = 0;
		for (const t of A) if (B.has(t)) overlap++;
		if (overlap === 0) return false;
		const otherIsFoundation = other.sources.every((s) => {
			const k = byName.get(s)?.kind;
			return k === "lecture" || k === "notes";
		});
		const thisIsLater = topic.requiredLevel > other.requiredLevel || topic.sources.some((s) => {
			const k = byName.get(s)?.kind;
			return k === "homework" || k === "exam" || k === "practice_exam" || k === "study_guide";
		});
		return otherIsFoundation && thisIsLater;
	});
	return related.map((t) => t.title);
}

export function blueprintToGoalInput(plan: ExamBlueprint, materials: MaterialSource[], why?: string): GoalInput {
	const target = plan.title;
	const nodes: GoalInput["nodes"] = plan.topics.map((t) => ({
		title: t.title,
		prerequisites: topicPrereqs(t, plan.topics, materials),
		summary: t.ideas[0] ?? t.evidence[0],
		requiredLevel: t.requiredLevel,
	}));
	nodes.push({
		title: target,
		prerequisites: plan.mustKnow.length ? plan.mustKnow : plan.topics.map((t) => t.title),
		summary: "Exam-ready: every listed topic at the required level.",
		requiredLevel: 4,
	});
	const approach = [
		"This goal was built from the learner's course files (lectures, homeworks, study guides, practice exams).",
		"Teach the graph from foundations up. For each node, the check quiz should be at that node's required level — that is the depth the exam appears to demand.",
		plan.mustKnow.length ? `Must be exam-ready: ${plan.mustKnow.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		title: plan.title,
		objective: `Be able to do the work these materials assess, at the required level for each topic (see the exam plan).`,
		why: why ?? "The learner is preparing from course files.",
		approach,
		target,
		nodes,
	};
}

export function formatExamPlanMarkdown(plan: ExamBlueprint): string {
	const rows = plan.topics.map((t) => {
		const ideas = t.ideas.length ? t.ideas.join("; ") : t.evidence[0] ?? "";
		return `| [[${t.title}]] | ${t.requiredLevel} | ${t.sources.map((s) => `\`${s}\``).join(", ")} | ${ideas.replace(/\|/g, "/")} |`;
	});
	return [
		`# ${plan.title}`,
		"",
		plan.courseGuess ? `Course: ${plan.courseGuess}` : "",
		`Exam kind: ${plan.examKind}`,
		"",
		"## Topics and required level",
		"",
		"Level is the same 1–5 scale as quizzes: 1 recognize · 2 recall · 3 apply · 4 combine · 5 transfer.",
		"",
		"| Topic | Need | From | What the files ask |",
		"| --- | --- | --- | --- |",
		...rows,
		"",
		"## Must know",
		"",
		plan.mustKnow.map((t) => `- [[${t}]]`).join("\n") || "- (none singled out)",
		"",
		"## Materials",
		"",
		...plan.materials.map((m) => `- **${m.name}** (${m.kind.replace("_", " ")})${m.path ? ` — [[${m.path}]]` : ""}${m.excerpt ? `\n  ${m.excerpt}` : ""}`),
		"",
		plan.notes.length ? `## Notes\n\n${plan.notes.map((n) => `- ${n}`).join("\n")}` : "",
	]
		.filter((l) => l !== "")
		.join("\n");
}

export function examPrepInstruction(plan: ExamBlueprint): string {
	const table = plan.topics.map((t) => `- **${t.title}** — need level ${t.requiredLevel}/5 (${t.sources.join(", ")})${t.ideas[0] ? `: ${t.ideas[0]}` : ""}`).join("\n");
	return [
		"<exam_plan>",
		"Groundwork parsed the attached course files into topics and the level each one must be learned to (1 recognize … 5 transfer). This is a first cut, not a substitute for reading the files.",
		`Goal title: ${plan.title}`,
		plan.mustKnow.length ? `Must-know (on an exam/study guide, or high demand): ${plan.mustKnow.join(", ")}` : "",
		"Topics:",
		table || "(no topics extracted — read the files with read_vault_file, then call ingest_exam_materials)",
		plan.notes.join("\n"),
		"Do this next: call get_learner_overview, refine the graph if needed, save it with set_goal (include requiredLevel on each node), then start teaching from the frontier. Check quizzes should hit each node's required level, not just recognition.",
		"The learner has not necessarily read these files. Define every symbol and term from them the first time you use it, and restate any problem you take from them in full.",
		"</exam_plan>",
	]
		.filter(Boolean)
		.join("\n");
}

/** Pull printable text out of simple (uncompressed) PDFs. Compressed PDFs stay for the model to read. */
export function extractPdfText(bytes: Uint8Array): string {
	let raw = "";
	for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
	const chunks: string[] = [];
	const re = /\((?:\\.|[^\\)])*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) {
		const s = unescapePdfString(m[0].slice(1, -1));
		if (/[A-Za-z]{2,}/.test(s)) chunks.push(s);
	}
	return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function unescapePdfString(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
		.replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function bytesFromBase64(data: string): Uint8Array {
	const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
	if (B) return Uint8Array.from(B.from(data, "base64"));
	const bin = atob(data);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function materialFromVaultFile(io: VaultIO, path: string): Promise<MaterialSource> {
	const file = await loadVaultFile(io, path);
	return materialFromLoadedFile(file);
}

export function materialFromLoadedFile(file: VaultFile): MaterialSource {
	const name = basename(file.path);
	let text = file.text?.trim() ?? "";
	if (!text && file.kind === "pdf" && file.data) text = extractPdfText(bytesFromBase64(file.data));
	if (!text && file.skipped) text = "";
	return { name, path: file.path, kind: classifyMaterial(name, text), text };
}
