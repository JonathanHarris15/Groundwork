export function pluginBuildStamp(opts: {
	prod: boolean;
	local: boolean;
	version: string;
	commit: string;
	time: string;
}): string;

/** Copies the fresh plugin build over packages/cli/dist/plugin when that snapshot already exists. */
export function refreshCliPluginSnapshot(pluginDist: string, cliPluginDir: string): boolean;
