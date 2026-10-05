import { describe, expect, it } from "vitest";
import { groundworkOpenedSignal, parseGroundworkConcept } from "../src/open-link";

describe("groundwork open link", () => {
	it("accepts safe concept titles for deep links", () => {
		expect(parseGroundworkConcept("Chain rule")).toBe("Chain rule");
		expect(parseGroundworkConcept("  Bayes' rule  ")).toBe("Bayes' rule");
		expect(parseGroundworkConcept("")).toBeNull();
		expect(parseGroundworkConcept("x".repeat(121))).toBeNull();
		expect(parseGroundworkConcept("bad\u0007title")).toBeNull();
	});

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
