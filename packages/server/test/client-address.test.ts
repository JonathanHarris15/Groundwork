import { describe, expect, it } from "vitest";
import { clientAddress } from "../src/client-address";

describe("client address behind Firebase Hosting and Cloud Run", () => {
	it("ignores a spoofed leading X-Forwarded-For entry", () => {
		const trusted = clientAddress("203.0.113.10, 35.191.1.1", "169.254.1.1");
		const spoofed = clientAddress("9.9.9.9, 203.0.113.10, 35.191.1.1", "169.254.1.1");
		expect(spoofed).toBe(trusted);
		expect(trusted).toBe("203.0.113.10");
	});

	it("does not let a lone header replace the socket address", () => {
		expect(clientAddress("9.9.9.9", "10.0.0.1")).toBe("10.0.0.1");
		expect(clientAddress(undefined, "10.0.0.1")).toBe("10.0.0.1");
		expect(clientAddress("  ", "10.0.0.1")).toBe("10.0.0.1");
	});
});
