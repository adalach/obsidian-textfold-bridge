// Hover previews of textfold:// links: the paragraph (u=) at the link's level or else Takeaway, the note (n=), or the
// document's title and authors. Obsidian's page previews only show vault files, so this uses its HoverPopover (the same
// popover, positioned and dismissed as Obsidian's are) and fills it. As with page previews, a link shows its preview on
// hover in Reading view and with Cmd/Ctrl held in the editor. Documents are cached for the session by the client.
import { EditorView } from "@codemirror/view";
import { Component, HoverParent, HoverPopover, Keymap, MarkdownRenderer, Plugin, setIcon } from "obsidian";
import type { TextFoldClient } from "./client";
import { DocIndex, sectionName, sectionText, unitText } from "./doc";
import { Level, TextFoldLink, parseLink } from "./links";
import { keepOutOfLists } from "./drag";
import { NotesFile, Paper, citationLinks, noteLine } from "./notes";
import { missingPaper } from "./opener";

const WAIT_MS = 300;
const NOTES_MS = 30_000; // a document's notes change as one reads: asked again after this long
const LEVEL_NAME: Record<Level, string> = { full: "Full", brief: "Brief", key: "Key", takeaway: "Takeaway", topic: "Topic" };

// a Markdown link to a textfold:// address on one line, for the editor, where the address is not in the DOM
const MD_LINK = /\[((?:\\.|[^\]\\])*)\]\((textfold:\/\/open\/?\?[^)\s]*)\)/gi;

export class LinkPreviews {
	private alive = new WeakMap<HTMLElement, number>(); // target -> when its popover was made
	private notes = new Map<string, { at: number; file: Promise<NotesFile | null> }>();

	constructor(private plugin: Plugin, private client: TextFoldClient, private enabled: () => boolean) {}

	install(listen: (fn: (doc: Document) => void) => void): void {
		listen(doc => this.plugin.registerDomEvent(doc, "mouseover", e => this.onMouseOver(e)));
		this.plugin.registerEditorExtension(EditorView.domEventHandlers({ mouseover: (e, view) => this.onEditorHover(e, view) }));
	}

	/** Preview this link while the pointer is on an element of the plugin's own (a row of the sidebar's citations). */
	attach(el: HTMLElement, link: TextFoldLink): void {
		el.addEventListener("mouseenter", () => {
			if (this.enabled()) this.show(el, link);
		});
	}

	/** Forget cached notes and titles (refresh, a refold). */
	forget(): void {
		this.notes.clear();
	}

	private onMouseOver(evt: MouseEvent): void {
		if (!this.enabled()) return;
		const a = (evt.target as Element | null)?.closest?.('a[href^="textfold:" i]');
		if (!a || a.closest(".tfb-view, .tfb-card")) return; // the sidebar has its own card
		const link = parseLink(a.getAttribute("href") ?? "");
		if (link) this.show(a as HTMLElement, link);
	}

	private onEditorHover(evt: MouseEvent, view: EditorView): boolean {
		const el = evt.target as Element | null;
		// TextFold's icon (iconLinks.ts) previews on a hover alone, as in Reading view; other links with Cmd/Ctrl held
		const icon = el?.closest?.(".tfb-lp-icon") as HTMLElement | null;
		if (!this.enabled() || (!icon && !Keymap.isModEvent(evt))) return false;
		const target = icon ?? (el?.closest?.(".cm-link, .cm-url") as HTMLElement | null);
		if (!target) return false;
		let pos: number;
		try {
			pos = view.posAtDOM(target);
		} catch {
			return false;
		}
		const line = view.state.doc.lineAt(pos);
		const at = pos - line.from;
		for (const m of line.text.matchAll(MD_LINK)) {
			const from = m.index ?? 0;
			if (at < from || at > from + m[0].length) continue;
			const link = parseLink(m[2]);
			if (link) this.show(target, link);
			break;
		}
		return false;
	}

	private show(target: HTMLElement, link: TextFoldLink): void {
		const made = this.alive.get(target);
		if (made && Date.now() - made < WAIT_MS + 200) return; // one is on its way
		this.alive.set(target, Date.now());
		const parent: HoverParent = { hoverPopover: null };
		const pop = new HoverPopover(parent, target, WAIT_MS);
		pop.hoverEl.addClass("tfb-hover");
		const body = pop.hoverEl.createDiv("tfb-hover-body");
		body.createDiv({ cls: "tfb-hover-meta", text: "TextFold…" });
		void this.fill(body, link, pop).catch((e: Error) => {
			body.empty();
			body.createDiv({ cls: "tfb-hover-meta", text: e.message });
		});
	}

	private async fill(body: HTMLElement, link: TextFoldLink, owner: Component): Promise<void> {
		const r = await this.client.server();
		if (!r.reachable) throw new Error(`TextFold is not reachable at ${r.url}.`);
		const doc = await this.client.doc(link.paper, link.lang).catch(() => null);
		const index = doc ? new DocIndex(doc) : null;
		const known = doc ? undefined : await this.paper(link.paper);
		body.empty();
		if (!doc && !known) {
			body.createDiv({ cls: "tfb-hover-text", text: missingPaper(link.paper) });
			return;
		}
		const title = doc?.title || known?.title || link.paper;
		const meta = body.createDiv("tfb-hover-meta");
		const head = [shortTitle(title)];

		if (link.n) {
			const nf = await this.notesOf(link.paper);
			const note = nf?.notes.find(n => n.id === link.n);
			const s = note && index?.sectionOf(note.unit, note.section);
			if (s) head.push(sectionName(s));
			const turnAt = link.t !== undefined && note?.kind === "ask" ? note.thread[link.t] : undefined;
			if (turnAt) head.push(`turn ${(link.t ?? 0) + 1} of ${note!.thread.length}`);
			meta.setText(head.join(" · "));
			if (!note) {
				body.createDiv({ cls: "tfb-hover-text", text: "This note is no longer in TextFold." });
				return;
			}
			if (turnAt) { // one turn of the conversation: its question and its answer
				body.createDiv({ cls: "tfb-card-q", text: turnAt.q });
				const a = body.createDiv("tfb-hover-text markdown-rendered");
				if (turnAt.a) await MarkdownRenderer.render(this.plugin.app, citationLinks(turnAt.a, link.paper), a, "", owner);
				else a.setText(turnAt.pending ? "Answering…" : "No answer.");
				return;
			}
			if (note.lost) lostLine(body);
			if (note.quote) body.createDiv({ cls: "tfb-card-quote", text: note.quote });
			if (note.text) body.createDiv({ cls: "tfb-card-text", text: note.text });
			const turn = note.kind === "ask" ? note.thread[0] : undefined;
			if (turn) {
				body.createDiv({ cls: "tfb-card-q", text: turn.q });
				if (turn.takeaway) body.createDiv({ cls: "tfb-hover-text", text: `→ ${turn.takeaway}` });
			}
			if (!note.quote && !note.text && !turn) body.createDiv({ cls: "tfb-hover-text", text: noteLine(note) });
			return;
		}

		if (link.s && !link.u) {
			const s = index?.sections.get(link.s);
			const level: Level = link.level ?? "takeaway";
			if (s) head.push(sectionName(s) || "Opening");
			head.push(LEVEL_NAME[level]);
			meta.setText(head.join(" · "));
			if (!s) {
				body.createDiv({ cls: "tfb-hover-text", text: doc ? "This section is not in the document any more." : `Section ${link.s}.` });
				return;
			}
			// its heading, then its summary and paragraphs (its subsections' too) at the level, as a drag of it has them
			const st = index ? sectionText(index, s.id, level) : null;
			if (s.title) body.createDiv({ cls: "tfb-hover-title", text: sectionName(s) });
			const text = body.createDiv("tfb-hover-text markdown-rendered");
			if (st?.text) await MarkdownRenderer.render(this.plugin.app, keepOutOfLists(capBlocks(st.text)).replace(/\[\[/g, "\\[\\["), text, "", owner);
			else text.setText(`${plural(s.units.length, "paragraph")}; no summary yet.`);
			return;
		}

		if (link.u) {
			// a paragraph, or the paragraphs from u to to, at the link's level
			const units = index?.range(link.u, link.to) ?? [];
			const s = index?.sectionOf(link.u);
			if (s) head.push(sectionName(s));
			if (units.length > 1) head.push(plural(units.length, "paragraph"));
			const level: Level = link.level ?? "takeaway";
			head.push(LEVEL_NAME[level]);
			meta.setText(head.join(" · "));
			if (!units.length) {
				body.createDiv({ cls: "tfb-hover-text", text: doc ? "This paragraph is not in the document any more." : `Paragraph ${link.u}.` });
				return;
			}
			const text = body.createDiv("tfb-hover-text markdown-rendered");
			const md = capBlocks(units.map(u => unitText(u, level)).join("\n\n"));
			await MarkdownRenderer.render(this.plugin.app, md.replace(/\[\[/g, "\\[\\["), text, "", owner);
			return;
		}

		// the document itself: what it is
		meta.setText("TextFold");
		body.createDiv({ cls: "tfb-hover-title", text: title });
		const authors = doc?.authors ?? (await this.paper(link.paper))?.authors ?? [];
		const by = [authors.slice(0, 4).join("; ") + (authors.length > 4 ? " et al." : ""), doc?.date, doc?.source.label].filter(Boolean).join(" · ");
		if (by) body.createDiv({ cls: "tfb-hover-text", text: by });
		const nf = await this.notesOf(link.paper);
		if (nf?.notes.length) body.createDiv({ cls: "tfb-hover-meta", text: `${nf.notes.length} note${nf.notes.length === 1 ? "" : "s"} in TextFold` });
	}

	private notesOf(paper: string): Promise<NotesFile | null> {
		const hit = this.notes.get(paper);
		if (hit && Date.now() - hit.at < NOTES_MS) return hit.file;
		const file = this.client.notes(paper);
		this.notes.set(paper, { at: Date.now(), file });
		file.catch(() => this.notes.delete(paper));
		return file;
	}

	private async paper(id: string): Promise<Paper | undefined> {
		return this.client.paperInfo(id).catch(() => undefined);
	}
}

export function lostLine(el: HTMLElement): void {
	const line = el.createDiv("tfb-lost-line");
	setIcon(line.createSpan("tfb-lost-icon"), "alert-triangle");
	line.createSpan({ text: "Passage not found after the edit" });
}

/** At most a dozen blocks of a long section or range, and how many more there are. */
function capBlocks(md: string, max = 12): string {
	const blocks = md.split(/\n{2,}/);
	return blocks.length <= max ? md : `${blocks.slice(0, max).join("\n\n")}\n\n*… ${blocks.length - max} more*`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function shortTitle(title: string): string {
	const short = /^(.{3,}?)\s*[:–—]\s+\S/.exec(title)?.[1] ?? title;
	return short.length > 60 ? `${short.slice(0, 59)}…` : short;
}
