import { describe, expect, it } from "vitest";
import { groundworkOpenedSignal } from "../src/open-link";

describe("groundwork open link", () => {
	it("keeps the website's open-ack URL and drops anything else", () => {
		const nonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		expect(groundworkOpenedSignal(`http://127.0.0.1:8080/v1/obsidian-opened/${nonce}/signal`)).toBe(
			`http://127.0.0.1:8080/v1/obsidian-opened/${nonce}/signal`,
		);
		expect(groundworkOpenedSignal(`https://groundwork.example/v1/obsidian-opened/${nonce}/signal?x=1`)).toContain("/signal");
		expect(groundworkOpenedSignal("https://evil.example/collect")).toBeNull();
		expect(groundworkOpenedSignal("file:///etc/passwd")).toBeNull();
		expect(groundworkOpenedSignal("http://user:pass@127.0.0.1/v1/obsidian-opened/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/signal")).toBeNull();
		expect(groundworkOpenedSignal(undefined)).toBeNull();
	});
});
