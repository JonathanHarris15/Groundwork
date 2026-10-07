import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Matches the Obsidian community scanner: eslint-plugin-obsidianmd recommended
// (ESLint core, typescript-eslint recommendedTypeChecked, Obsidian rules).
// The no-unsafe-* rules are enabled explicitly because the 0.1.11 scorecard
// reported them, and a later scanner doc turns them off for monorepo noise.
export default defineConfig([
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"build/**",
			"pkg/**",
			"**/.obsidian/**",
			"test-vault/**",
			"**/esbuild.config.mjs",
			"**/version-bump.mjs",
			"**/*.test.*",
			"**/*.tests.*",
			"**/*.spec.*",
			"**/*.specs.*",
			"**/test/**",
			"**/tests/**",
			"**/__tests__/**",
			"**/mocks/**",
			"**/*.cjs",
			"**/*.mjs",
			"**/*.cts",
			"**/*.mts",
			"**/vite*",
			"**/scripts/**",
			"**/docs/**",
			"e2e/**",
			"e2e-tests/**",
			"automation/**",
			"packages/server/public/**",
			"packages/**/dist/**",
			"playwright.config.ts",
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.{ts,tsx,cts,mts}"],
		plugins: {
			"@typescript-eslint": tseslint.plugin,
			obsidianmd,
		},
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
			// Command ids are already published. Renaming them would break user hotkeys.
			"obsidianmd/commands/no-command-in-command-id": "off",
			"obsidianmd/commands/no-plugin-id-in-command-id": "off",
			// Proper nouns stay capitalized. The 0.1.11 scanner did not report sentence case.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["Groundwork", "Obsidian", "Claude", "LaTeX", "Stripe", "Firebase", "Jost"],
					acronyms: ["PDF", "API", "URL", "ID", "SVG"],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
]);
