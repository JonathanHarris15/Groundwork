import { describe, expect, it } from "vitest";
import { CLAUDE_SETUP, type TutorStatus } from "@groundwork/core";
import { showComposerProviderChip, syncStatusShowsGlyph } from "../src/ui-invariants";

const hostedRoute = (): TutorStatus => ({
	action: "hosted",
	via: "hosted",
	model: "test",
	provider: "openrouter",
	label: "Groundwork small",
	error: null,
	setup: null,
	budgetUsed: 0,
	ownModel: false,
	claude: CLAUDE_SETUP,
});

describe("syncStatusShowsGlyph", () => {
	it("shows the glyph only while syncing, errored, or offline", () => {
		expect(syncStatusShowsGlyph("ok")).toBe(false);
		expect(syncStatusShowsGlyph("idle")).toBe(false);
		expect(syncStatusShowsGlyph("disabled")).toBe(false);
		expect(syncStatusShowsGlyph("syncing")).toBe(true);
		expect(syncStatusShowsGlyph("error")).toBe(true);
		expect(syncStatusShowsGlyph("offline")).toBe(true);
	});
});

describe("showComposerProviderChip", () => {
	it("hides the chip for hosted Groundwork tutor without setup", () => {
		const hosted = hostedRoute();
		expect(
			showComposerProviderChip({
				label: hosted.label ?? "Groundwork small",
				hasSetup: false,
				route: hosted,
				runtime: "proxy",
			}),
		).toBe(false);
	});

	it("shows the chip when sign-in is required", () => {
		expect(
			showComposerProviderChip({
				label: "Sign in",
				hasSetup: true,
				route: null,
				runtime: "setup",
			}),
		).toBe(true);
	});
});
