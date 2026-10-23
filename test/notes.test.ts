import { describe, expect, it } from "vitest";
import { citationLinks, isModelPassage, noteLine, noteLink, notePassage, parseNotes, parsePapers, passageLabel } from "../src/notes";

// the shape of TextFold's notes.json (docs/notes-format.md), with made-up text
const file = {
	format: "textfold/notes",
	version: 1,
	paper: { id: "pdf-357ae69fe0759131", version: "", title: "Convex Partition Zoner", url: "" },
	notes: [
		{
			id: "n-hl1", kind: "highlight", created: "2026-10-03T10:00:00Z", updated: "2026-10-03T10:05:00Z",
			anchor: { unit: "u12", section: "S2", lang: "en", level: 4, tokens: [1, 5], sents: [0], quote: { exact: "zones  are\nconvex", prefix: "", suffix: "" } },
			text: "", thread: [],
		},
		{
			id: "n-ask1", kind: "ask", created: "2026-10-14T08:00:00Z", updated: "2026-10-14T08:01:00Z",
			anchor: { unit: null, section: null, on: "paper", lang: "en", level: 2, tokens: null, sents: [], quote: { exact: "", prefix: "", suffix: "" } },
			text: "", thread: [{ q: "What is new?", a: "A partition [[u6]], fast [[?]].", takeaway: "Convex zones.", cites: ["u6"], next: [], model: "m", lang: "en", at: "" }],
		},
		{ id: "n-x", kind: "drawing", anchor: {} },
		{ kind: "note", anchor: {} },
	],
};

describe("parseNotes", () => {
	it("reads TextFold's notes and leaves out what it cannot show", () => {
		const nf = parseNotes(file, "pdf-357ae69fe0759131");
		expect(nf.paper).toEqual({ id: "pdf-357ae69fe0759131", title: "Convex Partition Zoner" });
		expect(nf.notes.map(n => n.id)).toEqual(["n-hl1", "n-ask1"]);
		expect(nf.notes[0]).toMatchObject({ kind: "highlight", quote: "zones  are\nconvex", unit: "u12", level: "full", lang: "en" });
		expect(nf.notes[1]).toMatchObject({ kind: "ask", on: "paper", level: "key", unit: undefined });
		expect(nf.notes[1].thread[0]).toMatchObject({ q: "What is new?", takeaway: "Convex zones.", pending: false });
	});

	it("gives an empty file for an answer without notes", () => {
		expect(parseNotes({}, "x1")).toEqual({ paper: { id: "x1", title: "x1" }, notes: [] });
	});
});

describe("noteLine and noteLink", () => {
	const [hl, ask] = parseNotes(file, "p").notes;

	it("shows a highlight's passage and an Ask's first question on one line", () => {
		expect(noteLine(hl)).toBe("zones are convex");
		expect(noteLine(ask)).toBe("What is new?");
	});

	it("opens the reader at the note, its paragraph, level and language", () => {
		expect(noteLink("p", hl)).toEqual({ paper: "p", n: "n-hl1", u: "u12", level: "full", lang: "en" });
		expect(noteLink("p", ask)).toEqual({ paper: "p", n: "n-ask1", level: "key", lang: "en" });
	});
});

describe("a note made on a written line", () => {
	const [key, take, bad] = parseNotes({
		notes: [
			{ id: "n-key", kind: "highlight", anchor: { unit: "u12", level: 2, tokens: [1, 5], quote: { exact: "zones are convex" }, shown: { words: [0, 3], exact: "Zones  are\nconvex, fast" } }, text: "", thread: [] },
			{ id: "n-take", kind: "note", anchor: { unit: "u12", level: 1, tokens: null, quote: { exact: "fast" }, shown: { words: [3, 3], exact: "fast" } }, text: "Why?", thread: [] },
			{ id: "n-bad", kind: "highlight", anchor: { unit: "u12", level: 2, quote: { exact: "zones" }, shown: { words: "0-3", exact: "Zones" } }, text: "", thread: [] },
		],
	}, "p").notes;

	it("keeps the line's words as the model wrote them, and the author's in the quote", () => {
		expect(key).toMatchObject({ quote: "zones are convex", shown: { words: [0, 3], exact: "Zones  are\nconvex, fast" }, level: "key" });
		expect(bad.shown).toBeUndefined();
	});

	it("shows the line's words, and says whose they are and at which level", () => {
		expect(notePassage(key)).toBe("Zones  are\nconvex, fast");
		expect(noteLine(key)).toBe("Zones are convex, fast");
		expect(noteLine(take)).toBe("Why?");
		expect(passageLabel(key)).toBe("at Key, in the model’s words");
		expect(passageLabel(take)).toBe("at Takeaway, in the model’s words");
		expect(notePassage(bad)).toBe("zones");
		expect(passageLabel(bad)).toBe("");
	});

	it("tells a line in the model's words from the reader's", () => {
		expect(isModelPassage(key, noteLine(key))).toBe(true);
		expect(isModelPassage(take, noteLine(take))).toBe(false);
		expect(isModelPassage(bad, "zones")).toBe(false);
		expect(isModelPassage(undefined, "zones")).toBe(false);
	});
});

describe("citationLinks", () => {
	it("turns citations into reader links, never wikilinks", () => {
		expect(citationLinks("A partition [[u6]], fast [[?]], lost [[!12]].", "p"))
			.toBe("A partition [u6](textfold://open?paper=p&u=u6), fast *(inference)*, lost `?12`.");
	});
});

describe("parsePapers", () => {
	it("reads the documents TextFold lists, with a citekey when there is one", () => {
		const papers = parsePapers([
			{ id: "pdf-357ae69fe0759131", title: "Convex Partition Zoner", authors: ["Xiang, Jialiang"], langs: ["en"], notes: 1, zotero: true },
			{ id: "zotero-g1-abc", title: "", authors: [], notes: 0, zotero: { citekey: "smith2024" } },
			{ id: "../bad", title: "x" },
			"junk",
		]);
		expect(papers).toEqual([
			{ id: "pdf-357ae69fe0759131", title: "Convex Partition Zoner", authors: ["Xiang, Jialiang"], citekey: undefined, notes: 1 },
			{ id: "zotero-g1-abc", title: "zotero-g1-abc", authors: [], citekey: "smith2024", notes: 0 },
		]);
		expect(parsePapers({ error: "x" })).toEqual([]);
	});
});
