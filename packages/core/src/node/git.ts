import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type SyncState = "not-a-repo" | "no-remote" | "synced" | "committed-offline" | "conflict-resolved" | "error";

export interface SyncReport {
	state: SyncState;
	message: string;
	committed: boolean;
	pulled: boolean;
	pushed: boolean;
	/** True when the merge brought in changes, so derived stats should be recomputed. */
	incoming: boolean;
}

/** GUI apps on macOS don't inherit the shell PATH; add the usual git locations. */
function gitEnv(): NodeJS.ProcessEnv {
	const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", path.join(os.homedir(), ".local/bin")];
	const sep = process.platform === "win32" ? ";" : ":";
	return {
		...process.env,
		PATH: [process.env.PATH ?? "", ...extra].filter(Boolean).join(sep),
		GIT_TERMINAL_PROMPT: "0",
	};
}

export function git(cwd: string, args: string[], gitPath = "git", timeoutMs = 60_000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(gitPath, args, { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
		});
	});
}

export class GitSync {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly dir: string,
		private readonly opts: { gitPath?: string; device?: string } = {},
	) {}

	private run(args: string[], timeoutMs?: number) {
		return git(this.dir, args, this.opts.gitPath, timeoutMs);
	}

	async isRepo(): Promise<boolean> {
		const r = await this.run(["rev-parse", "--is-inside-work-tree"]);
		return r.ok && r.stdout.trim() === "true";
	}

	async remote(): Promise<string | undefined> {
		const r = await this.run(["remote", "get-url", "origin"]);
		return r.ok ? r.stdout.trim() : undefined;
	}

	async branch(): Promise<string> {
		const r = await this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
		const b = r.stdout.trim();
		return r.ok && b && b !== "HEAD" ? b : "main";
	}

	/** Serialized so overlapping triggers (timer + manual + unload) never interleave git commands. */
	sync(message?: string, afterMerge?: () => Promise<void>): Promise<SyncReport> {
		const next = this.chain.then(() => this.doSync(message, afterMerge));
		this.chain = next.catch(() => undefined);
		return next;
	}

	private async commitAll(message: string): Promise<boolean> {
		await this.run(["add", "-A"]);
		const status = await this.run(["status", "--porcelain"]);
		if (!status.stdout.trim()) return false;
		const r = await this.run(["commit", "-m", message, "--no-verify"]);
		return r.ok;
	}

	private async doSync(message?: string, afterMerge?: () => Promise<void>): Promise<SyncReport> {
		const report: SyncReport = { state: "synced", message: "", committed: false, pulled: false, pushed: false, incoming: false };
		if (!(await this.isRepo())) return { ...report, state: "not-a-repo", message: "Vault is not a git repository." };

		const device = this.opts.device ?? os.hostname();
		const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
		report.committed = await this.commitAll(message ?? `groundwork: ${device} ${stamp}`);

		const remote = await this.remote();
		if (!remote) return { ...report, state: "no-remote", message: report.committed ? "Committed locally (no remote configured)." : "Up to date (no remote configured)." };

		const branch = await this.branch();
		const fetch = await this.run(["fetch", "origin", branch], 120_000);
		const remoteExists = (await this.run(["rev-parse", "--verify", "--quiet", `origin/${branch}`])).ok;
		if (!fetch.ok && remoteExists) {
			return { ...report, state: "committed-offline", message: `Offline — changes are committed locally and will sync later. (${firstLine(fetch.stderr)})` };
		}

		if (remoteExists) {
			const before = (await this.run(["rev-parse", "HEAD"])).stdout.trim();
			// Evidence logs are append-only and merged with the union driver (see .gitattributes);
			// prose conflicts prefer this machine's version, and derived stats are rebuilt afterwards.
			let merge = await this.run(["merge", "--no-edit", "-X", "ours", `origin/${branch}`]);
			if (!merge.ok) {
				await this.run(["add", "-A"]);
				merge = await this.run(["commit", "--no-edit", "--no-verify"]);
				if (!merge.ok) {
					await this.run(["merge", "--abort"]);
					return { ...report, state: "error", message: `Merge failed: ${firstLine(merge.stderr)}` };
				}
				report.state = "conflict-resolved";
			}
			const after = (await this.run(["rev-parse", "HEAD"])).stdout.trim();
			report.pulled = true;
			report.incoming = before !== after;
			if (report.incoming && afterMerge) {
				await afterMerge();
				await this.commitAll(`groundwork: rebuild stats after merge (${device})`);
			}
		}

		const ahead = remoteExists ? (await this.run(["rev-list", "--count", `origin/${branch}..HEAD`])).stdout.trim() : "1";
		if (ahead !== "0") {
			const push = await this.run(["push", "-u", "origin", branch], 120_000);
			if (!push.ok) {
				return { ...report, state: "committed-offline", message: `Push failed — will retry. (${firstLine(push.stderr)})` };
			}
			report.pushed = true;
		}
		report.message = report.pushed || report.pulled ? `Synced with ${remote.includes("github.com") ? "GitHub" : "origin"}.` : "Up to date.";
		return report;
	}
}

function firstLine(s: string): string {
	return s.trim().split("\n").filter(Boolean).pop() ?? "unknown error";
}
