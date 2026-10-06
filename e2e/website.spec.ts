import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const artifactRoot = "/opt/cursor/artifacts/website-e2e";
mkdirSync(artifactRoot, { recursive: true });

async function seedLargeAccount(request: APIRequestContext) {
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	const concepts = Array.from({ length: 48 }, (_, i) => ({
		id: `concept-${i}`,
		title: i === 3 ? "A very long concept name that should ellipsize in the list without breaking the row layout" : `Concept ${i + 1}`,
		status: i % 5 === 0 ? "unassessed" : i % 3 === 0 ? "learning" : "solid",
		current: 0.5,
		prerequisites: i > 0 ? [`concept-${i - 1}`] : [],
		domain: i % 7 === 0 ? "Physics" : i % 11 === 0 ? "History" : "Mathematics",
	}));
	await request.put("/v1/memory", {
		data: {
			files: {},
			knowledge: {
				updatedAt: new Date().toISOString(),
				concepts,
				goals: [
					{ title: "Finish the practice set", status: "done", built: 4, open: 0 },
					{ title: "Exam prep — long title that should wrap cleanly on narrow screens", status: "active", built: 2, open: 5 },
				],
			},
		},
	});
}

const publicPages = ["/", "/pricing", "/exam-prep", "/concept-map", "/quizzes-flashcards", "/goals", "/get-started", "/privacy", "/terms"];

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("gw-consent-hide", "1"));
});

test("public marketing pages load", async ({ page }) => {
	for (const href of publicPages) {
		const res = await page.goto(href);
		expect(res?.status(), href).toBe(200);
		await expect(page.locator("footer.foot")).toContainText("methoddev1505@gmail.com");
		await expect(page.locator("body")).not.toContainText("[Dev:");
	}
	const robots = await page.goto("/robots.txt");
	expect(robots?.status()).toBe(200);
	const sitemap = await page.goto("/sitemap.xml");
	expect(sitemap?.status()).toBe(200);
});

test("landing and 404", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: /Learn it from the ground up/i })).toBeVisible();
	await expect(page.locator("body")).toContainText("Bring your own model for $4/month");
	await expect(page.locator("body")).toContainText("for $15/month");
	await expect(page.locator("body")).toContainText("Start free on Groundwork");
	await expect(page).toHaveTitle(/Groundwork/);
	const res = await page.goto("/this-route-does-not-exist");
	expect(res?.status()).toBe(404);
	await expect(page.getByRole("heading", { name: /Page not found/i })).toBeVisible();
});

test("first visit is calm with a checklist", async ({ page, request }) => {
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	await request.put("/v1/memory", { data: { files: {}, knowledge: { concepts: [], goals: [] } } });
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /^Welcome,/ })).toBeVisible();
	await expect(page.getByRole("heading", { name: /First session/i })).toBeVisible();
	await expect(page.locator(".board")).toHaveCount(0);
	await expect(page.locator(".start-checklist #open-obsidian")).toBeVisible();
	await expect(page.locator(".panel-cta")).toHaveCount(0);
	await page.screenshot({ path: path.join(artifactRoot, "account-first-visit.png"), fullPage: true });
});

test("local account dashboard with large study record", async ({ page, request }) => {
	await seedLargeAccount(request);
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
	await expect(page.locator(".board")).toHaveCount(1);
	await expect(page.locator(".board")).toContainText("Tutor usage this month");
	await expect(page.locator(".board .quota-meter")).toBeVisible();
	await expect(page.getByRole("region", { name: /Concept graph/i })).toBeVisible();
	await expect(page.locator(".concept-list li")).toHaveCount(12);
	await page.getByRole("button", { name: /Show \d+ more/i }).click();
	expect(await page.locator(".concept-list li").count()).toBeGreaterThan(12);
	await page.screenshot({ path: path.join(artifactRoot, "account-large-data.png"), fullPage: true });
});

test("plan picker and sign-out", async ({ page, request }) => {
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await page.getByRole("button", { name: /Upgrade|Change plan/i }).click();
	await expect(page.getByRole("heading", { name: /Choose a plan/i })).toBeVisible();
	await expect(page.locator(".plans")).toContainText("$4");
	await expect(page.locator(".plans")).toContainText("$15");
	await expect(page.locator(".plans")).toContainText("Free");
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page.getByRole("heading", { name: /Learn it from the ground up/i })).toBeVisible();
});
