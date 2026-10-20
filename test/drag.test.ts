import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/doc";
import { DRAG_MIME, DragItem, formatItem, isItem, itemFromLink, itemLabel, itemSentence, jsonFromHtml, linkFromText, parseDragJson, readTransfer, toDragJson } from "../src/drag";
import { parseNotes } from "../src/notes";

// what TextFold's reader sends when a paragraph is dragged at Key (the contract, with made-up text)
const wire = {
	format: "textfold/drag", version: 1, paper: "2602.07369", title: "Convex Primitive Decomposition: Fast and Exact", authors: ["Chen, Xia"],
	citekey: "chenConvexPrimitive2026", section: { id: "S3", num: "3", title: "Method" }, kind: "paragraph", level: "key", lang: "en",
	text: "Primitives are fitted greedily. Each is convex.", written: true, link: "textfold://open?paper=2602.07369&u=S3.p2&level=key",
};

const transfer = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? "" });

describe("parseDragJson", () => {
	it("reads TextFold's drag JSON", () => {
		const item = parseDragJson(JSON.stringify(wire))!;
		expect(item).toMatchObject({ paper: "2602.07369", kind: "paragraph", level: "key", written: true, citekey: "chenConvexPrimitive2026", section: { id: "S3", num: "3", title: "Method" } });
		expect(item.link).toEqual({ paper: "2602.07369", u: "S3.p2", level: "key" });
	});

	it("refuses other formats and bad ids", () => {
		expect(parseDragJson(JSON.stringify({ ...wire, format: "textfold/notes" }))).toBeNull();
		expect(parseDragJson(JSON.stringify({ ...wire, version: 2 }))).toBeNull();
		expect(parseDragJson(JSON.stringify({ ...wire, paper: "../x" }))).toBeNull();
		expect(parseDragJson("not json")).toBeNull();
	});

	it("writes the link anew: another scheme or another document's link becomes the document's", () => {
		expect(parseDragJson(JSON.stringify({ ...wire, link: "https://example.org/x" }))!.link).toEqual({ paper: "2602.07369" });
		expect(parseDragJson(JSON.stringify({ ...wire, link: "textfold://open?paper=other" }))!.link).toEqual({ paper: "2602.07369" });
	});

	it("takes a missing section, level and comment", () => {
		const item = parseDragJson(JSON.stringify({ ...wire, section: null, level: "huge", comment: "Mine." }))!;
		expect(item.section).toBeNull();
		expect(item.level).toBeUndefined();
		expect(item.comment).toBe("Mine.");
	});

	it("round-trips through toDragJson", () => {
		const item = parseDragJson(JSON.stringify(wire))!;
		expect(parseDragJson(toDragJson(item))).toEqual(item);
	});
});

describe("reading a transfer", () => {
	it("prefers the JSON type, then the HTML attribute, then a lone link", () => {
		const html = `<div data-textfold="${JSON.stringify({ ...wire, kind: "note" }).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Primitives…</div>`;
		const a = readTransfer(transfer({ [DRAG_MIME]: JSON.stringify(wire), "text/html": html, "text/plain": "x" }));
		expect(a && isItem(a) && a.kind).toBe("paragraph");
		const b = readTransfer(transfer({ "text/html": html, "text/plain": "Primitives…" }));
		expect(b && isItem(b) && b.kind).toBe("note");
		const c = readTransfer(transfer({ "text/uri-list": "# a comment\ntextfold://open?paper=2602.07369&s=S3\n" }));
		expect(c).toEqual({ paper: "2602.07369", s: "S3" });
		expect(readTransfer(transfer({ "text/plain": "textfold://open?paper=x1" }))).toEqual({ paper: "x1" });
	});

	it("leaves every other drop alone", () => {
		expect(readTransfer(transfer({ "text/plain": "Some text with textfold://open?paper=x1 inside" }))).toBeNull();
		expect(readTransfer(transfer({ "text/uri-list": "https://example.org" }))).toBeNull();
		expect(readTransfer(transfer({ "text/html": "<b>bold</b>" }))).toBeNull();
		expect(readTransfer(transfer({}))).toBeNull();
	});

	it("unescapes the attribute in single or double quotes", () => {
		expect(jsonFromHtml(`<p data-textfold='{"a":"&lt;b&gt; &#39;x&#39;"}'>t</p>`)).toBe(`{"a":"<b> 'x'"}`);
		expect(jsonFromHtml("<p>none</p>")).toBeNull();
		expect(linkFromText("textfold://open?paper=a\ntextfold://open?paper=b")).toBeNull();
	});
});

describe("formatItem", () => {
	const item = parseDragJson(JSON.stringify({ ...wire, comment: "Check the proof." }))!;

	it("makes a callout: title and section, text, comment, link; marked as the model's words", () => {
		expect(formatItem(item, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> Primitives are fitted greedily. Each is convex.",
			">",
			"> Check the proof.",
			">",
			"> [Open in TextFold](textfold://open?paper=2602.07369&u=S3.p2&level=key)",
		].join("\n"));
	});

	it("makes a quote with the link, or the link alone", () => {
		expect(formatItem({ ...item, comment: undefined, written: false }, "quote")).toBe([
			"> Primitives are fitted greedily. Each is convex.",
			">",
			"> — [Convex Primitive Decomposition › 3 Method](textfold://open?paper=2602.07369&u=S3.p2&level=key)",
		].join("\n"));
		expect(formatItem(item, "quote")).toContain("· *written by the model*");
		expect(formatItem(item, "link")).toBe("[Convex Primitive Decomposition › 3 Method](textfold://open?paper=2602.07369&u=S3.p2&level=key)");
	});

	it("keeps text as text: citations become links, no wikilinks, every line quoted", () => {
		const md = formatItem({ ...item, comment: undefined, text: "A claim [[S3.p1]] and [[Another note]].\n\nSecond paragraph." }, "callout");
		expect(md).toContain("> A claim ([S3.p1](textfold://open?paper=2602.07369&u=S3.p1)) and \\[\\[Another note]].");
		expect(md.split("\n").every(l => l.startsWith(">"))).toBe(true);
	});

	it("leaves the reader's own comment as written, its [[ ]] escaped rather than made a citation", () => {
		const md = formatItem({ ...item, written: false, text: "Author's words [[S3.p1]].", comment: "See [[frjyhfh]]." }, "callout");
		expect(md).toContain("> Author's words \\[\\[S3.p1]].");
		expect(md).toContain("> See \\[\\[frjyhfh]].");
	});

	it("shows a note as its passage, then the reader's words, as TextFold sends it", () => {
		const note = parseDragJson(JSON.stringify({ ...wire, kind: "note", level: "full", text: "Why greedy?", quote: "fitted greedily", comment: "Why greedy?", written: false, link: "textfold://open?paper=2602.07369&n=n-1&lang=en" }))!;
		expect(formatItem(note, "callout")).toBe([
			"> [!textfold] Convex Primitive Decomposition › 3 Method",
			"> fitted greedily",
			">",
			"> Why greedy?",
			">",
			"> [Open in TextFold](textfold://open?paper=2602.07369&n=n-1&lang=en)",
		].join("\n"));
	});

	it("shows an Ask as passage, question and the model's answer", () => {
		const ask = parseDragJson(JSON.stringify({ ...wire, kind: "ask", text: "Yes, always [[S3.p2]].", quote: "Each is convex.", comment: "Always?", written: true, link: "textfold://open?paper=2602.07369&n=n-2" }))!;
		expect(formatItem(ask, "callout").split("\n").slice(0, 6)).toEqual([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> Each is convex.",
			">",
			"> **Always?**",
			">",
			"> Yes, always ([S3.p2](textfold://open?paper=2602.07369&u=S3.p2)).",
		]);
	});

	it("says what an item without text is", () => {
		const bare: DragItem = { paper: "x1", title: "x1", authors: [], section: null, kind: "paper", text: "", written: true, link: { paper: "x1" } };
		expect(formatItem(bare, "callout")).toBe("> [!textfold] x1\n>\n> [Open in TextFold](textfold://open?paper=x1)");
		expect(itemLabel(bare)).toBe("x1");
	});
});

describe("itemFromLink", () => {
	const doc = parseDoc({
		format: "textfold/doc", version: 0, id: "2602.07369", title: "Convex Primitive Decomposition: Fast and Exact", authors: ["Chen, Xia"], date: "2026",
		source: {}, provenance: { local: false },
		sections: [{ id: "S3", num: "3", title: "Method", takeaway: "Greedy fitting of convex primitives", topic: "greedy fitting", units: [
			{ id: "S3.p2", kind: "paragraph", full: "Primitives are fitted greedily. Each is convex.", brief: ["Primitives are fitted greedily."], key: "Greedy fitting, convex primitives.", takeaway: "Greedy fitting", topic: "" },
			{ id: "S3.p3", kind: "paragraph", full: "No levels yet.", brief: [], key: "", takeaway: "", topic: "" },
		] }],
	});
	const nf = parseNotes({ paper: { id: "2602.07369", title: "t" }, notes: [
		{ id: "n-1", kind: "highlight", anchor: { unit: "S3.p2", section: "S3", quote: { exact: "fitted greedily" } }, text: "Why greedy?", thread: [] },
		{ id: "n-2", kind: "ask", anchor: { unit: "S3.p2", section: "S3", quote: { exact: "Each is convex." } }, text: "", thread: [{ q: "Always?", a: "Yes [[S3.p2]].", takeaway: "Yes." }] },
	] }, "2602.07369");

	it("fills a paragraph link from the document, at its level", () => {
		const it = itemFromLink({ paper: "2602.07369", u: "S3.p2", level: "takeaway" }, doc, null);
		expect(it).toMatchObject({ kind: "paragraph", text: "Greedy fitting", written: true, section: { id: "S3", num: "3", title: "Method" } });
		expect(itemFromLink({ paper: "2602.07369", u: "S3.p2" }, doc, null)).toMatchObject({ text: "Primitives are fitted greedily. Each is convex.", written: false });
		expect(itemFromLink({ paper: "2602.07369", u: "S3.p3", level: "key" }, doc, null)).toMatchObject({ text: "No levels yet.", written: false });
	});

	it("fills a section link with its summary", () => {
		expect(itemFromLink({ paper: "2602.07369", s: "S3", level: "topic" }, doc, null)).toMatchObject({ kind: "section", text: "greedy fitting", written: true });
	});

	it("fills a note link with the passage and comment, an Ask with its question and answer", () => {
		expect(itemFromLink({ paper: "2602.07369", n: "n-1" }, doc, nf)).toMatchObject({ kind: "note", text: "Why greedy?", quote: "fitted greedily", comment: "Why greedy?", written: false });
		expect(itemFromLink({ paper: "2602.07369", n: "n-2" }, doc, nf)).toMatchObject({ kind: "ask", text: "Yes.", quote: "Each is convex.", comment: "Always?", written: true });
	});

	it("names the document when TextFold gave nothing", () => {
		expect(itemFromLink({ paper: "x1" }, null, null)).toMatchObject({ title: "x1", kind: "paper", text: "" });
		expect(itemFromLink({ paper: "2602.07369" }, doc, null)).toMatchObject({ kind: "paper", text: "Chen, Xia · 2026" });
	});
});

describe("text with a TextFold icon", () => {
	const of = (o: Record<string, unknown>) => parseDragJson(JSON.stringify({ ...wire, ...o }))!;

	it("writes the text, then a ↗ link back", () => {
		expect(formatItem(of({}), "icon")).toBe("Primitives are fitted greedily. Each is convex. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)");
	});

	it("reads each kind as it was dragged, on one line", () => {
		expect(itemSentence(of({ kind: "summary", text: "Greedy fitting\nof primitives", link: "textfold://open?paper=2602.07369&s=S3&level=key" }))).toBe("Greedy fitting of primitives");
		expect(itemSentence(of({ kind: "selection", text: "fitted greedily", quote: "fitted greedily", written: false }))).toBe("fitted greedily");
		expect(itemSentence(of({ kind: "chip", text: "greedy fitting", level: "topic" }))).toBe("greedy fitting");
		expect(itemSentence(of({ kind: "note", text: "Why greedy?", quote: "fitted greedily", comment: "Why greedy?", written: false }))).toBe("fitted greedily — Why greedy?");
		expect(itemSentence(of({ kind: "note", text: "fitted greedily", quote: "fitted greedily", written: false }))).toBe("fitted greedily");
		expect(itemSentence(of({ kind: "ask", text: "Yes, always [[S3.p2]].", quote: "Each is convex.", comment: "Always?" }))).toBe("Yes, always ([S3.p2](textfold://open?paper=2602.07369&u=S3.p2)).");
	});

	it("keeps text as text, and names the document when nothing was dragged", () => {
		expect(formatItem(of({ text: "See [[Other note]].", written: false }), "icon")).toBe("See \\[\\[Other note]]. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)");
		expect(formatItem(of({ text: "", section: null, kind: "paragraph" }), "icon")).toBe("Convex Primitive Decomposition [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)");
	});
});

