import { describe, expect, it } from "vitest";
import { citationLinks, noteLine, noteLink, parseNotes, parsePapers } from "../src/notes";

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
