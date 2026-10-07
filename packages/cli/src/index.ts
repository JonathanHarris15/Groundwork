import { Command } from "commander";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore } from "@groundwork/core";
import { git, GitSync, NodeVaultIO, scaffoldVault } from "@groundwork/core/node";
import { expandHome, defaultVaultDir, readConfig, resolveVault, writeConfig } from "./config";
import { bundledPluginDir, installPlugin, launchObsidian, obsidianUri, registerVault } from "./obsidian";

const cliDir = path.dirname(fileURLToPath(import.meta.url));

const say = (msg = "") => process.stdout.write(`${msg}\n`);
const step = (msg: string) => process.stdout.write(`  • ${msg}\n`);

function hasCommand(cmd: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function must(dir: string, args: string[]) {
	const r = await git(dir, args, "git", 180_000);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
	return r.stdout;
}

/** Everything `open` needs: plugin current, vault registered, Obsidian launched. */
async function prepareAndOpen(vault: string, launch: boolean) {
	const pluginSrc = bundledPluginDir(cliDir);
	const { changed, version } = await installPlugin(vault, pluginSrc);
	step(changed ? `Installed Groundwork plugin v${version} from ${pluginSrc}` : `Plugin v${version} is up to date (${pluginSrc})`);
	const reg = await registerVault(vault);
	step(reg.registered ? `Registered the vault with Obsidian` : `Vault already known to Obsidian`);
	if (changed) await new GitSync(vault).sync("groundwork: update plugin");
	if (launch) {
		launchObsidian(obsidianUri(reg.id));
		step("Opening Obsidian — the tutor panel opens on the right");
	}
}

const program = new Command()
	.name("groundwork")
	.description("A tutor that remembers what you know on your Groundwork account.")
	.version("0.1.0");

program
	.command("init")
	.description("Create a new knowledge vault (optionally as a private GitHub repo) and open it in Obsidian")
	.argument("[dir]", "where to create the vault", defaultVaultDir())
	.option("--github <name>", "create a private GitHub repo with this name using the gh CLI (e.g. my-knowledge)")
	.option("--remote <url>", "use an existing empty git remote")
	.option("--no-open", "don't launch Obsidian")
	.action(async (dirArg: string, opts: { github?: string; remote?: string; open: boolean }) => {
		const dir = expandHome(dirArg);
		say(`Creating knowledge vault at ${dir}`);
		const created = await scaffoldVault(dir);
		step(created.length ? `Wrote ${created.length} starter files` : "Vault files already present");
		const store = new KnowledgeStore(new NodeVaultIO(dir));
		await store.ensureLayout();

		const sync = new GitSync(dir);
		if (!(await sync.isRepo())) {
			await must(dir, ["init", "-b", "main"]);
			step("Initialized git repository");
		}
		await installPlugin(dir, bundledPluginDir(cliDir));
		await must(dir, ["add", "-A"]);
		const status = await git(dir, ["status", "--porcelain"]);
		if (status.stdout.trim()) await must(dir, ["commit", "-m", "Create Groundwork knowledge vault", "--no-verify"]);

		if (opts.remote && !(await sync.remote())) {
			await must(dir, ["remote", "add", "origin", opts.remote]);
			await must(dir, ["push", "-u", "origin", "main"]);
			step(`Pushed to ${opts.remote}`);
		} else if (opts.github && !(await sync.remote())) {
			if (!hasCommand("gh")) {
				step("GitHub CLI (gh) not found. Create a private repo yourself, then run:");
				say(`      git -C "${dir}" remote add origin <url> && git -C "${dir}" push -u origin main`);
			} else {
				const r = await new Promise<number>((resolve) => {
					const p = spawn("gh", ["repo", "create", opts.github!, "--private", "--source", dir, "--remote", "origin", "--push"], { stdio: "inherit" });
					p.on("exit", (code) => resolve(code ?? 1));
				});
				step(r === 0 ? `Created private GitHub repo ${opts.github} and pushed` : "gh repo create failed — add a remote manually later");
			}
		} else if (!(await sync.remote())) {
			step("No remote yet. Sync across computers by adding a private GitHub repo:");
			say(`      groundwork init "${dir}" --github my-knowledge   (or git remote add origin <url>)`);
		}

		await writeConfig({ ...(await readConfig()), vault: dir });
		step(`Saved as your default vault`);
		await prepareAndOpen(dir, opts.open);
		say();
		say("Next: in Obsidian, tell the tutor what you want to learn.");
	});

program
	.command("clone")
	.description("Set up an existing knowledge vault on this computer and open it")
	.argument("<url>", "git URL of your private knowledge repo")
	.argument("[dir]", "where to put it", defaultVaultDir())
	.option("--no-open", "don't launch Obsidian")
	.action(async (url: string, dirArg: string, opts: { open: boolean }) => {
		const dir = expandHome(dirArg);
		if (existsSync(path.join(dir, ".git"))) {
			step(`${dir} already exists — pulling instead`);
		} else {
			await must(os.homedir(), ["clone", url, dir]);
			step(`Cloned ${url}`);
		}
		const created = await scaffoldVault(dir);
		if (created.length) step(`Added ${created.length} missing vault files`);
		const store = new KnowledgeStore(new NodeVaultIO(dir));
		await new GitSync(dir).sync(undefined, () => store.recomputeAll());
		await writeConfig({ ...(await readConfig()), vault: dir });
		step("Saved as your default vault");
		await prepareAndOpen(dir, opts.open);
	});

program
	.command("open")
	.description("Pull the latest knowledge, update the plugin, and open the vault in Obsidian (the one command you need)")
	.option("--vault <dir>")
	.option("--no-launch", "prepare everything but don't launch Obsidian")
	.action(async (opts: { vault?: string; launch: boolean }) => {
		const vault = await resolveVault(opts.vault);
		const store = new KnowledgeStore(new NodeVaultIO(vault));
		const r = await new GitSync(vault).sync(undefined, () => store.recomputeAll());
		step(`Sync: ${r.message || r.state}`);
		await prepareAndOpen(vault, opts.launch);
	});

program
	.command("sync")
	.description("Commit and sync the vault with GitHub now")
	.option("--vault <dir>")
	.action(async (opts: { vault?: string }) => {
		const vault = await resolveVault(opts.vault);
		const store = new KnowledgeStore(new NodeVaultIO(vault));
		const r = await new GitSync(vault).sync(undefined, () => store.recomputeAll());
		say(`${r.state}: ${r.message}`);
	});

program
	.command("status")
	.description("Summarize what your vault knows")
	.option("--vault <dir>")
	.action(async (opts: { vault?: string }) => {
		const vault = await resolveVault(opts.vault);
		const store = new KnowledgeStore(new NodeVaultIO(vault));
		const o = await store.overview();
		say(`Vault: ${vault}`);
		say(`Concepts: ${o.conceptCount}  (${Object.entries(o.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "none yet"})`);
		if (o.activeGoals.length) {
			say("\nActive goals:");
			for (const g of o.activeGoals) {
				say(`  ${g.title} — ${g.progress}${g.targets.length ? `; still to build: ${g.targets.join(", ")}` : ""}`);
			}
		}
		if (o.dueReviews.length) {
			say("\nDue for review:");
			for (const d of o.dueReviews) say(`  ${d.title} (${d.now}, due ${d.nextReview})`);
		}
		if (o.recentlyPracticed.length) {
			say("\nRecently practiced:");
			for (const c of o.recentlyPracticed) say(`  ${c.title}: ${c.status}, ${c.now} — ${c.edge}`);
		}
		const sync = new GitSync(vault);
		say(`\nGit remote: ${(await sync.remote()) ?? "none (knowledge stays on this computer)"}`);
	});

program
	.command("install-plugin")
	.description("Copy the bundled Obsidian plugin into the vault")
	.option("--vault <dir>")
	.action(async (opts: { vault?: string }) => {
		const vault = await resolveVault(opts.vault);
		const pluginSrc = bundledPluginDir(cliDir);
		const r = await installPlugin(vault, pluginSrc);
		const build = r.build ?? `v${r.version}`;
		say(r.changed ? `Installed plugin build ${build}${r.previousBuild && r.previousBuild !== r.build ? ` (was ${r.previousBuild})` : ""}.` : `Plugin build ${build} already installed.`);
		say(`  from ${pluginSrc}`);
		say(`  into ${r.dest}`);
	});

program.parseAsync().catch((e: Error) => {
	console.error(`groundwork: ${e.message}`);
	process.exit(1);
});
