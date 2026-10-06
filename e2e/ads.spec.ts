import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const shots = "/opt/cursor/artifacts/site-ads";
mkdirSync(shots, { recursive: true });

const pages = ["/", "/pricing", "/exam-prep", "/concept-map", "/quizzes-flashcards", "/goals", "/get-started", "/privacy", "/terms"];

function slug(href: string): string {
	return href === "/" ? "home" : href.slice(1);
}

test("public pages, footer email, and screenshots", async ({ page }, testInfo) => {
	const width = testInfo.project.name === "phone" ? "mobile" : "desktop";
	for (const href of pages) {
		const res = await page.goto(href);
		expect(res?.status(), href).toBe(200);
		await expect(page.locator("footer").getByRole("link", { name: "methoddev1505@gmail.com" })).toBeVisible();
		await expect(page.locator("body")).not.toContainText("[Dev:");
		await expect(page.locator("body")).not.toContainText(/coming soon/i);
		if (href === "/") {
			await expect(page.getByRole("dialog", { name: "Cookies" })).toBeVisible();
			await page.screenshot({ path: path.join(shots, `home-consent-${width}.png`) });
			await page.getByRole("button", { name: "OK" }).click();
		}
		await page.screenshot({ path: path.join(shots, `${slug(href)}-${width}.png`), fullPage: true });
	}
	const missing = await page.goto("/this-route-does-not-exist");
	expect(missing?.status()).toBe(404);
	await expect(page.getByRole("heading", { name: /Page not found/i })).toBeVisible();
	await page.screenshot({ path: path.join(shots, `404-${width}.png`), fullPage: true });
});

test("consent defaults deny everywhere and grant the US", async ({ page }) => {
	await page.goto("/");
	const regions = await page.evaluate(() => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer.filter((entry) => Array.isArray(entry) && entry[0] === "consent" && entry[1] === "default") as Array<[string, string, { region?: string[]; ad_storage: string }]>;
	});
	expect(regions[0]?.[2].ad_storage).toBe("denied");
	expect(regions[0]?.[2].region).toBeUndefined();
	expect(regions[1]?.[2].region).toEqual(["US"]);
	expect(regions[1]?.[2].ad_storage).toBe("granted");
});

test("sign_up fires only when the account was just created", async ({ page }) => {
	await page.route("**/v1/account", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		const json = await response.json();
		await route.fulfill({ response, json: { ...json, created: true } });
	});
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect.poll(async () => countEvents(page, "sign_up")).toBe(1);

	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /Welcome|Choose a plan/i })).toBeVisible();
	expect(await countEvents(page, "sign_up")).toBe(0);
});

test("a returning account does not fire sign_up", async ({ page }) => {
	await page.route("**/v1/account", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		const json = await response.json();
		await route.fulfill({ response, json: { ...json, created: false } });
	});
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /Welcome|Choose a plan/i })).toBeVisible();
	expect(await countEvents(page, "sign_up")).toBe(0);
});

test("purchase fires once per checkout session", async ({ page }) => {
	await page.goto("/?billing=success&session_id=cs_test_1&plan=byom");
	await expect.poll(async () => purchaseParams(page)).toEqual([{ transaction_id: "cs_test_1", value: 9, currency: "USD" }]);
	await page.goto("/?billing=success&session_id=cs_test_1&plan=byom");
	await page.waitForFunction(() => Boolean((window as unknown as { GroundworkTracking?: unknown }).GroundworkTracking));
	expect(await countEvents(page, "purchase")).toBe(0);
	await page.goto("/?billing=success&session_id=cs_test_2&plan=included");
	await expect.poll(async () => purchaseParams(page)).toEqual([{ transaction_id: "cs_test_2", value: 20, currency: "USD" }]);
	expect(await page.evaluate(() => localStorage.getItem("gw-purchases"))).toContain("cs_test_1");
});

test("utm and gclid survive navigation and ride on the account request", async ({ page }) => {
	const headers: string[] = [];
	await page.route("**/v1/account**", async (route) => {
		headers.push(route.request().headers()["x-groundwork-attribution"] ?? "");
		await route.continue();
	});
	await page.goto("/?utm_source=ads&utm_medium=cpc&gclid=Cjwtest");
	await page.goto("/?utm_source=later&gclid=second");
	const stored = await page.evaluate(() => localStorage.getItem("gw-attribution"));
	expect(stored).toContain("ads");
	expect(stored).not.toContain("later");
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /Welcome|Choose a plan/i })).toBeVisible();
	const sent = headers.find((value) => value.includes("utm_source"));
	expect(sent).toBeTruthy();
	expect(decodeURIComponent(sent ?? "")).toContain("Cjwtest");
	expect(decodeURIComponent(sent ?? "")).not.toContain("second");
});

test("obsidian_connected fires on the first link only", async ({ page, request }) => {
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	await page.addInitScript(() => {
		document.addEventListener(
			"click",
			(event) => {
				const target = event.target;
				const link = target instanceof Element ? target.closest("a") : null;
				if (link instanceof HTMLAnchorElement && link.href.startsWith("obsidian:")) event.preventDefault();
			},
			true,
		);
	});
	let first = true;
	let links = 0;
	await page.route("**/v1/obsidian-opened/**", async (route) => {
		if (route.request().url().includes("/signal")) {
			await route.fulfill({ json: { ok: true } });
			return;
		}
		await route.fulfill({ json: { opened: true } });
	});
	await page.route("**/v1/account/obsidian-connected", async (route) => {
		links += 1;
		await route.fulfill({ json: { first } });
		first = false;
	});
	await page.goto("/?e2e=link#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await page.getByRole("button", { name: "Open Obsidian" }).click();
	await expect.poll(() => links).toBe(1);
	expect(await countEvents(page, "obsidian_connected")).toBe(1);
	await page.getByRole("button", { name: "Open Obsidian" }).click();
	await expect.poll(() => links).toBe(2);
	expect(await countEvents(page, "obsidian_connected")).toBe(1);
});

async function countEvents(page: import("@playwright/test").Page, name: string): Promise<number> {
	return page.evaluate((eventName) => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer.filter((entry) => Array.isArray(entry) && entry[1] === eventName).length;
	}, name);
}

async function purchaseParams(page: import("@playwright/test").Page): Promise<Array<{ transaction_id?: string; value?: number; currency?: string }>> {
	return page.evaluate(() => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer
			.filter((entry) => Array.isArray(entry) && entry[1] === "purchase")
			.map((entry) => (entry as [string, string, { transaction_id?: string; value?: number; currency?: string }])[2]);
	});
}
