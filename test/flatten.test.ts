import { describe, expect, it } from "vitest";
import { describePictures, flattenNote, imageRefs, passesThrough, stripFrontmatter, textHash } from "../src/flatten";

describe("flattenNote", () => {
	it("replaces wikilinks by their text", () => {
		expect(flattenNote("See [[Zoning notes|the zoning notes]] and [[Convex Partition Zoner]].")).toBe("See the zoning notes and Convex Partition Zoner.\n");
		expect(flattenNote("[[Methods#Zoning]], [[#Results]], [[Paper.md]], [[Note#^abc123]]")).toBe("Methods > Zoning, Results, Paper, Note\n");
	});

	it("drops embeds and pictures it was given nothing for, keeps web pictures, drops comments", () => {
		const text = "Before ![[diagram.png]] ![[Other note]] after.\n\n![chart](https://example.org/c.png)\n\n![local](figs/c.png)\n\nKept %%not this%% text.\n\n%%\nhidden\nlines\n%%\n\nEnd.";
		expect(flattenNote(text)).toBe("Before   after.\n\n![chart](https://example.org/c.png)\n\nKept  text.\n\nEnd.\n");
	});

	it("turns callouts into plain quotes", () => {
		expect(flattenNote("> [!note] A title\n> Body line.\n\n> [!warning]-\n> Only body.")).toBe("> **A title**\n>\n> Body line.\n\n> Only body.\n");
	});

	it("drops block ids and highlight marks", () => {
		expect(flattenNote("A paragraph with ==marked== words. ^p1\n\n- item\n\n^list-id\n")).toBe("A paragraph with marked words.\n\n- item\n");
	});

	it("leaves code as written", () => {
		const text = "Use `[[not a link]]` here.\n\n```md\n[[kept]] %%kept%% ![[kept]]\n```\n\n~~~\n==kept== ^kept\n~~~";
		expect(flattenNote(text)).toBe("Use `[[not a link]]` here.\n\n```md\n[[kept]] %%kept%% ![[kept]]\n```\n\n~~~\n==kept== ^kept\n~~~\n");
	});

	it("replaces the front matter, keeping only the note's title", () => {
		const text = "---\ntags: [phd]\ntextfold: md-x-1234abcd\n---\n# Heading\n\nText.";
		expect(flattenNote(text)).toBe("# Heading\n\nText.\n");
		expect(flattenNote(text, "My \"zoning\" note")).toBe("---\ntitle: \"My \\\"zoning\\\" note\"\n---\n\n# Heading\n\nText.\n");
	});
});

describe("stripFrontmatter", () => {
	it("removes only front matter at the very start", () => {
		expect(stripFrontmatter("---\na: 1\n---\nText")).toBe("Text");
		expect(stripFrontmatter("Text\n---\na: 1\n---\n")).toBe("Text\n---\na: 1\n---\n");
	});
});

describe("textHash", () => {
	it("is the same for the same text and differs for another", async () => {
		expect(await textHash("a")).toBe(await textHash("a"));
		expect(await textHash("a")).not.toBe(await textHash("b"));
		expect(await textHash("a")).toMatch(/^[0-9a-f]{24}$/);
	});
});

describe("pictures", () => {
	const note = [
		"---",
		"cover: ![[not-in-front-matter.png]]",
		"---",
		"A figure: ![[plot.png|300]] and ![[photo.jpg|The site]] and ![[plot.png|300]] again.",
		"",
		"![A chart](figs/my%20chart.png) ![](<figs/with space.webp> \"title\") ![web](https://example.org/w.png) ![inline](data:image/png;base64,iVBOR)",
		"",
		"`![[in-code.png]]` %% ![[in-comment.png]] %%",
		"",
		"```",
		"![[in-fence.png]]",
		"```",
		"",
		"![[Some note]] ![[paper.pdf]] ![[drawing.svg]]",
	].join("\n");
	const refs = imageRefs(note);

	it("finds each picture once, outside front matter, code and comments", () => {
		expect(refs.map(r => [r.kind, r.target, r.alt])).toEqual([
			["embed", "plot.png", ""],
			["embed", "photo.jpg", "The site"],
			["markdown", "figs/my chart.png", "A chart"],
			["markdown", "figs/with space.webp", ""],
			["markdown", "https://example.org/w.png", "web"],
			["markdown", "data:image/png;base64,iVBOR", "inline"],
			["embed", "Some note", ""],
			["embed", "paper.pdf", ""],
			["embed", "drawing.svg", ""],
		]);
	});

	it("lets web pictures and data URIs through as they are", () => {
		expect(refs.filter(passesThrough).map(r => r.target)).toEqual(["https://example.org/w.png", "data:image/png;base64,iVBOR"]);
	});

	it("puts what it is given in the pictures' places, every time a picture is used", () => {
		const map = new Map([
			["![[plot.png|300]]", "![plot](data:image/png;base64,AAA)"],
			["![A chart](figs/my%20chart.png)", "![A chart](data:image/png;base64,BBB)"],
		]);
		const out = flattenNote(note, undefined, map);
		expect(out).toContain("A figure: ![plot](data:image/png;base64,AAA) and  and ![plot](data:image/png;base64,AAA) again.");
		expect(out).toContain("![A chart](data:image/png;base64,BBB)  ![web](https://example.org/w.png) ![inline](data:image/png;base64,iVBOR)");
		expect(out).toContain("`![[in-code.png]]`");
		expect(out).toContain("```\n![[in-fence.png]]\n```");
		expect(out).not.toContain("drawing.svg");
	});

	it("changes the hash when a picture's data does", async () => {
		const a = flattenNote("![[p.png]]", undefined, new Map([["![[p.png]]", "![p](data:image/png;base64,AAA)"]]));
		const b = flattenNote("![[p.png]]", undefined, new Map([["![[p.png]]", "![p](data:image/png;base64,AAB)"]]));
		expect(await textHash(a)).not.toBe(await textHash(b));
	});

	it("says what went along and what was left out", () => {
		expect(describePictures({ sent: 0, left: [] })).toBe("");
		expect(describePictures({ sent: 1, left: [] })).toBe(" 1 picture went along.");
		expect(describePictures({ sent: 2, left: [{ name: "drawing.svg", why: "SVG" }, { name: "scan.png", why: "over 15 MB" }] }))
			.toBe(" 2 pictures went along; 2 left out: drawing.svg (SVG), scan.png (over 15 MB).");
	});
});

