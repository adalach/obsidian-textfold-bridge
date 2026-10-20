// TextFold Bridge: wiring only. TextFold keeps the papers and everything written on them; Obsidian keeps
// textfold:// links in notes (with hover previews), a sidebar with TextFold's notes for the open note, a picker that
// inserts a link, items dragged in from TextFold, "Fold this note" to read a note in TextFold, and "Import notes" to
// bring TextFold's notes into the vault.
import { Notice, Plugin, TFile, addIcon } from "obsidian";
import { TextFoldClient } from "./client";
import { Drops } from "./drop";
import { FoldRecord, Folds } from "./fold";
import { LinkPreviews } from "./hover";
import { ICON, ICON_SVG } from "./icon";
import { installIconLinks } from "./iconLinks";
import { flashField } from "./jump";
import { ImportPicker, Importer } from "./importer";
import { LinkOpener, listenDocuments } from "./opener";
import { insertPaperLink } from "./picker";
import { BridgeSettingTab, BridgeSettings, DEFAULT_SETTINGS } from "./settings";
import { TextFoldNotesView, VIEW_TYPE } from "./view";

interface StoredData extends Partial<BridgeSettings> {
	folds?: Record<string, FoldRecord>;
}

export default class TextFoldBridgePlugin extends Plugin {
	settings: BridgeSettings = { ...DEFAULT_SETTINGS };
	folded: Record<string, FoldRecord> = {}; // by document id: what each folded note sent
	client!: TextFoldClient;
	opener!: LinkOpener;
	previews!: LinkPreviews;
	folds!: Folds;
	importer!: Importer;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(ICON, ICON_SVG);
		this.client = new TextFoldClient(() => ({ mode: this.settings.addressMode, manualUrl: this.settings.manualUrl, folder: this.settings.sourceFolder }));
		this.opener = new LinkOpener(this.client, () => this.settings.openIn);
		this.opener.install(this);
		this.previews = new LinkPreviews(this, this.client, () => this.settings.hoverPreviews);
		this.previews.install(fn => listenDocuments(this, fn));
		this.folds = new Folds(this.app, this.client, () => this.folded, () => this.saveSettings(), () => this.settings.foldLang);
		this.register(() => this.folds.stop());
		new Drops(this, this.client, () => this.settings.dropAs).install();
		installIconLinks(this);
		this.registerEditorExtension(flashField);
		this.importer = new Importer(this.app, this.client, () => ({ folder: this.settings.importFolder, byCitekey: this.settings.importNames === "citekey" }));

		this.registerView(VIEW_TYPE, leaf => new TextFoldNotesView(leaf, this));
		this.addSettingTab(new BridgeSettingTab(this.app, this));

		this.addCommand({
			id: "insert-paper-link",
			icon: ICON,
			name: "Insert link to a TextFold paper",
			editorCallback: editor => void insertPaperLink(this.app, this.client, editor),
		});
		this.addCommand({
			id: "open-notes-view",
			icon: ICON,
			name: "Open TextFold notes",
			callback: () => void this.openView(),
		});
		this.addCommand({
			id: "fold-note",
			icon: ICON,
			name: "Fold this note",
			checkCallback: checking => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.folds.fold(file);
				return true;
			},
		});
		this.addCommand({
			id: "import-notes",
			icon: ICON,
			name: "Import notes from TextFold",
			callback: () => void this.pickImport(),
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

	private async pickImport(): Promise<void> {
		try {
			const papers = await this.client.papers();
			if (!papers.length) {
				new Notice("TextFold has no documents yet.");
				return;
			}
			new ImportPicker(this.app, papers, ids => void this.importer.importPapers(ids)).open();
		} catch (e) {
			new Notice((e as Error).message);
		}
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as StoredData;
		const { folds, ...settings } = data;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.folded = folds ?? {};
	}

	async saveSettings(): Promise<void> {
		const data: StoredData = { ...this.settings, folds: this.folded };
		await this.saveData(data);
	}
}
