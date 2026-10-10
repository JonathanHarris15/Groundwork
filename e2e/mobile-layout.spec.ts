import { expect, test, type Page } from "@playwright/test";

const pages = [
	"/",
	"/pricing",
	"/practice-tests",
	"/exam-prep",
	"/concept-map",
	"/quizzes-flashcards",
	"/goals",
	"/get-started",
	"/privacy",
	"/terms",
	"/this-route-does-not-exist",
	"/admin/usage",
];

const foldCtas = ["/", "/practice-tests", "/exam-prep"];

test.beforeEach(async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "Phone layout is measured once, at a set viewport");
	await page.addInitScript(() => localStorage.setItem("gw-consent-hide", "1"));
});

test("no horizontal overflow and a single header row at 360px", async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	for (const href of pages) {
		await page.goto(href);
		const layout = await measureHeader(page);
		expect(layout.overflow, href).toBeLessThanOrEqual(1);
		expect(layout.headerH, href).toBeLessThan(76);
		expect(layout.logoTop, href).toBeGreaterThanOrEqual(4);
		expect(layout.sameRow, href).toBe(true);
		expect(layout.menuShown, href).toBe(true);
		if (foldCtas.includes(href)) {
			expect(layout.ctaInFold, `${href} CTA`).toBe(true);
			expect(layout.ctaTall, `${href} CTA`).toBe(true);
		}
	}
});

test("desktop keeps the inline nav at 1280px", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	const layout = await measureHeader(page);
	expect(layout.overflow).toBeLessThanOrEqual(1);
	expect(layout.menuShown).toBe(false);
	await expect(page.locator(".bar-nav .nav-wide").first()).toBeVisible();
	await expect(page.locator(".sign-link")).toBeVisible();
});

test("signed-in account stays on one row and shows an empty goals state", async ({ page, request }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	await request.put("/v1/memory", {
		data: {
			files: {},
			knowledge: {
				updatedAt: new Date().toISOString(),
				concepts: [{ id: "c-1", title: "Chain rule", status: "solid", current: 0.5, prerequisites: [], domain: "Mathematics" }],
				goals: [],
			},
		},
	});
	await page.goto("/#signin");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
	await expect(page.locator(".big.is-empty")).toHaveText("None yet");
	await expect(page.getByText("Goals reached")).toBeVisible();
	const layout = await measureHeader(page);
	expect(layout.overflow).toBeLessThanOrEqual(1);
	expect(layout.headerH).toBeLessThan(76);
	expect(layout.logoTop).toBeGreaterThanOrEqual(4);
	expect(layout.sameRow).toBe(true);
	await page.locator("#site summary", { hasText: "Menu" }).click();
	await expect(page.locator("#sign-out")).toBeVisible();
	await expect(page.locator("#site .nav-menu").getByRole("link", { name: "Practice tests" })).toBeVisible();
	await expect(page.locator("#site .nav-menu").getByRole("link", { name: "Admin" })).toBeVisible();
});

test("checkout return banners stay inside the viewport", async ({ page, request }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await request.post("/v1/account/plan", { data: { plan: "free" } });
	for (const [flag, copy] of [
		["success", "Payment started. Your plan updates as soon as Stripe confirms it."],
		["cancel", "Checkout was canceled. Your plan is unchanged."],
	] as const) {
		await page.goto(`/?billing=${flag}#signin`);
		await page.getByRole("button", { name: "Continue on this device" }).click();
		await expect(page.getByText(copy)).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow, flag).toBeLessThanOrEqual(1);
	}
});

test("admin tables scroll inside the page at 360px", async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await page.addInitScript(() => localStorage.setItem("gw-e2e-email", "usage-admin@groundwork.test"));
	await page.goto("/admin/usage");
	await page.getByRole("button", { name: "Continue on this device" }).click();
	await expect(page.getByRole("heading", { name: "Free plan usage" })).toBeVisible();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
	await expect(page.locator(".usage-scroll").first()).toBeVisible();
});

test("the cookie banner is tappable and does not cover the first CTA", async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await page.addInitScript(() => localStorage.removeItem("gw-consent-hide"));
	await page.goto("/");
	const banner = page.getByRole("dialog", { name: "Cookies" });
	await expect(banner).toBeVisible();
	const fit = await page.evaluate(() => {
		const bar = document.querySelector(".consent");
		const cta = document.querySelector("a.cta");
		if (!bar || !cta) return null;
		const barBox = bar.getBoundingClientRect();
		const ctaBox = cta.getBoundingClientRect();
		const buttons = [...bar.querySelectorAll("button")].map((button) => button.getBoundingClientRect().height);
		const overlaps = barBox.left < ctaBox.right && barBox.right > ctaBox.left && barBox.top < ctaBox.bottom && barBox.bottom > ctaBox.top;
		return {
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			overlaps,
			buttons,
			text: Number.parseFloat(getComputedStyle(bar).fontSize),
		};
	});
	expect(fit).not.toBeNull();
	expect(fit?.overflow).toBeLessThanOrEqual(1);
	expect(fit?.overlaps).toBe(false);
	expect(fit?.text).toBeGreaterThanOrEqual(16);
	expect(fit?.buttons.every((height) => height >= 44)).toBe(true);
});

async function measureHeader(page: Page) {
	return page.evaluate(() => {
		const site = document.querySelector("#site");
		const header = site && !site.hasAttribute("hidden") ? site.querySelector("header.top") : document.querySelector("header.bar");
		const logo = header?.querySelector(".logo");
		const menu = header?.querySelector("summary");
		const cta = document.querySelector("a.cta");
		if (!header || !logo || !menu) return { overflow: 999, headerH: 999, logoTop: -1, sameRow: false, menuShown: false, ctaInFold: false, ctaTall: false };
		const logoBox = logo.getBoundingClientRect();
		const menuBox = menu.getBoundingClientRect();
		const headerBox = header.getBoundingClientRect();
		const ctaBox = cta?.getBoundingClientRect();
		return {
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			headerH: headerBox.height,
			logoTop: logoBox.top,
			sameRow: Math.abs(logoBox.top + logoBox.height / 2 - (menuBox.top + menuBox.height / 2)) < 8,
			menuShown: getComputedStyle(menu.closest(".nav-more") ?? menu).display !== "none",
			ctaInFold: Boolean(ctaBox && ctaBox.top >= 0 && ctaBox.bottom <= window.innerHeight),
			ctaTall: Boolean(ctaBox && ctaBox.height >= 44),
		};
	});
}
