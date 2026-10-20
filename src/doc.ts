// A document in the TextFold format (`textfold/doc`, version 0; docs/format.md in TextFold), as GET /api/doc/<id>
// gives it: its sections and units at the five levels. The plugin uses it for section names, reading order, the cite
// labels of answers and the hover previews. Pure functions without runtime imports from obsidian.
import { Level } from "./links";

export interface DocUnit {
	id: string;
	kind: string; // paragraph, list item, caption, abstract
	role: string; // context, gap, claim, method, setup, result, analysis, limitation
	full: string;
	sentences: string[];
	evidence: number[]; // the sentences the written levels rest on (Brief is exactly these)
	brief: string[];
	key: string;
	takeaway: string;
	topic: string;
}

export interface DocSection {
	id: string;
	num: string;
	title: string;
	depth: number;
	takeaway: string; // the section's summary, written by the model
	topic: string;
	units: DocUnit[];
}

export interface Doc {
	id: string;
	lang: string;
	title: string;
	authors: string[];
	date: string;
	source: { kind: string; url: string; label: string };
	sections: DocSection[];
	local: boolean; // no model has written its levels yet
	model: string; // the model that wrote them
	made: string; // when
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseDoc(data: unknown): Doc | null {
	const o = obj(data);
	if (o.format !== "textfold/doc" || !str(o.id)) return null;
	const source = obj(o.source);
	return {
		id: str(o.id),
		lang: str(o.lang) || "en",
		title: str(o.title),
		authors: strs(o.authors),
		date: str(o.date),
		source: { kind: str(source.kind), url: str(source.url), label: str(source.label) },
		sections: (Array.isArray(o.sections) ? o.sections : []).map((s): DocSection => {
			const c = obj(s);
			return {
				id: str(c.id),
				num: str(c.num),
				title: str(c.title),
				depth: typeof c.depth === "number" ? c.depth : 1,
				takeaway: str(c.takeaway),
				topic: str(c.topic),
				units: (Array.isArray(c.units) ? c.units : []).map((u): DocUnit => {
					const x = obj(u);
					const evidence = Array.isArray(x.evidence) ? x.evidence.filter((n): n is number => typeof n === "number") : [];
					return { id: str(x.id), kind: str(x.kind), role: str(x.role), full: str(x.full), sentences: strs(x.sentences), evidence, brief: strs(x.brief), key: str(x.key), takeaway: str(x.takeaway), topic: str(x.topic) };
				}),
			};
		}),
		local: obj(o.provenance).local === true,
		model: str(obj(o.provenance).model),
		made: str(obj(o.provenance).levels_made),
	};
}

/** What TextFold's reader calls a section: its number and title ("3 Results"); formulas without their dollars. */
export function sectionName(s: DocSection): string {
	return `${s.num ? `${s.num} ` : ""}${s.title.replace(/\$/g, "")}`.trim(); // "" for the untitled opening section
}

/** A unit's text at a level: the author's words at Full and Brief, the model's at Key, Takeaway and Topic; the full
 *  text when the level has nothing (a document read as written, without levels). */
export function unitText(u: DocUnit, level: Level): string {
	const text = level === "full" ? u.full : level === "brief" ? u.brief.join(" ") : level === "key" ? u.key : level === "takeaway" ? u.takeaway : u.topic || u.takeaway;
	return text.trim() || u.full;
}

/** A section's summary at a level: its topic at Topic, else its takeaway; "" when no model has written one. */
export function sectionSummary(s: DocSection, level: Level): string {
	return (level === "topic" ? s.topic || s.takeaway : s.takeaway).trim();
}

/** A section as TextFold's reader drags it by its heading: its name ("2.1 Method"), and its text at a level in blocks
 *  separated by blank lines. At Key, Takeaway and Topic the section's own block is its summary line and a "- " line
 *  per paragraph, and each subsection's block its name, its summary and its paragraphs the same way; at Full and Brief
 *  every paragraph is a block of its own, each subsection's name a block before its paragraphs. `units` are all the
 *  paragraphs, subsections' included, in reading order. */
export function sectionText(index: DocIndex, id: string, level: Level): { heading: string; text: string; units: string[] } | null {
	const all = index.withSubsections(id);
	if (!all.length) return null;
	const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
	const blocks: string[] = [];
	all.forEach((x, i) => {
		const name = i > 0 ? sectionName(x) : "";
		if (isWritten(level)) {
			const lines = [name, sectionSummary(x, level), ...x.units.map(u => `- ${oneLine(unitText(u, level))}`)].filter(Boolean);
			if (lines.length) blocks.push(lines.join("\n"));
		} else {
			if (name && x.units.length) blocks.push(name);
			for (const u of x.units) blocks.push(unitText(u, level));
		}
	});
	return { heading: sectionName(all[0]), text: blocks.join("\n\n"), units: all.flatMap(x => x.units.map(u => u.id)) };
}

/** Whether a level's text is a model's words (Key, Takeaway, Topic) rather than the author's (Full, Brief). */
export function isWritten(level: Level): boolean {
	return level === "key" || level === "takeaway" || level === "topic";
}

/** Where things are in a document: each unit's section and place in reading order. */
export class DocIndex {
	readonly sections = new Map<string, DocSection>();
	private unitSection = new Map<string, DocSection>();
	private units = new Map<string, DocUnit>();
	private list: DocUnit[] = []; // in reading order
	private order = new Map<string, number>();
	private sectionOrder = new Map<string, number>();

	constructor(readonly doc: Doc) {
		let n = 0;
		for (const s of doc.sections) {
			this.sections.set(s.id, s);
			this.sectionOrder.set(s.id, n);
			for (const u of s.units) {
				this.units.set(u.id, u);
				this.unitSection.set(u.id, s);
				this.order.set(u.id, n++);
				this.list.push(u);
			}
		}
	}

	unit(id: string): DocUnit | undefined {
		return this.units.get(id);
	}

	sectionOf(unit?: string | null, section?: string | null): DocSection | undefined {
		return (unit ? this.unitSection.get(unit) : undefined) ?? (section ? this.sections.get(section) : undefined);
	}

	/** A place in reading order: a paragraph by its order, a note on a section just before the section's paragraphs. */
	place(unit?: string | null, section?: string | null): number {
		if (unit && this.order.has(unit)) return this.order.get(unit) ?? 0;
		if (section && this.sectionOrder.has(section)) return (this.sectionOrder.get(section) ?? 0) - 0.5;
		return Number.MAX_SAFE_INTEGER;
	}

	/** The paragraphs from one to another in reading order (either way round, as TextFold's reader takes #u=…&to=…);
	 *  the first alone when the other is not in the document, none when the first is not. */
	range(from: string, to?: string): DocUnit[] {
		const a = this.order.get(from);
		if (a === undefined) return [];
		const b = to === undefined ? undefined : this.order.get(to);
		if (b === undefined) return [this.list[a]];
		return this.list.slice(Math.min(a, b), Math.max(a, b) + 1);
	}

	/** A section with its subsections: the sections after it that are deeper, up to one at its depth or above (so a
	 *  "2 Experiments" without paragraphs of its own brings 2.1–2.4 with it), as TextFold's reader drags a section. */
	withSubsections(id: string): DocSection[] {
		const all = this.doc.sections;
		const i = all.findIndex(x => x.id === id);
		if (i < 0) return [];
		const out = [all[i]];
		for (let j = i + 1; j < all.length && all[j].depth > all[i].depth; j++) out.push(all[j]);
		return out;
	}

	/** A cited paragraph as TextFold's reader labels it: its section and its place in it (§3 ¶2). */
	citeLabel(uid: string): string {
		const s = this.unitSection.get(uid);
		if (!s) return uid;
		const where = s.num ? (/\s/.test(s.num) ? s.num : `§${s.num}`) : s.title.replace(/\$/g, "") || s.id;
		const k = s.units.findIndex(u => u.id === uid);
		return s.units.length > 1 && k >= 0 ? `${where} ¶${k + 1}` : where;
	}
}

/** The year of a document's date ("2024", "2024-05-01"), if it has one. */
export function yearOf(date: string): number | undefined {
	const m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(date);
	return m ? Number(m[1]) : undefined;
}
