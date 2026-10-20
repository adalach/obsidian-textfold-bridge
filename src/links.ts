// textfold:// links: parse and build them, map them to TextFold's reader URL, and find the documents a note refers to.
// Pure functions without runtime imports from obsidian, so test/links.test.ts can run them in Node.
//
//   textfold://open?paper=<document id>[&s=<section id>][&u=<paragraph id>[&to=<paragraph id>]][&n=<note id>[&t=<turn>]][&level=<full|brief|key|takeaway|topic>][&lang=<code>]
//   -> <server>/p/<id>?lang=<code>#n=<note id>&t=<turn>&u=<paragraph id>&to=<paragraph id>&s=<section id>&level=<name>
// t is a turn of a conversation (0 is the first), and means something only with n; to is the last of a range of
// paragraphs from u (the reader flashes them all), and means something only with u.

export const LEVELS = ["full", "brief", "key", "takeaway", "topic"] as const;
export type Level = (typeof LEVELS)[number];

/** A note's anchor.level as TextFold stores it (4 Full … 0 Topic), as a level name. */
export function levelName(n: unknown): Level | undefined {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4 ? LEVELS[4 - n] : undefined;
}

export interface TextFoldLink {
	paper: string;
	s?: string; // section id, such as S3 or sec-introduction
	u?: string; // paragraph (unit) id, such as S2.SS3.p2
	to?: string; // with u: the last paragraph of a range from u, in reading order
	n?: string; // note id, such as n-k3f9a2qx
	t?: number; // a turn of the note's conversation, 0 the first (only with n)
	level?: Level;
	lang?: string;
}

// TextFold's document ids: arXiv ids, md-…, pdf-…, zotero-…, pmc…, wiki-…; its routes accept [\w.-]+
const PAPER_ID = /^[\w.-]{1,120}$/;
const NOTE_ID = /^[\w-]{1,80}$/;
const UNIT_ID = /^[\w.-]{1,200}$/; // as TextFold's links.js checks u and to
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export function isPaperId(id: string): boolean {
	return PAPER_ID.test(id);
}

/** A textfold:// link's parts, or null when it is not one (or names no valid document). Unknown or invalid
 *  optional parts are dropped, so a link written by a newer TextFold still opens its document. */
export function parseLink(href: string): TextFoldLink | null {
	const m = /^textfold:\/\/open\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(href.trim());
	if (!m) return null;
	const q = new URLSearchParams(m[1] ?? "");
	const paper = q.get("paper") ?? "";
	if (!isPaperId(paper)) return null;
	const link: TextFoldLink = { paper };
	const place = (v: string | null) => (v && v.length <= 200 && !/[\s#&]/.test(v) ? v : undefined);
	const sec = place(q.get("s"));
	if (sec) link.s = sec;
	const u = place(q.get("u"));
	if (u) link.u = u;
	const to = q.get("to");
	if (link.u && to && UNIT_ID.test(to) && to !== link.u) link.to = to;
	const n = q.get("n");
	if (n && NOTE_ID.test(n)) link.n = n;
	const t = q.get("t");
	if (link.n && t && /^\d{1,3}$/.test(t)) link.t = Number(t);
	const level = q.get("level")?.toLowerCase();
	if (level && (LEVELS as readonly string[]).includes(level)) link.level = level as Level;
	const lang = q.get("lang");
	if (lang && LANG.test(lang)) link.lang = lang;
	return link;
}

/** The textfold:// link for a document, a paragraph or a note in it. */
export function buildLink(link: TextFoldLink): string {
	const parts = [`paper=${encodeURIComponent(link.paper)}`];
	if (link.s) parts.push(`s=${encodeURIComponent(link.s)}`);
	if (link.u) parts.push(`u=${encodeURIComponent(link.u)}`);
	if (link.u && link.to) parts.push(`to=${encodeURIComponent(link.to)}`);
	if (link.n) parts.push(`n=${encodeURIComponent(link.n)}`);
	if (link.n && link.t !== undefined) parts.push(`t=${link.t}`);
	if (link.level) parts.push(`level=${link.level}`);
	if (link.lang) parts.push(`lang=${encodeURIComponent(link.lang)}`);
	return `textfold://open?${parts.join("&")}`;
}

/** The reader URL on a running TextFold server (base such as http://127.0.0.1:3017). The reader reads #n= (with #t=,
 *  a turn of its conversation), #u= (with #to=, the range's last paragraph), #s= and #level= each on its own; with
 *  both a note and a paragraph, the paragraph is where it goes when the note is gone. */
export function readerUrl(base: string, link: TextFoldLink): string {
	let url = `${base.replace(/\/+$/, "")}/p/${encodeURIComponent(link.paper)}`;
	if (link.lang) url += `?lang=${encodeURIComponent(link.lang)}`;
	const hash: string[] = [];
	if (link.n) hash.push(`n=${encodeURIComponent(link.n)}`);
	if (link.n && link.t !== undefined) hash.push(`t=${link.t}`); // the reader scrolls the conversation to that turn
	if (link.u) hash.push(`u=${encodeURIComponent(link.u)}`);
	if (link.u && link.to) hash.push(`to=${encodeURIComponent(link.to)}`);
	if (link.s) hash.push(`s=${encodeURIComponent(link.s)}`);
	if (link.level) hash.push(`level=${link.level}`);
	return hash.length ? `${url}#${hash.join("&")}` : url;
}

/** A Markdown link with this label, its brackets escaped so the label cannot end the link early. */
export function markdownLink(label: string, link: TextFoldLink): string {
	const text = label.replace(/\s+/g, " ").trim().replace(/([[\]\\])/g, "\\$1") || link.paper;
	return `[${text}](${buildLink(link)})`;
}

// a textfold:// link in running text ends at whitespace, or at a character that closes Markdown or HTML around it
const LINK_IN_TEXT = /textfold:\/\/open\/?\?[^\s)\]>"'`<]+/gi;

/** The documents a note refers to, in order of first mention: `textfold:` in its frontmatter (an id, a link, or a
 *  list of them) first, then every textfold:// link in its text. */
export function findPaperIds(text: string, frontmatterValue?: unknown): string[] {
	const ids: string[] = [];
	const add = (id: string | undefined) => {
		if (id && isPaperId(id) && !ids.includes(id)) ids.push(id);
	};
	const fromValue = (v: unknown) => {
		if (typeof v === "number") v = String(v); // an arXiv id typed without quotes is a YAML number
		if (typeof v !== "string") return;
		const s = v.trim();
		add(s.toLowerCase().startsWith("textfold:") ? parseLink(s)?.paper : s);
	};
	if (Array.isArray(frontmatterValue)) frontmatterValue.forEach(fromValue);
	else fromValue(frontmatterValue);
	for (const m of text.matchAll(LINK_IN_TEXT)) add(parseLink(m[0].replace(/[.,;:!?]+$/, ""))?.paper);
	return ids;
}

/** The property's value with this document added: a single id stays a single id, two become a list. */
export function withId(value: unknown, id: string): unknown {
	if (value === undefined || value === null || value === "") return id;
	const list: unknown[] = Array.isArray(value) ? value : [value];
	return list.includes(id) ? value : [...list, id];
}

/** The property's value without this document; undefined when nothing is left. */
export function withoutId(value: unknown, id: string): unknown {
	if (!Array.isArray(value)) return value === id ? undefined : value;
	const left = (value as unknown[]).filter(x => x !== id);
	return left.length === 0 ? undefined : left.length === 1 ? left[0] : left;
}
