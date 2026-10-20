// SPDX-License-Identifier: Apache-2.0. Adapted from TextFold, Copyright 2026 Xia Chen; changed for this plugin (see NOTICE).
// Words and levels of a folded note: every word gets an id that persists across the five levels, so a level change can
// slide each word from where it was to where it is. Adapted from TextFold's reader (textfold/web/reader.js) and its word
// alignment (textfold/tokens.py, textfold/ladder.py), Apache License 2.0, by way of the design mockup: the model's words
// at Key take the id of the author's word they match in the Brief sentences (a longest common subsequence of their
// normalized forms), Takeaway is the head of Key, Topic a run of Takeaway's words. Pure: test/fold.test.ts covers it.
import type { DocSection, DocUnit } from "../doc";
import type { Level } from "../links";

export const FOLD_LEVELS: Level[] = ["full", "brief", "key", "takeaway", "topic"];
export const LEVEL_LABEL: Record<Level, string> = { full: "Full", brief: "Brief", key: "Key", takeaway: "Takeaway", topic: "Topic" };

export interface Token {
	t: string; // the word or mark
	s?: 1; // a space follows it
	c0: number; // where it is in its text
	c1: number;
}

// a number with its decimals, a word with its inner apostrophes and hyphens, any other mark; spaces between
const TOKRE = /\s+|\d+(?:[.,]\d+)+%?|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|\S/gu;
const STOP = new Set(
	("the a an of to in is are was were be been and or that this these those it its for on with as by at from we our their they " +
		"which while than then into can not but such also has have had does do more most less only both").split(" "),
);

export function tokenize(text: string, base = 0): Token[] {
	const out: Token[] = [];
	for (const m of String(text).matchAll(TOKRE)) {
		if (/^\s+$/.test(m[0])) {
			if (out.length) out[out.length - 1].s = 1;
			continue;
		}
		const at = base + (m.index ?? 0);
		out.push({ t: m[0], c0: at, c1: at + m[0].length });
	}
	return out;
}

/** A word as compared across texts: lower case, letters and digits only. */
export const sq = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");

/** A word as matched between the author's and the model's: no stop words, a plural's s dropped. */
export function norm(t: string): string {
	let w = sq(t);
	if (!w || STOP.has(w)) return "";
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
	return w;
}

/** The pairs (i, j) of a longest common subsequence of a and b; empty strings never match. */
export function lcsPairs(a: string[], b: string[]): [number, number][] {
	const n = a.length, m = b.length;
	if (!n || !m) return [];
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: [number, number][] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (a[i] && a[i] === b[j]) {
			out.push([i, j]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
		else j++;
	}
	return out;
}

/** The run of `take` that spells `topic`, by its indexes; empty when there is none. */
export function locate(topic: string, take: { t: string }[]): number[] {
	const want = sq(topic);
	if (!want) return [];
	for (let i = 0; i < take.length; i++) {
		const a = sq(take[i].t);
		if (!a || !want.startsWith(a)) continue;
		let acc = "";
		for (let j = i; j < take.length; j++) {
			acc += sq(take[j].t);
			if (acc === want) return Array.from({ length: j - i + 1 }, (_, k) => i + k);
			if (!want.startsWith(acc)) break;
		}
	}
	return [];
}

/** One word as shown: its id (the same at every level where the word is), its text, a space after, whether it is a
 *  lead word (the Brief sentences at Full, the Takeaway inside Key …), marked by a highlight, or a gap (…). */
export interface Piece {
	id: string;
	t: string;
	s?: boolean;
	lead?: boolean;
	hl?: boolean;
	gap?: boolean;
}

type Aligned = Token & { id: string; m?: number; hl?: boolean };

/** A unit's words and how its written levels map onto them, worked out once. */
export interface PreparedUnit {
	id: string;
	pre: string;
	toks: Token[]; // the full text's words
	sr: [number, number][]; // each sentence's words, as [first, after-last]
	hl: Set<number>; // words in a highlight's passage
	ev: number[]; // the Brief sentences
	kt: Aligned[];
	km: Set<number>;
	tt: Aligned[];
	tp: Aligned[];
	inTopic: Set<string>;
	sentences: string[];
}

/** A highlight's passage: its text, and its first and last word in the unit when TextFold kept them (in this language). */
export type Passage = string | { quote: string; tokens?: [number, number] };

/** A unit of TextFold's document, prepared; `quotes` are the passages of the reader's highlights on it. */
export function prepUnit(u: DocUnit & { sentences?: string[]; evidence?: number[] }, quotes: Passage[] = []): PreparedUnit {
	const pre = `${u.id}:`;
	const sentences = u.sentences?.length ? u.sentences : [u.full];
	const toks: Token[] = [];
	const sr: [number, number][] = [];
	let base = 0;
	sentences.forEach((sent, si) => {
		const a = toks.length;
		const ts = tokenize(sent, base);
		if (ts.length && si < sentences.length - 1) ts[ts.length - 1].s = 1;
		toks.push(...ts);
		sr.push([a, toks.length]);
		base += sent.length + 1;
	});
	const full = sentences.join(" ");
	const hl = new Set<number>();
	for (const m of quotes) {
		const q = typeof m === "string" ? m : m.quote;
		const tk = typeof m === "string" ? undefined : m.tokens;
		// TextFold's words, when they still read as the passage (a phrase can be in a paragraph twice)
		if (tk && tk[0] >= 0 && tk[0] <= tk[1] && tk[1] < toks.length && sq(toks.slice(tk[0], tk[1] + 1).map(t => t.t).join("")) === sq(q)) {
			for (let i = tk[0]; i <= tk[1]; i++) hl.add(i);
			continue;
		}
		if (!q) continue;
		const at = full.indexOf(q);
		if (at < 0) continue;
		toks.forEach((t, i) => {
			if (t.c1 > at && t.c0 < at + q.length) hl.add(i);
		});
	}
	const ev = ((u.evidence ?? []).length ? (u.evidence ?? []) : [0]).filter(s => s < sr.length);
	const evIdx = ev.flatMap(s => Array.from({ length: sr[s][1] - sr[s][0] }, (_, k) => sr[s][0] + k));
	// Key: the model's words, each slid from the author's word it matches in the Brief sentences
	const kt: Aligned[] = tokenize(u.key).map(x => ({ ...x, id: "" }));
	for (const [bi, kj] of lcsPairs(kt.map(x => norm(x.t)), evIdx.map(i => norm(toks[i].t)))) kt[bi].m = evIdx[kj];
	kt.forEach((x, j) => {
		x.id = x.m !== undefined ? pre + x.m : `${pre}w${j}`;
		x.hl = x.m !== undefined && hl.has(x.m);
	});
	// Takeaway: the head of Key (the same words), else its own words aligned the same way
	const tkTok = tokenize(u.takeaway);
	let tt: Aligned[];
	if (tkTok.length <= kt.length && tkTok.every((x, j) => x.t === kt[j].t)) tt = kt.slice(0, tkTok.length).map(x => ({ ...x }));
	else {
		tt = tkTok.map(x => ({ ...x, id: "" }));
		for (const [bi, kj] of lcsPairs(tt.map(x => norm(x.t)), kt.map(x => norm(x.t)))) {
			tt[bi].id = kt[kj].id;
			tt[bi].hl = kt[kj].hl;
		}
		tt.forEach((x, j) => {
			if (!x.id) x.id = `${pre}x${j}`;
		});
	}
	if (tt.length) delete tt[tt.length - 1].s;
	// Topic: a run of the takeaway's words, else matched word by word, else its own
	const loc = locate(u.topic, tt);
	let tp: Aligned[];
	if (loc.length) tp = loc.map(i => ({ ...tt[i] }));
	else {
		tp = tokenize(u.topic).map(x => ({ ...x, id: "" }));
		for (const [bi, kj] of lcsPairs(tp.map(x => norm(x.t)), tt.map(x => norm(x.t)))) tp[bi].id = tt[kj].id;
		tp.forEach((x, j) => {
			if (!x.id) x.id = `${pre}q${j}`;
		});
	}
	if (tp.length) delete tp[tp.length - 1].s;
	return { id: u.id, pre, toks, sr, hl, ev, kt, km: new Set(kt.map(x => x.m).filter((x): x is number => x !== undefined)), tt, tp, inTopic: new Set(tp.map(x => x.id)), sentences };
}

/** What a unit shows at a level, as pieces with ids (TextFold's pieces()). `unfolded`: the unit opened at Full. */
export function piecesOf(u: PreparedUnit, level: Level, unfolded = false): Piece[] {
	const out: Piece[] = [];
	const { pre } = u;
	if (level === "full" || unfolded) {
		const ev = new Set(u.ev);
		u.sr.forEach(([a, b], s) => {
			for (let i = a; i < b; i++) out.push({ id: pre + i, t: u.toks[i].t, s: !!u.toks[i].s, lead: ev.has(s), hl: u.hl.has(i) });
		});
	} else if (level === "brief") {
		// a gap (…) wherever sentences were left out: before, between and after the ones kept, as in TextFold
		let prevEnd = 0;
		for (const s of u.ev) {
			const [a, b] = u.sr[s];
			if (a !== prevEnd) out.push({ id: `${pre}gap${s}`, t: "…", gap: true });
			for (let i = a; i < b; i++) out.push({ id: pre + i, t: u.toks[i].t, s: !!u.toks[i].s, lead: u.km.has(i), hl: u.hl.has(i) });
			prevEnd = b;
		}
		if (out.length && prevEnd < u.toks.length) out.push({ id: `${pre}gapz`, t: "…", gap: true });
	} else if (level === "key") {
		const tn = u.tt.length;
		u.kt.forEach((x, j) => out.push({ id: x.id, t: x.t, s: !!x.s, lead: j < tn, hl: x.hl }));
	} else if (level === "takeaway") {
		u.tt.forEach(x => out.push({ id: x.id, t: x.t, s: !!x.s, lead: u.inTopic.has(x.id), hl: x.hl }));
	} else u.tp.forEach(x => out.push({ id: x.id, t: x.t, s: !!x.s, lead: true, hl: x.hl }));
	return out;
}

/** A section's own summary words (Key and up) and topic, with ids. */
export function prepSection(s: DocSection): { tk: Piece[]; tp: Piece[] } {
	const pre = `${s.id}:`;
	const tk = tokenize(s.takeaway).map((x, j) => ({ id: `${pre}s${j}`, t: x.t, s: !!x.s, lead: true }));
	if (tk.length) tk[tk.length - 1].s = false;
	const loc = locate(s.topic, tk);
	const tp = loc.length ? loc.map(i => ({ ...tk[i] })) : tokenize(s.topic).map((x, j) => ({ id: `${pre}q${j}`, t: x.t, s: !!x.s, lead: true }));
	if (tp.length) tp[tp.length - 1].s = false;
	return { tk, tp };
}

/** Pieces as plain text (a row drawn before it is near the viewport). */
export function piecesText(pcs: Piece[]): string {
	return pcs.map((x, n) => x.t + (n < pcs.length - 1 && (x.gap || x.s || pcs[n + 1].gap) ? " " : "")).join("");
}

/** Which of a rendered text's words are which of a unit's: indexes into `units`' tokens for each rendered word, matched
 *  in order by their compared forms (words the rendering adds, such as a link's address, stay unmatched). */
export function alignRendered(rendered: string[], units: Token[]): (number | undefined)[] {
	const out: (number | undefined)[] = rendered.map(() => undefined);
	for (const [i, j] of lcsPairs(rendered.map(sq), units.map(x => sq(x.t)))) out[i] = j;
	return out;
}
