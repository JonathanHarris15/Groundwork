import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "scripts/obsidian-lint-baseline.json");

function run(cmd, args) {
	const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const eslint = run("npx", ["eslint", ".", "-f", "json"]);
let report;
try {
	report = JSON.parse(eslint.stdout || "[]");
} catch {
	process.stderr.write(eslint.stderr || eslint.stdout);
	process.exit(1);
}

const errors = [];
const warningCounts = new Map();
for (const file of report) {
	const rel = path.relative(root, file.filePath);
	for (const message of file.messages) {
		const rule = message.ruleId || "parse";
		if (message.severity === 2) {
			errors.push(`${rel}:${message.line ?? 0} ${rule} ${message.message}`);
			continue;
		}
		if (message.severity !== 1) continue;
		const key = `${rel}\t${rule}`;
		warningCounts.set(key, (warningCounts.get(key) || 0) + 1);
	}
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const allowed = new Map(Object.entries(baseline.warnings || {}));
const over = [];
for (const [key, count] of warningCounts) {
	const cap = allowed.get(key) ?? 0;
	if (count > cap) over.push(`${key.replace("\t", " ")} ${count} > ${cap}`);
}

const style = run("npx", [
	"stylelint",
	"packages/obsidian-plugin/styles.css",
	"packages/server/public/styles.css",
	"--formatter",
	"unix",
]);

if (errors.length || over.length || style.status !== 0) {
	if (errors.length) {
		process.stderr.write(`eslint errors (${errors.length}):\n`);
		for (const line of errors) process.stderr.write(`  ${line}\n`);
	}
	if (over.length) {
		process.stderr.write(`eslint warnings above scripts/obsidian-lint-baseline.json (${over.length}):\n`);
		for (const line of over) process.stderr.write(`  ${line}\n`);
	}
	if (style.status !== 0) {
		process.stderr.write(style.stdout);
		process.stderr.write(style.stderr);
	}
	process.exit(1);
}

process.stdout.write(`obsidian lint ok (${warningCounts.size} baselined warning groups, 0 errors)\n`);
