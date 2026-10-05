import { FileSystemAdapter, Notice, Plugin, type ObsidianProtocolData, type WorkspaceLeaf } from "obsidian";
import { AccountClient, AccountError, CLAUDE_SETUP, cleanFolderList, GroundworkProvider, isTutorMemoryPath, knowledgeSnapshot, KnowledgeStore, MemoryVaultIO, mergeTutorMemoryFiles, parseTutorMemoryFiles, refreshFirebaseSession, remoteAnswerGrader, replaceTutorMemoryFiles, SIGN_IN_DETAIL, syncFlashcards, tutorMemoryFiles, tutorRuntime, type AnswerGrader, type Provider, type TutorMemory, type TutorStatus, type VaultIO } from "@groundwork/core";
import { checkClaudeCode, findClaudeExecutable, type ClaudeCodeConfig, type ClaudeCodeStatus, type ModelInfo } from "@groundwork/core/claude-code";
import { BUILD, readBuildStamp } from "./build";
import { groundworkOpenedSignal } from "./open-link";
import { ObsidianVaultIO } from "./obsidian-io";
import { appearanceFrom } from "./appearance";
import { accountOrigin, DEFAULT_SETTINGS, GROUNDWORK_WEB_API_KEY, GroundworkSettingTab, loadAccountToken, saveAccountToken, type GroundworkSettings } from "./settings";
import { closeSettings, pluginManager } from "./obsidian-host";
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
	/** Files and timestamp last loaded or saved. The next save is based on this, so another device is not wiped. */
	private memoryBaseline: { files: Record<string, string>; updatedAt: string } | null = null;
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
			const open = this.app.workspace.getLeavesOfType(VIEW_TYPE);
			const inMain = open.some((leaf) => leaf.getRoot() === this.app.workspace.rootSplit);
			if (reveal || !inMain) await this.activateView(reveal);
		});

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
				const btn = f.createEl("button", { text: "Reload Groundwork", cls: "mod-cta gw-notice-reload-btn" });
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
			new Notice("Groundwork: this device is linked to your account.");
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
		const id = this.manifest.id;
		await pluginManager(this.app).disablePlugin(id);
		await pluginManager(this.app).enablePlugin(id);
		new Notice(`Groundwork reloaded (build ${(await this.installedBuild()) ?? "unknown"}).`);
	}

	onunload(): void {
		if (this.accountTimer !== null) window.clearTimeout(this.accountTimer);
		if (loadAccountToken(this.app)) void this.saveMemory(false).catch(() => undefined);
	}

	deviceName(): string {
		const name = this.settings?.deviceName?.trim();
		return name || "Obsidian";
	}

	// ── provider ───────────────────────────────────────────────────────

	/** Filled by “Check connection”; the models this Claude plan can use. */
	claudeModels: ModelInfo[] = [];
	/** Last answer from the account. Null when this device is not signed in. */
	tutorRoute: TutorStatus | null = null;

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
			const body = (await res.json()) as TutorStatus & { error?: unknown };
			if (!res.ok) {
				if (res.status === 401 || res.status === 403) this.disconnectAccount();
				else {
					const message =
						typeof body.error === "string"
							? body.error
							: `Groundwork could not load tutor settings (${res.status}). Try again in a moment.`;
					this.tutorRoute = this.unavailableTutorRoute(message);
				}
				return;
			}
			this.tutorRoute = body;
		} catch {
			// Keep the last route. A missed refresh should not drop a lesson in progress.
		}
	}

	private unavailableTutorRoute(message: string): TutorStatus {
		return {
			action: "blocked",
			via: "hosted",
			model: null,
			provider: null,
			label: "Tutor paused",
			error: message,
			setup: null,
			budgetUsed: 0,
			ownModel: false,
			claude: CLAUDE_SETUP,
		};
	}

	tutorRouteKey(): string {
		const route = this.tutorRoute;
		if (!route) return `local:${this.settings.provider}`;
		return `${route.action}:${route.provider ?? ""}:${route.model ?? ""}:${route.setup ?? ""}`;
	}

	signedIn(): boolean {
		return !!loadAccountToken(this.app);
	}

	runtime(): ReturnType<typeof tutorRuntime> {
		return tutorRuntime({
			selected: this.settings.provider === "demo" ? "demo" : "claude",
			account: this.tutorRoute,
			signedIn: this.signedIn(),
			claudeReady: !!this.claudeCodeConfig(),
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
		if (!this.signedIn()) {
			return {
				label: "Sign in",
				demo: false,
				setup: { title: "Sign in to start the tutor.", detail: SIGN_IN_DETAIL, action: "Open website", website: true },
			};
		}
		const { provider } = this.settings;
		if (provider === "demo") return { label: "Demo tutor (scripted)", demo: true, setup: null };
		const runtime = this.runtime();
		const route = this.tutorRoute;
		if (runtime.runtime === "proxy") return { label: route?.label ?? "Groundwork", demo: false, setup: null };
		if (runtime.runtime === "setup") {
			return {
				label: route?.action === "blocked" ? "Tutor paused" : runtime.website ? "Account" : "Claude Code not found",
				demo: false,
				setup: {
					title: runtime.website ? "Finish setup on the website." : "Install Claude Code to use your subscription.",
					detail: runtime.detail ?? SIGN_IN_DETAIL,
					action: runtime.website ? "Open website" : "Open settings",
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
					detail: "Install Claude Code, run `claude` once in a terminal and sign in (/login), then press Check connection in Groundwork settings.",
					action: "Open settings",
				},
			};
		}
		return { label: route?.label ?? "Groundwork", demo: false, setup: null };
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
		closeSettings(this.app);
		const view = await this.activateView();
		await view?.showSettings();
	}

	// ── view ───────────────────────────────────────────────────────────

	async activateView(reveal = true): Promise<ChatView | null> {
		const { workspace } = this.app;
		const open = workspace.getLeavesOfType(VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = open.find((item) => item.getRoot() === workspace.rootSplit) ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		for (const side of open) if (side !== leaf) side.detach();
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

	applyAppearance(): void {
		for (const view of this.views()) view.applyAppearance(this.settings.appearance);
	}


	/** ID token for the website after exchanging the stored refresh token. */
	private async accountAccessToken(): Promise<string | null> {
		const refresh = loadAccountToken(this.app);
		if (!refresh) return null;
		try {
			const session = await refreshFirebaseSession(refresh, GROUNDWORK_WEB_API_KEY);
			if (session.refreshToken !== refresh) saveAccountToken(this.app, session.refreshToken);
			return session.idToken;
		} catch (e) {
			if (e instanceof AccountError && (e.status === 401 || e.status === 400)) this.disconnectAccount();
			else this.setSync("error", e instanceof Error ? e.message : String(e));
			return null;
		}
	}

	private disconnectAccount(): void {
		saveAccountToken(this.app, "");
		this.tutorRoute = null;
		this.setSync("offline", "choose Open Obsidian on the Groundwork website");
	}

	private async memoryClient(): Promise<AccountClient | null> {
		const token = await this.accountAccessToken();
		if (!token) {
			if (!loadAccountToken(this.app)) this.setSync("offline", "choose Open Obsidian on the Groundwork website");
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
			this.memoryBaseline = { files: { ...remote.files }, updatedAt: remote.updatedAt };
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
			this.setSync("offline", "choose Open Obsidian on the Groundwork website");
			return;
		}
		if (this.accountTimer !== null) window.clearTimeout(this.accountTimer);
		this.accountTimer = window.setTimeout(() => {
			this.accountTimer = null;
			void this.saveMemory(false);
		}, 2000);
	}

	/** Pull hand edits of cards the learner already wrote into the vault. Does not copy cards out. */
	async syncFlashcards(): Promise<void> {
		try {
			await syncFlashcards(this.store, this.settings.writeFolders);
		} catch {
			// Flashcard sync is best-effort; the tutor still runs from account memory.
		}
	}

	/** Save concepts, notes, evidence, chats, and the learner profile to the website account. */
	async saveMemory(manual: boolean): Promise<void> {
		const client = await this.memoryClient();
		if (!client) {
			if (manual) new Notice("Groundwork: sign in on the website and choose Open Obsidian. Tutor memory stays on your account.");
			return;
		}
		if (!this.memoryBaseline) {
			if (!manual) return;
			await this.connectMemory();
			if (!this.memoryBaseline) new Notice("Groundwork: could not load tutor memory. Check the network, then choose Open Obsidian on the website again.");
			return;
		}
		if (this.accountPublishing) {
			this.accountPublishAgain = true;
			return;
		}
		this.accountPublishing = true;
		this.setSync("syncing", "saving tutor memory…");
		try {
			let saved: TutorMemory | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				const concepts = [...(await this.store.concepts()).values()];
				const goals = await this.store.goals();
				try {
					saved = await client.putHostedMemory({
						files: tutorMemoryFiles(this.memoryIO.files),
						knowledge: knowledgeSnapshot(concepts, goals, new Date().toISOString()),
						baseUpdatedAt: this.memoryBaseline.updatedAt,
					});
					break;
				} catch (e) {
					if (!(e instanceof AccountError) || e.status !== 409 || attempt === 2) throw e;
					new Notice("Groundwork: your account changed on another device. Merged the changes and saving again.");
					const remote = memoryFromConflict(e.body) ?? (await client.getHostedMemory());
					const merged = mergeTutorMemoryFiles(this.memoryBaseline.files, tutorMemoryFiles(this.memoryIO.files), remote.files);
					replaceTutorMemoryFiles(this.memoryIO.files, { files: merged });
					this.store.invalidate();
					this.memoryBaseline = { files: { ...remote.files }, updatedAt: remote.updatedAt };
				}
			}
			if (!saved) return;
			this.memoryBaseline = { files: { ...saved.files }, updatedAt: saved.updatedAt };
			this.lastSync = saved.updatedAt ? new Date(saved.updatedAt) : new Date();
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
		const data = ((await this.loadData()) ?? {}) as Partial<GroundworkSettings> & { siteTheme?: unknown; provider?: string };
		const appearance = appearanceFrom(data);
		delete data.siteTheme;
		if (data.provider !== "demo" && data.provider !== "claude-code") data.provider = "claude-code";
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.appearance = appearance;
		this.settings.readFolders = cleanFolderList("readFolders" in data ? data.readFolders : DEFAULT_SETTINGS.readFolders);
		this.settings.writeFolders = cleanFolderList("writeFolders" in data ? data.writeFolders : DEFAULT_SETTINGS.writeFolders);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.resetAgent();
		this.applyAppearance();
	}
}

function memoryFromConflict(body: unknown): TutorMemory | null {
	if (!body || typeof body !== "object") return null;
	const memory = (body as { memory?: unknown }).memory;
	if (!memory || typeof memory !== "object") return null;
	const updatedAt = (memory as { updatedAt?: unknown }).updatedAt;
	if (typeof updatedAt !== "string") return null;
	try {
		return { updatedAt, files: parseTutorMemoryFiles((memory as { files?: unknown }).files) };
	} catch {
		return null;
	}
}
