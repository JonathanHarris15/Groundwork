import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { listAnthropicModels } from "@groundwork/core";
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
};

/** The API key lives in this device's local storage, never in the vault, so it is never pushed to GitHub. */
const KEY_STORAGE = "groundwork-anthropic-key";
const JEV_KEY_STORAGE = "groundwork-typesafe-key";

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
				"Optional. Jev matches a question or a course-file idea to a concept already in the vault, checks whether a prerequisite link is direct, grades the understanding in a written answer, and picks among ready next steps. Mastery numbers and the map stay in the vault. The key stays on this device.",
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

		new Setting(containerEl).setName("About").setHeading();

		const version = new Setting(containerEl).setName("Running build").setDesc(BUILD);
		void this.plugin.installedBuild().then((onDisk) => {
			if (!onDisk || onDisk === BUILD) return;
			version.setDesc(`${BUILD}. A newer build is installed: ${onDisk}.`);
			version.addButton((b) => b.setButtonText("Reload Groundwork").setCta().onClick(() => void this.plugin.reloadSelf()));
		});
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
