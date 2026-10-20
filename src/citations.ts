// The TextFold citations in a note: every textfold:// link in its text (a plain link, a dropped callout's or quote's
// link, a ↗ icon link, a bare address), where it is, and what it cites; grouped by the note's headings or by paper and
// section. Pure functions without runtime imports from obsidian; test/citations.test.ts covers them.
import { Doc, DocIndex, sectionName, sectionSummary, unitText } from "./doc";
import { TextFoldLink, parseLink } from "./links";
import { NotesFile } from "./notes";

export interface Citation {
	link: TextFoldLink;
	href: string;
	from: number; // offsets of the whole Markdown link (or the bare address) in the note's text
	to: number;
	line: number; // 0-based
	form: "link" | "icon" | "bare";
	label: string; // the link's own words: its label, or for an icon or "Open in TextFold" the words it stands by
	index: number; // place in reading order
}

const MD_LINK = /\[((?:\\.|[^\]\\\n])*)\]\((textfold:\/\/open\/?\?[^)\s]*)\)/gi;
const BARE = /textfold:\/\/open\/?\?[^\s)\]>"'`<]+/gi;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const GENERIC = /^(?:↗|open in textfold)$/i;

/** Every textfold:// link in a note's text, in reading order, outside its front matter and its code. */
export function findCitations(text: string): Citation[] {
	const lines = text.split("\n");
	const starts: number[] = [];
	let at = 0;
	for (const l of lines) {
		starts.push(at);
		at += l.length + 1;
	}
	let first = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
		if (end > 0) first = end + 1;
	}
	const out: Citation[] = [];
	let fence: string | null = null;
	for (let n = first; n < lines.length; n++) {
		const line = lines[n];
		const f = FENCE.exec(line);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
			continue;
		}
		if (f) {
			fence = f[1];
			continue;
		}
		const code = codeSpans(line);
		const taken: [number, number][] = [];
		for (const m of line.matchAll(MD_LINK)) {
			const s = m.index ?? 0;
			taken.push([s, s + m[0].length]);
			if (code.some(([a, b]) => s >= a && s < b)) continue;
			const link = parseLink(m[2]);
			if (!link) continue;
			const label = m[1].replace(/\\([[\]\\])/g, "$1").trim();
			out.push({
				link,
				href: m[2],
				from: starts[n] + s,
				to: starts[n] + s + m[0].length,
				line: n,
				form: label === "↗" ? "icon" : "link",
				label: GENERIC.test(label) ? context(lines, n, s) || label : label,
				index: 0,
			});
		}
		for (const m of line.matchAll(BARE)) {
			const s = m.index ?? 0;
			if (taken.some(([a, b]) => s >= a && s < b) || code.some(([a, b]) => s >= a && s < b)) continue;
			const href = m[0].replace(/[.,;:!?]+$/, "");
			const link = parseLink(href);
			if (link) out.push({ link, href, from: starts[n] + s, to: starts[n] + s + href.length, line: n, form: "bare", label: context(lines, n, s), index: 0 });
		}
	}
	out.sort((a, b) => a.from - b.from).forEach((c, i) => (c.index = i));
	return out;
}

/** Inline code spans of a line, as [start, end) offsets. */
function codeSpans(line: string): [number, number][] {
	const spans: [number, number][] = [];
	for (const m of line.matchAll(/(`+)[^`]*?\1/g)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
	return spans;
}

/** The words a link without words of its own stands by: before it on its line (a ↗ after dropped text), else the
 *  nearest line above with words (an "Open in TextFold" under a quote or a comment). */
function context(lines: string[], n: number, ch: number): string {
	const head = lines[n].slice(0, ch);
	const prev = [...head.matchAll(/\]\([^)\s]*\)/g)].pop(); // words since the line's last link, not before it
	const before = plain(prev ? head.slice((prev.index ?? 0) + prev[0].length) : head);
	if (before) return before;
	for (let i = n - 1; i >= 0 && i >= n - 8; i--) {
		const t = lines[i].replace(/^\s*(?:>\s*)*/, "").trim();
		if (!t || /^\^[\w-]+$/.test(t) || /^\[!/.test(t)) {
			if (/^\[!/.test(t)) return plain(t.replace(/^\[![\w|-]+\][+-]?\s*/, ""));
			continue;
		}
		return plain(t);
	}
	return "";
}

/** Markdown reduced to its words, for one line of the list. */
function plain(s: string): string {
	return s
		.replace(/^\s*(?:>\s*)+/, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`=]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** What a citation cites, from TextFold: a note's quote (an Ask's question: the linked turn's, else the first), a
 *  paragraph at the link's level (else Takeaway), a range of them as its first and how many follow ("… (+2)"), a
 *  section by its heading (its summary when it has no title); null when TextFold gave nothing for it. */
export function citedText(c: Citation, doc: Doc | null, nf: NotesFile | null): string | null {
	const index = doc ? new DocIndex(doc) : null;
	const level = c.link.level ?? "takeaway";
	if (c.link.n) {
		const note = nf?.notes.find(x => x.id === c.link.n);
		if (!note) return null;
		if (note.kind === "ask") return (c.link.t !== undefined ? note.thread[c.link.t]?.q : undefined) || note.thread[0]?.q || note.quote || null;
		return note.quote || note.text || null;
	}
	if (c.link.u) {
		const units = index?.range(c.link.u, c.link.to) ?? [];
		if (!units.length) return null;
		const first = unitText(units[0], level);
		return units.length > 1 ? `${first.replace(/\s+/g, " ").trim()} … (+${units.length - 1})` : first;
	}
	if (c.link.s) {
		const s = index?.sections.get(c.link.s);
		return s ? sectionName(s) || sectionSummary(s, level) || null : null;
	}
	return null;
}

/** The section a citation is in, from the document: the note's, the paragraph's, or the section linked. */
export function citedSection(c: Citation, doc: Doc | null, nf: NotesFile | null): { id: string; name: string; place: number } | null {
	if (!doc) return null;
	const index = new DocIndex(doc);
	let s;
	if (c.link.n) {
		const note = nf?.notes.find(x => x.id === c.link.n);
		s = note ? index.sectionOf(note.unit, note.section) : undefined;
	} else if (c.link.u) s = index.sectionOf(c.link.u);
	else if (c.link.s) s = index.sections.get(c.link.s);
	if (!s) return null;
	return { id: s.id, name: sectionName(s) || "Opening", place: index.place(s.units[0]?.id, s.id) };
}

export interface HeadingPos {
	heading: string;
	level: number;
	offset: number; // where the heading starts in the note's text
}

export interface CitationGroup<T> {
	key: string;
	name: string;
	level: number; // a heading's level (1–6); 0 for the note's title or a paper; 1 under a paper for its sections
	items: T[];
	sub?: CitationGroup<T>[]; // by paper: its sections
}

/** Citations under the note's headings (the innermost one they follow), in reading order; those before the first
 *  heading under the note's title. Headings without citations are left out. */
export function groupByHeading(cites: Citation[], headings: HeadingPos[], title: string): CitationGroup<Citation>[] {
	const hs = [...headings].sort((a, b) => a.offset - b.offset);
	const groups: CitationGroup<Citation>[] = [];
	for (const c of cites) {
		let k = -1;
		for (let i = 0; i < hs.length && hs[i].offset <= c.from; i++) k = i;
		const key = k < 0 ? "title" : `h${k}`;
		let g = groups.find(x => x.key === key);
		if (!g) {
			g = { key, name: k < 0 ? title : hs[k].heading, level: k < 0 ? 0 : hs[k].level, items: [] };
			groups.push(g);
		}
		g.items.push(c);
	}
	return groups;
}

/** Citations by paper (in the order the note first cites each), then by the paper's sections in the paper's order
 *  (citations of the whole paper, or of a place TextFold cannot say, first), then in reading order. `info` says a citation's paper title and section, when TextFold knows them. */
export function groupByPaper(
	cites: Citation[],
	info: (c: Citation) => { title: string; section: { id: string; name: string; place: number } | null },
): CitationGroup<Citation>[] {
	const papers: CitationGroup<Citation>[] = [];
	const places = new Map<string, number>();
	for (const c of cites) {
		const { title, section } = info(c);
		let p = papers.find(x => x.key === c.link.paper);
		if (!p) {
			p = { key: c.link.paper, name: title, level: 0, items: [], sub: [] };
			papers.push(p);
		}
		p.items.push(c);
		const key = `${c.link.paper}/${section?.id ?? ""}`;
		let s = p.sub!.find(x => x.key === key);
		if (!s) {
			s = { key, name: section?.name ?? "", level: 1, items: [] };
			p.sub!.push(s);
			places.set(key, section ? section.place : -Number.MAX_SAFE_INTEGER); // the whole paper first, as TextFold lists it
		}
		s.items.push(c);
	}
	for (const p of papers) p.sub!.sort((a, b) => (places.get(a.key) ?? 0) - (places.get(b.key) ?? 0));
	return papers;
}
