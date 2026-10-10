import { expect, test } from "@playwright/test";
import path from "node:path";

const shots = "/opt/cursor/artifacts";

test.describe("admin usage on a desktop", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "chromium", "Desktop nav is the chromium project");
		await page.addInitScript(() => localStorage.setItem("gw-consent-hide", "1"));
	});

	test("the desktop nav shows Admin only for an allowlisted user", async ({ page }) => {
		await page.goto("/admin/usage");
		await expect(page.locator(".nav-wide[data-admin-link]")).toBeHidden();
		await page.addInitScript(() => localStorage.setItem("gw-e2e-email", "usage-admin@groundwork.test"));
		await page.goto("/admin/usage");
		await page.getByRole("button", { name: "Continue on this device" }).click();
		await expect(page.getByRole("heading", { name: "Free plan usage" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Account counts" })).toBeVisible();
		await expect(page.locator(".usage-head-cards")).toBeVisible();
		await expect(page.locator(".nav-wide[data-admin-link]")).toBeVisible();
		await expect(page.locator(".nav-wide[data-admin-link]")).toHaveAttribute("href", "/admin/usage");
	});
});

test.describe("admin usage on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "phone", "Mobile viewport is the phone project");
		await page.addInitScript(() => localStorage.setItem("gw-consent-hide", "1"));
	});

	test("signed out visitors get the sign-in prompt and no admin link", async ({ page }) => {
		await page.goto("/admin/usage");
		await expect(page.getByRole("heading", { name: "Sign in or start free." })).toBeVisible();
		await expect(page.locator(".sign-link")).toHaveText("Sign in");
		await expect(page.locator(".nav-menu [data-admin-link]")).toBeHidden();
		await expect(page.locator("body")).not.toContainText("$1.25");
		await page.locator("summary", { hasText: "Menu" }).click();
		await expect(page.locator(".nav-menu").getByRole("link", { name: "Admin" })).toBeHidden();
	});

	test("a signed-in non-admin sees the 404 and a signed-in header", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("gw-e2e-email", "stranger@learners.invalid"));
		await page.goto("/admin/usage");
		await page.getByRole("button", { name: "Continue on this device" }).click();
		await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
		await expect(page.locator(".sign-link")).toContainText("stranger@learners.invalid");
		await expect(page.locator(".sign-link")).not.toHaveText("Sign in");
		await page.locator("summary", { hasText: "Menu" }).click();
		await expect(page.locator(".nav-menu").getByRole("link", { name: "Admin" })).toBeHidden();
		await page.screenshot({ path: path.join(shots, "non-admin-header-mobile.png") });
		await page.goto("/this-route-does-not-exist");
		await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
		await expect(page.locator(".sign-link")).toContainText("stranger@learners.invalid");
		await expect(page.locator(".nav-menu [data-admin-link]")).toBeHidden();
	});

	test("an allowlisted user sees the dashboard, the menu link, and can download the CSV", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("gw-e2e-email", "usage-admin@groundwork.test"));
		await page.goto("/admin/usage");
		await page.getByRole("button", { name: "Continue on this device" }).click();
		await expect(page.getByRole("heading", { name: "Free plan usage" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Account counts" })).toBeVisible();
		await expect(page.locator(".usage-head")).toContainText("Users");
		await expect(page.locator(".usage-head")).toContainText("Paid users");
		await expect(page.locator(".usage-head")).toContainText("Joined in the last 7 days");
		await expect(page.locator(".usage-head")).toContainText("No plan");
		await expect(page.locator(".usage-orphans")).toContainText("Orphaned records");
		await expect(page.locator(".usage-head")).toContainText("Comped on GROUNDWORKTESTER");
		await expect(page.locator(".usage-stat-note")).toContainText("more than $0 after discounts");
		const headBox = await page.locator(".usage-head").boundingBox();
		const titleBox = await page.getByRole("heading", { name: "Free plan usage" }).boundingBox();
		expect(headBox && titleBox && headBox.y < titleBox.y).toBe(true);
		await expect(page.locator("body")).toContainText("A consistent user is active on at least one day in 3 of the last 4 ISO weeks");
		await expect(page.locator("body")).toContainText("$1.25");
		await expect(page.locator(".sign-link")).toContainText("usage-admin@groundwork.test");
		await page.screenshot({ path: path.join(shots, "admin-usage-mobile.png"), fullPage: true });
		await page.locator("summary", { hasText: "Menu" }).click();
		const admin = page.locator(".nav-menu").getByRole("link", { name: "Admin" });
		await expect(admin).toBeVisible();
		await page.screenshot({ path: path.join(shots, "admin-header-link-mobile.png") });
		await page.locator("details.nav-more").evaluate((el: HTMLDetailsElement) => {
			el.open = false;
		});
		await expect(admin).toBeHidden();
		const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
		expect(download.suggestedFilename()).toBe("groundwork-usage.csv");
		const file = await download.path();
		expect(file).toBeTruthy();
	});
});
