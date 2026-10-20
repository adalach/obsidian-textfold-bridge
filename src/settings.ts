// Settings: where TextFold is, and where a textfold:// link opens.
import { App, PluginSettingTab, Setting, SettingDefinitionItem, debounce } from "obsidian";
import type TextFoldBridgePlugin from "./main";
import { DEFAULT_URL, Resolved, loopbackUrl } from "./server";

export interface BridgeSettings {
	addressMode: "auto" | "manual"; // auto: server.json in TextFold's data folder, else DEFAULT_URL
	manualUrl: string;
	openIn: "browser" | "app"; // browser: the reader page on the running server; app: textfold:// for TextFold to open
}

export const DEFAULT_SETTINGS: BridgeSettings = {
	addressMode: "auto",
	manualUrl: DEFAULT_URL,
	openIn: "browser",
};

/** The connection in one plain sentence. */
export function describeConnection(r: Resolved | null): string {
	if (!r) return "Not checked yet.";
	const from = r.source === "server.json" ? "found through server.json" : r.source === "manual" ? "set by hand" : "the default address";
	if (r.reachable) return `Connected to TextFold${r.version ? ` ${r.version}` : ""} at ${r.url} (${from}).`;
	return `TextFold is not reachable at ${r.url} (${from}${r.note ? `; ${r.note}` : ""}).`;
}

export class BridgeSettingTab extends PluginSettingTab {
	// a changed address is checked once typing pauses
	private recheck = debounce(() => void this.plugin.client.check(), 600, true);

	constructor(app: App, private plugin: TextFoldBridgePlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<keyof BridgeSettings>[] {
		const s = () => this.plugin.settings;
		return [
			{
				name: "TextFold address",
				desc: "Automatic reads the server.json that TextFold writes into its data folder, and tries http://127.0.0.1:3017 when there is none.",
				control: { type: "dropdown", key: "addressMode", defaultValue: DEFAULT_SETTINGS.addressMode, options: { auto: "Automatic", manual: "Manual" } },
			},
			{
				name: "Manual address",
				desc: "TextFold's address on this computer, such as http://127.0.0.1:3017.",
				visible: () => s().addressMode === "manual",
				control: {
					type: "text",
					key: "manualUrl",
					defaultValue: DEFAULT_SETTINGS.manualUrl,
					placeholder: DEFAULT_URL,
					validate: (v: string) => (loopbackUrl(v) ? undefined : "Use an address on 127.0.0.1 with a port, such as http://127.0.0.1:3017."),
				},
			},
			{
				name: "Connection",
				render: (setting: Setting) => {
					const show = (r: Resolved | null) => {
						setting.setDesc(describeConnection(r));
					};
					show(this.plugin.client.state);
					if (!this.plugin.client.state) void this.plugin.client.check();
					setting.addButton(b => b.setButtonText("Test connection").onClick(() => {
						b.setDisabled(true);
						setting.setDesc("Checking…");
						void this.plugin.client.check().finally(() => b.setDisabled(false));
					}));
					return this.plugin.client.onChange(show);
				},
			},
			{
				name: "Open links in",
				desc: "Browser opens the paper on TextFold's reader page. TextFold app needs a TextFold that opens textfold:// links.",
				control: { type: "dropdown", key: "openIn", defaultValue: DEFAULT_SETTINGS.openIn, options: { browser: "Browser", app: "TextFold app" } },
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof BridgeSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "addressMode") s.addressMode = value === "manual" ? "manual" : "auto";
		else if (key === "manualUrl") s.manualUrl = typeof value === "string" ? (loopbackUrl(value) ?? value) : s.manualUrl;
		else if (key === "openIn") s.openIn = value === "app" ? "app" : "browser";
		await this.plugin.saveSettings();
		if (key === "addressMode") this.update();
		if (key !== "openIn") {
			this.plugin.client.reset();
			this.recheck();
		}
	}
}
