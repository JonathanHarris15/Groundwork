/**
 * Tutor replies and quiz copy mix Obsidian highlights (`==…==`) with LaTeX.
 * Those two syntaxes fight: wrapping `$math$` (or a whole English sentence) in
 * `==` or `$` leaves leftover `$` delimiters, and Obsidian then typesets the
 * surrounding prose as math — spaces vanish, `\alpha` shows as "alpha", and
 * failed spans appear as raw highlighted TeX. Repair that before render.
 */

const LATEX_NAMED = new Set([
	"sin",
	"cos",
	"tan",
	"log",
	"ln",
	"exp",
	"lim",
	"sup",
	"inf",
	"max",
	"min",
	"det",
	"dim",
	"ker",
	"arg",
	"deg",
	"gcd",
	"hom",
	"Pr",
]);

const FENCE_LINE = /^(```+|~~~+)/;

export function normalizeTutorMarkdown(md: string): string {
	if (!md) return md;
	const parts = splitFences(unescapeOverEscaped(md));
	return parts.map((p) => (p.fence ? p.text : normalizeQuoted(p.text))).join("");
}

const QUOTE_PREFIX = /^((?:[ \t]*>[ \t]?)+)/;

/**
 * Math must not pair across a blockquote/callout boundary, and lines added
 * inside a quote need its `> ` prefix, or `$$` leaks out and swallows the
 * prose after the callout. Normalize each run of quoted lines on its own.
 */
function normalizeQuoted(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const depth = quoteDepth(lines[i]);
		let j = i + 1;
		while (j < lines.length && quoteDepth(lines[j]) === depth) j++;
		const run = lines.slice(i, j);
		if (!depth) {
			out.push(normalizeFlow(run.join("\n")));
		} else {
			const prefix = `${QUOTE_PREFIX.exec(run[0])![1].trimEnd()} `;
			const inner = run.map((l) => l.replace(QUOTE_PREFIX, "")).join("\n");
			out.push(
				normalizeQuoted(inner)
					.split("\n")
					.map((l) => (l ? prefix + l : prefix.trimEnd()))
					.join("\n"),
			);
		}
		i = j;
	}
	return out.join("\n");
}

function quoteDepth(line: string): number {
	const m = QUOTE_PREFIX.exec(line);
	return m ? (m[1].match(/>/g) ?? []).length : 0;
}

/** Elicitation and other plain-text surfaces: drop markdown/TeX wrappers. */
export function latexToPlain(s: string): string {
	return normalizeTutorMarkdown(s)
		.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => ` ${plainMath(inner)} `)
		.replace(/\$([^$]+)\$/g, (_, inner: string) => plainMath(inner))
		.replace(/\*\*|__|==/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function normalizeFlow(text: string): string {
	let s = text;
	s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => `\n$$\n${inner.trim()}\n$$\n`);
	s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`);
	s = s.replace(/==([\s\S]+?)==/g, (_, inner: string) => unwrapHighlight(inner));
	s = rewriteMathSpans(s, true, (inner) => {
		const t = inner.trim();
		return looksLikeProse(t) ? wrapLatexPhrases(t) : `$$\n${t}\n$$`;
	});
	s = rewriteMathSpans(s, false, (inner) => {
		const t = inner.trim();
		return looksLikeProse(t) ? wrapLatexPhrases(t) : `$${t}$`;
	});
	s = wrapLatexPhrases(s);
	return s;
}

const N_MACRO =
	/^(nabla|ne|neq|neg|ni|nu|not|notin|newline|newcommand|nolimits|normalsize|nleq|ngeq|nless|ngtr|nmid|nparallel|nexists|nsubseteq|nsupseteq|nsim|ncong|nearrow|nwarrow|nRightarrow|nLeftarrow|nrightarrow|nleftarrow)$/;
const OVER_ESCAPED_NEWLINE = /\\n(?=\\n|[A-Z0-9\s.,;:!?)]|$)/;
const DOUBLED_MACRO = /\\\\([a-zA-Z]{2,})/g;

/**
 * Tool arguments sometimes arrive escaped one level too deep: `\n` as two
 * characters and `\\top` for `\top`. MathJax reads `\\` as a line break, so
 * `\\times` renders as "times" and `^\\top` is a parse error.
 */
function unescapeOverEscaped(s: string): string {
	const doubled = [...s.matchAll(DOUBLED_MACRO)].some((m) => isTexMacroName(m[1]) || LATEX_NAMED.has(m[1]));
	if (!doubled && !OVER_ESCAPED_NEWLINE.test(s)) return s;
	let out = s.replace(/\\\\+([a-zA-Z]{2,})/g, (all, name: string) =>
		isTexMacroName(name) || LATEX_NAMED.has(name) || name.startsWith("math") ? `\\${name}` : all,
	);
	out = out.replace(/\\{1,2}n([a-zA-Z]*)/g, (all, rest: string) => {
		if (N_MACRO.test(`n${rest}`)) return all.startsWith("\\\\") ? `\\n${rest}` : all;
		return `\n${rest}`;
	});
	out = out.replace(/\\"/g, '"');
	return out;
}

function unwrapHighlight(inner: string): string {
	const t = inner.trim();
	const display = /^\$\$([\s\S]+)\$\$$/.exec(t);
	if (display) return `$$${display[1].trim()}$$`;
	const inline = /^\$([^$]+)\$$/.exec(t);
	if (inline) return `$${inline[1].trim()}$`;
	if (/\\[a-zA-Z]+/.test(t) && !looksLikeProse(t)) return `$${t}$`;
	// Mixed highlight (prose + $math$): drop == so leftover $ cannot re-pair.
	return inner;
}

function rewriteMathSpans(s: string, display: boolean, rewrite: (inner: string) => string): string {
	const parts = splitFences(s);
	return parts
		.map((p) => {
			if (p.fence) return p.text;
			if (display) return p.text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => rewrite(inner));
			return replaceInlineMath(p.text, rewrite);
		})
		.join("");
}

function replaceInlineMath(s: string, rewrite: (inner: string) => string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		if (s.startsWith("$$", i)) {
			const end = s.indexOf("$$", i + 2);
			if (end < 0) {
				out += s.slice(i);
				break;
			}
			out += s.slice(i, end + 2);
			i = end + 2;
			continue;
		}
		if (s[i] === "$") {
			const end = s.indexOf("$", i + 1);
			if (end < 0) {
				out += s.slice(i);
				break;
			}
			out += rewrite(s.slice(i + 1, end));
			i = end + 1;
			continue;
		}
		out += s[i++];
	}
	return out;
}

function looksLikeProse(s: string): boolean {
	const bare = s
		.replace(/\\(begin|end)\{[^}]*\}/g, " ")
		.replace(/\\(text|mathrm|operatorname)\{[^}]*\}/g, " ")
		.replace(/\\[a-zA-Z]+/g, " ");
	const words = bare.match(/[A-Za-z]{3,}/g) ?? [];
	const english = words.filter((w) => !LATEX_NAMED.has(w) && !isTexMacroName(w));
	return english.length >= 3;
}

function isTexMacroName(w: string): boolean {
	return /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|nabla|infty|cdot|times|circ|oplus|otimes|wedge|vee|cap|cup|subset|supset|in|notin|to|mapsto|leq|geq|neq|approx|equiv|pm|mp|sum|prod|int|partial|emptyset|forall|exists|ell|hbar|mathbf|mathrm|mathsf|mathit|mathcal|mathbb|text|frac|dfrac|sqrt|overline|underline|hat|bar|vec|dot|ddot|tilde|left|right|big|Big|cdot|times|top|bot|mid|quad|qquad)$/i.test(
		w,
	);
}

function wrapLatexPhrases(s: string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		if (s.startsWith("$$", i)) {
			const end = s.indexOf("$$", i + 2);
			if (end < 0) {
				out += s.slice(i);
				break;
			}
			out += s.slice(i, end + 2);
			i = end + 2;
			continue;
		}
		if (s[i] === "$") {
			const end = s.indexOf("$", i + 1);
			if (end < 0) {
				out += s.slice(i);
				break;
			}
			out += s.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (s[i] === "\\") {
			const start = i;
			i = consumeLatex(s, i);
			const chunk = s.slice(start, i).trimEnd();
			out += chunk ? `$${chunk}$` : "";
			continue;
		}
		out += s[i++];
	}
	return out;
}

function consumeLatex(s: string, i: number): number {
	const n = s.length;
	while (i < n) {
		if (s[i] === "\\") {
			i++;
			if (i < n && /[a-zA-Z]/.test(s[i])) {
				while (i < n && /[a-zA-Z]/.test(s[i])) i++;
				if (s[i] === "*") i++;
			} else if (i < n) {
				i++;
			}
			continue;
		}
		if (s[i] === "{" || s[i] === "(" || s[i] === "[") {
			const close = s[i] === "{" ? "}" : s[i] === "(" ? ")" : "]";
			const open = s[i];
			let depth = 1;
			i++;
			while (i < n && depth) {
				if (s[i] === "\\") {
					i += i + 1 < n ? 2 : 1;
					continue;
				}
				if (s[i] === open) depth++;
				else if (s[i] === close) depth--;
				i++;
			}
			continue;
		}
		if (s[i] === "^" || s[i] === "_") {
			i++;
			if (s[i] === "{") continue;
			if (i < n && s[i] !== " ") i++;
			continue;
		}
		if (s[i] === "'") {
			i++;
			continue;
		}
		if (/[0-9+\-=<>|/,.'.]/.test(s[i])) {
			i++;
			continue;
		}
		if (s[i] === " " || s[i] === "\t") {
			let j = i + 1;
			while (j < n && (s[j] === " " || s[j] === "\t")) j++;
			if (j < n && continuesMath(s, j)) {
				i = j;
				continue;
			}
			return i;
		}
		if (/[A-Za-z]/.test(s[i])) {
			let j = i;
			while (j < n && /[A-Za-z]/.test(s[j])) j++;
			const word = s.slice(i, j);
			if (word.length === 1 || LATEX_NAMED.has(word)) {
				i = j;
				continue;
			}
			return i;
		}
		return i;
	}
	return i;
}

function continuesMath(s: string, i: number): boolean {
	const c = s[i];
	if (c === "\\" || c === "^" || c === "_" || c === "{" || c === "(" || c === "[" || c === "'" || /[0-9+\-=<>|/,.]/.test(c)) return true;
	if (/[A-Za-z]/.test(c)) {
		let j = i;
		while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
		const word = s.slice(i, j);
		return word.length === 1 || LATEX_NAMED.has(word);
	}
	return false;
}

function splitFences(md: string): Array<{ fence: boolean; text: string }> {
	const out: Array<{ fence: boolean; text: string }> = [];
	const lines = md.split("\n");
	let fence: string | null = null;
	let start = 0;
	const emit = (end: number, isFence: boolean) => {
		if (end <= start) return;
		const text = lines.slice(start, end).join("\n");
		if (end < lines.length) out.push({ fence: isFence, text: text + "\n" });
		else out.push({ fence: isFence, text });
		start = end;
	};
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (fence) {
			if (t.startsWith(fence)) {
				emit(i + 1, true);
				fence = null;
			}
			continue;
		}
		const m = FENCE_LINE.exec(t);
		if (m) {
			emit(i, false);
			fence = m[1];
		}
	}
	emit(lines.length, !!fence);
	return out;
}

function plainMath(inner: string): string {
	let s = inner.trim();
	s = s.replace(/\\(dfrac|frac)\{([^{}]*)\}\{([^{}]*)\}/g, "($2)/($3)");
	s = s.replace(/\\mathbf\{([^{}]*)\}/g, "$1");
	s = s.replace(/\\mathrm\{([^{}]*)\}/g, "$1");
	s = s.replace(/\\mathbb\{([^{}]*)\}/g, "$1");
	s = s.replace(/\\text\{([^{}]*)\}/g, "$1");
	const cmds: Record<string, string> = {
		alpha: "α",
		beta: "β",
		gamma: "γ",
		delta: "δ",
		epsilon: "ε",
		theta: "θ",
		lambda: "λ",
		mu: "μ",
		pi: "π",
		sigma: "σ",
		phi: "φ",
		omega: "ω",
		nabla: "∇",
		times: "×",
		cdot: "·",
		circ: "∘",
		in: "∈",
		notin: "∉",
		mapsto: "↦",
		to: "→",
		leq: "≤",
		geq: "≥",
		neq: "≠",
		approx: "≈",
		pm: "±",
		infty: "∞",
		top: "⊤",
		partial: "∂",
		sum: "∑",
		prod: "∏",
		int: "∫",
		dots: "…",
		ldots: "…",
		cdots: "⋯",
	};
	s = s.replace(/\\([a-zA-Z]+)/g, (_, name: string) => cmds[name] ?? name);
	s = s.replace(/[\^{}]+/g, "");
	s = s.replace(/\s+/g, " ").trim();
	return s;
}
