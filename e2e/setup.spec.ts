import { expect, test } from "@playwright/test";

test("get-started checklist offers an Obsidian download and a plugin link", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "chromium", "Desktop checklist");
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
	await page.goto("/get-started");
	await expect(page.getByRole("heading", { name: "Get Groundwork running" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Get Obsidian" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Add Groundwork" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Connect your account" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sign in to connect" })).toBeVisible();
	await expect(page.locator("[data-setup-phone]")).toBeHidden();
	const primary = page.locator(".guide-go[data-os]").first();
	await expect(primary).toBeVisible();
	await expect(primary).toHaveAttribute("href", /\/v1\/setup\/obsidian-download\?os=(windows|mac|linux)/);
	await expect(page.getByRole("link", { name: "Add Groundwork" })).toHaveAttribute("href", "obsidian://show-plugin?id=groundwork");
	await page.getByRole("link", { name: "Add Groundwork" }).click();
	await expect(page.locator("[data-plugin-fallback]")).toBeVisible();
	await expect(page).toHaveURL(/\/get-started/);
});

test("a phone sign-in can copy the setup link", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "phone", "Phone handoff");
	await page.addInitScript(() => {
		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied = text;
				},
				readText: async () => copied,
			},
		});
	});
	await page.goto("/get-started");
	await expect(page.getByRole("heading", { name: "Groundwork runs on your computer." })).toBeVisible();
	await expect(page.getByRole("img", { name: /QR code/i })).toBeVisible();
	await page.getByRole("button", { name: "Copy link" }).click();
	await expect(page.getByText("Link copied.")).toBeVisible();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain("/get-started");
	await expect.poll(async () =>
		page.evaluate(() => {
			const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
			return layer.some((entry) => {
				if (entry == null || typeof entry !== "object" || typeof (entry as { length?: unknown }).length !== "number") return false;
				return Array.from(entry as ArrayLike<unknown>)[1] === "setup_link_sent";
			});
		}),
	).toBe(true);
});

test("a setup code works once", async ({ request }) => {
	const issued = await request.post("/v1/connect/code", { data: {} });
	expect(issued.ok()).toBeTruthy();
	const body = (await issued.json()) as { code: string };
	expect(body.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
	const redeemed = await request.post("/v1/connect/redeem", { data: { code: body.code } });
	expect(redeemed.ok()).toBeTruthy();
	const session = (await redeemed.json()) as { token?: string };
	expect(session.token).toBe("local");
	const again = await request.post("/v1/connect/redeem", { data: { code: body.code } });
	expect(again.status()).toBe(410);
});
