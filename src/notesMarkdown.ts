// TextFold's notes on a document as Markdown in the vault ("Import notes"), in the style of TextFold's own export for
// Obsidian (notesMarkdown in its reader.js): grouped by section in reading order, each highlight a quote with the note's
// id as its block id (^n-…), then the reader's comment and a link back to the note in TextFold; a conversation as a
// [!question] callout. The notes go between two marker comments, so a re-import replaces only them and keeps what was
// written around them. Pure functions without runtime imports from obsidian; test/notesMarkdown.test.ts covers them.
import { Doc, DocIndex, sectionName } from "./doc";
import { buildLink } from "./links";
import { Note, NotesFile, noteLink } from "./notes";

export const BLOCK_START = "%% TextFold notes: a re-import replaces everything from here to the end marker %%";
export const BLOCK_END = "%% End of TextFold notes %%";
export const WHOLE = "The whole paper"; // TextFold's name for notes on the whole text

export interface NoteGroup {
	name: string; // section name, WHOLE, or "" when the section is unknown
	notes: Note[];
}

/** Notes in reading order, grouped as TextFold groups them: the whole paper first, then by section. Without the
 *  document (an older TextFold), in the file's order under the section ids they name. */
export function groupNotes(notes: Note[], index: DocIndex | null): NoteGroup[] {
	const isWhole = (n: Note) => n.on === "paper";
	const place = (n: Note) => (isWhole(n) ? -1e9 : index ? index.place(n.unit, n.section) : 0);
	const sorted = notes
		.map((n, i) => ({ n, i }))
		.sort((a, b) => place(a.n) - place(b.n) || tokenStart(a.n) - tokenStart(b.n) || a.i - b.i)
		.map(x => x.n);
	const groups: NoteGroup[] = [];
	for (const n of sorted) {
		const s = isWhole(n) ? null : index?.sectionOf(n.unit, n.section);
		const name = isWhole(n) ? WHOLE : s ? sectionName(s) : n.section ?? "";
		const last = groups[groups.length - 1];
		if (last && last.name === name) last.notes.push(n);
		else groups.push({ name, notes: [n] });
	}
	return groups;
}

const tokenStart = (n: Note) => n.tokens?.[0] ?? 0;

/** "Xiang, Jialiang" as "Jialiang Xiang", as TextFold's export writes authors. */
export function flipName(n: string): string {
	const p = n.split(",").map(x => x.trim());
	return p.length === 2 && p[0] && p[1] ? `${p[1]} ${p[0]}` : n;
}

/** An answer's citations as Obsidian Markdown: [[u6]] -> ([§3 ¶2](textfold://…&u=u6)), [[?]] -> (inference), and a
 *  citation that named no paragraph dropped, as TextFold's export does. */
export function answerMarkdown(md: string, paper: string, index: DocIndex | null): string {
	return md.replace(/\s*\[\[([^[\]]+)\]\]/g, (_, raw: string) => {
		const x = raw.trim();
		if (x === "?") return " (inference)";
		if (x.startsWith("!") || !/^[\w.-]+$/.test(x) || (index && !index.unit(x))) return "";
		return ` ([${index ? index.citeLabel(x) : x}](${buildLink({ paper, u: x })}))`;
	});
}

const quote = (s: string) => s.split("\n").map(l => (l ? `> ${l}` : ">"));

/** The block of notes (markers included) for one document. */
export function notesBlock(nf: NotesFile, doc: Doc | null, source?: { label: string; url: string }): string {
	const paper = nf.paper.id;
	const index = doc ? new DocIndex(doc) : null;
	const title = doc?.title || nf.paper.title;
	const authors = (doc?.authors ?? []).map(flipName).join(", ");
	const src = source ?? doc?.source;
	const from = src?.url ? `[${src.label || src.url}](${src.url})` : src?.label ?? "";
	const out = [BLOCK_START, "", `# ${title}`, ""];
	const byline = [authors, from].filter(Boolean).join(" · ");
	if (byline) out.push(byline, "");
	out.push(`[Open in TextFold](${buildLink({ paper })})`, "");
	for (const g of groupNotes(nf.notes, index)) {
		if (g.name) out.push(`## ${g.name}`, "");
		for (const n of g.notes) out.push(...noteMarkdown(n, paper, index), "");
	}
	if (!nf.notes.length) out.push("*No notes in TextFold yet.*", "");
	out.push("---", "", "*Made with [TextFold](https://github.com/chenxiachan/textfold)*", "", BLOCK_END);
	return out.join("\n");
}

function noteMarkdown(n: Note, paper: string, index: DocIndex | null): string[] {
	const out: string[] = [];
	const said = n.kind === "ask" ? n.thread.filter(t => t.a) : [];
	if (said.length) { // the conversation as one callout: the first question its title, each later one in bold
		out.push(...quote(`[!question] ${said[0].q}`));
		if (n.quote) out.push(...quote(`*${n.quote}*`));
		said.forEach((t, k) => {
			out.push(">");
			if (k) out.push(...quote(`**${t.q}**`), ">");
			out.push(...quote(answerMarkdown(t.a, paper, index)));
			if (t.takeaway) out.push(">", ...quote(`→ ${t.takeaway}`));
		});
	} else if (n.on !== "paper" && n.quote) out.push(...quote(n.quote)); // (a note on the whole paper quotes nothing)
	out.push("", `^${n.id}`, "");
	if (n.lost) out.push("*Passage not found after the edit.*", "");
	if (n.text.trim()) out.push(n.text.trim(), "");
	out.push(`[Open in TextFold](${buildLink(noteLink(paper, n))})`);
	return out;
}

/** The note's text with its block of TextFold notes replaced (or added at the end), everything else kept. */
export function replaceBlock(text: string, block: string): string {
	const start = text.indexOf(BLOCK_START);
	const end = start < 0 ? -1 : text.indexOf(BLOCK_END, start);
	if (start >= 0 && end >= 0) return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
	const body = text.replace(/\s+$/, "");
	return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** A file name for a document's note: its short title (before a colon), or its citekey when asked and known. */
export function noteFileName(title: string, citekey: string | undefined, byCitekey: boolean): string {
	if (byCitekey && citekey && safeName(citekey)) return safeName(citekey);
	const short = /^(.{3,}?)\s*[:–—]\s+\S/.exec(title)?.[1] ?? title;
	let name = safeName(short);
	if (name.length > 80) name = name.slice(0, 80).replace(/\s+\S*$/, "");
	return name || "Untitled";
}

function safeName(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
}
