import { describe, expect, it } from "vitest";
import { DocIndex, parseDoc, sectionText } from "../src/doc";

// "2 Experiments" holds no paragraph itself; 2.1 and 2.2 are its subsections; "3 Results" ends it
const u = (id: string, full: string, takeaway: string) => ({ id, kind: "paragraph", full, brief: [full.split(".")[0] + "."], key: takeaway, takeaway, topic: "" });
const doc = parseDoc({
	format: "textfold/doc", version: 0, id: "2602.07369", title: "Convex Primitive Decomposition", authors: [], date: "", source: {}, provenance: { local: false },
	sections: [
		{ id: "S1", num: "1", title: "Introduction", depth: 1, takeaway: "Why convex parts", topic: "", units: [u("S1.p1", "Convex parts collide fast. They are simple.", "Convex parts are fast")] },
		{ id: "S2", num: "2", title: "Experiments", depth: 1, takeaway: "", topic: "", units: [] },
		{ id: "S2.1", num: "2.1", title: "Setup", depth: 2, takeaway: "Meshes and machines", topic: "", units: [u("S2.1.p1", "We use Thingi10K. It is large.", "Thingi10K meshes"), u("S2.1.p2", "A laptop runs it. Nothing else.", "A laptop")] },
		{ id: "S2.2", num: "2.2", title: "Results", depth: 2, takeaway: "Faster queries", topic: "", units: [u("S2.2.p1", "Queries run faster. By far.", "Faster queries")] },
		{ id: "S3", num: "3", title: "Discussion", depth: 1, takeaway: "Limits", topic: "", units: [u("S3.p1", "Thin parts are hard. Sometimes.", "Thin parts")] },
	],
})!;
const index = new DocIndex(doc);

describe("ranges and sections of a document", () => {
	it("gives the paragraphs from one to another in reading order, either way round", () => {
		expect(index.range("S2.1.p2", "S3.p1").map(x => x.id)).toEqual(["S2.1.p2", "S2.2.p1", "S3.p1"]);
		expect(index.range("S3.p1", "S2.1.p2").map(x => x.id)).toEqual(["S2.1.p2", "S2.2.p1", "S3.p1"]);
		expect(index.range("S1.p1").map(x => x.id)).toEqual(["S1.p1"]);
		expect(index.range("S1.p1", "gone").map(x => x.id)).toEqual(["S1.p1"]);
		expect(index.range("gone", "S1.p1")).toEqual([]);
	});

	it("takes a section with its deeper sections, up to one at its depth", () => {
		expect(index.withSubsections("S2").map(x => x.id)).toEqual(["S2", "S2.1", "S2.2"]);
		expect(index.withSubsections("S2.1").map(x => x.id)).toEqual(["S2.1"]);
		expect(index.withSubsections("nope")).toEqual([]);
	});

	it("writes a section at Takeaway as its summary and bullets, a block per subsection", () => {
		expect(sectionText(index, "S2", "takeaway")).toEqual({
			heading: "2 Experiments",
			text: "2.1 Setup\nMeshes and machines\n- Thingi10K meshes\n- A laptop\n\n2.2 Results\nFaster queries\n- Faster queries",
			units: ["S2.1.p1", "S2.1.p2", "S2.2.p1"],
		});
		expect(sectionText(index, "S1", "key")!.text).toBe("Why convex parts\n- Convex parts are fast");
	});

	it("writes a section at Full and Brief as a block per paragraph, each subsection's name before its own", () => {
		expect(sectionText(index, "S2", "full")!.text).toBe("2.1 Setup\n\nWe use Thingi10K. It is large.\n\nA laptop runs it. Nothing else.\n\n2.2 Results\n\nQueries run faster. By far.");
		expect(sectionText(index, "S3", "brief")!.text).toBe("Thin parts are hard.");
		// at Topic, its card on the map: its summary, then its paragraphs' topics on one line; a subsection is a card of its own
		expect(sectionText(index, "S2.1", "topic")).toEqual({ heading: "2.1 Setup", text: "Meshes and machines\nThingi10K meshes · A laptop", units: ["S2.1.p1", "S2.1.p2"] });
		expect(sectionText(index, "S2", "topic")).toEqual({ heading: "2 Experiments", text: "", units: [] });
		expect(sectionText(index, "nope", "full")).toBeNull();
	});
});
