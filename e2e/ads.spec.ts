import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const shots = "/opt/cursor/artifacts/site-ads";
mkdirSync(shots, { recursive: true });

const pages = ["/", "/pricing", "/practice-tests", "/exam-prep", "/concept-map", "/quizzes-flashcards", "/goals", "/get-started", "/privacy", "/terms"];

function slug(href: string): string {
	return href === "/" ? "home" : href.slice(1);
}

test("public pages, footer email, and screenshots", async ({ page }, testInfo) => {
	const width = testInfo.project.name === "phone" ? "mobile" : "desktop";
	for (const href of pages) {
		const res = await page.goto(href);
		expect(res?.status(), href).toBe(200);
		await expect(page.locator("footer.foot").getByRole("link", { name: "methoddev1505@gmail.com" })).toBeVisible();
		await expect(page.locator("body")).not.toContainText("[Dev:");
		await expect(page.locator("body")).not.toContainText(/coming soon/i);
		if (href === "/") {
			await expect(page.getByRole("dialog", { name: "Cookies" })).toBeVisible();
			const paint = await heroPaint(page);
			if (!paint) throw new Error("hero heading or Start free is missing");
			expect(paint.h1Animation).toBe("none");
			expect(paint.subAnimation).toBe("none");
			expect(paint.ctaAnimation).toBe("none");
			expect(paint.h1Opacity).toBe("1");
			expect(paint.subOpacity).toBe("1");
			expect(paint.ctaOpacity).toBe("1");
			expect(paint.h1InView).toBe(true);
			expect(paint.subInView).toBe(true);
			expect(paint.ctaInView).toBe(true);
			expect(paint.noteBelow).toBe(true);
			expect(paint.noteAligned).toBe(true);
			expect(paint.noteText).toBe(width === "mobile" ? "Requires Obsidian desktop. Sign up here, install on your computer." : "Requires Obsidian desktop");
			expect(paint.headerOneRow).toBe(true);
			if (width === "mobile") {
				expect(paint.consentShort).toBe(true);
				await expect(page.locator(".bar-nav .nav-wide").first()).toBeHidden();
				await expect(page.locator(".nav-more")).toBeVisible();
			} else {
				await expect(page.locator(".bar-nav .nav-wide").first()).toBeVisible();
				await expect(page.locator(".nav-more")).toBeHidden();
			}
			expect(paint.ctaCovered).toBe(false);
			expect(paint.buttons).toEqual(["OK", "Opt out"]);
			expect(paint.consentFont).toMatch(/Jost/);
			expect(paint.heroLoaded).toBe(true);
			const revealed = await page.evaluate(() => {
				const nodes = ["#how-title", "#close-title", ".close .cta"].map((sel) => document.querySelector(sel));
				return nodes.map((el) => {
					if (!el) return 0;
					let opacity = 1;
					let node: Element | null = el;
					while (node) {
						opacity *= Number(getComputedStyle(node).opacity);
						node = node.parentElement;
					}
					return opacity * el.getBoundingClientRect().height;
				});
			});
			expect(revealed.every((value) => value > 1)).toBe(true);
			const shot = await page.screenshot({ animations: "allow" });
			const heading = lightShare(shot, paint.h1Box, paint.scale);
			const cta = lightShare(shot, paint.ctaBox, paint.scale);
			expect(heading.light, "H1 is not visible in the home screenshot").toBeGreaterThan(24);
			expect(cta.share, "Start free is not visible in the home screenshot").toBeGreaterThan(0.45);
			writeFileSync(path.join(shots, `home-consent-${width}.png`), shot);
			await page.getByRole("button", { name: "OK", exact: true }).click();
		}
		if (href === "/") {
			const shots = page.locator(".story-shot img");
			await expect(shots).toHaveCount(5);
			for (const img of await shots.all()) {
				await img.scrollIntoViewIfNeeded();
				await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
			}
			if (width === "desktop") {
				const sides = await page.locator(".story").evaluateAll((sections) =>
					sections.map((section) => {
						const copy = section.querySelector(".story-copy")?.getBoundingClientRect();
						const shot = section.querySelector(".story-shot")?.getBoundingClientRect();
						return { copy: copy?.x ?? 0, shot: shot?.x ?? 0, shotWidth: shot?.width ?? 0, sectionWidth: section.getBoundingClientRect().width };
					}),
				);
				expect(sides).toHaveLength(5);
				sides.forEach((side, index) => {
					expect(side.shotWidth).toBeGreaterThan(side.sectionWidth * 0.35);
					if (index % 2 === 0) expect(side.shot).toBeGreaterThan(side.copy);
					else expect(side.copy).toBeGreaterThan(side.shot);
				});
			}
		}
		if (["/concept-map", "/quizzes-flashcards", "/exam-prep", "/goals", "/practice-tests"].includes(href)) {
			const shotImg = page.locator(".mkt-shot img").first();
			await expect(shotImg).toBeVisible();
			await expect.poll(async () => shotImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
		}
		await page.screenshot({ path: path.join(shots, `${slug(href)}-${width}.png`), fullPage: true });
	}
	const missing = await page.goto("/this-route-does-not-exist");
	expect(missing?.status()).toBe(404);
	await expect(page.getByRole("heading", { name: /Page not found/i })).toBeVisible();
	await page.screenshot({ path: path.join(shots, `404-${width}.png`), fullPage: true });
});

test("every call to action label contrasts with its background", async ({ page }) => {
	for (const href of [...pages, "/this-route-does-not-exist"]) {
		await page.goto(href);
		const results = await page.evaluate(() => {
			const parse = (color: string): [number, number, number] | null => {
				const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
				if (!match) return null;
				return [Number(match[1]), Number(match[2]), Number(match[3])];
			};
			const lin = (channel: number) => {
				const s = channel / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			const lum = (rgb: [number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
			const contrast = (a: [number, number, number], b: [number, number, number]) => {
				const left = lum(a);
				const right = lum(b);
				return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
			};
			return [...document.querySelectorAll("a.cta, a.btn")].map((el) => {
				const style = getComputedStyle(el);
				const fg = parse(style.color);
				const bg = parse(style.backgroundColor);
				return {
					text: (el.textContent || "").replace(/\s+/g, " ").trim(),
					ratio: fg && bg && style.backgroundColor !== "rgba(0, 0, 0, 0)" ? contrast(fg, bg) : 0,
					opacity: style.opacity,
				};
			});
		});
		const expectsCta = href !== "/privacy" && href !== "/terms";
		if (expectsCta) expect(results.length, href).toBeGreaterThan(0);
		else expect(results, href).toEqual([]);
		for (const item of results) {
			expect(item.text.length, href).toBeGreaterThan(0);
			expect(item.opacity, `${href} ${item.text}`).toBe("1");
			expect(item.ratio, `${href} ${item.text}`).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test("pricing cards share a height and line up price, copy, and buttons", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name === "phone", "stacked cards are a single column");
	await page.goto("/pricing");
	const boxes = await page.locator(".plan-card").evaluateAll((cards) =>
		cards.map((card) => {
			const price = card.querySelector(".price")?.getBoundingClientRect();
			const desc = card.querySelector("p:not(.price)")?.getBoundingClientRect();
			const cta = card.querySelector(".cta")?.getBoundingClientRect();
			const cardBox = card.getBoundingClientRect();
			return { price: price?.top ?? 0, desc: desc?.top ?? 0, cta: cta?.top ?? 0, height: cardBox.height };
		}),
	);
	expect(boxes).toHaveLength(3);
	const aligned = (values: number[]) => Math.max(...values) - Math.min(...values) < 2;
	expect(aligned(boxes.map((box) => box.height))).toBe(true);
	expect(aligned(boxes.map((box) => box.price))).toBe(true);
	expect(aligned(boxes.map((box) => box.desc))).toBe(true);
	expect(aligned(boxes.map((box) => box.cta))).toBe(true);
	await expect(page.getByText("Billing is handled by Stripe.")).toHaveCount(0);
	for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 900 }]) {
		await page.setViewportSize(viewport);
		const fits = await page.locator(".plan-card .cta").evaluateAll((buttons) =>
			buttons.map((button) => {
				const card = button.closest(".plan-card")?.getBoundingClientRect();
				const box = button.getBoundingClientRect();
				return {
					text: (button.textContent || "").replace(/\s+/g, " ").trim(),
					height: box.height,
					inside: Boolean(card && box.left >= card.left - 1 && box.right <= card.right + 1),
				};
			}),
		);
		expect(fits.map((button) => button.text)).toEqual(["Start free", "Choose $6", "Choose $20"]);
		for (const button of fits) {
			expect(button.inside, `${button.text} at ${viewport.width}`).toBe(true);
			expect(button.height, `${button.text} at ${viewport.width}`).toBeLessThanOrEqual(64);
		}
	}
});

test("consent defaults deny everywhere and grant the US", async ({ page }) => {
	await page.goto("/");
	const regions = await page.evaluate(() => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer.flatMap((entry) => {
			const args = argsOf(entry);
			if (!args || args[0] !== "consent" || args[1] !== "default") return [];
			return [args as [string, string, { region?: string[]; ad_storage: string }]];
		});
		function argsOf(entry: unknown): unknown[] | null {
			if (entry == null || typeof entry !== "object" || typeof (entry as { length?: unknown }).length !== "number") return null;
			return Array.from(entry as ArrayLike<unknown>);
		}
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

	await page.goto("/?dedupe=1#signin");
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

test("the success page does not emit a purchase", async ({ page }) => {
	let amountHits = 0;
	const google: string[] = [];
	await page.route("**/v1/billing/checkout-amount**", async (route) => {
		amountHits += 1;
		await route.fulfill({ status: 500, body: "no" });
	});
	await page.route("**/v1/web-config", async (route) => {
		const response = await route.fetch();
		const json = await response.json();
		await route.fulfill({ response, json: { ...json, ga4MeasurementId: "G-F4236HGZSM", googleAdsId: "AW-123" } });
	});
	page.on("request", (request) => {
		const url = request.url();
		if (/googletagmanager|google-analytics|\/g\/collect/.test(url)) google.push(url);
	});
	await page.goto("/?billing=success&session_id=cs_test_1&plan=included");
	await page.waitForFunction(() => Boolean((window as unknown as { GroundworkTracking?: unknown }).GroundworkTracking));
	await page.waitForLoadState("networkidle");
	expect(await purchaseParams(page)).toEqual([]);
	expect(await countEvents(page, "purchase")).toBe(0);
	expect(await countEvents(page, "conversion")).toBe(0);
	expect(amountHits).toBe(0);
	expect(google).toEqual([]);
	expect(await page.evaluate(() => localStorage.getItem("gw-purchases"))).toBeNull();

	await page.goto("/?billing=success&subscription_id=sub_123&plan=byom");
	await page.waitForFunction(() => Boolean((window as unknown as { GroundworkTracking?: unknown }).GroundworkTracking));
	expect(await countEvents(page, "purchase")).toBe(0);
});

test("automation does not send page_view, sign_up, or purchase to the production property", async ({ page }) => {
	const hits: string[] = [];
	await page.addInitScript(() => {
		localStorage.setItem("gw-consent", "granted");
	});
	await page.route("**/v1/web-config", async (route) => {
		const response = await route.fetch();
		const json = await response.json();
		await route.fulfill({ response, json: { ...json, ga4MeasurementId: "G-F4236HGZSM", googleAdsId: "AW-123" } });
	});
	await page.route(COLLECT, async (route) => {
		hits.push(route.request().url());
		await route.abort();
	});
	const scripts: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("googletagmanager.com")) scripts.push(request.url());
	});
	await page.goto("/");
	await page.waitForFunction(() => Boolean((window as unknown as { GroundworkTracking?: { noteSignUp?: unknown } }).GroundworkTracking));
	await page.evaluate(() => {
		(window as unknown as { GroundworkTracking?: { noteSignUp: (created: boolean, method: string) => void } }).GroundworkTracking?.noteSignUp(true, "Google");
	});
	await expect.poll(async () => countEvents(page, "sign_up")).toBe(1);
	await page.waitForLoadState("networkidle");
	expect(hits).toEqual([]);
	expect(scripts).toEqual([]);
	expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
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

async function heroPaint(page: Page) {
	return page.evaluate(() => {
		const h1 = document.querySelector(".hero h1");
		const sub = document.querySelector(".hero-copy .sub");
		const cta = document.querySelector(".hero-copy .cta");
		const note = document.querySelector(".hero-copy .cta-note");
		const bar = document.querySelector(".consent");
		const header = document.querySelector(".bar");
		const img = document.querySelector<HTMLImageElement>(".hero-shot");
		if (!h1 || !sub || !cta || !note || !bar || !header || !img) return null;
		const box = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
		};
		const h1Box = box(h1);
		const subBox = box(sub);
		const ctaBox = box(cta);
		const noteBox = box(note);
		const barBox = box(bar);
		const overlaps = barBox.left < ctaBox.right && barBox.right > ctaBox.left && barBox.top < ctaBox.bottom && barBox.bottom > ctaBox.top;
		const inView = (r: { top: number; left: number; bottom: number; right: number; width: number; height: number }) =>
			r.width > 8 && r.height > 8 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
		const h1Style = getComputedStyle(h1);
		const subStyle = getComputedStyle(sub);
		const ctaStyle = getComputedStyle(cta);
		return {
			h1Animation: h1Style.animationName,
			subAnimation: subStyle.animationName,
			ctaAnimation: ctaStyle.animationName,
			h1Opacity: h1Style.opacity,
			subOpacity: subStyle.opacity,
			ctaOpacity: ctaStyle.opacity,
			h1InView: inView(h1Box),
			subInView: inView(subBox),
			ctaInView: inView(ctaBox),
			noteBelow: noteBox.top >= ctaBox.bottom - 1 && noteBox.top - ctaBox.bottom < 28,
			noteAligned: Math.abs(noteBox.left - ctaBox.left) < 12,
			noteText: (note as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
			headerOneRow: header.getBoundingClientRect().height < 100,
			consentShort: barBox.height < 96,
			ctaCovered: overlaps,
			buttons: [...bar.querySelectorAll("button")].map((button) => button.textContent?.trim()),
			consentFont: getComputedStyle(bar).fontFamily,
			heroLoaded: img.complete && img.naturalWidth > 0,
			scale: window.devicePixelRatio,
			h1Box,
			ctaBox,
		};
	});
}

function lightShare(png: Buffer, box: { x: number; y: number; width: number; height: number }, scale: number) {
	const { width, height, data } = decodePng(png);
	const x0 = Math.max(0, Math.floor(box.x * scale));
	const y0 = Math.max(0, Math.floor(box.y * scale));
	const x1 = Math.min(width, Math.ceil((box.x + box.width) * scale));
	const y1 = Math.min(height, Math.ceil((box.y + box.height) * scale));
	let light = 0;
	let n = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const i = (y * width + x) * 4;
			const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
			n++;
			if (luma > 190) light++;
		}
	}
	return { light, n, share: n ? light / n : 0 };
}

function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = 0;
	const idat: Buffer[] = [];
	while (offset + 8 <= buf.length) {
		const len = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			colorType = data[9];
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		offset += 12 + len;
	}
	const channels = colorType === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = new Uint8Array(width * height * 4);
	let src = 0;
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[src++];
		const row = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? row[i - channels] : 0;
			const up = prev[i] ?? 0;
			const upLeft = i >= channels ? prev[i - channels] ?? 0 : 0;
			const value = raw[src++];
			if (filter === 0) row[i] = value;
			else if (filter === 1) row[i] = (value + left) & 255;
			else if (filter === 2) row[i] = (value + up) & 255;
			else if (filter === 3) row[i] = (value + Math.floor((left + up) / 2)) & 255;
			else {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				row[i] = (value + pred) & 255;
			}
		}
		prev = row;
		for (let x = 0; x < width; x++) {
			const s = x * channels;
			const d = (y * width + x) * 4;
			out[d] = row[s];
			out[d + 1] = row[s + 1];
			out[d + 2] = row[s + 2];
			out[d + 3] = channels === 4 ? row[s + 3] : 255;
		}
	}
	return { width, height, data: out };
}

const COLLECT = /(?:google-analytics\.com|analytics\.google\.com|www\.google\.com)\/g\/collect/;

async function countEvents(page: Page, name: string): Promise<number> {
	return page.evaluate((eventName) => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer.filter((entry) => argsOf(entry)?.[1] === eventName).length;
		function argsOf(entry: unknown): unknown[] | null {
			if (entry == null || typeof entry !== "object" || typeof (entry as { length?: unknown }).length !== "number") return null;
			return Array.from(entry as ArrayLike<unknown>);
		}
	}, name);
}

async function purchaseParams(page: import("@playwright/test").Page): Promise<Array<{ transaction_id?: string; value?: number; currency?: string }>> {
	return page.evaluate(() => {
		const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
		return layer.flatMap((entry) => {
			const args = argsOf(entry);
			if (!args || args[1] !== "purchase") return [];
			const params = args[2] as { transaction_id?: string; value?: number; currency?: string };
			return [params];
		});
		function argsOf(entry: unknown): unknown[] | null {
			if (entry == null || typeof entry !== "object" || typeof (entry as { length?: unknown }).length !== "number") return null;
			return Array.from(entry as ArrayLike<unknown>);
		}
	});
}
