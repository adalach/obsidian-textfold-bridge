import { describe, expect, it } from "vitest";
import { DocIndex, parseDoc, sectionName, unitText, yearOf } from "../src/doc";
import { parseNotes } from "../src/notes";
import { BLOCK_END, BLOCK_START, answerMarkdown, flipName, groupNotes, noteFileName, notesBlock, replaceBlock } from "../src/notesMarkdown";

// the shape of GET /api/doc/<id> (TextFold's docs/format.md), with made-up text
const docJson = {
	format: "textfold/doc", version: 0, id: "md-zoning-1234abcd", lang: "en", title: "Zoning: a short note", authors: ["Dalach, Agata"], date: "2026-10-20",
	source: { kind: "markdown", url: "", snapshot: "", label: "zoning.md", license: "" },
	provenance: { local: false },
	sections: [
		{ id: "S0", num: "", title: "Zoning", depth: 1, takeaway: "", topic: "", units: [
			{ id: "p-aaaa1111", kind: "paragraph", full: "Zones are convex. They are fast.", sentences: [], brief: ["Zones are convex."], key: "Zones are convex, which is fast.", takeaway: "Zones are convex", topic: "convex zones" },
		] },
		{ id: "S1", num: "2", title: "Method with $x$", depth: 1, takeaway: "", topic: "", units: [
			{ id: "p-bbbb2222", kind: "paragraph", full: "We partition.", sentences: [], brief: [], key: "", takeaway: "", topic: "" },
			{ id: "p-cccc3333", kind: "paragraph", full: "We merge.", sentences: [], brief: [], key: "", takeaway: "", topic: "" },
		] },
	],
};

const notesJson = {
	paper: { id: "md-zoning-1234abcd", title: "Zoning: a short note" },
	notes: [
		{ id: "n-late", kind: "highlight", anchor: { unit: "p-cccc3333", section: "S1", tokens: [0, 1], quote: { exact: "We merge." } }, text: "Check this.", thread: [] },
		{ id: "n-early", kind: "highlight", anchor: { unit: "p-bbbb2222", section: "S1", tokens: [0, 1], quote: { exact: "We partition." } }, text: "", thread: [] },
		{ id: "n-ask", kind: "ask", anchor: { unit: null, section: null, on: "paper", quote: { exact: "" } }, text: "", thread: [{ q: "Why convex?", a: "Speed [[p-aaaa1111]] and taste [[?]].\n\n- one [[!3]]", takeaway: "For speed." }] },
		{ id: "n-lost", kind: "highlight", anchor: { unit: "p-aaaa1111", section: "S0", tokens: null, quote: { exact: "old words" }, lost: { unit: "u3", since: "2026-10-20" } }, text: "", thread: [] },
	],
};

const doc = parseDoc(docJson);
const nf = parseNotes(notesJson, "md-zoning-1234abcd");

describe("doc", () => {
	it("reads the TextFold format and refuses anything else", () => {
		expect(doc?.sections.map(s => s.id)).toEqual(["S0", "S1"]);
		expect(parseDoc({ format: "textfold/notes", id: "x" })).toBeNull();
		expect(parseDoc(null)).toBeNull();
	});

	it("names sections and units as TextFold's reader does", () => {
		const index = new DocIndex(doc!);
		expect(sectionName(doc!.sections[1])).toBe("2 Method with x");
		expect(index.citeLabel("p-cccc3333")).toBe("§2 ¶2");
		expect(index.citeLabel("p-aaaa1111")).toBe("Zoning");
		expect(index.citeLabel("u99")).toBe("u99");
	});

	it("gives a unit's text at each level, and the full text where a level is empty", () => {
		const u = doc!.sections[0].units[0];
		expect(unitText(u, "takeaway")).toBe("Zones are convex");
		expect(unitText(u, "brief")).toBe("Zones are convex.");
		expect(unitText(u, "topic")).toBe("convex zones");
		expect(unitText(doc!.sections[1].units[0], "key")).toBe("We partition.");
	});

	it("finds a year in a date", () => {
		expect(yearOf("2024")).toBe(2024);
		expect(yearOf("2026-10-20")).toBe(2026);
		expect(yearOf("")).toBeUndefined();
	});
});

describe("groupNotes", () => {
	it("puts the whole paper first, then sections in reading order", () => {
		const groups = groupNotes(nf.notes, new DocIndex(doc!));
		expect(groups.map(g => [g.name, g.notes.map(n => n.id)])).toEqual([
			["The whole paper", ["n-ask"]],
			["Zoning", ["n-lost"]],
			["2 Method with x", ["n-early", "n-late"]],
		]);
	});

	it("keeps the file's order without the document", () => {
		expect(groupNotes(nf.notes, null).flatMap(g => g.notes.map(n => n.id))).toEqual(["n-ask", "n-late", "n-early", "n-lost"]);
	});
});

describe("notesBlock", () => {
	const block = notesBlock(nf, doc);
	const lines = block.split("\n");

	it("is wrapped in the markers and opens with the title, byline and a link", () => {
		expect(lines[0]).toBe(BLOCK_START);
		expect(lines[lines.length - 1]).toBe(BLOCK_END);
		expect(lines.slice(2, 7)).toEqual(["# Zoning: a short note", "", "Agata Dalach · zoning.md", "", "[Open in TextFold](textfold://open?paper=md-zoning-1234abcd)"]);
	});

	it("writes a highlight as a quote with its block id, comment and link back", () => {
		const at = lines.indexOf("> We merge.");
		expect(lines.slice(at, at + 7)).toEqual(["> We merge.", "", "^n-late", "", "Check this.", "", "[Open in TextFold](textfold://open?paper=md-zoning-1234abcd&u=p-cccc3333&n=n-late)"]);
	});

	it("writes a conversation as a question callout, citations as links", () => {
		const at = lines.indexOf("> [!question] Why convex?");
		expect(lines.slice(at, at + 9)).toEqual([
			"> [!question] Why convex?",
			">",
			"> Speed ([Zoning](textfold://open?paper=md-zoning-1234abcd&u=p-aaaa1111)) and taste (inference).",
			">",
			"> - one",
			">",
			"> → For speed.",
			"",
			"^n-ask",
		]);
	});

	it("flags a note whose passage was lost in an edit", () => {
		const at = lines.indexOf("^n-lost");
		expect(lines[at + 2]).toBe("*Passage not found after the edit.*");
	});

	it("groups by section with headings", () => {
		expect(lines.filter(l => l.startsWith("## "))).toEqual(["## The whole paper", "## Zoning", "## 2 Method with x"]);
	});
});

describe("answerMarkdown", () => {
	it("labels citations by unit id without the document", () => {
		expect(answerMarkdown("A [[u6]].", "p", null)).toBe("A ([u6](textfold://open?paper=p&u=u6)).");
	});
});

describe("replaceBlock", () => {
	const block = `${BLOCK_START}\nnew\n${BLOCK_END}`;

	it("replaces only the block, keeping text before and after", () => {
		const text = `---\na: 1\n---\nMine above.\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\nMine below.\n`;
		expect(replaceBlock(text, block)).toBe(`---\na: 1\n---\nMine above.\n\n${block}\n\nMine below.\n`);
	});

	it("adds the block at the end when the note has none", () => {
		expect(replaceBlock("Mine.\n\n", block)).toBe(`Mine.\n\n${block}\n`);
		expect(replaceBlock("", block)).toBe(`${block}\n`);
	});
});

describe("noteFileName and flipName", () => {
	it("uses the short title, or the citekey when asked and known", () => {
		expect(noteFileName("Convex Partition Zoner: A New Algorithm for Automated Thermal Zoning", undefined, false)).toBe("Convex Partition Zoner");
		expect(noteFileName("Convex Partition Zoner: A New Algorithm", "xiangConvexPartitionZoner2024", true)).toBe("xiangConvexPartitionZoner2024");
		expect(noteFileName("A/B testing? [draft]", undefined, true)).toBe("A B testing draft");
		expect(noteFileName("", undefined, false)).toBe("Untitled");
	});

	it("turns 'Last, First' into 'First Last'", () => {
		expect(flipName("Xiang, Jialiang")).toBe("Jialiang Xiang");
		expect(flipName("Chen Xia")).toBe("Chen Xia");
	});
});
