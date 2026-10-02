import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, knowledgeSnapshot } from "@groundwork/core/account";
import { createAccountServer } from "../src/server";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site/public");
const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-accounts-")), "accounts.json");
const server = createAccountServer({ dataFile, siteDir });

let baseUrl = "";

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("account server", () => {
	it("stores a concept map and serves it live on the profile", async () => {
		const password = "correct horse battery";
		const ada = new AccountClient(baseUrl);
		const session = await ada.register({ email: "Ada@Example.com", password, displayName: "Ada Lovelace", handle: "ada" });
		expect(session.user.email).toBe("ada@example.com");
		expect(session.user.handle).toBe("ada");

		const concepts = [
			{ id: "limit", title: "Limit", prerequisites: [], stats: { status: "solid" as const, current: 0.9 }, body: "do not publish this note" },
			{ id: "derivative", title: "Derivative", prerequisites: ["limit"], stats: { status: "learning" as const, current: 0.42 } },
		];
		const snap = knowledgeSnapshot(concepts, [{ title: "The derivative", status: "active", targets: ["derivative"], built: ["limit"] }], "2020-01-01T00:00:00.000Z");
		const saved = await ada.putKnowledge(snap);
		expect(saved.updatedAt > "2020-01-01").toBe(true);

		const profile = await ada.profile();
		expect(profile.user.displayName).toBe("Ada Lovelace");
		expect(profile.updatedAt).toBe(saved.updatedAt);
		expect(profile.map.nodes.map((n) => n.id).sort()).toEqual(["derivative", "limit"]);
		expect(profile.map.edges).toEqual([{ from: "limit", to: "derivative" }]);
		expect(profile.map.nodes.every((n) => typeof n.x === "number" && typeof n.y === "number")).toBe(true);
		expect(profile.goals[0]?.title).toBe("The derivative");
		expect(JSON.stringify(profile)).not.toContain("do not publish");

		const anon = new AccountClient(baseUrl);
		const pub = await anon.publicProfile("ada");
		expect(pub.user.email).toBe("");
		expect(pub.map.nodes).toHaveLength(2);

		const onDisk = await readFile(dataFile, "utf8");
		expect(onDisk).not.toContain(password);
		expect(onDisk).not.toContain(session.token);
		expect(onDisk).toContain("scrypt:");
	});

	it("keeps the website session when the plugin signs in", async () => {
		const password = "another-good-password";
		const site = new AccountClient(baseUrl);
		const first = await site.register({ email: "grace@example.com", password, displayName: "Grace Hopper" });
		const plugin = new AccountClient(baseUrl);
		const second = await plugin.login({ email: "grace@example.com", password });
		expect(second.token).not.toBe(first.token);
		await expect(site.me()).resolves.toMatchObject({ email: "grace@example.com" });
		await expect(plugin.me()).resolves.toMatchObject({ displayName: "Grace Hopper" });
		await plugin.logout();
		await expect(plugin.me()).rejects.toMatchObject({ status: 401 });
		await expect(site.me()).resolves.toMatchObject({ email: "grace@example.com" });
	});

	it("rejects a bad token and a short password", async () => {
		const client = new AccountClient(baseUrl, "not-a-token");
		await expect(client.profile()).rejects.toMatchObject({ status: 401 });
		await expect(new AccountClient(baseUrl).register({ email: "bob@example.com", password: "short", displayName: "Bob" })).rejects.toMatchObject({ status: 400 });
	});

	it("serves the site with the Obsidian install link", async () => {
		const home = await fetch(baseUrl + "/profile");
		expect(home.status).toBe(200);
		expect(home.headers.get("content-type")).toContain("text/html");
		const html = await home.text();
		expect(html).toContain('id="groundwork"');
		expect(html).toContain("obsidian://show-plugin?id=groundwork");
		const css = await (await fetch(baseUrl + "/site.css")).text();
		expect(css).toContain("#0e6b52");
		expect(css).toContain("#f3efe6");
	});
});
