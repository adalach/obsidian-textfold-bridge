// Items dragged (or copied) from TextFold into a note: what the data says, and the Markdown a drop inserts. Pure
// functions without runtime imports from obsidian; test/drag.test.ts covers them.
//
// TextFold sends `application/x-textfold+json` (also as JSON in a `data-textfold` attribute of its text/html, for
// programs that drop custom types between apps):
//   {"format": "textfold/drag", "version": 1, "paper", "title", "authors": [..], "citekey"?, "section": {"id", "num",
//    "title"} | null, "kind": "note" | "ask" | "paragraph" | "summary" | "section" | "selection" | "chip", "level",
//    "lang", "text", "written", "quote"?, "comment"?, "link"}
// A plain textfold:// link (text/uri-list or text/plain) is made into an item from the document's JSON instead.
import { Doc, DocIndex, isWritten, sectionName, sectionSummary, unitText } from "./doc";
import { Level, LEVELS, TextFoldLink, buildLink, isPaperId, parseLink } from "./links";
import { NotesFile, noteLine } from "./notes";
import { answerMarkdown } from "./notesMarkdown";

export const DRAG_MIME = "application/x-textfold+json";

export type DropMode = "callout" | "quote" | "link" | "icon";

/** The label of a link the plugin draws as TextFold's icon: `<text> [↗](textfold://…)`. */
export const ICON_LABEL = "↗";

export interface DragItem {
	paper: string;
	title: string;
	authors: string[];
	citekey?: string;
	section: { id: string; num: string; title: string } | null;
	kind: string; // note, ask, paragraph, summary, section, selection, chip; "paper" for a link to the whole document
	level?: Level;
	lang?: string;
	text: string;
	written: boolean; // the text is a model's words
	quote?: string;
	comment?: string;
	link: TextFoldLink;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** An item from TextFold's drag JSON, or null when it is not one. The link is checked and written anew, so a drop
 *  can only ever insert a textfold:// link to the item's own document. */
export function parseDragJson(text: string): DragItem | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	const o = obj(data);
	if (o.format !== "textfold/drag" || o.version !== 1) return null;
	const paper = str(o.paper);
	if (!isPaperId(paper)) return null;
	const parsed = parseLink(str(o.link));
	const link: TextFoldLink = parsed && parsed.paper === paper ? parsed : { paper };
	const s = o.section === null ? null : obj(o.section);
	const level = str(o.level).toLowerCase();
	return {
		paper,
		title: str(o.title) || paper,
		authors: Array.isArray(o.authors) ? o.authors.filter((a): a is string => typeof a === "string") : [],
		citekey: str(o.citekey) || undefined,
		section: s && str(s.id) ? { id: str(s.id), num: str(s.num), title: str(s.title) } : null,
		kind: str(o.kind) || "selection",
		level: (LEVELS as readonly string[]).includes(level) ? (level as Level) : undefined,
		lang: str(o.lang) || undefined,
		text: str(o.text),
		written: o.written === true,
		quote: str(o.quote) || undefined,
		comment: str(o.comment) || undefined,
		link,
	};
}

/** The drag JSON TextFold puts in a `data-textfold` attribute of its HTML, unescaped, or null. */
export function jsonFromHtml(html: string): string | null {
	const m = /\bdata-textfold\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
	return m ? unescapeHtml(m[2] ?? m[3] ?? "") : null;
}

function unescapeHtml(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** A textfold:// link that is all of a text/uri-list (comment lines aside) or a text/plain, or null. */
export function linkFromText(text: string): TextFoldLink | null {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
	return lines.length === 1 ? parseLink(lines[0]) : null;
}

/** What a data transfer holds for TextFold, in order: the drag JSON, the JSON in the HTML, a lone link. */
export function readTransfer(data: { getData(type: string): string }): DragItem | TextFoldLink | null {
	const json = data.getData(DRAG_MIME);
	const fromJson = json ? parseDragJson(json) : null;
	if (fromJson) return fromJson;
	const inHtml = jsonFromHtml(data.getData("text/html") || "");
	const fromHtml = inHtml ? parseDragJson(inHtml) : null;
	if (fromHtml) return fromHtml;
	return linkFromText(data.getData("text/uri-list") || "") ?? linkFromText(data.getData("text/plain") || "");
}

export function isItem(x: DragItem | TextFoldLink): x is DragItem {
	return "kind" in x;
}

/** An item for a plain link, filled in from the document's JSON and notes when TextFold gave them. */
export function itemFromLink(link: TextFoldLink, doc: Doc | null, nf: NotesFile | null, citekey?: string): DragItem {
	const index = doc ? new DocIndex(doc) : null;
	const level = link.level;
	const item: DragItem = {
		paper: link.paper,
		title: doc?.title || nf?.paper.title || link.paper,
		authors: doc?.authors ?? [],
		citekey,
		section: null,
		kind: "paper",
		level,
		lang: link.lang,
		text: "",
		written: false,
		link,
	};
	const section = (s: { id: string; num: string; title: string } | undefined) => (s ? { id: s.id, num: s.num, title: s.title } : null);
	const note = link.n ? nf?.notes.find(n => n.id === link.n) : undefined;
	if (note) {
		item.kind = note.kind === "ask" ? "ask" : "note";
		item.section = section(index?.sectionOf(note.unit, note.section));
		// as TextFold's reader sends them: a note's text is the reader's words (else the passage), an Ask's is the last
		// answer in one sentence, its comment the reader's question
		if (note.quote) item.quote = note.quote;
		if (note.kind === "ask") {
			const said = [...note.thread].reverse().find(t => t.a);
			item.text = said ? said.takeaway || said.a : "";
			item.written = !!said;
			if (note.thread[0]?.q) item.comment = note.thread[0].q;
		} else {
			item.text = note.text.trim() || note.quote || noteLine(note);
			if (note.text.trim()) item.comment = note.text.trim();
		}
	} else if (link.u && index?.unit(link.u)) {
		const unit = index.unit(link.u);
		const lv = level ?? "full";
		item.kind = "paragraph";
		item.section = section(index.sectionOf(link.u));
		item.text = unit ? unitText(unit, lv) : "";
		const own = unit ? (lv === "key" ? unit.key : lv === "takeaway" ? unit.takeaway : lv === "topic" ? unit.topic || unit.takeaway : "") : "";
		item.written = !!doc && !doc.local && isWritten(lv) && !!own.trim(); // (an empty level falls back to the full text)
	} else if (link.s && index?.sections.get(link.s)) {
		const s = index.sections.get(link.s)!;
		item.kind = "section";
		item.section = section(s);
		item.text = sectionSummary(s, level ?? "takeaway");
		item.written = !!item.text && !doc?.local;
	} else if (doc) {
		item.text = [doc.authors.slice(0, 4).join("; ") + (doc.authors.length > 4 ? " et al." : ""), doc.date].filter(Boolean).join(" · ");
	}
	return item;
}

/** The title before a colon or dash, for a callout's one-line head. */
export function shortTitle(title: string): string {
	return /^(.{3,}?)\s*[:–—]\s+\S/.exec(title)?.[1] ?? title;
}

/** "Short title › 3 Results", the item's place in one line. */
export function itemLabel(item: DragItem): string {
	const s = item.section ? sectionName({ ...item.section, depth: 1, takeaway: "", topic: "", units: [] }) : "";
	return [shortTitle(item.title), s].filter(Boolean).join(" › ").replace(/\s+/g, " ").trim();
}

/** Text from TextFold as Markdown that stays text in the vault: in a model's words citations become reader links, and
 *  no other [[ … ]] can become a wikilink. */
function safeText(text: string, paper: string, citations: boolean): string {
	if (!citations) return text.replace(/\[\[/g, "\\[\\[").replace(/\r\n?/g, "\n").trim();
	const kept = text.replace(/\[\[([^[\]]+)\]\]/g, (m, x: string) => (/^(?:[\w.-]+|\?|!\d+)$/.test(x.trim()) ? m : `\uE001${x}]]`));
	return answerMarkdown(kept, paper, null).replace(/\[\[|\uE001/g, "\\[\\[").replace(/\r\n?/g, "\n").trim();
}

const quoted = (s: string) => s.split("\n").map(l => (l.trim() ? `> ${l}` : ">"));

/** The Markdown a drop inserts: a [!textfold] callout (the default), a quote, the link alone, or the text alone; all
 *  but the link end in a ↗ link back, drawn as TextFold's icon. A model's words are marked: the callout as
 *  `[!textfold|written]`, a quote with a few words before its icon. */
export function formatItem(item: DragItem, mode: DropMode): string {
	const link = buildLink(item.link);
	const label = itemLabel(item).replace(/([[\]])/g, "\\$1") || item.paper;
	const icon = `[${ICON_LABEL}](${link})`;
	if (mode === "link") return `[${label}](${link})`;
	if (mode === "icon") return `${itemSentence(item) || label} ${icon}`;
	const parts = itemParts(item);
	const written = item.written && parts.some(p => p.written);
	const body: string[] = [];
	for (const p of parts) {
		if (body.length) body.push(">");
		body.push(...quoted(p.md));
	}
	if (mode === "quote") {
		if (!body.length) body.push(`> ${label}`);
		body[body.length - 1] += `${written ? " *(written by the model)*" : ""} ${icon}`;
		return body.join("\n");
	}
	const head = `> [!textfold${written ? "|written" : ""}] ${itemLabel(item) || item.paper}`;
	if (!body.length) return `${head} ${icon}`;
	body[body.length - 1] += ` ${icon}`;
	return [head, ...body].join("\n");
}

/** What was dragged as it reads, on one line: a paragraph, summary, section, selection or chip as shown; a note's
 *  passage, then the reader's words; a conversation's answer in one sentence. */
export function itemSentence(item: DragItem): string {
	const line = (s: string | undefined, citations = false) => (s ? safeText(s.replace(/\s+/g, " "), item.paper, citations) : "");
	if (item.kind === "note") return [line(item.quote), line(item.comment)].filter(Boolean).join(" — ") || line(item.text);
	if (item.kind === "ask") return line(item.text, true) || line(item.quote);
	return line(item.text || item.quote, item.written);
}

/** What an item shows, in order, as TextFold's own Markdown for it does: a note's passage, then the reader's words;
 *  an Ask's passage, the reader's question in bold, then the model's answer; anything else its text. */
function itemParts(item: DragItem): { md: string; written: boolean }[] {
	const own = (s?: string) => (s ? safeText(s, item.paper, false) : "");
	const parts: { md: string; written: boolean }[] = [];
	const add = (md: string, written = false) => {
		if (md) parts.push({ md, written });
	};
	if (item.kind === "note") {
		add(own(item.quote));
		add(own(item.comment ?? (item.quote ? "" : item.text)), item.written && !item.comment);
		if (!parts.length) add(own(item.text), item.written);
	} else if (item.kind === "ask") {
		add(own(item.quote));
		if (item.comment) add(`**${own(item.comment)}**`);
		add(safeText(item.text, item.paper, true), item.written);
	} else {
		add(safeText(item.text || item.quote || "", item.paper, item.written), item.written);
		add(own(item.comment));
	}
	return parts;
}

/** An item as TextFold's drag JSON (the sidebar's rows send what TextFold's reader sends). */
export function toDragJson(item: DragItem): string {
	const o: Record<string, unknown> = {
		format: "textfold/drag",
		version: 1,
		paper: item.paper,
		title: item.title,
		authors: item.authors,
		...(item.citekey ? { citekey: item.citekey } : {}),
		section: item.section,
		kind: item.kind,
		level: item.level ?? null,
		lang: item.lang ?? null,
		text: item.text,
		written: item.written,
		...(item.quote ? { quote: item.quote } : {}),
		...(item.comment ? { comment: item.comment } : {}),
		link: buildLink(item.link),
	};
	return JSON.stringify(o);
}

/** Put an item on a drag's (or copy's) data: the JSON, and the link for programs that only read text. */
export function setTransfer(data: { setData(type: string, value: string): void }, item: DragItem): void {
	const link = buildLink(item.link);
	data.setData(DRAG_MIME, toDragJson(item));
	data.setData("text/uri-list", link);
	data.setData("text/plain", link);
}
