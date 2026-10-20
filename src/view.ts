// The sidebar: for the active note, the TextFold documents it refers to (frontmatter `textfold:` and textfold://
// links in its text), each with its highlights, comments and Ask conversations, one line each; hovering a line shows
// the whole note, and an answer is rendered with MarkdownRenderer. Server text never goes in as HTML.
import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon, setTooltip } from "obsidian";
import { TextFoldError } from "./client";
import { TextFoldLink, findPaperIds, markdownLink } from "./links";
import type TextFoldBridgePlugin from "./main";
import { Note, NotesFile, citationLinks, noteLine, noteLink } from "./notes";
import { describeConnection } from "./settings";

export const VIEW_TYPE = "textfold-notes";

const KIND_ICON = { highlight: "highlighter", note: "sticky-note", ask: "message-circle-question" } as const;
const KIND_NAME = { highlight: "Highlight", note: "Note", ask: "Ask" } as const;
const LEVEL_NAME = { full: "Full", brief: "Brief", key: "Key", takeaway: "Takeaway", topic: "Topic" } as const;

type Doc = { id: string; file: NotesFile | null; error?: string };

export class TextFoldNotesView extends ItemView {
	private file: TFile | null = null;
	private ids: string[] = [];
	private run = 0;
	private lastRefresh = 0;
	private collapsed = new Set<string>();
	private statusEl!: HTMLElement;
	private listEl!: HTMLElement;
	private card: HoverCard | null = null;
	// the note was edited: ask TextFold again only when its documents changed
	private onChanged = debounce((file: TFile) => {
		if (file !== this.file) return;
		void this.paperIds(file).then(ids => {
			if (file === this.file && ids.join("\n") !== this.ids.join("\n")) void this.refresh(false);
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
		const refresh = bar.createDiv({ cls: "clickable-icon tfb-icon", attr: { "aria-label": "Refresh" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.refresh(true));
		this.listEl = root.createDiv("tfb-list");
		this.card = new HoverCard(this);
		this.addChild(this.card);

		this.registerEvent(this.app.workspace.on("file-open", () => void this.refresh(false)));
		this.registerEvent(this.app.metadataCache.on("changed", file => this.onChanged(file)));
		// coming back from TextFold: its notes may have changed
		this.registerDomEvent(window, "focus", () => {
			if (Date.now() - this.lastRefresh > 3000 && this.containerEl.isShown()) void this.refresh(false);
		});
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
			this.showStatus(file ? "Open a Markdown note to see its TextFold documents." : "No note is open.");
			this.listEl.empty();
			return;
		}
		const ids = await this.paperIds(file);
		if (run !== this.run) return;
		this.ids = ids;
		if (!ids.length) {
			this.showStatus("This note links to no TextFold document.", "Add textfold: <document id> to its properties, or insert a link with the command \"Insert link to a TextFold paper\".");
			this.listEl.empty();
			return;
		}
		this.showStatus("Loading…");
		const client = this.plugin.client;
		const r = recheck ? await client.check() : await client.server();
		if (run !== this.run) return;
		const docs: Doc[] = [];
		if (r.reachable) {
			for (const id of ids) {
				try {
					docs.push({ id, file: await client.notes(id) });
				} catch (e) {
					docs.push({ id, file: null, error: e instanceof TextFoldError ? e.message : String(e) });
				}
				if (run !== this.run) return;
			}
		}
		const state = client.state;
		if (!state?.reachable) {
			this.showStatus(`TextFold is not reachable at ${state?.url ?? r.url}.`, describeConnection(state));
			this.render(ids.map(id => ({ id, file: null })), false);
			return;
		}
		const count = docs.reduce((n, d) => n + (d.file?.notes.length ?? 0), 0);
		this.showStatus(`${plural(ids.length, "document")} · ${plural(count, "note")}`, describeConnection(state));
		this.render(docs, true);
	}

	private async paperIds(file: TFile): Promise<string[]> {
		const text = await this.app.vault.cachedRead(file);
		return findPaperIds(text, this.app.metadataCache.getFileCache(file)?.frontmatter?.textfold);
	}

	private showStatus(text: string, tooltip?: string): void {
		this.statusEl.setText(text);
		setTooltip(this.statusEl, tooltip ?? text, { placement: "bottom" });
	}

	private render(docs: Doc[], reachable: boolean): void {
		this.card?.hide();
		const list = this.listEl;
		list.empty();
		for (const doc of docs) {
			const title = doc.file?.paper.title ?? doc.id;
			const notes = doc.file ? sortNotes(doc.file.notes) : [];
			const open = !this.collapsed.has(doc.id);
			const row = list.createDiv({ cls: "tfb-row tfb-doc" });
			const chevron = row.createDiv("tfb-chevron");
			setIcon(chevron, notes.length ? (open ? "chevron-down" : "chevron-right") : "file-text");
			row.createDiv({ cls: "tfb-text", text: title });
			if (notes.length) row.createDiv({ cls: "tfb-count", text: String(notes.length) });
			const missing = reachable && !doc.file;
			if (missing || !reachable) row.addClass("tfb-muted");
			const tip = [title !== doc.id ? `${title}\n${doc.id}` : doc.id];
			if (missing) tip.push(doc.error ?? "TextFold has no document with this id.");
			setTooltip(row, tip.join("\n"), { placement: "left" });
			this.actions(row, { paper: doc.id }, title);
			row.addEventListener("click", () => {
				if (!notes.length) return;
				if (open) this.collapsed.add(doc.id);
				else this.collapsed.delete(doc.id);
				this.render(docs, reachable);
			});
			if (!open) continue;
			for (const note of notes) {
				const line = noteLine(note) || KIND_NAME[note.kind];
				const nrow = list.createDiv({ cls: `tfb-row tfb-item tfb-is-${note.kind}` });
				setIcon(nrow.createDiv("tfb-kind"), KIND_ICON[note.kind]);
				nrow.createDiv({ cls: "tfb-text", text: line });
				const link = noteLink(doc.id, note);
				this.actions(nrow, link, line);
				nrow.addEventListener("click", () => void this.plugin.opener.open(link));
				this.card?.attach(nrow, () => ({ note, paper: doc.id, sourcePath: this.file?.path ?? "" }));
			}
		}
	}

	/** Open in TextFold, Copy link, Insert link at the cursor: icons at the row's right edge, shown on hover. */
	private actions(row: HTMLElement, link: TextFoldLink, label: string): void {
		const box = row.createDiv("tfb-actions");
		const add = (icon: string, tip: string, fn: () => void) => {
			const b = box.createDiv({ cls: "clickable-icon tfb-icon", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("click", e => {
				e.stopPropagation();
				fn();
			});
		};
		add("external-link", "Open in TextFold", () => void this.plugin.opener.open(link));
		add("copy", "Copy link", () => void this.copy(markdownLink(label, link)));
		add("text-cursor-input", "Insert link at the cursor", () => this.insert(markdownLink(truncate(label, 80), link)));
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

	attach(row: HTMLElement, data: () => { note: Note; paper: string; sourcePath: string }): void {
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

	private async show(row: HTMLElement, { note, paper, sourcePath }: { note: Note; paper: string; sourcePath: string }): Promise<void> {
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
		if (note.on === "paper") meta.push("the whole paper");
		if (note.level) meta.push(LEVEL_NAME[note.level]);
		if (note.lang) meta.push(note.lang);
		if (note.updated) meta.push(note.updated.slice(0, 10));
		card.createDiv({ cls: "tfb-card-meta", text: meta.join(" · ") });
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

/** Whole-paper conversations first (TextFold lists them first too), then the file's order. */
function sortNotes(notes: Note[]): Note[] {
	return [...notes.filter(n => n.on === "paper"), ...notes.filter(n => n.on !== "paper")];
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
