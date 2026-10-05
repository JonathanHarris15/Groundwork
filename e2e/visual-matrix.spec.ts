import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const outDir = "/opt/cursor/artifacts/website-matrix";
mkdirSync(outDir, { recursive: true });

const viewports = [
	{ tag: "390x844", width: 390, height: 844 },
	{ tag: "768x1024", width: 768, height: 1024 },
	{ tag: "1024x768", width: 1024, height: 768 },
	{ tag: "1280x800", width: 1280, height: 800 },
	{ tag: "1440x900", width: 1440, height: 900 },
	{ tag: "1920x1080", width: 1920, height: 1080 },
	{ tag: "2560x1440", width: 2560, height: 1440 },
] as const;

async function seedMemory(request: APIRequestContext, count: number) {
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	if (count === 0) {
		await request.put("/v1/memory", { data: { files: {}, knowledge: { concepts: [], goals: [] } } });
		return;
	}
	const concepts = Array.from({ length: count }, (_, i) => ({
		id: `c-${i}`,
		title: `Concept ${i + 1}`,
		status: i % 6 === 0 ? "rusty" : i % 5 === 0 ? "shaky" : i % 4 === 0 ? "learning" : i % 3 === 0 ? "unassessed" : "solid",
		current: 0.5,
		prerequisites: i > 0 ? [`c-${i - 1}`] : [],
		domain: i % 7 === 0 ? "Physics" : "Mathematics",
	}));
	const goals = count > 0 ? [{ title: "Practice set", status: "done", built: 2, open: 0 }] : [];
	await request.put("/v1/memory", {
		data: {
			files: {},
			knowledge: { updatedAt: new Date().toISOString(), concepts, goals },
		},
	});
}

async function signInLocal(page: Page) {
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /^Welcome,/ })).toBeVisible();
}

for (const vp of viewports) {
	test.describe(`viewport ${vp.tag}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("landing", async ({ page }) => {
			await page.goto("/");
			await expect(page.getByRole("heading", { name: /Learn it from the ground up/i })).toBeVisible();
			await page.screenshot({ path: path.join(outDir, `landing-${vp.tag}.png`), fullPage: true });
		});

		test("account empty", async ({ page, request }) => {
			await seedMemory(request, 0);
			await signInLocal(page);
			await page.screenshot({ path: path.join(outDir, `account-empty-${vp.tag}.png`), fullPage: true });
		});

		test("account typical", async ({ page, request }) => {
			await seedMemory(request, 15);
			await signInLocal(page);
			await page.screenshot({ path: path.join(outDir, `account-typical-${vp.tag}.png`), fullPage: true });
		});

		test("account large", async ({ page, request }) => {
			await seedMemory(request, 200);
			await signInLocal(page);
			await page.screenshot({ path: path.join(outDir, `account-large-${vp.tag}.png`), fullPage: true });
		});
	});
}
