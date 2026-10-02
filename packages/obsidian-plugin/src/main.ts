import { FileSystemAdapter, Notice, Plugin, type ObsidianProtocolData, type WorkspaceLeaf } from "obsidian";
import { AccountClient, AnthropicProvider, cleanFolderList, DemoProvider, GroundworkProvider, isTutorMemoryPath, knowledgeSnapshot, KnowledgeStore, MemoryVaultIO, refreshFirebaseSession, remoteAnswerGrader, replaceTutorMemoryFiles, syncFlashcards, tutorMemoryFiles, tutorRuntime, type AnswerGrader, type Provider, type TutorStatus, type VaultIO } from "@groundwork/core";
import { checkClaudeCode, findClaudeExecutable, type ClaudeCodeConfig, type ClaudeCodeStatus, type ModelInfo } from "@groundwork/core/claude-code";
import * as os from "node:os";
import { BUILD, readBuildStamp } from "./build";
import { groundworkOpenedSignal } from "./open-link";
import { ObsidianVaultIO } from "./obsidian-io";
import { accountOrigin, accountOriginIsLocal, DEFAULT_SETTINGS, GROUNDWORK_WEB_API_KEY, GroundworkSettingTab, loadAccountToken, loadApiKey, saveAccountToken, type GroundworkSettings } from "./settings";
import { ChatView, VIEW_TYPE } from "./view";

type SyncUiState = "idle" | "syncing" | "ok" | "offline" | "error" | "disabled";

export default class GroundworkPlugin extends Plugin {
	declare settings: GroundworkSettings;
	store!: KnowledgeStore;
	private memoryIO!: MemoryVaultIO;
	syncStatus: { state: SyncUiState; text: string } = { state: "idle", text: "not synced yet" };
	private accountTimer: number | null = null;
	private accountPublishing = false;
	private accountPublishAgain = false;
	private statusEl!: HTMLElement;
	private lastSync: Date | null = null;
	private markLayoutReady: () => void = () => {};
	private readonly layoutReady = new Promise<void>((resolve) => {
		this.markLayoutReady = resolve;
	});

	async onload(): Promise<void> {
		await this.loadSettings();
		this.memoryIO = new MemoryVaultIO();
		this.store = new KnowledgeStore(this.memoryIO, {
			device: this.deviceName(),
			onChange: () => this.onKnowledgeChanged(),
			context: new ObsidianVaultIO(this.app.vault.adapter),
		});

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
		this.addCommand({
			id: "flashcards",
			name: "Study flashcards",
			callback: async () => (await this.activateView())?.showFlashcards(),
		});
		this.addCommand({
			id: "recompute",
			name: "Rebuild all mastery stats from evidence",
			callback: async () => {
				await this.store.recomputeAll();
				new Notice("Groundwork: stats rebuilt from evidence.");
			},
		});

		this.addSettingTab(new GroundworkSettingTab(this.app, this));
		this.registerObsidianProtocolHandler("groundwork", (params) => {
			void this.handleOpenLink(params);
		});

		this.app.workspace.onLayoutReady(async () => {
			this.markLayoutReady();
			await this.connectMemory();
			await this.refreshTutorRoute();
			await this.store.ensureLayout();
			const reveal = this.takeOpenRequest();
			if (reveal || !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) await this.activateView(reveal);
		});

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

	/** Website "Open Obsidian": connect this account, sync tutor memory, reveal the tutor, and reload a newer build already on disk. */
	private async handleOpenLink(params: ObsidianProtocolData): Promise<void> {
		await this.layoutReady;
		const refresh = typeof params.refresh === "string" ? params.refresh.trim() : "";
		if (refresh) {
			saveAccountToken(this.app, refresh);
			new Notice("Groundwork: this device is connected to your account.");
		}
		await this.signalOpened(typeof params.opened === "string" ? params.opened : undefined);
		await this.connectMemory();
		await this.refreshTutorRoute();
		const onDisk = await this.installedBuild();
		if (onDisk && onDisk !== BUILD) {
			this.requestOpenAfterReload();
			new Notice("Groundwork found an update and is reloading it.");
			await this.reloadSelf();
			return;
		}
		await this.activateView(true);
	}

	private async signalOpened(opened: string | undefined): Promise<void> {
		const url = groundworkOpenedSignal(opened);
		if (!url) return;
		try {
			await Promise.race([
				fetch(url, { cache: "no-store" }),
				new Promise((resolve) => window.setTimeout(resolve, 1500)),
			]);
		} catch {
			// A missed ack sends the website on to the installer.
		}
	}

	private requestOpenAfterReload(): void {
		this.app.saveLocalStorage("groundwork-open-on-load", "1");
	}

	private takeOpenRequest(): boolean {
		if (this.app.loadLocalStorage("groundwork-open-on-load") !== "1") return false;
		this.app.saveLocalStorage("groundwork-open-on-load", null);
		return true;
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
	/** Last answer from the account. Null when this device is not signed in. */
	tutorRoute: TutorStatus | null = null;

	/** For the API-key and demo providers; the Claude subscription runs through {@link claudeCodeConfig}. */
	makeProvider(): Provider | null {
		if (this.settings.provider === "demo") return new DemoProvider();
		const apiKey = loadApiKey(this.app) || process.env.ANTHROPIC_API_KEY || "";
		if (!apiKey) return null;
		return new AnthropicProvider({
			apiKey,
			model: this.settings.model,
			maxTokens: this.settings.maxTokens,
			webSearch: true,
		});
	}

	/** Hosted plans and saved bring-your-own keys. The key stays on the server. */
	makeGroundworkProvider(): Provider {
		return new GroundworkProvider({
			origin: accountOrigin(),
			token: () => this.accountAccessToken(),
			maxTokens: this.settings.maxTokens,
		});
	}

	async refreshTutorRoute(): Promise<void> {
		const token = await this.accountAccessToken();
		if (!token) {
			this.tutorRoute = null;
			return;
		}
		try {
			const res = await fetch(`${accountOrigin()}/v1/tutor`, { headers: { authorization: `Bearer ${token}` } });
			const body = (await res.json()) as TutorStatus;
			if (!res.ok) return;
			this.tutorRoute = body;
		} catch {
			// Keep the last route. A missed refresh should not drop a lesson in progress.
		}
	}

	tutorRouteKey(): string {
		const route = this.tutorRoute;
		if (!route) return `local:${this.settings.provider}`;
		return `${route.action}:${route.provider ?? ""}:${route.model ?? ""}:${route.setup ?? ""}`;
	}

	runtime(): ReturnType<typeof tutorRuntime> {
		return tutorRuntime({
			selected: this.settings.provider === "demo" ? "demo" : this.settings.provider === "anthropic" ? "anthropic" : "claude",
			account: this.tutorRoute,
			claudeReady: !!this.claudeCodeConfig(),
			localKey: !!(loadApiKey(this.app) || process.env.ANTHROPIC_API_KEY),
		});
	}

	claudeExecutable(): string | null {
		return findClaudeExecutable(this.settings.claudePath);
	}

	/** Jev grading goes through the website. This device never holds the Jev key. */
	answerGrader(): AnswerGrader {
		return remoteAnswerGrader(accountOrigin(), fetch, () => this.accountAccessToken());
	}

	claudeCodeConfig(): ClaudeCodeConfig | null {
		const executable = this.claudeExecutable();
		const adapter = this.app.vault.adapter;
		if (!executable || !(adapter instanceof FileSystemAdapter)) return null;
		return { executable, cwd: adapter.getBasePath(), model: this.settings.claudeModel, webSearch: true };
	}

	async checkClaudeCode(): Promise<ClaudeCodeStatus> {
		const cfg = this.claudeCodeConfig();
		if (!cfg) return { ok: false, message: this.settings.claudePath ? `No file at ${this.settings.claudePath}.` : "Claude Code wasn't found. Install it, then run `claude` in a terminal and type /login." };
		return checkClaudeCode(cfg);
	}

	providerLabel(): { label: string; demo: boolean; setup: { title: string; detail: string; action: string; website?: boolean } | null } {
		const { provider } = this.settings;
		if (provider === "demo") return { label: "Demo tutor (scripted)", demo: true, setup: null };
		const runtime = this.runtime();
		const route = this.tutorRoute;
		if (runtime.runtime === "proxy") return { label: route?.label ?? "Groundwork", demo: false, setup: null };
		if (runtime.runtime === "local-key") return { label: this.settings.model, demo: false, setup: null };
		if (runtime.runtime === "setup") {
			return {
				label: route?.action === "blocked" ? "Tutor paused" : provider === "claude-code" ? "Claude Code not found" : "No API key",
				demo: false,
				setup: {
					title: runtime.website ? "Finish setup on the website." : provider === "claude-code" ? "Connect your Claude subscription to start." : "Connect a model to start.",
					detail: runtime.detail ?? "Set up a tutor provider in Settings → Groundwork.",
					action: runtime.website ? "Open website" : provider === "claude-code" ? "Open settings" : "Add API key",
					website: runtime.website,
				},
			};
		}
		if (provider === "claude-code" || route?.action === "claude") {
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

	resetAgent(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ChatView) leaf.view.resetAgent();
		}
	}

	openSettings(): void {
		void this.openGroundworkSettings();
	}

	/** The real settings live in the Groundwork panel, not Obsidian's plugin tab. */
	async openGroundworkSettings(): Promise<void> {
		(this.app as any).setting?.close();
		const view = await this.activateView();
		await view?.showSettings();
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

	applySiteTheme(): void {
		const on = this.settings.siteTheme;
		for (const view of this.views()) view.applySiteTheme(on);
	}

	/** ID token for the website, or the stored token when talking to a local server. */
	private async accountAccessToken(): Promise<string | null> {
		const refresh = loadAccountToken(this.app);
		if (!refresh) return null;
		if (accountOriginIsLocal()) return refresh;
		try {
			const session = await refreshFirebaseSession(refresh, GROUNDWORK_WEB_API_KEY);
			if (session.refreshToken !== refresh) saveAccountToken(this.app, session.refreshToken);
			return session.idToken;
		} catch (e) {
			this.setSync("error", e instanceof Error ? e.message : String(e));
			return null;
		}
	}

	private async memoryClient(): Promise<AccountClient | null> {
		const token = await this.accountAccessToken();
		if (!token) {
			if (!loadAccountToken(this.app)) this.setSync("offline", "open the website and choose Open Obsidian");
			return null;
		}
		return new AccountClient(accountOrigin(), token);
	}

	/** Load tutor memory from the website. An empty account picks up notes already in this vault, once. */
	async connectMemory(): Promise<void> {
		const client = await this.memoryClient();
		if (!client) return;
		this.setSync("syncing", "loading tutor memory…");
		try {
			const remote = await client.getHostedMemory();
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
			await this.syncFlashcards();
		} catch (e) {
			this.setSync("error", (e as Error).message);
		}
	}

	private scheduleMemorySave(): void {
		if (!loadAccountToken(this.app)) {
			this.setSync("offline", "open the website and choose Open Obsidian");
			return;
		}
		if (this.accountTimer !== null) window.clearTimeout(this.accountTimer);
		this.accountTimer = window.setTimeout(() => {
			this.accountTimer = null;
			void this.saveMemory(false);
		}, 2000);
	}

	/** Copy account flashcards into flashcards/ inside each write folder, and pull hand edits back. */
	async syncFlashcards(): Promise<void> {
		try {
			await syncFlashcards(this.store, this.settings.writeFolders);
		} catch (e) {
			console.error("Groundwork flashcards", e);
		}
	}

	/** Save concepts, notes, evidence, chats, and the learner profile to the website account. */
	async saveMemory(manual: boolean): Promise<void> {
		const client = await this.memoryClient();
		if (!client) {
			if (manual) new Notice("Groundwork: open the website and choose Open Obsidian. Tutor memory is kept on that account.");
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
			const saved = await client.putHostedMemory({
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
		this.resetAgent();
		this.applySiteTheme();
	}
}
