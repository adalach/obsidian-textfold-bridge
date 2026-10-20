// TextFold Bridge: wiring only. TextFold keeps the papers and everything written on them; Obsidian keeps
// textfold:// links in notes, a sidebar with TextFold's notes for the open note, and a picker that inserts a link.
import { Plugin } from "obsidian";
import { TextFoldClient } from "./client";
import { LinkOpener } from "./opener";
import { insertPaperLink } from "./picker";
import { BridgeSettingTab, BridgeSettings, DEFAULT_SETTINGS } from "./settings";
import { TextFoldNotesView, VIEW_TYPE } from "./view";

export default class TextFoldBridgePlugin extends Plugin {
	settings: BridgeSettings = { ...DEFAULT_SETTINGS };
	client!: TextFoldClient;
	opener!: LinkOpener;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.client = new TextFoldClient(() => ({ mode: this.settings.addressMode, manualUrl: this.settings.manualUrl }));
		this.opener = new LinkOpener(this.client, () => this.settings.openIn);
		this.opener.install(this);

		this.registerView(VIEW_TYPE, leaf => new TextFoldNotesView(leaf, this));
		this.addSettingTab(new BridgeSettingTab(this.app, this));

		this.addCommand({
			id: "insert-paper-link",
			name: "Insert link to a TextFold paper",
			editorCallback: editor => void insertPaperLink(this.app, this.client, editor),
		});
		this.addCommand({
			id: "open-notes-view",
			name: "Open TextFold notes",
			callback: () => void this.openView(),
		});
	}

	/** The sidebar in the right leaf, revealed; one only. */
	async openView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE, active: true });
			leaf = right;
		}
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<BridgeSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
