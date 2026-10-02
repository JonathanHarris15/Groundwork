import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { AccountClient, AnthropicProvider, cleanFolderList, DemoProvider, isTutorMemoryPath, jevClient, knowledgeSnapshot, KnowledgeStore, MemoryVaultIO, replaceTutorMemoryFiles, tutorMemoryFiles, type Provider, type VaultIO } from "@groundwork/core";
import { GitSync } from "@groundwork/core/node";
import { checkClaudeCode, findClaudeExecutable, type ClaudeCodeConfig, type ClaudeCodeStatus, type ModelInfo } from "@groundwork/core/claude-code";
import * as os from "node:os";
import { BUILD, readBuildStamp } from "./build";
import { ObsidianVaultIO } from "./obsidian-io";
import { DEFAULT_SETTINGS, GroundworkSettingTab, loadAccountToken, loadApiKey, loadJevKey, type GroundworkSettings } from "./settings";
import { ChatView, VIEW_TYPE } from "./view";

type SyncUiState = "idle" | "syncing" | "ok" | "offline" | "error" | "disabled";

export default class GroundworkPlugin extends Plugin {
	declare settings: GroundworkSettings;
	store!: KnowledgeStore;
	private memoryIO!: MemoryVaultIO;
	syncStatus: { state: SyncUiState; text: string } = { state: "idle", text: "not synced yet" };
	private git: GitSync | null = null;
	private accountTimer: number | null = null;
	private accountPublishing = false;
	private accountPublishAgain = false;
	private statusEl!: HTMLElement;
	private lastSync: Date | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.memoryIO = new MemoryVaultIO();
		this.store = new KnowledgeStore(this.memoryIO, {
			device: this.deviceName(),
			onChange: () => this.onKnowledgeChanged(),
			judgments: jevClient(loadJevKey(this.app) || process.env.TYPESAFE_API_KEY || ""),
			context: new ObsidianVaultIO(this.app.vault.adapter),
		});

		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			this.git = new GitSync(adapter.getBasePath(), { gitPath: this.settings.gitPath, device: this.deviceName() });
		}

		this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addRibbonIcon("graduation-cap", "Open Groundwork tutor", () => void this.activateView());
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("gw-statusbar");
		this.statusEl.addEventListener("click", () => void this.saveMemory(true));
		this.renderStatus();

		this.addCommand({ id: "open-tutor", name: "Open tutor", callback: () => void this.activateView() });
		this.addCommand({
			id: "new-session",
			name: "Start a new tutoring session",
			callback: async () => (await this.activateView())?.newSession(),
		});
		this.addCommand({
			id: "practice-test",
			name: "Take a practice test",
			callback: async () => (await this.activateView())?.startPracticeTest(),
		});
		this.addCommand({ id: "sync-now", name: "Sync knowledge with GitHub now", callback: () => void this.syncNow("manual") });
		this.addCommand({
			id: "recompute",
			name: "Rebuild all mastery stats from evidence",
			callback: async () => {
				await this.store.recomputeAll();
				new Notice("Groundwork: stats rebuilt from evidence.");
			},
		});

		this.addSettingTab(new GroundworkSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.connectMemory();
			await this.store.ensureLayout();
			if (this.settings.autoSync) await this.syncNow("open");
			if (!this.app.workspace.getLeavesOfType(VIEW_TYPE).length) await this.activateView(false);
		});

		// Periodic pull keeps two open machines close even without local changes.
		this.registerInterval(window.setInterval(() => this.settings.autoSync && void this.syncNow("periodic"), 10 * 60_000));

		// Obsidian keeps running the loaded bundle after `update_groundwork.py` replaces it on disk.
		console.log(`Groundwork build ${BUILD}`);
		this.registerDomEvent(window, "focus", () => void this.checkForUpdate());
		this.registerInterval(window.setInterval(() => void this.checkForUpdate(), 5 * 60_000));
	}

	private updateOffered = false;

	async installedBuild(): Promise<string | null> {
		if (!this.manifest.dir) return null;
		try {
			return readBuildStamp(await this.app.vault.adapter.read(`${this.manifest.dir}/main.js`));
		} catch {
			return null;
		}
	}

	private async checkForUpdate(): Promise<void> {
		if (this.updateOffered) return;
		const onDisk = await this.installedBuild();
		if (!onDisk || onDisk === BUILD) return;
		this.updateOffered = true;
		const notice = new Notice(
			createFragment((f) => {
				f.createDiv({ text: "Groundwork was updated. Reload it to use the new version." });
				const btn = f.createEl("button", { text: "Reload Groundwork", cls: "mod-cta" });
				btn.style.marginTop = "8px";
				btn.addEventListener("click", () => {
					notice.hide();
					void this.reloadSelf();
				});
			}),
			0,
		);
	}

	async reloadSelf(): Promise<void> {
		const plugins = (this.app as any).plugins;
		const id = this.manifest.id;
		await plugins.disablePlugin(id);
		await plugins.enablePlugin(id);
		new Notice(`Groundwork reloaded (build ${(await this.installedBuild()) ?? "unknown"}).`);
	}

	onunload(): void {
		if (this.accountTimer !== null) window.clearTimeout(this.accountTimer);
		if (loadAccountToken(this.app)) void this.saveMemory(false);
	}

	deviceName(): string {
		return this.settings?.deviceName || os.hostname() || "obsidian";
	}

	// ── provider ───────────────────────────────────────────────────────

	/** Filled by “Check connection”; the models this Claude plan can use. */
	claudeModels: ModelInfo[] = [];

	/** For the API-key and demo providers; the Claude subscription runs through {@link claudeCodeConfig}. */
	makeProvider(): Provider | null {
		if (this.settings.provider === "demo") return new DemoProvider();
		const apiKey = loadApiKey(this.app) || process.env.ANTHROPIC_API_KEY || "";
		if (!apiKey) return null;
		return new AnthropicProvider({
			apiKey,
			model: this.settings.model,
			maxTokens: this.settings.maxTokens,
			webSearch: this.settings.webSearch,
		});
	}

	claudeExecutable(): string | null {
		return findClaudeExecutable(this.settings.claudePath);
	}

	claudeCodeConfig(): ClaudeCodeConfig | null {
		const executable = this.claudeExecutable();
		const adapter = this.app.vault.adapter;
		if (!executable || !(adapter instanceof FileSystemAdapter)) return null;
		return { executable, cwd: adapter.getBasePath(), model: this.settings.claudeModel, webSearch: this.settings.webSearch };
	}

	async checkClaudeCode(): Promise<ClaudeCodeStatus> {
		const cfg = this.claudeCodeConfig();
		if (!cfg) return { ok: false, message: this.settings.claudePath ? `No file at ${this.settings.claudePath}.` : "Claude Code wasn't found. Install it, then run `claude` in a terminal and type /login." };
		return checkClaudeCode(cfg);
	}

	providerLabel(): { label: string; demo: boolean; setup: { title: string; detail: string; action: string } | null } {
		const { provider } = this.settings;
		if (provider === "demo") return { label: "Demo tutor (scripted)", demo: true, setup: null };
		if (provider === "claude-code") {
			const model = this.claudeModels.find((m) => m.value === this.settings.claudeModel)?.displayName ?? this.settings.claudeModel;
			if (this.claudeCodeConfig()) return { label: `Claude subscription${model ? ` · ${model}` : ""}`, demo: false, setup: null };
			return {
				label: "Claude Code not found",
				demo: false,
				setup: {
					title: "Connect your Claude subscription to start.",
					detail: "Groundwork runs the tutor through Claude Code, so it uses your Pro or Max plan instead of an API key. Install Claude Code, run `claude` once in a terminal and type /login, then check the connection in settings.",
					action: "Open settings",
				},
			};
		}
		const hasKey = !!(loadApiKey(this.app) || process.env.ANTHROPIC_API_KEY);
		if (hasKey) return { label: this.settings.model, demo: false, setup: null };
		return {
			label: "No API key",
			demo: false,
			setup: {
				title: "Connect a model to start.",
				detail: "Add your Anthropic API key (kept on this device only), or switch the provider to your Claude subscription.",
				action: "Add API key",
			},
		};
	}

	async useDemo(): Promise<void> {
		this.settings.provider = "demo";
		await this.saveSettings();
	}

	useJevKey(key: string): void {
		this.store.useJudgments(jevClient(key || process.env.TYPESAFE_API_KEY || ""));
	}

	resetAgent(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ChatView) leaf.view.resetAgent();
		}
	}

	openSettings(): void {
		const setting = (this.app as any).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	// ── view ───────────────────────────────────────────────────────────

	async activateView(reveal = true): Promise<ChatView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		if (reveal) await workspace.revealLeaf(leaf);
		return leaf.view instanceof ChatView ? leaf.view : null;
	}

	private views(): ChatView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is ChatView => v instanceof ChatView);
	}

	// ── sync ───────────────────────────────────────────────────────────

	onKnowledgeChanged(): void {
		this.scheduleMemorySave();
	}

	async syncNow(reason: "open" | "manual" | "changes" | "periodic"): Promise<void> {
		if (!this.git) {
			this.setSync("disabled", "git sync needs the desktop app");
			return;
		}
		this.setSync("syncing", "syncing…");
		try {
			const r = await this.git.sync(undefined, async () => {
				await this.store.recomputeAll();
			});
			this.lastSync = new Date();
			if (r.incoming) this.store.invalidate();
			switch (r.state) {
				case "not-a-repo":
					this.setSync("disabled", "vault is not a git repo");
					if (reason === "manual") new Notice("Groundwork: this vault isn't a git repository yet. Run `groundwork init` or `git init` + add a GitHub remote.");
					break;
				case "no-remote":
					this.setSync("offline", "no GitHub remote");
					if (reason === "manual") new Notice(`Groundwork: ${r.message}`);
					break;
				case "committed-offline":
					this.setSync("offline", r.message);
					if (reason === "manual") new Notice(`Groundwork: ${r.message}`);
					break;
				case "error":
					this.setSync("error", r.message);
					new Notice(`Groundwork sync: ${r.message}`);
					break;
				default:
					this.setSync("ok", r.incoming ? "pulled changes from another machine" : "synced");
					if (reason === "manual") new Notice(`Groundwork: ${r.message}`);
			}
		} catch (e) {
			this.setSync("error", (e as Error).message);
		}
	}

	applySiteTheme(): void {
		const on = this.settings.siteTheme;
		for (const view of this.views()) view.applySiteTheme(on);
	}

	/** Load tutor memory from the account. An empty account picks up notes already in this vault, once. */
	async connectMemory(): Promise<void> {
		const token = loadAccountToken(this.app);
		if (!token) {
			this.setSync("offline", "sign in to keep tutor memory on your account");
			return;
		}
		this.setSync("syncing", "loading tutor memory…");
		try {
			const remote = await new AccountClient(this.settings.accountServerUrl, token).getMemory();
			if (Object.keys(remote.files).length === 0) {
				const imported = await this.importVaultMemory();
				const local = tutorMemoryFiles(this.memoryIO.files);
				if (imported || Object.keys(local).length) {
					await this.saveMemory(false);
					if (imported) new Notice(`Groundwork: moved ${imported} existing vault note${imported === 1 ? "" : "s"} onto your account.`);
				} else this.setSync("ok", "tutor memory is on your account");
			} else {
				replaceTutorMemoryFiles(this.memoryIO.files, remote);
				this.store.invalidate();
				this.lastSync = remote.updatedAt ? new Date(remote.updatedAt) : new Date();
				this.setSync("ok", "tutor memory loaded from your account");
			}
		} catch (e) {
			this.setSync("error", (e as Error).message);
		}
	}

	private scheduleMemorySave(): void {
		if (!loadAccountToken(this.app)) {
			this.setSync("offline", "sign in to keep tutor memory on your account");
			return;
		}
		if (this.accountTimer !== null) window.clearTimeout(this.accountTimer);
		const delay = Math.max(2, this.settings.syncDelaySeconds) * 1000;
		this.accountTimer = window.setTimeout(() => {
			this.accountTimer = null;
			void this.saveMemory(false);
		}, delay);
	}

	/** Save concepts, notes, evidence, chats, and the learner profile to the account. */
	async saveMemory(manual: boolean): Promise<void> {
		const token = loadAccountToken(this.app);
		if (!token) {
			this.setSync("offline", "sign in to keep tutor memory on your account");
			if (manual) new Notice("Groundwork: sign in under Settings → Groundwork → Account. Tutor memory is kept on that account.");
			return;
		}
		if (this.accountPublishing) {
			this.accountPublishAgain = true;
			return;
		}
		this.accountPublishing = true;
		this.setSync("syncing", "saving tutor memory…");
		try {
			const concepts = [...(await this.store.concepts()).values()];
			const goals = await this.store.goals();
			const saved = await new AccountClient(this.settings.accountServerUrl, token).putMemory({
				files: tutorMemoryFiles(this.memoryIO.files),
				knowledge: knowledgeSnapshot(concepts, goals, new Date().toISOString()),
			});
			this.lastSync = new Date(saved.updatedAt);
			this.setSync("ok", "tutor memory saved to your account");
			if (manual) new Notice("Groundwork: tutor memory saved to your account. Your profile map will follow it.");
		} catch (e) {
			this.setSync("error", (e as Error).message);
			if (manual) new Notice(`Groundwork: could not save tutor memory. ${(e as Error).message}`);
		} finally {
			this.accountPublishing = false;
			if (this.accountPublishAgain) {
				this.accountPublishAgain = false;
				void this.saveMemory(false);
			}
		}
	}

	private async importVaultMemory(): Promise<number> {
		const vault = this.store.context;
		const paths: string[] = [];
		if (await vault.exists("learner.md")) paths.push("learner.md");
		for (const dir of ["concepts", "goals", "sessions", "exams", "tests", ".groundwork"]) await this.walkMemory(vault, dir, paths);
		let imported = 0;
		for (const path of paths) {
			if (!isTutorMemoryPath(path) || this.memoryIO.files.has(path)) continue;
			try {
				this.memoryIO.files.set(path, await vault.read(path));
				imported++;
			} catch {
				// Skip a file the vault cannot read. The account copy is what the tutor will use.
			}
		}
		if (imported) this.store.invalidate();
		return imported;
	}

	private async walkMemory(vault: VaultIO, dir: string, out: string[]): Promise<void> {
		if (dir.split("/").includes("cache") || !(await vault.exists(dir))) return;
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await vault.list(dir);
		} catch {
			return;
		}
		for (const file of listed.files) if (isTutorMemoryPath(file)) out.push(file);
		for (const folder of listed.folders) await this.walkMemory(vault, folder, out);
	}

	private setSync(state: SyncUiState, text: string): void {
		this.syncStatus = { state, text };
		this.renderStatus();
		for (const v of this.views()) v.refreshSyncIndicator();
	}

	private renderStatus(): void {
		if (!this.statusEl) return;
		const { state, text } = this.syncStatus;
		const icon = { idle: "○", syncing: "↻", ok: "✓", offline: "⚠", error: "✕", disabled: "–" }[state];
		const when = this.lastSync && state === "ok" ? ` ${this.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
		this.statusEl.setText(`Groundwork ${icon}${when}`);
		this.statusEl.setAttr("aria-label", `Tutor memory: ${text} (click to save to your account)`);
		this.statusEl.setAttr("data-state", state);
	}

	// ── settings ───────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<GroundworkSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.readFolders = cleanFolderList("readFolders" in data ? data.readFolders : DEFAULT_SETTINGS.readFolders);
		this.settings.writeFolders = cleanFolderList("writeFolders" in data ? data.writeFolders : DEFAULT_SETTINGS.writeFolders);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.git = this.git ? new GitSync(this.git.dir, { gitPath: this.settings.gitPath, device: this.deviceName() }) : null;
		this.resetAgent();
		this.applySiteTheme();
	}
}
