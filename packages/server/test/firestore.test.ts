import { describe, expect, it } from "vitest";
import { usesRuntimeFirestore } from "../src/firestore";

describe("firestore credentials", () => {
	it("uses the Cloud Run runtime account when the service is running there", () => {
		expect(usesRuntimeFirestore({ K_SERVICE: "groundwork" } as NodeJS.ProcessEnv)).toBe(true);
		expect(usesRuntimeFirestore({ K_SERVICE: "  " } as NodeJS.ProcessEnv)).toBe(false);
		expect(usesRuntimeFirestore({} as NodeJS.ProcessEnv)).toBe(false);
	});
});
