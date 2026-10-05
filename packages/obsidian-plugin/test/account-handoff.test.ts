import { describe, expect, it, vi } from "vitest";
import { afterWebsiteHandoff } from "../src/account-handoff";

describe("website sign-in handoff", () => {
	it("runs finishLink after saving the refresh token so the plugin can repaint as linked", async () => {
		const saved: string[] = [];
		const finishLink = vi.fn(async () => {});
		await afterWebsiteHandoff("  refresh-token  ", {
			saveToken: (token) => saved.push(token),
			finishLink,
		});
		expect(saved).toEqual(["refresh-token"]);
		expect(finishLink).toHaveBeenCalledOnce();
	});

	it("still finishes linking when the deep link carries no refresh param", async () => {
		const finishLink = vi.fn(async () => {});
		await afterWebsiteHandoff("", { saveToken: () => {}, finishLink });
		expect(finishLink).toHaveBeenCalledOnce();
	});
});
