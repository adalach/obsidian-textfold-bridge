// The note's own blocks (as Obsidian's metadata cache divides it: headings, paragraphs, lists, callouts, code, …) and
// which of TextFold's paragraphs and sections each one is. TextFold read the note as flattened Markdown (flatten.ts), so
// its paragraphs (ids p-<hash>, made from the paragraph's words) follow the note's blocks in order: a block is matched
// by its words, a list block can hold several of TextFold's list items. Pure: test/fold.test.ts covers it.
import type { Doc } from "../doc";
import { flattenNote } from "../flatten";
import { sq, tokenize } from "./align";

export interface NoteBlock {
	index: number;
	type: string; // Obsidian's section type: paragraph, heading, list, callout, blockquote, code, table, math, yaml, …
	markdown: string;
	from: number;
	to: number;
	level?: number; // a heading's level
	heading?: string; // a heading's text
	words: string[]; // its words as compared
}

export interface SectionPos {
	type: string;
	start: number; // offsets in the note's text
	end: number;
}

/** The note in blocks: from the metadata cache's sections when given, else by blank lines. Front matter is left out. */
export function splitBlocks(text: string, sections?: SectionPos[]): NoteBlock[] {
	const parts: { type: string; from: number; to: number }[] = [];
	if (sections?.length) for (const s of sections) parts.push({ type: s.type, from: s.start, to: s.end });
	else {
		const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
		const start = fm ? fm[0].length : 0;
		const re = /(?:^|\n)((?:[^\n]+\n?)+)/g;
		for (const m of text.slice(start).matchAll(re)) {
			const from = start + (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0);
			const md = m[1].replace(/\n$/, "");
			// a heading starts a block of its own
			const lines = md.split("\n");
			let at = from;
			let cur: string[] = [];
			const flush = () => {
				if (!cur.length) return;
				const chunk = cur.join("\n");
				parts.push({ type: "paragraph", from: at - 1 - chunk.length, to: at - 1 });
				cur = [];
			};
			for (const line of lines) {
				if (/^#{1,6}\s/.test(line)) {
					flush();
					parts.push({ type: "heading", from: at, to: at + line.length });
				} else cur.push(line);
				at += line.length + 1;
			}
			flush();
		}
	}
	const out: NoteBlock[] = [];
	for (const p of parts) {
		if (p.type === "yaml") continue;
		const markdown = text.slice(p.from, p.to);
		const block: NoteBlock = { index: out.length, type: p.type, markdown, from: p.from, to: p.to, words: [] };
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(markdown);
		if (p.type === "heading" && h) {
			block.level = h[1].length;
			block.heading = plainText(h[2]);
		}
		block.words = wordsOf(p.type === "heading" ? block.heading ?? "" : plainText(markdown));
		out.push(block);
	}
	return out;
}

/** A block's Markdown as its words read: Obsidian's syntax flattened as for TextFold, then Markdown's marks dropped. */
export function plainText(markdown: string): string {
	return flattenNote(markdown)
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s*(?:>\s*)+/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_~`=]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function wordsOf(text: string): string[] {
	return tokenize(text).map(t => sq(t.t)).filter(Boolean);
}

export interface FoldMap {
	unitBlock: Map<string, number>; // TextFold paragraph -> the block it is in
	blockUnits: Map<number, string[]>; // block -> its paragraphs, in order
	headingSection: Map<number, string>; // heading block -> TextFold section
	titleBlock: number | null; // the heading TextFold took as the document's title
}

const TEXT_BLOCKS = new Set(["paragraph", "list", "callout", "blockquote", "table", "footnoteDefinition"]);
const LOOKAHEAD = 8;

/** Which block each of TextFold's paragraphs is in, and which heading each section is, by order and words. */
export function mapUnits(blocks: NoteBlock[], doc: Doc): FoldMap {
	const map: FoldMap = { unitBlock: new Map(), blockUnits: new Map(), headingSection: new Map(), titleBlock: null };
	// headings: in order, by their words
	const titleWords = wordsOf(doc.title).join(" ");
	let hs = 0;
	const sections = doc.sections.filter(s => s.title);
	for (const b of blocks) {
		if (b.type !== "heading") continue;
		const words = b.words.join(" ");
		const k = sections.findIndex((s, i) => i >= hs && wordsOf(s.title).join(" ") === words);
		if (k >= 0) {
			map.headingSection.set(b.index, sections[k].id);
			hs = k + 1;
		} else if (map.titleBlock === null && words && words === titleWords) map.titleBlock = b.index;
	}
	// paragraphs: each in the first block from where the last one was that holds most of its words
	let at = 0;
	for (const u of doc.sections.flatMap(s => s.units)) {
		const want = wordsOf(u.full);
		if (!want.length) continue;
		for (let i = at; i < blocks.length && i < at + LOOKAHEAD; i++) {
			const b = blocks[i];
			if (!TEXT_BLOCKS.has(b.type) || overlap(want, b.words) < 0.6) continue;
			map.unitBlock.set(u.id, i);
			map.blockUnits.set(i, [...(map.blockUnits.get(i) ?? []), u.id]);
			at = i; // (a list block may hold the next ones too)
			break;
		}
	}
	return map;
}

/** How many of `want`'s words the block has, as a share of them (each word of the block counted once). */
function overlap(want: string[], have: string[]): number {
	const left = new Map<string, number>();
	for (const w of have) left.set(w, (left.get(w) ?? 0) + 1);
	let hit = 0;
	for (const w of want) {
		const n = left.get(w) ?? 0;
		if (n > 0) {
			hit++;
			left.set(w, n - 1);
		}
	}
	return hit / want.length;
}
