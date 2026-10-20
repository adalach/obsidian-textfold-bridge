// TextFold Bridge: wiring only. TextFold keeps the papers and everything written on them; Obsidian keeps
// textfold:// links in notes (with hover previews), a sidebar with TextFold's notes for the open note, a picker that
// inserts a link, items dragged in from TextFold, "Fold this note" to read a note in TextFold, and "Import notes" to
// bring TextFold's notes into the vault.
import { MarkdownView, Notice, Plugin, TFile, addIcon } from "obsidian";
import { TextFoldClient } from "./client";
import { Drops } from "./drop";
import { FOLD_VIEW, FoldView } from "./fold/view";
import { Lang, foldLanguage } from "./langs";
import { FoldRecord, Folds } from "./fold";
import { LinkPreviews } from "./hover";
import { ICON, ICON_SVG } from "./icon";
import { installIconLinks } from "./iconLinks";
import { flashField } from "./jump";
import { ImportPicker, Importer } from "./importer";
import { LinkOpener, listenDocuments } from "./opener";
import { insertPaperLink } from "./picker";
import { BridgeSettingTab, BridgeSettings, DEFAULT_SETTINGS } from "./settings";
import { migrateSettings } from "./stored";
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
	langs: Lang[] | null = null; // TextFold's list (GET /api/langs), once it gave one

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(ICON, ICON_SVG);
		this.client = new TextFoldClient(() => ({ mode: this.settings.addressMode, manualUrl: this.settings.manualUrl, folder: this.settings.sourceFolder }));
		this.opener = new LinkOpener(this.client, () => this.settings.openIn);
		this.opener.install(this);
		this.previews = new LinkPreviews(this, this.client, () => this.settings.hoverPreviews);
		this.previews.install(fn => listenDocuments(this, fn));
		this.folds = new Folds(this.app, this.client, () => this.folded, () => this.saveSettings(), () => this.foldLanguage());
		this.folds.onFolded = (rec, exported) => this.folded_(rec, exported);
		this.register(() => this.folds.stop());
		new Drops(this, this.client, () => this.settings.dropAs).install();
		installIconLinks(this);
		this.registerEditorExtension(flashField);
		this.importer = new Importer(this.app, this.client, () => ({ location: this.settings.importLocation, folder: this.settings.importFolder, byCitekey: this.settings.importNames === "citekey" }));

		this.registerView(VIEW_TYPE, leaf => new TextFoldNotesView(leaf, this));
		this.registerView(FOLD_VIEW, leaf => new FoldView(leaf, this));
		this.app.workspace.onLayoutReady(() => void this.learnLanguages());
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
				if (!checking) void this.openFold(file);
				return true;
			},
		});
		this.addCommand({
			id: "export-note",
			icon: ICON,
			name: "Export this note to TextFold",
			checkCallback: checking => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.folds.fold(file, { exported: true });
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

	/** The language to fold and export in: the setting's, or TextFold's own (else English). */
	foldLanguage(): string {
		return foldLanguage(this.settings.language, this.client.readerLang);
	}

	/** Ask TextFold which languages it reads in, and the reader's own. */
	private async learnLanguages(): Promise<void> {
		try {
			this.langs = (await this.client.langs()) ?? this.langs;
			await this.client.readerLanguage();
		} catch {
			// TextFold not running, or older: its list from langs.py, and English
		}
	}

	/** "Fold this note": the note in the fold view, in its own tab (the one that shows it, else a new one). */
	async openFold(file: TFile): Promise<void> {
		const { workspace } = this.app;
		const recent = workspace.getMostRecentLeaf();
		const showing = recent?.view instanceof MarkdownView && recent.view.file === file ? recent : workspace.getLeavesOfType("markdown").find(l => l.view instanceof MarkdownView && l.view.file === file);
		const leaf = showing ?? workspace.getLeaf("tab");
		await leaf.setViewState({ type: FOLD_VIEW, state: { file: file.path, level: this.settings.foldStart }, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** A fold ended: after "Export this note", offer the next step; a fold view updates itself. */
	private folded_(rec: { paper: string; path: string; lang: string }, exported: boolean): void {
		if (!exported) return;
		const file = this.app.vault.getAbstractFileByPath(rec.path);
		const frag = createFragment(f => {
			f.createDiv({ text: "TextFold has folded the note." });
			const row = f.createDiv("tfb-notice-actions");
			const open = row.createEl("button", { text: "Open in TextFold" });
			open.addEventListener("click", () => void this.opener.open({ paper: rec.paper, lang: rec.lang }));
			if (file instanceof TFile) {
				const fold = row.createEl("button", { text: "Fold in Obsidian" });
				fold.addEventListener("click", () => void this.openFold(file));
			}
		});
		new Notice(frag, 15_000);
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
		const { folds, ...settings } = migrateSettings(data as Record<string, unknown>) as StoredData;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.folded = folds ?? {};
	}

	async saveSettings(): Promise<void> {
		const data: StoredData = { ...this.settings, folds: this.folded };
		await this.saveData(data);
	}
}
