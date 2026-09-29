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
			if (block.type === "text") await this.stream(block.text, req);
		}
		const hasTool = step.some((b) => b.type === "tool_use");
		return { content: step, stopReason: hasTool ? "tool_use" : "end_turn" };
	}

	private async stream(text: string, req: ProviderRequest): Promise<void> {
		const chunks = text.match(/[\s\S]{1,18}/g) ?? [];
		for (const c of chunks) {
			if (req.signal?.aborted) throw new Error("aborted");
			req.onText(c);
			if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		}
	}

	private tool(name: string, input: unknown): ContentBlock {
		return { type: "tool_use", id: `demo_${++this.counter}_${name}`, name, input };
	}

	private nextStep(messages: ChatMessage[]): ContentBlock[] {
		const last = messages[messages.length - 1];
		const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
		const lastToolNames = results.map((r) => toolNameFor(messages, (r as any).tool_use_id));
		const userTurns = messages.filter(isLearnerTurn).length;
		const learnerSpoke = !!last && isLearnerTurn(last);
		const resultText = results.map((r) => String((r as any).content)).join("\n");

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
						"Start from slope (an unconditional truth: rise over run for a straight line), ask how to get a slope for a curve, discover that zooming in makes curves look straight, formalize the zoom as a limit, and arrive at the derivative.",
					target: "Derivative",
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
				mermaid = JSON.parse(resultText).mermaid ?? "";
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

		if (lastToolNames.includes("quiz") && !/Secant line/.test(resultText)) {
			const right = /CORRECTLY/.test(resultText) && !/INCORRECTLY/.test(resultText);
			return [
				{
					type: "text",
					text: right
						? "Solid floor. Now the motivating problem: a curve like $y = x^2$ has no single rise-over-run. But pick **two points** on it and you get a line through them, the ==secant line==, which *does* have a slope.\n\n> [!tip] How could you have discovered this?\n> You only know how to measure the slope of lines, so turn the curve problem into a line problem: draw a line through two points on the curve.\n"
						: "That's the edge, and a useful one. Slope is ==change in $y$ divided by change in $x$==, always in that order. Let's lock that in and then use it on curves.\n\n> [!note] Unconditional truth\n> For any straight line, $m = \\dfrac{y_2 - y_1}{x_2 - x_1}$, no matter which two points you pick.\n",
				},
				this.tool("quiz", {
					concept: "Secant line",
					question: "On $y = x^2$, what is the slope of the secant line through $x = 1$ and $x = 1 + h$?",
					options: [
						{ label: "$2 + h$", value: "2h" },
						{ label: "$2$", value: "2", misconception: "Jumps to the tangent slope before taking any limit" },
						{ label: "$h^2$", value: "h2", misconception: "Squares the step size instead of forming the difference quotient" },
						{ label: "$1 + h$", value: "1h", misconception: "Uses the change in x as the slope" },
					],
					correctAnswer: "2h",
					explanation: "$\\frac{(1+h)^2 - 1^2}{h} = \\frac{2h + h^2}{h} = 2 + h$. Notice what happens as $h$ shrinks: that's the next node, the limit.",
					difficulty: 3,
					kind: "check",
				}),
			];
		}

		if (lastToolNames.includes("quiz")) {
			return [
				{
					type: "text",
					text: "Look at what you just computed: the secant slope is $2 + h$, and as the two points squeeze together ($h \\to 0$) it heads to $2$. That squeezing is exactly what a ==limit== makes precise:\n\n$$\nf'(1) = \\lim_{h \\to 0} \\frac{f(1+h) - f(1)}{h} = 2\n$$\n\nI've recorded both answers in your vault. Open the goal note to see the map re-colored.\n",
				},
				this.tool("save_session_summary", {
					title: "The derivative (demo)",
					summary: "Probed slope of a line, then derived the secant slope on $y=x^2$ as the setup for limits.",
					concepts: ["Slope of a line", "Secant line", "Limit", "Derivative"],
					next: "Formalize the limit, then derive $\\frac{d}{dx}x^2 = 2x$.",
				}),
			];
		}

		if (lastToolNames.includes("save_session_summary")) {
			return [
				{
					type: "text",
					text: "Session saved. This is the end of the scripted demo. Add an Anthropic API key in **Settings → Groundwork** for a real tutor that plans any goal you give it.",
				},
			];
		}

		return [
			{
				type: "text",
				text: "*(Demo mode)* The scripted tutor has finished. Add an Anthropic API key in **Settings → Groundwork** to learn anything you like, or start a new session to replay the demo.",
			},
		];
	}
}

function isLearnerTurn(m: ChatMessage): boolean {
	return m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
}

function toolNameFor(messages: ChatMessage[], toolUseId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const hit = m.content.find((b) => b.type === "tool_use" && (b as any).id === toolUseId);
		if (hit) return (hit as any).name;
	}
	return undefined;
}
