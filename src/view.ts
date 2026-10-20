// The sidebar: for the active note, the TextFold documents it refers to (frontmatter `textfold:` and textfold://
// links in its text), each with its highlights, comments and Ask conversations, one line each, under the names of the
// sections they are in; hovering a line shows the whole note, and an answer is rendered with MarkdownRenderer. A note
// folded in TextFold also shows how its fold stands (folding, folded, changed since, failed). Server text never goes in
// as HTML.
import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon, setTooltip } from "obsidian";
import { TextFoldError } from "./client";
import { Doc, DocIndex, sectionName } from "./doc";
import { itemFromLink, setTransfer } from "./drag";
import { FoldRecord, FoldState } from "./fold";
import { lostLine } from "./hover";
import { TextFoldLink, findPaperIds, markdownLink } from "./links";
import { missingPaper } from "./opener";
import type TextFoldBridgePlugin from "./main";
import { Note, NotesFile, citationLinks, noteLine, noteLink } from "./notes";
import { WHOLE, groupNotes } from "./notesMarkdown";
import { describeConnection } from "./settings";

export const VIEW_TYPE = "textfold-notes";

const KIND_ICON = { highlight: "highlighter", note: "sticky-note", ask: "message-circle-question" } as const;
const KIND_NAME = { highlight: "Highlight", note: "Note", ask: "Ask" } as const;
const LEVEL_NAME = { full: "Full", brief: "Brief", key: "Key", takeaway: "Takeaway", topic: "Topic" } as const;

type Item = { id: string; file: NotesFile | null; doc: Doc | null; error?: string };
type Fold = { rec: FoldRecord; state: FoldState };

export class TextFoldNotesView extends ItemView {
	private file: TFile | null = null;
	private ids: string[] = [];
	private items: Item[] = [];
	private reachable = false;
	private fold: Fold | null = null;
	private run = 0;
	private lastRefresh = 0;
	private collapsed = new Set<string>();
	private statusEl!: HTMLElement;
	private listEl!: HTMLElement;
	private card: HoverCard | null = null;
	// the note was edited: ask TextFold again only when its documents changed; a folded note may now differ from its fold
	private onChanged = debounce((file: TFile) => {
		if (file !== this.file) return;
		void this.paperIds(file).then(ids => {
			if (file !== this.file) return;
			if (ids.join("\n") !== this.ids.join("\n")) void this.refresh(false);
			else void this.updateFold();
		});
	}, 800, true);

	constructor(leaf: WorkspaceLeaf, private plugin: TextFoldBridgePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "TextFold notes";
	}

	getIcon(): string {
		return "book-open-text";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tfb-view");
		const bar = root.createDiv("tfb-bar");
		this.statusEl = bar.createDiv("tfb-status");
		const button = (icon: string, tip: string, fn: () => void) => {
			const b = bar.createDiv({ cls: "clickable-icon tfb-icon", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("click", fn);
		};
		button("layers", "Fold this note in TextFold", () => {
			if (this.file) void this.plugin.folds.fold(this.file);
		});
		button("download", "Import the notes of these documents into the vault", () => void this.importAll());
		button("refresh-cw", "Refresh", () => void this.refresh(true));
		this.listEl = root.createDiv("tfb-list");
		this.card = new HoverCard(this);
		this.addChild(this.card);

		this.registerEvent(this.app.workspace.on("file-open", () => void this.refresh(false)));
		this.registerEvent(this.app.metadataCache.on("changed", file => this.onChanged(file)));
		// coming back from TextFold: its notes may have changed
		this.registerDomEvent(window, "focus", () => {
			if (Date.now() - this.lastRefresh > 3000 && this.containerEl.isShown()) void this.refresh(false);
		});
		this.register(this.plugin.folds.onChange(() => {
			const was = this.fold?.state.kind === "folding";
			void this.updateFold().then(() => {
				if (was && this.fold?.state.kind !== "folding") void this.refresh(false); // a fold ended: new levels, notes found again
			});
		}));
		this.register(() => this.onChanged.cancel());
		await this.refresh(true);
	}

	async onClose(): Promise<void> {
		this.run++;
		this.contentEl.empty();
	}

	/** Read the active note's documents again, and their notes from TextFold. `recheck` looks for TextFold anew. */
	async refresh(recheck: boolean): Promise<void> {
		const run = ++this.run;
		this.lastRefresh = Date.now();
		const file = this.app.workspace.getActiveFile();
		this.file = file;
		if (!file || file.extension !== "md") {
			this.ids = [];
			this.items = [];
			this.fold = null;
			this.showStatus(file ? "Open a Markdown note to see its TextFold documents." : "No note is open.");
			this.listEl.empty();
			return;
		}
		const ids = await this.paperIds(file);
		if (run !== this.run) return;
		this.ids = ids;
		if (!ids.length) {
			this.items = [];
			this.fold = null;
			this.showStatus("This note links to no TextFold document.", "Add textfold: <document id> to its properties, insert a link with \"Insert link to a TextFold paper\", or fold the note with the layers button.");
			this.listEl.empty();
			return;
		}
		this.showStatus("Loading…");
		if (recheck) this.plugin.previews.forget();
		const client = this.plugin.client;
		const r = recheck ? await client.check() : await client.server();
		if (run !== this.run) return;
		const items: Item[] = [];
		if (r.reachable) {
			for (const id of ids) {
				try {
					const notes = await client.notes(id);
					const doc = notes ? await client.doc(id).catch(() => null) : null;
					items.push({ id, file: notes, doc });
				} catch (e) {
					items.push({ id, file: null, doc: null, error: e instanceof TextFoldError ? e.message : String(e) });
				}
				if (run !== this.run) return;
			}
			const rec = this.plugin.folds.recordFor(file);
			if (rec) await this.plugin.folds.refreshJobs([rec.paper]).catch(() => undefined);
		}
		if (run !== this.run) return;
		this.reachable = !!client.state?.reachable;
		this.items = this.reachable ? items : ids.map(id => ({ id, file: null, doc: null }));
		await this.updateFold(false);
		if (run !== this.run) return;
		const state = client.state;
		if (!this.reachable) this.showStatus(`TextFold is not reachable at ${state?.url ?? r.url}.`, describeConnection(state));
		else {
			const count = items.reduce((n, d) => n + (d.file?.notes.length ?? 0), 0);
			this.showStatus(`${plural(ids.length, "document")} · ${plural(count, "note")}`, describeConnection(state));
		}
		this.render();
	}

	/** How this note's fold stands, from what is known (no request but the note's own text). */
	private async updateFold(render = true): Promise<void> {
		const file = this.file;
		const rec = file ? this.plugin.folds.recordFor(file) : undefined;
		this.fold = file && rec && this.ids.includes(rec.paper) ? { rec, state: await this.plugin.folds.state(file, rec) } : null;
		if (render && file === this.file) this.render();
	}

	private async paperIds(file: TFile): Promise<string[]> {
		const text = await this.app.vault.cachedRead(file);
		return findPaperIds(text, this.app.metadataCache.getFileCache(file)?.frontmatter?.textfold);
	}

	private showStatus(text: string, tooltip?: string): void {
		this.statusEl.setText(text);
		setTooltip(this.statusEl, tooltip ?? text, { placement: "bottom" });
	}

	private render(): void {
		this.card?.hide();
		const list = this.listEl;
		list.empty();
		const reachable = this.reachable;
		for (const item of this.items) {
			const title = item.doc?.title || item.file?.paper.title || item.id;
			const index = item.doc ? new DocIndex(item.doc) : null;
			const groups = item.file ? groupNotes(item.file.notes, index) : [];
			const count = item.file?.notes.length ?? 0;
			const open = !this.collapsed.has(item.id);
			const row = list.createDiv({ cls: "tfb-row tfb-doc" });
			setIcon(row.createDiv("tfb-chevron"), count ? (open ? "chevron-down" : "chevron-right") : "file-text");
			row.createDiv({ cls: "tfb-text", text: title });
			if (count) row.createDiv({ cls: "tfb-count", text: String(count) });
			const missing = reachable && !item.file;
			if (missing || !reachable) row.addClass("tfb-muted");
			const tip = [title !== item.id ? `${title}\n${item.id}` : item.id];
			if (missing) tip.push(item.error ?? missingPaper(item.id));
			setTooltip(row, tip.join("\n"), { placement: "left" });
			this.actions(row, { paper: item.id }, title, item.file ? item.id : undefined, missing ? missingPaper(item.id) : undefined);
			if (item.file) this.draggable(row, item, { paper: item.id });
			row.addEventListener("click", () => {
				if (!count) return;
				if (open) this.collapsed.add(item.id);
				else this.collapsed.delete(item.id);
				this.render();
			});
			if (this.fold?.rec.paper === item.id && reachable) this.foldRow(list, this.fold, item.doc);
			if (!open) continue;
			for (const g of groups) {
				if (g.name && (groups.length > 1 || g.name !== WHOLE)) list.createDiv({ cls: "tfb-section", text: g.name });
				for (const note of g.notes) this.noteRow(list, item, note, index);
			}
		}
	}

	private noteRow(list: HTMLElement, item: Item, note: Note, index: DocIndex | null): void {
		const line = noteLine(note) || KIND_NAME[note.kind];
		const row = list.createDiv({ cls: `tfb-row tfb-item tfb-is-${note.kind}` });
		setIcon(row.createDiv("tfb-kind"), KIND_ICON[note.kind]);
		row.createDiv({ cls: "tfb-text", text: line });
		if (note.lost) {
			row.addClass("tfb-lost");
			const mark = row.createDiv({ cls: "tfb-lost-icon", attr: { "aria-label": "Passage not found after the edit" } });
			setIcon(mark, "alert-triangle");
		}
		const link = noteLink(item.id, note);
		this.actions(row, link, line);
		this.draggable(row, item, link);
		row.addEventListener("click", () => void this.plugin.opener.open(link));
		const s = index?.sectionOf(note.unit, note.section);
		const section = note.on === "paper" ? WHOLE : s ? sectionName(s) : "";
		this.card?.attach(row, () => ({ note, paper: item.id, section, sourcePath: this.file?.path ?? "" }));
	}

	/** The fold of this note: under way, failed, changed since, or done; with Refold or Open as fits. */
	private foldRow(list: HTMLElement, fold: Fold, doc: Doc | null): void {
		const row = list.createDiv({ cls: "tfb-row tfb-item tfb-fold" });
		const icon = row.createDiv("tfb-kind");
		const text = row.createDiv("tfb-text");
		const st = fold.state;
		const refold = () => {
			if (this.file) void this.plugin.folds.fold(this.file);
		};
		let action: [string, () => void] | null = null;
		if (st.kind === "folding") {
			setIcon(icon, "hourglass");
			const j = st.job;
			text.setText(`Folding${j ? ` · ${j.status === "queued" ? "waiting" : j.stage}${j.total ? ` ${j.done}/${j.total}` : ""}` : ""}…`);
		} else if (st.kind === "failed") {
			setIcon(icon, "alert-triangle");
			text.setText(`Folding failed: ${st.error}`);
			action = ["Refold", refold];
		} else if (st.kind === "changed") {
			setIcon(icon, "pencil");
			text.setText("Changed since folding");
			action = ["Refold", refold];
		} else if (doc?.local) { // stored, but no model wrote its levels: it reads as written
			setIcon(icon, "alert-triangle");
			text.setText("In TextFold without levels: no model was connected");
			action = ["Refold", refold];
		} else {
			setIcon(icon, "check");
			text.setText(`Folded ${fold.rec.at.slice(0, 10)} · ${fold.rec.lang}`);
			action = ["Open in TextFold", () => void this.plugin.opener.open({ paper: fold.rec.paper, lang: fold.rec.lang })];
		}
		setTooltip(row, `${text.getText()}\n${fold.rec.paper}`, { placement: "left" });
		if (action) {
			const [label, fn] = action;
			const b = row.createEl("button", { cls: "tfb-button", text: label });
			b.addEventListener("click", e => {
				e.stopPropagation();
				fn();
			});
		}
	}

	/** A row dragged into a note goes in as a dropped TextFold item does (drop.ts), with the same data. */
	private draggable(row: HTMLElement, item: Item, link: TextFoldLink): void {
		row.draggable = true;
		row.addEventListener("dragstart", e => {
			if (!e.dataTransfer) return;
			this.card?.hide();
			setTransfer(e.dataTransfer, itemFromLink(link, item.doc, item.file));
			e.dataTransfer.effectAllowed = "copy";
		});
	}

	/** Open in TextFold, Copy link, Insert link at the cursor, and for a document Import: icons at the row's right
	 *  edge, shown on hover. For a document the running TextFold does not have, Open says so instead. */
	private actions(row: HTMLElement, link: TextFoldLink, label: string, importId?: string, missing?: string): void {
		const box = row.createDiv("tfb-actions");
		const add = (icon: string, tip: string, fn: () => void) => {
			const b = box.createDiv({ cls: "clickable-icon tfb-icon", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("click", e => {
				e.stopPropagation();
				fn();
			});
		};
		if (missing) add("external-link", missing, () => new Notice(missing, 8000));
		else add("external-link", "Open in TextFold", () => void this.plugin.opener.open(link));
		add("copy", "Copy link", () => void this.copy(markdownLink(label, link)));
		add("text-cursor-input", "Insert link at the cursor", () => this.insert(markdownLink(truncate(label, 80), link)));
		if (importId) add("download", "Import its notes into the vault", () => void this.plugin.importer.importPapers([importId]));
	}

	private async importAll(): Promise<void> {
		const ids = this.items.filter(i => i.file).map(i => i.id);
		if (!ids.length) {
			new Notice(this.reachable ? "No TextFold document is listed." : "TextFold is not reachable.");
			return;
		}
		await this.plugin.importer.importPapers(ids);
	}

	private async copy(text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		new Notice("Link copied.");
	}

	private insert(text: string): void {
		const view = this.editorFor(this.file);
		if (!view) {
			new Notice("Open the note in the editor to insert a link.");
			return;
		}
		view.editor.replaceSelection(text);
	}

	/** The open editor of this note: the one used last, if it shows the note, else any that does. */
	private editorFor(file: TFile | null): MarkdownView | null {
		if (!file) return null;
		const views = this.app.workspace.getLeavesOfType("markdown")
			.map(l => l.view)
			.filter((v): v is MarkdownView => v instanceof MarkdownView && v.file === file && v.getMode() === "source");
		const recent = this.app.workspace.getMostRecentLeaf()?.view;
		return views.find(v => v === recent) ?? views[0] ?? null;
	}
}

type CardData = { note: Note; paper: string; section: string; sourcePath: string };

/** The whole note beside the sidebar while a row is hovered: passage, the reader's text, the conversation. */
class HoverCard extends Component {
	private el: HTMLElement | null = null;
	private content = new Component();
	private timer = 0;

	constructor(private view: ItemView) {
		super();
	}

	onunload(): void {
		this.hide();
	}

	attach(row: HTMLElement, data: () => CardData): void {
		row.addEventListener("mouseenter", () => {
			window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => void this.show(row, data()), 350);
		});
		row.addEventListener("mouseleave", () => this.hideSoon());
	}

	private hideSoon(): void {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.hide(), 250);
	}

	hide(): void {
		window.clearTimeout(this.timer);
		this.content.unload();
		this.el?.remove();
		this.el = null;
	}

	private async show(row: HTMLElement, { note, paper, section, sourcePath }: CardData): Promise<void> {
		this.hide();
		if (!row.isConnected) return;
		const doc = row.ownerDocument;
		const card = doc.body.createDiv("tfb-card");
		this.el = card;
		card.addEventListener("mouseenter", () => window.clearTimeout(this.timer));
		card.addEventListener("mouseleave", () => this.hideSoon());
		this.content = new Component();
		this.content.load();

		const meta: string[] = [KIND_NAME[note.kind]];
		if (section) meta.push(section);
		if (note.level) meta.push(LEVEL_NAME[note.level]);
		if (note.lang) meta.push(note.lang);
		if (note.updated) meta.push(note.updated.slice(0, 10));
		card.createDiv({ cls: "tfb-card-meta", text: meta.join(" · ") });
		if (note.lost) lostLine(card);
		if (note.quote) card.createDiv({ cls: "tfb-card-quote", text: note.quote });
		if (note.text) card.createDiv({ cls: "tfb-card-text", text: note.text });
		for (const turn of note.thread) {
			if (turn.q) card.createDiv({ cls: "tfb-card-q", text: turn.q });
			const a = card.createDiv("tfb-card-a markdown-rendered");
			if (turn.a) await MarkdownRenderer.render(this.view.app, citationLinks(turn.a, paper), a, sourcePath, this.content);
			else a.setText(turn.error ? `No answer: ${turn.error}` : turn.pending ? "Answering…" : "No answer.");
			if (this.el !== card) return; // hidden while rendering
		}
		place(card, row);
	}
}

/** To the left of the row when there is room (the sidebar is on the right), else under it; inside the window. */
function place(card: HTMLElement, row: HTMLElement): void {
	const win = row.ownerDocument.defaultView ?? window;
	const r = row.getBoundingClientRect();
	const w = card.offsetWidth;
	const h = card.offsetHeight;
	let left = r.left - w - 6;
	let top = r.top;
	if (left < 8) {
		left = Math.max(8, Math.min(r.left, win.innerWidth - w - 8));
		top = r.bottom + 4;
	}
	top = Math.max(8, Math.min(top, win.innerHeight - h - 8));
	card.setCssProps({ "--tfb-left": `${left}px`, "--tfb-top": `${top}px` });
	card.addClass("is-placed");
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
