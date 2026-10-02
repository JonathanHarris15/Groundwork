import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import { AccountClient, cleanFolderList, DEFAULT_READ_FOLDERS, DEFAULT_WRITE_FOLDERS, listAnthropicModels, normalizeVaultPath, type FolderAccess } from "@groundwork/core";
import { BUILD } from "./build";
import type GroundworkPlugin from "./main";

export type ProviderId = "claude-code" | "anthropic" | "demo";

export interface GroundworkSettings {
	provider: ProviderId;
	/** Path to Claude Code's `claude` executable; empty means auto-detect. */
	claudePath: string;
	/** Claude Code model alias or id; empty means Claude Code's default. */
	claudeModel: string;
	model: string;
	maxTokens: number;
	webSearch: boolean;
	autoSync: boolean;
	syncDelaySeconds: number;
	gitPath: string;
	deviceName: string;
	/** Account server that stores the published concept map. */
	accountServerUrl: string;
	accountEmail: string;
	/** Publish the concept map to the account server for the website profile. */
	accountSync: boolean;
	/** Restyle the Groundwork panel with the website’s colors and type. */
	siteTheme: boolean;
	/** Vault folders the tutor may list and open. */
	readFolders: string[];
	/** Vault folders where the tutor may write a file to hand in. */
	writeFolders: string[];
}

export const DEFAULT_SETTINGS: GroundworkSettings = {
	provider: "claude-code",
	claudePath: "",
	claudeModel: "",
	model: "claude-sonnet-4-5",
	maxTokens: 8192,
	webSearch: false,
	autoSync: true,
	syncDelaySeconds: 30,
	gitPath: "git",
	deviceName: "",
	accountServerUrl: "http://127.0.0.1:8787",
	accountEmail: "",
	accountSync: false,
	siteTheme: false,
	readFolders: [],
	writeFolders: [],
};

export function folderAccessFrom(settings: GroundworkSettings): FolderAccess {
	return {
		readFolders: cleanFolderList(settings.readFolders ?? DEFAULT_READ_FOLDERS),
		writeFolders: cleanFolderList(settings.writeFolders ?? DEFAULT_WRITE_FOLDERS),
	};
}

/** The API key lives in this device's local storage, never in the vault, so it is never pushed to GitHub. */
const KEY_STORAGE = "groundwork-anthropic-key";
const JEV_KEY_STORAGE = "groundwork-typesafe-key";
const ACCOUNT_TOKEN_STORAGE = "groundwork-account-token";

export function loadApiKey(app: App): string {
	return (app.loadLocalStorage(KEY_STORAGE) as string | null) ?? "";
}

export function saveApiKey(app: App, key: string): void {
	app.saveLocalStorage(KEY_STORAGE, key || null);
}

export function loadJevKey(app: App): string {
	return (app.loadLocalStorage(JEV_KEY_STORAGE) as string | null) ?? "";
}

export function saveJevKey(app: App, key: string): void {
	app.saveLocalStorage(JEV_KEY_STORAGE, key || null);
}

/** Session token for the account server. Local to this device, like the API key — never written into the vault. */
export function loadAccountToken(app: App): string {
	return (app.loadLocalStorage(ACCOUNT_TOKEN_STORAGE) as string | null) ?? "";
}

export function saveAccountToken(app: App, token: string): void {
	app.saveLocalStorage(ACCOUNT_TOKEN_STORAGE, token || null);
}

export class GroundworkSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: GroundworkPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = async () => {
			await this.plugin.saveSettings();
		};

		new Setting(containerEl).setName("Tutor").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Claude subscription runs the tutor through Claude Code with your Pro/Max plan, no API key needed. Anthropic API bills an API key. Demo plays a scripted lesson.")
			.addDropdown((d) =>
				d
					.addOption("claude-code", "Claude subscription (Claude Code)")
					.addOption("anthropic", "Anthropic API key")
					.addOption("demo", "Demo (scripted)")
					.setValue(s.provider)
					.onChange(async (v) => {
						s.provider = v as ProviderId;
						await save();
						this.display();
					}),
			);

		if (s.provider === "claude-code") this.claudeCodeSettings(containerEl, save);
		if (s.provider === "anthropic") this.anthropicSettings(containerEl, save);

		new Setting(containerEl).setName("Judgments").setHeading();
		new Setting(containerEl)
			.setName("TypeSafe API key")
			.setDesc(
				"Optional. Jev matches a question or a course-file idea to a concept already in your account, checks whether a prerequisite link is direct, grades the understanding in a written answer, and picks among ready next steps. Mastery numbers stay on the account. The key stays on this device.",
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("TypeSafe API key")
					.setValue(loadJevKey(this.app))
					.onChange((v) => {
						saveJevKey(this.app, v.trim());
						this.plugin.useJevKey(v.trim());
					});
			});

		if (s.provider !== "demo") {
			new Setting(containerEl)
				.setName("Web search for fact-checking")
				.setDesc(
					s.provider === "claude-code"
						? "Lets the tutor use Claude Code's web search and fetch tools to verify facts."
						: "Lets the tutor verify facts with Anthropic's web search tool. Your organization must have it enabled.",
				)
				.addToggle((t) =>
					t.setValue(s.webSearch).onChange(async (v) => {
						s.webSearch = v;
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync with GitHub automatically")
			.setDesc("Pulls when Obsidian opens and commits + pushes shortly after the tutor changes your knowledge. Requires this vault to be a git repo with an `origin` remote.")
			.addToggle((t) =>
				t.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Sync delay (seconds)")
			.setDesc("How long to wait after a change before committing, so a burst of quiz answers becomes one commit.")
			.addText((t) =>
				t.setValue(String(s.syncDelaySeconds)).onChange(async (v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 5) {
						s.syncDelaySeconds = Math.round(n);
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Git executable")
			.setDesc("Path to git if it isn't on the default PATH.")
			.addText((t) =>
				t.setValue(s.gitPath).onChange(async (v) => {
					s.gitPath = v.trim() || "git";
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Recorded on quiz evidence and commits so you can tell machines apart. Defaults to the hostname.")
			.addText((t) =>
				t.setPlaceholder(this.plugin.deviceName()).setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim();
					await save();
				}),
			);

		this.folderSettings(containerEl, save);
		this.accountSettings(containerEl, save);
		this.appearanceSettings(containerEl, save);

		new Setting(containerEl).setName("About").setHeading();

		const version = new Setting(containerEl).setName("Running build").setDesc(BUILD);
		void this.plugin.installedBuild().then((onDisk) => {
			if (!onDisk || onDisk === BUILD) return;
			version.setDesc(`${BUILD}. A newer build is installed: ${onDisk}.`);
			version.addButton((b) => b.setButtonText("Reload Groundwork").setCta().onClick(() => void this.plugin.reloadSelf()));
		});
	}

	private folderSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
		const s = this.plugin.settings;
		s.readFolders = cleanFolderList(s.readFolders);
		s.writeFolders = cleanFolderList(s.writeFolders);
		new Setting(containerEl).setName("Vault folders").setHeading();
		new Setting(containerEl)
			.setName("Folders the tutor can read")
			.setDesc("Optional extra context in this vault. The tutor lists and opens files only inside these folders, and chat uploads are saved in the first one. Leave this empty and it does not read the vault. Concepts, notes, and quiz evidence are kept on your account.");
		this.folderRows(containerEl, "readFolders", save);
		new Setting(containerEl)
			.setName("Folders the tutor can write")
			.setDesc("Optional. When you ask for a file to hand in, the tutor writes it inside these vault folders and nowhere else.");
		this.folderRows(containerEl, "writeFolders", save);
	}

	private folderRows(containerEl: HTMLElement, key: "readFolders" | "writeFolders", save: () => Promise<void>): void {
		const s = this.plugin.settings;
		const folders = s[key];
		if (!folders.length) {
			new Setting(containerEl).setName("None").setDesc("The tutor cannot use a folder until you add one.");
		}
		for (const folder of folders) {
			new Setting(containerEl).setName(folder).addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove")
					.onClick(async () => {
						s[key] = folders.filter((item) => item !== folder);
						await save();
						this.display();
					}),
			);
		}
		let typed = "";
		new Setting(containerEl)
			.setName("Add a folder")
			.addText((t) =>
				t.setPlaceholder(key === "readFolders" ? "resources" : "submissions").onChange((v) => {
					typed = v;
				}),
			)
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					const folder = normalizeVaultPath(typed);
					if (!folder) {
						new Notice("Groundwork: use a vault folder such as resources or submissions/homework.");
						return;
					}
					if (!s[key].includes(folder)) s[key].push(folder);
					await save();
					this.display();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Choose…").onClick(() => {
					new VaultFolderModal(this.app, async (picked) => {
						const folder = normalizeVaultPath(picked.path);
						if (!folder) {
							new Notice("Groundwork: that folder can’t be used.");
							return;
						}
						if (!s[key].includes(folder)) s[key].push(folder);
						await save();
						this.display();
					}).open();
				}),
			);
	}

	private accountSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
		const s = this.plugin.settings;
		new Setting(containerEl).setName("Account").setHeading();

		new Setting(containerEl)
			.setName("Account server")
			.setDesc("The site reads your concept map from this server. Use the address printed by `npm run account`, or a hosted account server.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.accountServerUrl)
					.setValue(s.accountServerUrl)
					.onChange(async (v) => {
						s.accountServerUrl = v.trim() || DEFAULT_SETTINGS.accountServerUrl;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Email")
			.addText((t) =>
				t.setPlaceholder("you@example.com").setValue(s.accountEmail).onChange(async (v) => {
					s.accountEmail = v.trim();
					await save();
				}),
			);

		let password = "";
		new Setting(containerEl)
			.setName("Password")
			.setDesc("Used only to sign in. It is not stored in the vault or in plugin settings.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("At least 8 characters").onChange((v) => {
					password = v;
				});
			});

		const actions = new Setting(containerEl)
			.setName("Sign in")
			.setDesc("Create an account or sign in. The session token stays on this device.");
		const runAuth = async (create: boolean) => {
			if (!s.accountEmail || password.length < 8) {
				new Notice("Groundwork: enter your email and a password of at least 8 characters.");
				return;
			}
			try {
				const client = new AccountClient(s.accountServerUrl);
				const session = create
					? await client.register({
							email: s.accountEmail,
							password,
							displayName: s.accountEmail.split("@")[0] || "Learner",
						})
					: await client.login({ email: s.accountEmail, password });
				saveAccountToken(this.app, session.token);
				new Notice(`Groundwork: signed in as ${session.user.displayName} (@${session.user.handle}).`);
				await this.plugin.connectMemory();
				this.display();
			} catch (e) {
				new Notice(`Groundwork: ${(e as Error).message}`);
			}
		};
		actions.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => void runAuth(false)));
		actions.addButton((b) => b.setButtonText("Create account").onClick(() => void runAuth(true)));

		const session = new Setting(containerEl).setName("Session");
		const token = loadAccountToken(this.app);
		if (!token) session.setDesc("Not signed in.");
		else {
			session.setDesc("Checking the account server…");
			void new AccountClient(s.accountServerUrl, token).me().then(
				(user) => session.setDesc(`Signed in as ${user.displayName} (@${user.handle}). The site shows this map on your profile.`),
				(e) => session.setDesc((e as Error).message || "Saved sign-in was rejected. Sign in again."),
			);
		}
		session.addButton((b) =>
			b.setButtonText("Sign out").onClick(async () => {
				const current = loadAccountToken(this.app);
				if (current) {
					await this.plugin.saveMemory(false);
					try {
						await new AccountClient(s.accountServerUrl, current).logout();
					} catch {
						// Drop the local token either way so this device stops saving.
					}
				}
				saveAccountToken(this.app, "");
				new Notice("Groundwork: signed out on this device. Tutor memory stays on the account.");
				this.display();
			}),
		);

		new Setting(containerEl)
			.setName("Tutor memory")
			.setDesc("Concepts, notes, quiz evidence, chats, and your learner profile are saved on this account, not in the vault. The profile page draws the concept map from that memory. Vault folders above are only extra context.")
			.addButton((b) => b.setButtonText("Save now").setCta().onClick(() => void this.plugin.saveMemory(true)));
	}

	private appearanceSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
		const s = this.plugin.settings;
		new Setting(containerEl).setName("Appearance").setHeading();
		new Setting(containerEl)
			.setName("Match the Groundwork website")
			.setDesc("Override Obsidian’s colors and type inside this panel so Groundwork uses the website’s paper, ink, and status colors. The rest of Obsidian keeps its theme.")
			.addToggle((t) =>
				t.setValue(s.siteTheme).onChange(async (v) => {
					s.siteTheme = v;
					await save();
				}),
			);
	}

	private claudeCodeSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
		const s = this.plugin.settings;
		const detected = this.plugin.claudeExecutable();

		const status = new Setting(containerEl).setName("Connection");
		const statusText = status.descEl.createDiv({ cls: "gw-setting-status" });
		const showStatus = (ok: boolean | null, text: string) => {
			statusText.setText(text);
			statusText.toggleClass("is-ok", ok === true);
			statusText.toggleClass("is-error", ok === false);
		};
		showStatus(
			detected ? null : false,
			detected ? "Uses the Claude account Claude Code is signed in with on this computer." : "Claude Code wasn't found. Install it, then run `claude` in a terminal and type /login.",
		);
		status.addButton((b) =>
			b
				.setButtonText("Check connection")
				.setCta()
				.onClick(async () => {
					b.setDisabled(true).setButtonText("Checking…");
					try {
						const r = await this.plugin.checkClaudeCode();
						showStatus(r.ok, r.message);
						if (r.models?.length) this.plugin.claudeModels = r.models;
						renderModels();
					} catch (e) {
						showStatus(false, `Check failed: ${(e as Error).message}`);
					} finally {
						b.setDisabled(false).setButtonText("Check connection");
					}
				}),
		);

		new Setting(containerEl)
			.setName("Claude Code executable")
			.setDesc(detected && !s.claudePath ? `Found at ${detected}. Leave empty to auto-detect.` : "Leave empty to auto-detect `claude` on your PATH and the usual install locations.")
			.addText((t) =>
				t
					.setPlaceholder(detected ?? "claude")
					.setValue(s.claudePath)
					.onChange(async (v) => {
						s.claudePath = v.trim();
						await save();
					}),
			);

		const model = new Setting(containerEl).setName("Model");
		const renderModels = () => {
			model.controlEl.empty();
			const models = this.plugin.claudeModels;
			model.setDesc(models.length ? "Models your Claude plan can use." : "Claude Code's default, or an alias like sonnet or opus. Check the connection to list your plan's models.");
			if (models.length) {
				model.addDropdown((d) => {
					for (const m of models) d.addOption(m.value === "default" ? "" : m.value, m.displayName || m.value);
					if (s.claudeModel && !models.some((m) => m.value === s.claudeModel)) d.addOption(s.claudeModel, s.claudeModel);
					d.setValue(s.claudeModel).onChange(async (v) => {
						s.claudeModel = v;
						await save();
					});
				});
			} else {
				model.addText((t) =>
					t
						.setPlaceholder("default")
						.setValue(s.claudeModel)
						.onChange(async (v) => {
							s.claudeModel = v.trim();
							await save();
						}),
				);
			}
		};
		renderModels();
	}

	private anthropicSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Stored only on this device (not in the vault), so it is never committed to GitHub.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("sk-ant-…")
					.setValue(loadApiKey(this.app))
					.onChange((v) => {
						saveApiKey(this.app, v.trim());
						this.plugin.resetAgent();
					});
			});

		const modelSetting = new Setting(containerEl)
			.setName("Model")
			.setDesc("Any Anthropic model id. Use “Load models” to pick from what your key can access.")
			.addText((t) =>
				t.setValue(s.model).onChange(async (v) => {
					s.model = v.trim();
					await save();
				}),
			);
		modelSetting.addButton((b) =>
			b.setButtonText("Load models").onClick(async () => {
				const key = loadApiKey(this.app);
				if (!key) return new Notice("Add your API key first.");
				try {
					const models = await listAnthropicModels(key);
					modelSetting.controlEl.empty();
					modelSetting.addDropdown((d) => {
						for (const m of models) d.addOption(m.id, `${m.name} (${m.id})`);
						if (!models.some((m) => m.id === s.model) && models[0]) s.model = models[0].id;
						d.setValue(s.model).onChange(async (v) => {
							s.model = v;
							await save();
						});
					});
					await save();
				} catch (e) {
					new Notice(`Could not list models: ${(e as Error).message}`);
				}
			}),
		);

		new Setting(containerEl).setName("Max output tokens").addText((t) =>
			t.setValue(String(s.maxTokens)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 1024) {
					s.maxTokens = Math.round(n);
					await save();
				}
			}),
		);
	}
}

class VaultFolderModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly onPick: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a vault folder");
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllFolders(false)
			.filter((folder) => !folder.path.split("/").some((part) => part.startsWith(".")))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onPick(folder);
	}
}
