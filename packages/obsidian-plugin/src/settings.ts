import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { listAnthropicModels } from "@groundwork/core";
import type GroundworkPlugin from "./main";

export interface GroundworkSettings {
	provider: "anthropic" | "demo";
	model: string;
	maxTokens: number;
	webSearch: boolean;
	autoSync: boolean;
	syncDelaySeconds: number;
	gitPath: string;
	deviceName: string;
}

export const DEFAULT_SETTINGS: GroundworkSettings = {
	provider: "anthropic",
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

export function loadApiKey(app: App): string {
	return (app.loadLocalStorage(KEY_STORAGE) as string | null) ?? "";
}

export function saveApiKey(app: App, key: string): void {
	app.saveLocalStorage(KEY_STORAGE, key || null);
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
			.setDesc("Anthropic runs the real tutor. Demo plays a scripted lesson so you can try the interface without a key.")
			.addDropdown((d) =>
				d
					.addOption("anthropic", "Anthropic (Claude)")
					.addOption("demo", "Demo (no API key)")
					.setValue(s.provider)
					.onChange(async (v) => {
						s.provider = v as GroundworkSettings["provider"];
						await save();
						this.display();
					}),
			);

		if (s.provider === "anthropic") {
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

			new Setting(containerEl)
				.setName("Web search for fact-checking")
				.setDesc("Lets the tutor verify facts with Anthropic's web search tool. Your organization must have it enabled.")
				.addToggle((t) =>
					t.setValue(s.webSearch).onChange(async (v) => {
						s.webSearch = v;
						await save();
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
	}
}
