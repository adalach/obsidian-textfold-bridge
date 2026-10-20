// Settings: where TextFold is, where a textfold:// link opens, its hover previews, the language a note is folded in,
// and where imported notes go.
import { App, PluginSettingTab, Setting, SettingDefinitionItem, debounce } from "obsidian";
import type { DropMode } from "./drag";
import type TextFoldBridgePlugin from "./main";
import { DEFAULT_URL, Resolved, loopbackUrl } from "./server";

export interface BridgeSettings {
	addressMode: "auto" | "manual"; // auto: server.json in TextFold's data folder, else DEFAULT_URL
	manualUrl: string;
	sourceFolder: string; // a clone of TextFold, whose server writes server.json there; also looked in by Automatic
	openIn: "browser" | "app"; // browser: the reader page on the running server; app: textfold:// for TextFold to open
	hoverPreviews: boolean;
	dropAs: DropMode; // what a TextFold item dropped or pasted into a note becomes
	foldLang: string; // the language "Fold this note" folds in
	importFolder: string;
	importNames: "title" | "citekey";
	sidebarTab: "note" | "textfold"; // the sidebar shows the note's citations, or the documents' notes in TextFold
	citationsGroup: "heading" | "paper";
}

export const DEFAULT_SETTINGS: BridgeSettings = {
	addressMode: "auto",
	manualUrl: DEFAULT_URL,
	sourceFolder: "",
	openIn: "browser",
	hoverPreviews: true,
	dropAs: "callout",
	foldLang: "en",
	importFolder: "TextFold",
	importNames: "title",
	sidebarTab: "note",
	citationsGroup: "heading",
};

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

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
				name: "TextFold run from source",
				desc: "A TextFold started from a clone of its repository writes its server.json in the clone's folder. Name that folder to have Automatic look there first.",
				visible: () => s().addressMode === "auto",
				control: { type: "text", key: "sourceFolder", defaultValue: DEFAULT_SETTINGS.sourceFolder, placeholder: "~/textfold" },
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
				type: "group",
				heading: "Links",
				items: [
					{
						name: "Open links in",
						desc: "Browser opens the paper on TextFold's reader page. TextFold app hands the textfold:// link to a packaged TextFold that opens these links.",
						control: { type: "dropdown", key: "openIn", defaultValue: DEFAULT_SETTINGS.openIn, options: { browser: "Browser", app: "TextFold app" } },
					},
					{
						name: "Hover previews",
						desc: "Show a link's paragraph, note or paper on hover in Reading view, and with Cmd or Ctrl held in the editor.",
						control: { type: "toggle", key: "hoverPreviews", defaultValue: DEFAULT_SETTINGS.hoverPreviews },
					},
				],
			},
			{
				type: "group",
				heading: "Drops from TextFold",
				items: [
					{
						name: "Dropped TextFold items as",
						desc: "Callout, Quote and Text end with the TextFold icon linking back; Full link inserts a titled link.",
						// (the stored values stay as they were: "icon" is Text, "link" is Full link)
						control: { type: "dropdown", key: "dropAs", defaultValue: DEFAULT_SETTINGS.dropAs, options: { callout: "Callout", quote: "Quote", icon: "Text", link: "Full link" } },
					},
				],
			},
			{
				type: "group",
				heading: "Fold this note",
				items: [
					{
						name: "Language",
						desc: "The language TextFold folds a note in, as a code such as en, de or zh. Folding uses the model set up in TextFold.",
						control: {
							type: "text",
							key: "foldLang",
							defaultValue: DEFAULT_SETTINGS.foldLang,
							placeholder: "en",
							validate: (v: string) => (LANG.test(v.trim()) ? undefined : "Use a language code such as en, de or zh-Hant."),
						},
					},
				],
			},
			{
				type: "group",
				heading: "Import notes",
				items: [
					{
						name: "Folder",
						desc: "Where imported notes go, one per TextFold document.",
						control: { type: "folder", key: "importFolder", defaultValue: DEFAULT_SETTINGS.importFolder, placeholder: "TextFold" },
					},
					{
						name: "Note names",
						desc: "Name a new note by the document's short title, or by its citekey when TextFold has one.",
						control: { type: "dropdown", key: "importNames", defaultValue: DEFAULT_SETTINGS.importNames, options: { title: "Short title", citekey: "Citekey" } },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof BridgeSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		const text = typeof value === "string" ? value.trim() : "";
		if (key === "addressMode") s.addressMode = value === "manual" ? "manual" : "auto";
		else if (key === "manualUrl") s.manualUrl = loopbackUrl(text) ?? text;
		else if (key === "sourceFolder") s.sourceFolder = text;
		else if (key === "openIn") s.openIn = value === "app" ? "app" : "browser";
		else if (key === "hoverPreviews") s.hoverPreviews = value === true;
		else if (key === "dropAs") s.dropAs = value === "quote" || value === "link" || value === "icon" ? value : "callout";
		else if (key === "foldLang") s.foldLang = text || DEFAULT_SETTINGS.foldLang;
		else if (key === "importFolder") s.importFolder = text || DEFAULT_SETTINGS.importFolder;
		else if (key === "importNames") s.importNames = value === "citekey" ? "citekey" : "title";
		await this.plugin.saveSettings();
		if (key === "addressMode") this.update();
		if (key === "addressMode" || key === "manualUrl" || key === "sourceFolder") {
			this.plugin.client.reset();
			this.recheck();
		}
	}
}
