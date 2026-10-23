import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/doc";
import { DRAG_MIME, DragItem, formatItem, isItem, itemFromLink, itemLabel, itemSentence, jsonFromHtml, linkFromText, keepOutOfLists, multiLine, parseDragJson, readTransfer, toDragJson } from "../src/drag";
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

	it("makes a callout: title and section, text, comment ending in the icon link; marked as the model's words", () => {
		expect(formatItem(item, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> Primitives are fitted greedily. Each is convex.",
			">",
			"> Check the proof. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)",
		].join("\n"));
	});

	it("makes a quote with the link, or the link alone", () => {
		expect(formatItem({ ...item, comment: undefined, written: false }, "quote")).toBe(
			"> Primitives are fitted greedily. Each is convex. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)",
		);
		expect(formatItem(item, "quote")).toBe([
			"> Primitives are fitted greedily. Each is convex.",
			">",
			"> Check the proof. *(written by the model)* [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)",
		].join("\n"));
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
			"> Why greedy? [↗](textfold://open?paper=2602.07369&n=n-1&lang=en)",
		].join("\n"));
	});

	it("marks a highlight made on a written line as the model's words, as TextFold 0.10.28 sends it", () => {
		const hl = parseDragJson(JSON.stringify({ ...wire, kind: "note", level: "key", text: "fitted one by one", quote: "fitted one by one", comment: "", written: true, link: "textfold://open?paper=2602.07369&n=n-3&level=key" }))!;
		expect(formatItem(hl, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> fitted one by one [↗](textfold://open?paper=2602.07369&n=n-3&level=key)",
		].join("\n"));
		expect(formatItem(hl, "quote")).toBe("> fitted one by one *(written by the model)* [↗](textfold://open?paper=2602.07369&n=n-3&level=key)");
	});

	it("shows an Ask as passage, question and the model's answer", () => {
		const ask = parseDragJson(JSON.stringify({ ...wire, kind: "ask", text: "Yes, always [[S3.p2]].", quote: "Each is convex.", comment: "Always?", written: true, link: "textfold://open?paper=2602.07369&n=n-2" }))!;
		expect(formatItem(ask, "callout").split("\n").slice(0, 6)).toEqual([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> Each is convex.",
			">",
			"> **Always?**",
			">",
			"> Yes, always ([S3.p2](textfold://open?paper=2602.07369&u=S3.p2)). [↗](textfold://open?paper=2602.07369&n=n-2)",
		]);
	});

	it("says what an item without text is", () => {
		const bare: DragItem = { paper: "x1", title: "x1", authors: [], section: null, kind: "paper", text: "", written: true, link: { paper: "x1" } };
		expect(formatItem(bare, "callout")).toBe("> [!textfold] x1 [↗](textfold://open?paper=x1)");
		expect(formatItem(bare, "quote")).toBe("> x1 [↗](textfold://open?paper=x1)");
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

	it("fills a section link with its heading, summary and paragraphs, as TextFold drags a section", () => {
		expect(itemFromLink({ paper: "2602.07369", s: "S3", level: "topic" }, doc, null)).toMatchObject({   // (its card on the map)
			kind: "section", heading: "3 Method", text: "Greedy fitting of convex primitives\nGreedy fitting · No levels yet.", units: ["S3.p2", "S3.p3"], written: true,
		});
		expect(itemFromLink({ paper: "2602.07369", s: "S3", level: "full" }, doc, null)).toMatchObject({
			text: "Primitives are fitted greedily. Each is convex.\n\nNo levels yet.", written: false,
		});
	});

	it("fills a range link with a block per paragraph", () => {
		const it = itemFromLink({ paper: "2602.07369", u: "S3.p3", to: "S3.p2", level: "takeaway" }, doc, null);
		expect(it).toMatchObject({ kind: "selection", text: "Greedy fitting\n\nNo levels yet.", units: ["S3.p2", "S3.p3"], written: true, link: { u: "S3.p3", to: "S3.p2" } });
		expect(itemFromLink({ paper: "2602.07369", u: "S3.p2", to: "S9.p1" }, doc, null)).toMatchObject({ kind: "paragraph", units: ["S3.p2"] });
	});

	it("fills a link to one turn with that turn's answer, its question as the comment", () => {
		const chat = parseNotes({ paper: { id: "2602.07369", title: "t" }, notes: [
			{ id: "n-chat", kind: "ask", anchor: { unit: null, section: null, on: "paper", quote: { exact: "" } }, text: "", thread: [{ q: "First?", a: "One.", takeaway: "1" }, { q: "Second?", a: "Two [[S3.p2]].", takeaway: "2" }] },
		] }, "2602.07369");
		expect(itemFromLink({ paper: "2602.07369", n: "n-chat", t: 1 }, doc, chat)).toMatchObject({ kind: "ask", text: "Two [[S3.p2]].", comment: "Second?", written: true, link: { t: 1 } });
		expect(itemFromLink({ paper: "2602.07369", n: "n-chat" }, doc, chat)).toMatchObject({ kind: "ask", text: "2", comment: "First?" });
	});

	it("fills a note link with the passage and comment, an Ask with its question and answer", () => {
		expect(itemFromLink({ paper: "2602.07369", n: "n-1" }, doc, nf)).toMatchObject({ kind: "note", text: "Why greedy?", quote: "fitted greedily", comment: "Why greedy?", written: false });
		expect(itemFromLink({ paper: "2602.07369", n: "n-2" }, doc, nf)).toMatchObject({ kind: "ask", text: "Yes.", quote: "Each is convex.", comment: "Always?", written: true });
	});

	it("fills a note made on a written line with the line's words, the model's unless the reader wrote a comment", () => {
		const key = parseNotes({ paper: { id: "2602.07369", title: "t" }, notes: [
			{ id: "n-key", kind: "highlight", anchor: { unit: "S3.p2", section: "S3", level: 2, tokens: [0, 3], quote: { exact: "Primitives are fitted greedily." }, shown: { words: [0, 3], exact: "fitted one by one" } }, text: "", thread: [] },
			{ id: "n-key2", kind: "highlight", anchor: { unit: "S3.p2", section: "S3", level: 2, tokens: [0, 3], quote: { exact: "Primitives are fitted greedily." }, shown: { words: [0, 3], exact: "fitted one by one" } }, text: "Why?", thread: [] },
		] }, "2602.07369");
		expect(itemFromLink({ paper: "2602.07369", n: "n-key" }, doc, key)).toMatchObject({ kind: "note", text: "fitted one by one", quote: "fitted one by one", written: true });
		expect(itemFromLink({ paper: "2602.07369", n: "n-key2" }, doc, key)).toMatchObject({ kind: "note", text: "Why?", quote: "fitted one by one", comment: "Why?", written: false });
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

describe("messages of a conversation and Topic cards, as TextFold sends them", () => {
	const chat = (o: Record<string, unknown>) => parseDragJson(JSON.stringify({ ...wire, section: null, kind: "ask", level: "key", ...o }))!;

	it("keeps the turn in the link", () => {
		expect(chat({ text: "Why convex?", written: false, link: "textfold://open?paper=2602.07369&n=n-chat&t=1&lang=en" }).link).toEqual({ paper: "2602.07369", n: "n-chat", t: 1, lang: "en" });
	});

	it("drops a question as the question, an answer under its question", () => {
		const q = chat({ text: "Why convex?", written: false, link: "textfold://open?paper=2602.07369&n=n-chat&t=1&lang=en" });
		expect(formatItem(q, "icon")).toBe("Why convex? [↗](textfold://open?paper=2602.07369&n=n-chat&t=1&lang=en)");
		const a = chat({ text: "Speed (§1 ¶1) and simplicity (inference).", comment: "Why convex?", written: true, link: "textfold://open?paper=2602.07369&n=n-chat&t=1&lang=en" });
		expect(formatItem(a, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition",
			"> **Why convex?**",
			">",
			"> Speed (§1 ¶1) and simplicity (inference). [↗](textfold://open?paper=2602.07369&n=n-chat&t=1&lang=en)",
		].join("\n"));
	});

	it("drops a Topic card as its topic and chips", () => {
		const card = parseDragJson(JSON.stringify({ ...wire, kind: "section", level: "topic", text: "Greedy fitting\nconvex primitives · linear operators", written: true, link: "textfold://open?paper=2602.07369&s=S3&level=topic&lang=en" }))!;
		expect(formatItem(card, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition › 3 Method",
			"> Greedy fitting",
			"> convex primitives · linear operators [↗](textfold://open?paper=2602.07369&s=S3&level=topic&lang=en)",
		].join("\n"));
		expect(itemSentence(card)).toBe("Greedy fitting convex primitives · linear operators");
	});
});

describe("drops of several paragraphs", () => {
	// a section dragged by its heading at Takeaway, and a selection over two paragraphs at Full (made-up text)
	const section = parseDragJson(JSON.stringify({
		...wire, section: { id: "S2", num: "2", title: "Experiments" }, heading: "2 Experiments", kind: "section", level: "takeaway", written: true,
		text: "Two benchmarks show the gain.\n- Thingi10K meshes decompose exactly\n- Queries run faster\n\n2.1 Setup\nMeshes and machines.\n- A laptop CPU",
		units: ["S2.p1", "S2.p2", "S2.SS1.p1"], link: "textfold://open?paper=2602.07369&s=S2&level=takeaway",
	}))!;
	const selection = parseDragJson(JSON.stringify({
		...wire, kind: "selection", level: "full", written: false, text: "We collect meshes.\n\nQueries run faster.", quote: "We collect meshes.\n\nQueries run faster.",
		units: ["S1.p5.1", "S1.p6"], link: "textfold://open?paper=2602.07369&u=S1.p5.1&to=S1.p6&level=full",
	}))!;

	it("reads the heading, the units and a range link", () => {
		expect(section).toMatchObject({ heading: "2 Experiments", units: ["S2.p1", "S2.p2", "S2.SS1.p1"], link: { s: "S2", level: "takeaway" } });
		expect(selection.link).toEqual({ paper: "2602.07369", u: "S1.p5.1", to: "S1.p6", level: "full" });
		expect(parseDragJson(JSON.stringify({ ...wire, units: ["ok.1", "bad id", 3] }))!.units).toEqual(["ok.1"]);
		expect(multiLine(section) && multiLine(selection) && !multiLine(parseDragJson(JSON.stringify(wire))!)).toBe(true);
	});

	it("writes a callout titled by the heading, every line quoted, bullets kept, the icon at the end", () => {
		expect(formatItem(section, "callout")).toBe([
			"> [!textfold|written] Convex Primitive Decomposition › 2 Experiments",
			"> Two benchmarks show the gain.",
			"> - Thingi10K meshes decompose exactly",
			"> - Queries run faster",
			">",
			"> 2\\.1 Setup",
			"> Meshes and machines.",
			"> - A laptop CPU [↗](textfold://open?paper=2602.07369&s=S2&level=takeaway)",
		].join("\n"));
		expect(formatItem(selection, "callout")).toBe([
			"> [!textfold] Convex Primitive Decomposition › 3 Method",
			"> We collect meshes.",
			">",
			"> Queries run faster. [↗](textfold://open?paper=2602.07369&u=S1.p5.1&to=S1.p6&level=full)",
		].join("\n"));
	});

	it("writes a multi-line quote, a section's heading in bold on its first line", () => {
		const q = formatItem(section, "quote").split("\n");
		expect(q[0]).toBe("> **2 Experiments**");
		expect(q[1]).toBe("> Two benchmarks show the gain.");
		expect(q.at(-1)).toBe("> - A laptop CPU *(written by the model)* [↗](textfold://open?paper=2602.07369&s=S2&level=takeaway)");
		expect(q.every(l => l === ">" || l.startsWith("> "))).toBe(true);
		expect(formatItem(selection, "quote")).toBe("> We collect meshes.\n>\n> Queries run faster. [↗](textfold://open?paper=2602.07369&u=S1.p5.1&to=S1.p6&level=full)");
	});

	it("writes Text as a bold heading line and the lines as they came, the icon at the end", () => {
		expect(formatItem(section, "icon")).toBe([
			"**2 Experiments**",
			"Two benchmarks show the gain.",
			"- Thingi10K meshes decompose exactly",
			"- Queries run faster",
			"",
			"2\\.1 Setup",
			"Meshes and machines.",
			"- A laptop CPU [↗](textfold://open?paper=2602.07369&s=S2&level=takeaway)",
		].join("\n"));
		expect(formatItem(selection, "icon")).toBe("We collect meshes.\n\nQueries run faster. [↗](textfold://open?paper=2602.07369&u=S1.p5.1&to=S1.p6&level=full)");
	});

	it("keeps a numbered line after a list out of the list, reading the same", () => {
		expect(keepOutOfLists("- a\n\n2.1 Setup\n3 Results\n  4.2 x")).toBe("- a\n\n2\\.1 Setup\n3 Results\n  4\\.2 x");
	});

	it("writes Full link as one titled link", () => {
		expect(formatItem(section, "link")).toBe("[Convex Primitive Decomposition › 2 Experiments](textfold://open?paper=2602.07369&s=S2&level=takeaway)");
		expect(formatItem(selection, "link")).toBe("[Convex Primitive Decomposition › 3 Method](textfold://open?paper=2602.07369&u=S1.p5.1&to=S1.p6&level=full)");
	});

	it("keeps the heading and units in the JSON the sidebar sends", () => {
		const back = parseDragJson(toDragJson(section))!;
		expect(back).toMatchObject({ heading: "2 Experiments", units: ["S2.p1", "S2.p2", "S2.SS1.p1"], kind: "section" });
	});
});
