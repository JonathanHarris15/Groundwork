import { describe, expect, it } from "vitest";
import { isTutorMemoryPath } from "../src/account";
import { figureFile, figureForChat, parseFigureSpec, renderFigure, saveFigure } from "../src/figure";
import { sanitizeSvg } from "../src/figure-svg";
import { assertPublicHttpsUrl, fetchPublic, isPrivateAddress } from "../src/figure-net";
import { runPythonFigure } from "../src/figure-python";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const publicLookup = async () => ["1.1.1.1"];

describe("public figures", () => {
	it("refuses addresses that are not public https", async () => {
		expect(() => assertPublicHttpsUrl("http://example.com/a.png")).toThrow(/https/);
		expect(() => assertPublicHttpsUrl("https://user:secret@example.com/a.png")).toThrow(/password/);
		expect(() => assertPublicHttpsUrl("https://127.0.0.1/latest")).toThrow(/not public/);
		expect(() => assertPublicHttpsUrl("https://169.254.169.254/latest")).toThrow(/not public/);
		expect(() => assertPublicHttpsUrl("https://10.0.0.5/map.json")).toThrow(/not public/);
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("8.8.8.8")).toBe(false);

		let fetched = 0;
		await expect(
			fetchPublic("https://evil.example/map.json", {
				lookup: async () => ["169.254.169.254"],
				fetch: async () => {
					fetched++;
					return new Response("no");
				},
			}),
		).rejects.toThrow(/not public/);
		expect(fetched).toBe(0);

		await expect(
			fetchPublic("https://maps.example/start", {
				lookup: publicLookup,
				fetch: async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }),
			}),
		).rejects.toThrow(/not public/);
	});

	it("reads a public GeoJSON document and draws the tutor's marks on it", async () => {
		const geo = {
			type: "Polygon",
			coordinates: [
				[
					[0, 40],
					[20, 40],
					[20, 55],
					[0, 55],
					[0, 40],
				],
			],
		};
		const svg = renderFigure(
			parseFigureSpec({
				title: "The front",
				kind: "geo",
				geojson: geo,
				markers: [
					{ name: "Normandy", lat: 49.3, lon: 0.5, side: "Allies" },
					{ name: "Berlin", lat: 52.5, lon: 13.4, side: "Axis" },
				],
				movements: [{ from: "Normandy", to: "Berlin", label: "1944" }],
			}),
		);
		expect(svg).toContain("Normandy");
		expect(svg).toContain("Berlin");
		expect(svg).toContain("1944");
		expect(svg.match(/fill="#e4ddd0"/g)?.length).toBe(1);

		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		const figure = await saveFigure(
			store,
			{ title: "Coast", kind: "geo", url: "https://maps.example/coast.geojson" },
			undefined,
			{
				lookup: publicLookup,
				fetch: async () => new Response(JSON.stringify(geo), { status: 200, headers: { "content-type": "application/geo+json" } }),
			},
		);
		expect(figure.svg).toContain("<path ");
		expect(figure.credit).toBe("maps.example");
		expect(figure.spec.kind === "geo" && figure.spec.polygons.length).toBe(1);
		expect(isTutorMemoryPath(figureFile(figure.id))).toBe(true);
	});

	it("saves a public image on the account and leaves the bytes out of the chat copy", async () => {
		const io = new MemoryVaultIO();
		const store = new KnowledgeStore(io);
		const figure = await saveFigure(
			store,
			{ title: "Western Front", kind: "image", url: "https://upload.example/front.png", credit: "Wikimedia Commons" },
			undefined,
			{
				lookup: publicLookup,
				fetch: async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
			},
		);
		expect(figure.media?.mime).toBe("image/png");
		expect(figure.media?.width).toBe(1);
		expect(figure.media?.height).toBe(1);
		expect(figure.credit).toBe("Wikimedia Commons");
		const chat = figureForChat(figure);
		expect(chat.media).toBeUndefined();
		expect(chat.hasMedia).toBe(true);
		const saved = JSON.parse(await io.read(figureFile(figure.id))) as { media: { base64: string } };
		expect(saved.media.base64).toBe(PNG.toString("base64"));

		const huge = Buffer.alloc(200_001);
		PNG.copy(huge);
		await expect(
			saveFigure(store, { title: "Too big", kind: "image", url: "https://upload.example/big.png" }, undefined, {
				lookup: publicLookup,
				fetch: async () => new Response(huge, { status: 200, headers: { "content-type": "image/png" } }),
			}),
		).rejects.toThrow(/thumbnail/);
	});

	it("keeps an animated drawing and drops scripts", () => {
		const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>alert(1)</script><circle cx="10" cy="20" r="4" onclick="alert(1)" href="https://evil.example/x"><animate attributeName="cx" from="10" to="30" dur="1s" repeatCount="indefinite"/></circle></svg>`);
		expect(clean).not.toContain("<script");
		expect(clean).not.toContain("onclick");
		expect(clean).not.toContain("evil.example");
		expect(clean).toContain("<animate");
		const svg = renderFigure(parseFigureSpec({ title: "Motion", kind: "svg", markup: clean }));
		expect(svg).toContain("<animate");
	});

	it("runs a Python program that writes the figure, without the tutor's secrets", async () => {
		process.env.GW_FIGURE_SENTINEL = "secret-value";
		try {
			const produced = await runPythonFigure(`import os
open("figure.svg","w").write('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="8" cy="20" r="4"><animate attributeName="cx" from="8" to="32" dur="1s" repeatCount="indefinite"/></circle><text>' + os.environ.get("GW_FIGURE_SENTINEL","missing") + '</text></svg>')
`);
			expect(produced.svg).toContain("<animate");
			expect(produced.svg).toContain("missing");
			expect(produced.svg).not.toContain("secret-value");
		} finally {
			delete process.env.GW_FIGURE_SENTINEL;
		}
	});

	it("fetch_public refuses a local address before any request", async () => {
		const tool = toolByName("fetch_public");
		await expect(tool!.run({ url: "https://localhost/map.json" }, { store: new KnowledgeStore(new MemoryVaultIO()) })).rejects.toThrow(/not public/);
	});
});
