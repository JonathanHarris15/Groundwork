import { later } from "../timers";
import { asRecord, asText } from "../unknown";
import type { ChatMessage, ContentBlock, Provider, ProviderRequest, ProviderResponse } from "./types";

/**
 * A scripted tutor that exercises every tool and rendering feature without an
 * API key: memory recall, goal planning with a dependency map, LaTeX, callouts,
 * graded quizzes that update the vault, and a session summary. It is clearly
 * labelled as a demo in the UI; switch to Anthropic in settings for real tutoring.
 */
export class DemoProvider implements Provider {
	readonly name = "demo";
	private counter = 0;

	constructor(private readonly delayMs = 12) {}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const step = this.nextStep(req.messages);
		for (const block of step) {
			if (block.type === "text" && typeof block.text === "string") await this.stream(block.text, req);
		}
		const hasTool = step.some((b) => b.type === "tool_use");
		return { content: step, stopReason: hasTool ? "tool_use" : "end_turn" };
	}

	private async stream(text: string, req: ProviderRequest): Promise<void> {
		const chunks = text.match(/[\s\S]{1,18}/g) ?? [];
		for (const c of chunks) {
			if (req.signal?.aborted) throw new Error("aborted");
			req.onText(c);
			if (this.delayMs) await new Promise<void>((r) => later(() => r(), this.delayMs));
		}
	}

	private tool(name: string, input: unknown): ContentBlock {
		return { type: "tool_use", id: `demo_${++this.counter}_${name}`, name, input };
	}

	private practiceTest(): ContentBlock[] {
		return [
			{ type: "text", text: "Here's a short practice test. No feedback until you submit; free-response answers take LaTeX.\n" },
			this.tool("upsert_concept", { title: "Slope of a line", domain: "calculus" }),
			this.tool("upsert_concept", { title: "Derivative", domain: "calculus", prerequisites: ["Slope of a line"] }),
			this.tool("practice_test", {
				title: "Derivative basics (demo)",
				objective:
					"Whether you can do the three things the derivative rests on: find a slope, apply the power rule, and write the limit definition. Together they show whether you're ready for derivative problems on an exam.",
				instructions: "Answer every question, then press **Submit test**. Use $...$ for math in written answers.",
				timeLimitMinutes: 10,
				questions: [
					{
						concept: "Slope of a line",
						question: "A line passes through $(0, 1)$ and $(2, 5)$. What is its slope?",
						options: [
							{ label: "$2$", value: "two" },
							{ label: "$\\frac{1}{2}$", value: "half", misconception: "Divides run by rise" },
							{ label: "$4$", value: "four", misconception: "Uses the rise alone" },
						],
						correctAnswer: "two",
						explanation: "$\\frac{5-1}{2-0} = 2$.",
						difficulty: 2,
					},
					{
						concept: "Derivative",
						question: "Using the power rule, find $\\frac{d}{dx}\\left(x^2\\right)$, the derivative of $x^2$ with respect to $x$.",
						format: "free",
						referenceAnswer: "$2x$",
						rubric: "Full credit: $2x$. Partial: an $x$ term with the wrong coefficient.",
						explanation: "Bring the exponent down and lower it by one: $2x^{1}$.",
						difficulty: 2,
					},
					{
						concept: "Derivative",
						question: "For a function $f$ and a point $x = a$, write the limit that defines $f'(a)$, the derivative of $f$ at $a$. Use $h$ for the step between the two points.",
						format: "free",
						referenceAnswer: "$$f'(a) = \\lim_{h \\to 0} \\frac{f(a+h) - f(a)}{h}$$",
						rubric: "Full credit: the difference quotient with $h \\to 0$. Partial: the quotient without the limit.",
						explanation: "The derivative is the limit of secant slopes as the two points merge.",
						difficulty: 3,
					},
				],
			}),
		];
	}

	/** The demo "grades" by looking for the key expression, so the flow is visible without a model. */
	private gradeTest(testId: string, resultText: string): ContentBlock[] {
		const answers = [...resultText.matchAll(/### Question (\d+)[\s\S]*?They wrote:\n([\s\S]*?)\nReference answer:/g)];
		const grades = answers.map(([, n, text]) => {
			const t = text.replace(/\s+/g, "");
			const ok = n === "2" ? /2x/.test(t) : /lim/.test(t) && /h/.test(t);
			const partial = n === "3" && !ok && /f\(a\+h\)/.test(t);
			return {
				question: Number(n),
				outcome: ok ? "correct" : partial ? "partial" : "incorrect",
				feedback: ok ? "That's it." : partial ? "Right quotient, but it needs $\\lim_{h \\to 0}$ in front." : "Compare with the model answer below.",
			};
		});
		return [this.tool("grade_practice_test", { test_id: testId, grades })];
	}

	private nextStep(messages: ChatMessage[]): ContentBlock[] {
		const last = messages[messages.length - 1];
		const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
		const lastToolNames = results.map((r) => toolNameFor(messages, r.type === "tool_result" && typeof r.tool_use_id === "string" ? r.tool_use_id : ""));
		const userTurns = messages.filter(isLearnerTurn).length;
		const learnerSpoke = !!last && isLearnerTurn(last);
		const resultText = results.map((r) => (r.type === "tool_result" && typeof r.content === "string" ? r.content : "")).join("\n");

		if (learnerSpoke && /practice test/i.test(learnerText(last))) return this.practiceTest();
		if (lastToolNames.includes("practice_test") || lastToolNames.includes("grade_practice_test")) {
			const testId = /test_id "([^"]+)"/.exec(resultText)?.[1];
			if (testId) return this.gradeTest(testId, resultText);
			return [
				{
					type: "text",
					text: /Practice test evaluated/.test(resultText)
						? "Your evaluation is in the test card and saved under `tests/`. With a real tutor, this is where it would debrief and then start from the smallest piece you missed, stepping down until you get one right and teaching up from there."
						: "No problem, the test is closed and nothing was recorded.",
				},
			];
		}

		if (learnerSpoke && userTurns === 1) {
			return [
				{ type: "text", text: "Let me check what your vault already knows before we start.\n" },
				this.tool("get_learner_overview", {}),
				this.tool("search_knowledge", { query: "derivative slope limit" }),
			];
		}

		if (lastToolNames.includes("get_learner_overview")) {
			const known = /"title": "Slope of a line"[\s\S]*?"status": "solid"/.test(resultText);
			return [
				{
					type: "text",
					text: known
						? "Your vault already has **Slope of a line** as solid, so we won't re-teach it. I'll build the plan on top of it.\n"
						: "Nothing on this in your vault yet, so we start from the ground. Here's the dependency graph I'd build toward ==the derivative==.\n",
				},
				this.tool("set_goal", {
					title: "Understand the derivative",
					objective: "Explain what $f'(x)$ means, and derive $\\frac{d}{dx}x^2 = 2x$ from the definition without looking it up.",
					why: "Demo goal: the foundation for everything in calculus.",
					approach:
						"Start from slope (an unconditional truth: rise over run, the same number for any two points on a straight line). Show that a curve has no such number — two segments of y=x^2 give two slopes — and name the secant as the line that turns the curve back into a slope. Then shrink the two points together: that is the limit, and the derivative is the slope you get when they meet.",
					targets: ["Derivative"],
					nodes: [
						{ title: "Slope of a line", summary: "Rise over run: $m = \\frac{\\Delta y}{\\Delta x}$.", domain: "calculus" },
						{ title: "Secant line", prerequisites: ["Slope of a line"], domain: "calculus" },
						{ title: "Limit", domain: "calculus" },
						{ title: "Derivative", prerequisites: ["Secant line", "Limit"], domain: "calculus" },
					],
				}),
			];
		}

		if (lastToolNames.includes("set_goal")) {
			let mermaid = "";
			try {
				mermaid = asText(asRecord(JSON.parse(resultText))?.mermaid);
			} catch {
				// keep the prose-only plan
			}
			return [
				{
					type: "text",
					text: [
						"## The plan",
						"",
						"We start from one fact you can accept with zero caveats — for a straight line, slope is rise over run:",
						"",
						"$$",
						"m = \\frac{\\Delta y}{\\Delta x}",
						"$$",
						"",
						"Then we ask the question that forces everything else: *a curve's steepness keeps changing, so what could \"the slope at a point\" even mean?* Chasing that question gives us secant lines, then limits, then the derivative.",
						"",
						"```mermaid",
						mermaid,
						"```",
						"",
						"> [!question] Does this plan look right?",
						"> Say **go** and I'll start by checking where your understanding of slope sits.",
					].join("\n"),
				},
			];
		}

		if (learnerSpoke && userTurns === 2) {
			return [
				{
					type: "text",
					text: "First, a probe. I'm finding the *edge* of what you know, so it's fine to get this wrong, and \"I don't know\" is an honest answer.\n",
				},
				this.tool("quiz", {
					concept: "Slope of a line",
					purpose: "Checking where your slope skills are. The derivative is built on slope, so this tells me where to start.",
					question: "A line passes through $(1, 2)$ and $(3, 8)$. What is its slope?",
					options: [
						{ label: "$3$", value: "three" },
						{ label: "$\\frac{1}{3}$", value: "third", misconception: "Divides run by rise instead of rise by run" },
						{ label: "$6$", value: "six", misconception: "Uses the rise alone and forgets to divide by the run" },
						{ label: "$4$", value: "four", misconception: "Divides a y-value by an x-value instead of using differences" },
					],
					correctAnswer: "three",
					explanation: "Slope is rise over run: $\\frac{8-2}{3-1} = \\frac{6}{2} = 3$.",
					difficulty: 2,
					kind: "probe",
				}),
			];
		}

		if (lastToolNames.includes("quiz")) {
			const asks = quizConcepts(messages);
			const right = /CORRECTLY/.test(resultText) && !/INCORRECTLY/.test(resultText);
			const slopeAsks = asks.filter((c) => c === "Slope of a line").length;
			const secantAsks = asks.filter((c) => c === "Secant line").length;
			if (secantAsks === 0 && !right && slopeAsks === 1) return this.reteachSlope();
			if (secantAsks === 0) return this.introduceSecant();
			if (secantAsks === 1 && !right) return this.reteachSecant();
			return this.finishLesson();
		}

		if (lastToolNames.includes("save_session_summary")) {
			return [
				{
					type: "text",
					text: "Session saved. This is the end of the scripted demo. On the Groundwork website, choose a plan for a tutor that plans any goal you give it.",
				},
			];
		}

		return [
			{
				type: "text",
				text: "*(Demo mode)* The scripted tutor has finished. Choose a plan on the Groundwork website to learn anything you like, or start a new session to replay the demo.",
			},
		];
	}

	/** A missed root: two cases, one flipped case, then the truth, then a new check. */
	private reteachSlope(): ContentBlock[] {
		return [
			{
				type: "text",
				text: [
					"That's the edge, and a useful one. Slope is ==change in $y$ divided by change in $x$==, always in that order.",
					"",
					"Two lines, same fact. Through $(0, 0)$ and $(2, 6)$ the rise is $6$ and the run is $2$, so the slope is $3$. Through $(1, 2)$ and $(3, 8)$ the rise is $6$ and the run is $2$, so the slope is $3$ again. Any two points on a straight line give that same number.",
					"",
					"The flipped case is a different quantity. Dividing the run by the rise gives $\\frac{2}{6}$, and dividing a $y$-value by an $x$-value gives $\\frac{8}{3}$. Neither one is the slope.",
					"",
					"> [!note] Unconditional truth",
					"> For any straight line, $m = \\dfrac{y_2 - y_1}{x_2 - x_1}$, no matter which two points you pick. The two lines above and this statement are the same fact.",
				].join("\n"),
			},
			this.tool("upsert_concept", {
				title: "Slope of a line",
				domain: "calculus",
				summary: "For any straight line, slope is rise over run, and every pair of points gives that same number.",
				unconditionalTruths: "For any straight line, $m = \\frac{y_2 - y_1}{x_2 - x_1}$, no matter which two points you pick.",
				misconceptions: "Run divided by rise. A y-value divided by an x-value, instead of the differences.",
			}),
			this.tool("quiz", {
				concept: "Slope of a line",
				purpose: "Checking the same fact on a new line. The derivative is built on this, so it has to be solid before we leave it.",
				question: "A line passes through $(0, 1)$ and $(4, 9)$. What is its slope?",
				options: [
					{ label: "$2$", value: "two" },
					{ label: "$\\frac{1}{2}$", value: "half", misconception: "Divides run by rise instead of rise by run" },
					{ label: "$8$", value: "eight", misconception: "Uses the rise alone and forgets to divide by the run" },
					{ label: "$\\frac{9}{4}$", value: "nine-fourths", misconception: "Divides a y-value by an x-value instead of using differences" },
				],
				correctAnswer: "two",
				explanation: "Rise over run: $\\frac{9-1}{4-0} = \\frac{8}{4} = 2$.",
				difficulty: 2,
				kind: "check",
			}),
		];
	}

	/** A derived node: the relation that carries, one contrast, a worked case, then a new case. */
	private introduceSecant(): ContentBlock[] {
		return [
			{
				type: "text",
				text: [
					"A secant does for two points on a curve what slope did for two points on a line. Slope is one number for a whole line: any two points give it. A curve has no such number, which is why the derivative needs a new idea.",
					"",
					"On $y = x^2$, from $x = 1$ ($y = 1$) to $x = 2$ ($y = 4$) the slope is $\\frac{4-1}{2-1} = 3$. From $x = 2$ ($y = 4$) to $x = 3$ ($y = 9$) the slope is $\\frac{9-4}{3-2} = 5$. Same curve, two slopes. A line would have given the same slope both times.",
					"",
					"The line through two points on a curve is the ==secant line==. It turns the curve problem back into a line problem, so it has a slope: rise over run between those two points. In symbols, with $h$ the horizontal distance between them, that slope is",
					"",
					"$$",
					"\\frac{f(a+h) - f(a)}{h}",
					"$$",
					"",
					"where $f(a)$ is the height of the curve at $x = a$. The $3$ and the $5$ above are this same fact with the numbers filled in. Worked at $a = 1$:",
					"",
					"$$",
					"\\frac{(1+h)^2 - 1^2}{h} = \\frac{2h + h^2}{h} = 2 + h",
					"$$",
					"",
					"> [!warning] What a secant is not",
					"> It is not the slope at a single point, and it is not a formula sitting on the curve. It is the ordinary slope of the line through two points. The slope at one point comes later, when those two points meet.",
				].join("\n"),
			},
			this.tool("upsert_concept", {
				title: "Slope of a line",
				domain: "calculus",
				summary: "For any straight line, slope is rise over run, and every pair of points gives that same number.",
				unconditionalTruths: "For any straight line, $m = \\frac{y_2 - y_1}{x_2 - x_1}$, no matter which two points you pick.",
				misconceptions: "Run divided by rise. A y-value divided by an x-value, instead of the differences.",
			}),
			this.tool("upsert_concept", {
				title: "Secant line",
				domain: "calculus",
				prerequisites: ["Slope of a line"],
				summary: "The line through two points on a curve. Its slope is rise over run between those points.",
				connections: "A secant does for two points on a curve what slope did for two points on a line. It is how a curve gets a slope at all.",
				misconceptions:
					"Dividing run by rise. Using a y-value instead of the change in y. Treating the secant as the slope at a single point — that is a later idea, the limit.",
			}),
			this.tool("quiz", {
				concept: "Secant line",
				purpose: "Checking you can read a secant as an ordinary slope between two new points on the curve. The next step, the limit, shrinks exactly this.",
				question:
					"On the curve $y = x^2$, what is the slope of the secant line through $x = 3$ (where $y = 9$) and $x = 4$ (where $y = 16$)?",
				options: [
					{ label: "$7$", value: "seven" },
					{ label: "$\\frac{1}{7}$", value: "seventh", misconception: "Divides run by rise instead of rise by run" },
					{ label: "$16$", value: "sixteen", misconception: "Uses a y-value instead of the change in y" },
					{ label: "$4$", value: "four", misconception: "Uses a point's x-value as the slope" },
				],
				correctAnswer: "seven",
				explanation: "Rise over run between the two points: $\\frac{16-9}{4-3} = 7$. That line is the secant.",
				difficulty: 2,
				kind: "check",
			}),
		];
	}

	/** The other representation: a picture of the same fact, then a new case. */
	private reteachSecant(): ContentBlock[] {
		return [
			{
				type: "text",
				text: [
					"Same fact, as a picture. Draw $y = x^2$. Push a pin in at $x = 0$ (height $0$) and another at $x = 2$ (height $4$). Lay a ruler across the two pins. The steepness of that ruler is the secant slope: rise $4$, run $2$, slope $2$.",
					"",
					"The fraction $\\frac{f(a+h)-f(a)}{h}$ is that ruler written down. The pins and the fraction are the same fact.",
				].join("\n"),
			},
			this.tool("quiz", {
				concept: "Secant line",
				purpose: "Checking the picture on a new pair of pins. This is the same secant idea, not a new one.",
				question: "On $y = x^2$, pins at $x = 1$ (height $1$) and $x = 3$ (height $9$). What is the slope of the ruler through them, the secant?",
				options: [
					{ label: "$4$", value: "four" },
					{ label: "$\\frac{1}{4}$", value: "fourth", misconception: "Divides run by rise instead of rise by run" },
					{ label: "$8$", value: "eight", misconception: "Uses the rise alone and forgets to divide by the run" },
					{ label: "$1$", value: "one", misconception: "Uses the starting x-value as the slope" },
				],
				correctAnswer: "four",
				explanation: "Rise over run: $\\frac{9-1}{3-1} = 4$.",
				difficulty: 2,
				kind: "check",
			}),
		];
	}

	private finishLesson(): ContentBlock[] {
		return [
			{
				type: "text",
				text: [
					"You started from slope, one number for a whole line, and you now have a way to give a curve a slope: the secant through two of its points.",
					"",
					"Next is the ==limit==. The secant slope changes as you move the two points — $3$ on one segment of $y = x^2$, $5$ on the next. The limit is what that slope becomes when the two points meet, and that is the derivative. We'll formalize it from here.",
					"",
					"I've recorded both answers in your vault. Open the goal note to see the map re-colored.",
				].join("\n"),
			},
			this.tool("save_session_summary", {
				title: "The derivative (demo)",
				summary: "Probed slope of a line, then introduced the secant as rise over run between two points on $y=x^2$.",
				concepts: ["Slope of a line", "Secant line", "Limit", "Derivative"],
				next: "Formalize the limit, then derive $\\frac{d}{dx}x^2 = 2x$.",
			}),
		];
	}
}

function learnerText(m: ChatMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
}

function isLearnerTurn(m: ChatMessage): boolean {
	return m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
}

function quizConcepts(messages: ChatMessage[]): string[] {
	const titles: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b.type === "tool_use" && b.name === "quiz") {
				const concept = (b.input as { concept?: string } | undefined)?.concept;
				if (concept) titles.push(concept);
			}
		}
	}
	return titles;
}

function toolNameFor(messages: ChatMessage[], toolUseId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const hit = m.content.find((b) => b.type === "tool_use" && typeof b.id === "string" && b.id === toolUseId);
		if (hit?.type === "tool_use" && typeof hit.name === "string") return hit.name;
	}
	return undefined;
}
