// TextFold's data as the plugin reads it: the documents of GET /api/papers and the notes of GET /api/notes/<id>
// (textfold/notes, version 1; see docs/notes-format.md in TextFold). Parsing is lenient: a field TextFold adds later is
// ignored, a missing one gets an empty value, and a note of an unknown kind is left out.
import { TextFoldLink, buildLink, isPaperId, levelName } from "./links";

export interface Paper {
	id: string;
	title: string;
	authors: string[];
	citekey?: string; // only when TextFold lists one (today's /api/papers does not)
	notes: number;
}

export type NoteKind = "highlight" | "note" | "ask";

export interface Turn {
	q: string;
	a: string; // Markdown, with TextFold's inline citations [[S3.p2.1]], [[?]], [[!12]]
	takeaway: string;
	pending: boolean;
	error: string;
}

export interface Note {
	id: string;
	kind: NoteKind;
	quote: string; // the passage in the author's words, anchor.quote.exact
	shown?: { words: [number, number]; exact: string }; // made on a written line (Key, Takeaway): its words selected, as the model wrote them
	text: string; // the reader's own note
	thread: Turn[];
	unit?: string;
	section?: string;
	on?: string; // "paper" for a conversation about the whole paper, "summary" or "title" for one on a section
	tokens?: [number, number]; // first and last token of the passage in its unit
	lost?: { since: string }; // its passage was not found again after the text was edited (refold in place)
	level?: TextFoldLink["level"];
	lang?: string;
	updated: string;
}

export interface NotesFile {
	paper: { id: string; title: string };
	notes: Note[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" ? [v[0], v[1]] : undefined);

export function parsePapers(data: unknown): Paper[] {
	if (!Array.isArray(data)) return [];
	return data.flatMap((d): Paper[] => {
		const o = obj(d);
		const id = str(o.id);
		if (!isPaperId(id)) return [];
		const zotero = obj(o.zotero); // `zotero: true` today; an object with the citekey, should TextFold list it
		const citekey = str(o.citekey) || str(zotero.citekey) || undefined;
		return [{
			id,
			title: str(o.title) || id,
			authors: Array.isArray(o.authors) ? o.authors.filter((a): a is string => typeof a === "string") : [],
			citekey,
			notes: typeof o.notes === "number" ? o.notes : 0,
		}];
	});
}

export function parseNotes(data: unknown, id: string): NotesFile {
	const o = obj(data);
	const paper = obj(o.paper);
	const notes = Array.isArray(o.notes) ? o.notes.flatMap((n): Note[] => {
		const note = parseNote(n);
		return note ? [note] : [];
	}) : [];
	return { paper: { id: str(paper.id) || id, title: str(paper.title) || id }, notes };
}

function parseNote(data: unknown): Note | null {
	const o = obj(data);
	const kind = str(o.kind);
	if (!str(o.id) || (kind !== "highlight" && kind !== "note" && kind !== "ask")) return null;
	const anchor = obj(o.anchor);
	const shown = obj(anchor.shown);
	const words = pair(shown.words);
	const thread = (Array.isArray(o.thread) ? o.thread : []).map((t): Turn => {
		const r = obj(t);
		return { q: str(r.q), a: str(r.a), takeaway: str(r.takeaway), pending: r.pending === true, error: str(r.error) };
	});
	return {
		id: str(o.id),
		kind,
		quote: str(obj(anchor.quote).exact),
		shown: words && str(shown.exact) ? { words, exact: str(shown.exact) } : undefined,
		text: str(o.text),
		thread,
		unit: str(anchor.unit) || undefined,
		section: str(anchor.section) || undefined,
		on: str(anchor.on) || undefined,
		tokens: pair(anchor.tokens),
		lost: anchor.lost && typeof anchor.lost === "object" ? { since: str(obj(anchor.lost).since) } : undefined,
		level: levelName(anchor.level),
		lang: str(anchor.lang) || undefined,
		updated: str(o.updated) || str(o.created),
	};
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The one line a note shows as: an Ask conversation's first question, a note's text, else the passage. */
export function noteLine(note: Note): string {
	const passage = notePassage(note);
	const line = note.kind === "ask" ? note.thread[0]?.q || passage : note.kind === "note" ? note.text || passage : passage || note.text;
	return flat(line);
}

/** The passage a note marks, as the reader selected it (TextFold's reader shows it so): the words of the written line
 *  it was made on, the model's, else its quote, the author's. */
export function notePassage(note: Note): string {
	return note.shown?.exact || note.quote;
}

/** For a note made on a written line, where its passage is and whose words they are, as TextFold's export says it:
 *  "at Key, in the model’s words"; "" for any other note. */
export function passageLabel(note: Note): string {
	if (!note.shown) return "";
	const at = note.level ? `at ${note.level[0].toUpperCase()}${note.level.slice(1)}, ` : "";
	return `${at}in the model’s words`;
}

/** Whether a line shown for a note (its noteLine, a citation's text) is its passage in the model's words. */
export function isModelPassage(note: Note | undefined, line: string): boolean {
	return !!note?.shown && flat(line) === flat(note.shown.exact);
}

/** The link that opens the reader at this note, at the level and in the language it was made in. */
export function noteLink(paper: string, note: Note): TextFoldLink {
	const link: TextFoldLink = { paper, n: note.id };
	if (note.unit) link.u = note.unit;
	if (note.level) link.level = note.level;
	if (note.lang) link.lang = note.lang;
	return link;
}

/** An answer's inline citations as Markdown Obsidian shows without making wikilinks of them: [[u6]] becomes a link
 *  to that paragraph in the reader, [[?]] "(inference)", and [[!12]], a citation that named no paragraph, `?12`. */
export function citationLinks(md: string, paper: string): string {
	return md
		.replace(/[ \t]?\[\[\?\]\]/g, " *(inference)*")
		.replace(/[ \t]?\[\[!(\d+)\]\]/g, " `?$1`")
		.replace(/[ \t]?\[\[([\w.-]{1,80})\]\]/g, (_, u: string) => ` [${u}](${buildLink({ paper, u })})`);
}
