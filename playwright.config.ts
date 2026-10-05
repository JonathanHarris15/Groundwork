import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.GROUNDWORK_PORT ?? 8797);
const baseURL = process.env.GROUNDWORK_E2E_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: "e2e",
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "phone", use: { ...devices["Pixel 7"] } },
	],
	webServer: {
		command: `npm run build -w packages/server && GROUNDWORK_E2E=1 GROUNDWORK_PORT=${port} GROUNDWORK_ACCOUNT_FILE=${process.env.GROUNDWORK_ACCOUNT_FILE ?? "./data/e2e-accounts.json"} GROUNDWORK_MEMORY_FILE=${process.env.GROUNDWORK_MEMORY_FILE ?? "./data/e2e-memory.json"} node packages/server/dist/server.js`,
		url: `${baseURL}/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			...process.env,
			FIREBASE_WEB_API_KEY: "",
			FIREBASE_AUTH_DOMAIN: "",
			FIREBASE_PROJECT_ID: "",
			FIREBASE_SERVICE_ACCOUNT_JSON: "",
			GOOGLE_APPLICATION_CREDENTIALS: "",
		},
	},
});
