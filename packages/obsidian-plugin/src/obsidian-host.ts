import type { App } from "obsidian";

interface PluginManager {
	disablePlugin(id: string): Promise<void>;
	enablePlugin(id: string): Promise<void>;
}

interface SettingHost {
	close(): void;
}

type GroundworkApp = App & {
	plugins: PluginManager;
	setting?: SettingHost;
};

export function pluginManager(app: App): PluginManager {
	return (app as GroundworkApp).plugins;
}

export function closeSettings(app: App): void {
	(app as GroundworkApp).setting?.close();
}
