import { describe, expect, it } from "vitest";
import { isTutorMemoryPath } from "../src/account";
import {
	compileExpr,
	demoFigureFor,
	figureFile,
	figureFromModelText,
	parseFigureSpec,
	renderFigure,
	saveFigure,
} from "../src/figure";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";

describe("figures", () => {
	it("plots an expression, including a 3D surface", () => {
		const plot = renderFigure(
			demoFigureFor("graph the derivative of the parabola"),
		);
		expect(plot).toContain("y = x²");
		expect(plot).toContain("<path");
		expect(plot).not.toContain("<script");

		const surface = renderFigure(demoFigureFor("show the saddle as a 3d surface"));
		expect(surface).toContain("A surface");
		expect(surface.match(/<path /g)?.length ?? 0).toBeGreaterThan(20);
	});

	it("draws a story arc, a troop map, a conjugation, and a sentence", () => {
		const story = renderFigure(demoFigureFor("the rising action reaches a climax"));
		expect(story).toContain("Rising action");
		expect(story).toContain("Climax");
		expect(story).toContain("Falling action");

		const map = renderFigure(demoFigureFor("where the troops were in the Normandy campaign"));
		expect(map).toContain("Normandy");
		expect(map).toContain("Berlin");
		expect(map).toContain("Allies");
		expect(map).toContain("Axis");

		const verb = renderFigure(demoFigureFor("Spanish conjugation of hablar"));
		expect(verb).toContain("hablas");
		expect(verb).toContain("#f3e0c4");

		const sentence = renderFigure(demoFigureFor("diagram this grammar sentence"));
		expect(sentence).toContain("dog");
		expect(sentence).toContain("chased");
		expect(sentence).toContain("cat");
	});

	it("escapes text so a title cannot break the svg", () => {
		const svg = renderFigure({
			kind: "story",
			title: `</title><script>alert("x")</script>`,
			beats: [
				{ stage: "exposition", label: "Start" },
				{ stage: "climax", label: "Turn" },
			],
		});
		expect(svg).not.toContain("<script");
		expect(svg).toContain("&lt;/title&gt;");
	});

	it("rejects a plot expression that is not math", () => {
		expect(() => compileExpr("process.exit(1)", ["x"])).toThrow(/not a variable|Unknown function|Can't read/);
		expect(() => parseFigureSpec({ title: "Bad", kind: "plot", series: [{ name: "nope", mark: "line" }] })).toThrow(/points or an expr/);
	});

	it("reads a fenced reply from the visualization request", () => {
		const spec = figureFromModelText('Here you go:\n```json\n{"title":"Arc","kind":"story","beats":[{"stage":"rising","label":"Build"},{"stage":"climax","label":"Turn"}]}\n```');
		expect(spec.kind).toBe("story");
	});

	it("saves the figure on the account and hands it to the tutor window", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		const seen: string[] = [];
		const ui: ToolUI = {
			async quiz() {
				return null;
			},
			async ask() {
				return { selected: [] };
			},
			showFigure(figure) {
				seen.push(figure.id);
			},
		};
		const tool = toolByName("show_figure");
		const result = await tool!.run(
			{
				title: "y = sin(x)",
				kind: "plot",
				xLabel: "x",
				yLabel: "y",
				series: [{ name: "sin", expr: "sin(x)", mark: "line" }],
			},
			{ store, ui, session: { id: "chat-1" } },
		);
		expect(result.isError).toBeUndefined();
		expect(result.summary).toBe("Figure: y = sin(x)");
		expect(seen).toHaveLength(1);
		const path = figureFile(seen[0]);
		expect(isTutorMemoryPath(path)).toBe(true);
		expect(await io.exists(path)).toBe(true);
		const saved = JSON.parse(await io.read(path)) as { svg: string; sessionId: string };
		expect(saved.sessionId).toBe("chat-1");
		expect(saved.svg).toContain("<svg");
	});

	it("evaluates the expression, then places those points on the axes", () => {
		expect(compileExpr("-x^2 + 3*x + 1", ["x"])({ x: 4 })).toBe(-16 + 12 + 1);
		expect(compileExpr("2^3^2", ["x"])({ x: 0 })).toBe(512);
		expect(compileExpr("sin(pi/2)", ["x"])({ x: 0 })).toBeCloseTo(1, 12);
		expect(compileExpr("log(e)", ["x"])({ x: 0 })).toBeCloseTo(1, 12);

		const spec = parseFigureSpec({
			title: "y = x^2",
			kind: "plot",
			xMin: -2,
			xMax: 2,
			yMin: 0,
			yMax: 4,
			series: [{ expr: "x^2", mark: "line" }],
		});
		if (spec.kind !== "plot") throw new Error("expected a plot");
		for (const [x, y] of spec.series[0].points) expect(y).toBeCloseTo(x * x, 10);

		const svg = renderFigure(spec);
		const frame = frameOf(svg);
		for (const [px, py] of pathVertices(svg)) {
			const x = frame.x0 + ((px - frame.left) / frame.plotWidth) * (frame.x1 - frame.x0);
			const y = frame.y1 - ((py - frame.top) / frame.plotHeight) * (frame.y1 - frame.y0);
			expect(Math.abs(y - x * x)).toBeLessThan(0.02);
		}
	});

	it("breaks a curve at an asymptote instead of drawing across it", () => {
		const spec = parseFigureSpec({
			title: "y = tan(x)",
			kind: "plot",
			xMin: 0,
			xMax: 2,
			yMin: -4,
			yMax: 4,
			series: [{ expr: "tan(x)", mark: "line" }],
		});
		const svg = renderFigure(spec);
		const frame = frameOf(svg);
		const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
		expect(paths.length).toBeGreaterThan(1);
		const piOver2 = Math.PI / 2;
		for (const d of paths) {
			const xs = pathVertices(d).map(([px]) => frame.x0 + ((px - frame.left) / frame.plotWidth) * (frame.x1 - frame.x0));
			const crosses = xs.some((x) => x < piOver2 - 0.05) && xs.some((x) => x > piOver2 + 0.05);
			expect(crosses).toBe(false);
		}
	});

	it("samples a surface from the expression", () => {
		const spec = parseFigureSpec({
			title: "bowl",
			kind: "plot3d",
			expr: "x^2 + y^2",
			xMin: -1,
			xMax: 1,
			yMin: -1,
			yMax: 1,
		});
		if (spec.kind !== "plot3d") throw new Error("expected a surface");
		const n = spec.grid.length;
		expect(spec.grid[0][0]).toBeCloseTo(2, 8);
		expect(spec.grid[n - 1][n - 1]).toBeCloseTo(2, 8);
		const mid = Math.floor((n - 1) / 2);
		expect(spec.grid[mid][mid]).toBeLessThan(0.02);
	});

	it("keeps a direct save addressable", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		const figure = await saveFigure(store, demoFigureFor("a story climax"), { quote: "climax", anchor: "item:1", id: "fig_test1" });
		expect(figure.anchor).toBe("item:1");
		expect(figureFile(figure.id)).toBe(".groundwork/figures/fig_test1.json");
	});
});

function frameOf(svg: string): { x0: number; x1: number; y0: number; y1: number; left: number; top: number; plotWidth: number; plotHeight: number } {
	const attr = (name: string) => {
		const match = new RegExp(`data-${name}="([^"]+)"`).exec(svg);
		if (!match) throw new Error(`missing data-${name}`);
		return Number(match[1]);
	};
	return {
		x0: attr("x0"),
		x1: attr("x1"),
		y0: attr("y0"),
		y1: attr("y1"),
		left: attr("left"),
		top: attr("top"),
		plotWidth: attr("plot-width"),
		plotHeight: attr("plot-height"),
	};
}

function pathVertices(markup: string): Array<[number, number]> {
	return [...markup.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
}
