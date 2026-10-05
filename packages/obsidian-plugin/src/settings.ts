import { App, FuzzySuggestModal, PluginSettingTab, Setting, TFolder } from "obsidian";
import { cleanFolderList, DEFAULT_READ_FOLDERS, DEFAULT_WRITE_FOLDERS, type FolderAccess } from "@groundwork/core";
import { BUILD } from "./build";
import type GroundworkPlugin from "./main";

export type ProviderId = "claude-code" | "demo";

/** The public Groundwork website. Account, sign-in, and tutor memory live here. */
export const GROUNDWORK_SITE = "https://groundwork-6f9ca.web.app";

/** Public Firebase web key, same value the website already ships. */
export const GROUNDWORK_WEB_API_KEY = "AIzaSyCsQcpNESDt2wD72gyvjxBO_fXk0T5q0Dw";

export function accountOrigin(): string {
	const override = process.env.GROUNDWORK_API_URL?.trim();
	return (override || GROUNDWORK_SITE).replace(/\/+$/, "");
}

/** Website sign-in. The plugin opens this when the tutor is used while signed out. */
export function accountSignInUrl(): string {
	return `${accountOrigin()}/#signin`;
}

export function accountOriginIsLocal(): boolean {
	try {
		const host = new URL(accountOrigin()).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	} catch {
		return false;
	}
}

export interface GroundworkSettings {
	provider: ProviderId;
	/** Path to Claude Code's `claude` executable; empty means auto-detect. */
	claudePath: string;
	/** Claude Code model alias or id; empty means Claude Code's default. */
	claudeModel: string;
	model: string;
	maxTokens: number;
	deviceName: string;
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
	deviceName: "",
	readFolders: [],
	writeFolders: [],
};

export function folderAccessFrom(settings: GroundworkSettings): FolderAccess {
	return {
		readFolders: cleanFolderList(settings.readFolders ?? DEFAULT_READ_FOLDERS),
		writeFolders: cleanFolderList(settings.writeFolders ?? DEFAULT_WRITE_FOLDERS),
	};
}

/** Refresh token from the website sign-in. Local to this device, never written into the vault. */
const ACCOUNT_TOKEN_STORAGE = "groundwork-account-token";
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

		new Setting(containerEl)
			.setName("Groundwork")
			.setDesc("Vault folders, the tutor, and appearance are in the Groundwork panel.");
		new Setting(containerEl)
			.setName("Open the panel")
			.setDesc("Change those settings there.")
			.addButton((b) => b.setButtonText("Open Groundwork").setCta().onClick(() => void this.plugin.openGroundworkSettings()));

		new Setting(containerEl)
			.setName("Website")
			.setDesc("Sign in, plans, and billing are on the Groundwork website. Tutor memory is stored with that account.");
		new Setting(containerEl).addButton((b) => b.setButtonText("Open website").setCta().onClick(() => window.open(accountOrigin())));

		const version = new Setting(containerEl).setName("Running build").setDesc(BUILD);
		void this.plugin.installedBuild().then((onDisk) => {
			if (!onDisk || onDisk === BUILD) return;
			version.setDesc(`${BUILD}. A newer build is installed: ${onDisk}.`);
			version.addButton((b) => b.setButtonText("Reload Groundwork").setCta().onClick(() => void this.plugin.reloadSelf()));
		});
	}
}

export class VaultFolderModal extends FuzzySuggestModal<TFolder> {
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
