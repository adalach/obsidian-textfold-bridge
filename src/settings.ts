// Settings: where TextFold is, where a textfold:// link opens, its hover previews, the language a note is folded in,
// and where imported notes go.
import { App, PluginSettingTab, Setting, SettingDefinitionItem, debounce } from "obsidian";
import type { DropMode } from "./drag";
import { FOLD_LEVELS, LEVEL_LABEL } from "./fold/align";
import { languageOptions } from "./langs";
import type { Level } from "./links";
import type { ImportLocation } from "./notesMarkdown";
import type TextFoldBridgePlugin from "./main";
import { DEFAULT_URL, Resolved, loopbackUrl } from "./server";

export interface BridgeSettings {
	addressMode: "auto" | "manual"; // auto: server.json in TextFold's data folder, else DEFAULT_URL
	manualUrl: string;
	sourceFolder: string; // a clone of TextFold, whose server writes server.json there; also looked in by Automatic
	openIn: "browser" | "app"; // browser: the reader page on the running server; app: textfold:// for TextFold to open
	hoverPreviews: boolean;
	dropAs: DropMode; // what a TextFold item dropped or pasted into a note becomes
	language: string; // "textfold" (TextFold's own) or a language code: what a note is folded and exported in
	foldControl: "buttons" | "slider"; // the fold view's level control
	foldComments: "margin" | "inline"; // TextFold's comments in the fold view: in the margin, or under their paragraph
	foldStart: Level; // the level a fold view opens at
	importLocation: ImportLocation; // where a new imported note goes
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
	language: "textfold",
	foldControl: "buttons",
	foldComments: "margin",
	foldStart: "full",
	importLocation: "folder",
	importFolder: "TextFold",
	importNames: "title",
	sidebarTab: "note",
	citationsGroup: "heading",
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
						desc: "The language a note is folded and exported in. Another language is translated by the model set up in TextFold.",
						control: { type: "dropdown", key: "language", defaultValue: DEFAULT_SETTINGS.language, options: languageOptions(this.plugin.langs) },
					},
					{
						name: "Level control",
						desc: "Buttons for the five levels, or a slider that moves the words as you drag it.",
						control: { type: "dropdown", key: "foldControl", defaultValue: DEFAULT_SETTINGS.foldControl, options: { buttons: "Buttons", slider: "Slider" } },
					},
					{
						name: "TextFold comments",
						desc: "Your highlights, notes and questions from TextFold beside their paragraph, or under it. Highlights are marked in the text either way.",
						control: { type: "dropdown", key: "foldComments", defaultValue: DEFAULT_SETTINGS.foldComments, options: { margin: "In the margin", inline: "Under the paragraph" } },
					},
					{
						name: "Start level",
						desc: "The level a folded note opens at.",
						control: { type: "dropdown", key: "foldStart", defaultValue: DEFAULT_SETTINGS.foldStart, options: Object.fromEntries(FOLD_LEVELS.map(l => [l, LEVEL_LABEL[l]])) },
					},
				],
			},
			{
				type: "group",
				heading: "Import notes",
				items: [
					{
						name: "Location for imported notes",
						desc: "Where a new imported note goes, one per TextFold document. A note imported before is updated where it is.",
						control: {
							type: "dropdown",
							key: "importLocation",
							defaultValue: DEFAULT_SETTINGS.importLocation,
							options: { folder: "In the folder specified below", current: "Same folder as current note", root: "Vault folder" },
						},
					},
					{
						name: "Folder",
						desc: "The folder for imported notes.",
						visible: () => s().importLocation === "folder",
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
		else if (key === "language") s.language = text || DEFAULT_SETTINGS.language;
		else if (key === "foldControl") s.foldControl = value === "slider" ? "slider" : "buttons";
		else if (key === "foldComments") s.foldComments = value === "inline" ? "inline" : "margin";
		else if (key === "foldStart") s.foldStart = (FOLD_LEVELS as string[]).includes(text) ? (text as Level) : "full";
		else if (key === "importLocation") s.importLocation = value === "current" || value === "root" ? value : "folder";
		else if (key === "importFolder") s.importFolder = text || DEFAULT_SETTINGS.importFolder;
		else if (key === "importNames") s.importNames = value === "citekey" ? "citekey" : "title";
		await this.plugin.saveSettings();
		if (key === "addressMode" || key === "importLocation") this.update();
		if (key === "addressMode" || key === "manualUrl" || key === "sourceFolder") {
			this.plugin.client.reset();
			this.recheck();
		}
	}
}
