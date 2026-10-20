import { describe, expect, it } from "vitest";
import { citedSection, citedText, findCitations, groupByHeading, groupByPaper } from "../src/citations";
import { parseDoc } from "../src/doc";
import { parseNotes } from "../src/notes";

const note = [
	"---",
	"link: textfold://open?paper=fm-only",
	"---",
	"Intro cites [the zoner](textfold://open?paper=pdf-357ae69fe0759131&u=u6&level=key).",
	"",
	"# Methods",
	"",
	"Greedy fitting works. [↗](textfold://open?paper=2602.07369&u=S3.p1.1&level=takeaway&lang=en)",
	"",
	"> [!textfold] Convex Primitive Decomposition › 3 Method",
	"> A dropped paragraph.",
	"> [Open in TextFold](textfold://open?paper=2602.07369&s=S3)",
	"",
	"## Details",
	"",
	"`[code](textfold://open?paper=in-code)` and a bare textfold://open?paper=2602.07369&n=n-1.",
	"",
	"```",
	"[fenced](textfold://open?paper=in-fence)",
	"```",
	"",
	"# Results",
	"",
	"Again [↗](textfold://open?paper=2602.07369&u=S3.p1.1&level=takeaway&lang=en) and [Zoner note](textfold://open?paper=pdf-357ae69fe0759131&n=n-up2cwk6l)",
].join("\n");

const cites = findCitations(note);

describe("findCitations", () => {
	it("finds every link in reading order, outside front matter and code", () => {
		expect(cites.map(c => c.link.paper)).toEqual(["pdf-357ae69fe0759131", "2602.07369", "2602.07369", "2602.07369", "2602.07369", "pdf-357ae69fe0759131"]);
		expect(cites.map(c => c.form)).toEqual(["link", "icon", "link", "bare", "icon", "link"]);
		expect(cites.map(c => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("knows where each one is", () => {
		const c = cites[1];
		expect(note.slice(c.from, c.to)).toBe("[↗](textfold://open?paper=2602.07369&u=S3.p1.1&level=takeaway&lang=en)");
		expect(c.line).toBe(7);
		expect(note.slice(cites[3].from, cites[3].to)).toBe("textfold://open?paper=2602.07369&n=n-1");
	});

	it("labels a link by its words, an icon or 'Open in TextFold' by the words it stands by", () => {
		expect(cites[0].label).toBe("the zoner");
		expect(cites[1].label).toBe("Greedy fitting works.");
		expect(cites[2].label).toBe("A dropped paragraph.");
		expect(cites[4].label).toBe("Again");
		expect(cites[5].label).toBe("Zoner note");
	});
});

describe("groupByHeading", () => {
	const headings = [
		{ heading: "Methods", level: 1, offset: note.indexOf("# Methods") },
		{ heading: "Details", level: 2, offset: note.indexOf("## Details") },
		{ heading: "Results", level: 1, offset: note.indexOf("# Results") },
	];

	it("puts each citation under the heading it follows, the first under the note's title", () => {
		const groups = groupByHeading(cites, headings, "My note");
		expect(groups.map(g => [g.name, g.level, g.items.map(c => c.index)])).toEqual([
			["My note", 0, [0]],
			["Methods", 1, [1, 2]],
			["Details", 2, [3]],
			["Results", 1, [4, 5]],
		]);
	});

	it("leaves out headings without citations", () => {
		expect(groupByHeading(cites.slice(4), headings, "t").map(g => g.name)).toEqual(["Results"]);
		expect(groupByHeading([], headings, "t")).toEqual([]);
	});
});

describe("by paper, with what TextFold says", () => {
	const doc = parseDoc({
		format: "textfold/doc", version: 0, id: "2602.07369", title: "Convex Primitive Decomposition for Collision Detection", authors: [], date: "",
		source: {}, provenance: { local: false },
		sections: [
			{ id: "S1", num: "1", title: "Introduction", takeaway: "Why", topic: "", units: [{ id: "S1.p1.1", kind: "paragraph", full: "Intro.", brief: [], key: "", takeaway: "", topic: "" }] },
			{ id: "S3", num: "3", title: "Method", takeaway: "Greedy fitting of convex primitives", topic: "greedy", units: [
				{ id: "S3.p1.1", kind: "paragraph", full: "Primitives are fitted greedily.", brief: [], key: "Greedy, convex.", takeaway: "Greedy fitting", topic: "" },
			] },
		],
	});
	const nf = parseNotes({ paper: { id: "2602.07369", title: "t" }, notes: [
		{ id: "n-1", kind: "ask", anchor: { unit: "S1.p1.1", section: "S1", quote: { exact: "Intro." } }, text: "", thread: [{ q: "Why convex?", a: "Speed.", takeaway: "Speed." }, { q: "And why greedy?", a: "Simplicity.", takeaway: "Simple." }] },
	] }, "2602.07369");

	it("tells what each citation cites", () => {
		expect(citedText(cites[1], doc, nf)).toBe("Greedy fitting");
		expect(citedText(cites[2], doc, nf)).toBe("Greedy fitting of convex primitives");
		expect(citedText(cites[3], doc, nf)).toBe("Why convex?");
		expect(citedText(cites[0], null, null)).toBeNull();
		const [turn] = findCitations("[a turn](textfold://open?paper=2602.07369&n=n-1&t=1)");
		expect(citedText(turn, doc, nf)).toBe("And why greedy?");
		const [gone] = findCitations("[a turn](textfold://open?paper=2602.07369&n=n-1&t=7)");
		expect(citedText(gone, doc, nf)).toBe("Why convex?");
	});

	it("groups by paper in the order first cited, then by section in the paper's order", () => {
		const groups = groupByPaper(cites, c => ({
			title: c.link.paper === "2602.07369" ? doc!.title : c.link.paper,
			section: c.link.paper === "2602.07369" ? citedSection(c, doc, nf) : null,
		}));
		expect(groups.map(g => [g.key, g.items.length])).toEqual([["pdf-357ae69fe0759131", 2], ["2602.07369", 4]]);
		expect(groups[1].sub!.map(s => [s.name, s.items.map(c => c.index)])).toEqual([["1 Introduction", [3]], ["3 Method", [1, 2, 4]]]);
		expect(groups[0].sub!.map(s => s.name)).toEqual([""]);
	});
});
