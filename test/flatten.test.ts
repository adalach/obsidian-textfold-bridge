import { describe, expect, it } from "vitest";
import { flattenNote, stripFrontmatter, textHash } from "../src/flatten";

describe("flattenNote", () => {
	it("replaces wikilinks by their text", () => {
		expect(flattenNote("See [[Zoning notes|the zoning notes]] and [[Convex Partition Zoner]].")).toBe("See the zoning notes and Convex Partition Zoner.\n");
		expect(flattenNote("[[Methods#Zoning]], [[#Results]], [[Paper.md]], [[Note#^abc123]]")).toBe("Methods > Zoning, Results, Paper, Note\n");
	});

	it("drops embeds, images and comments, also comments over several lines", () => {
		const text = "Before ![[diagram.png]] after.\n\n![chart](https://example.org/c.png)\n\nKept %%not this%% text.\n\n%%\nhidden\nlines\n%%\n\nEnd.";
		expect(flattenNote(text)).toBe("Before  after.\n\nKept  text.\n\nEnd.\n");
	});

	it("turns callouts into plain quotes", () => {
		expect(flattenNote("> [!note] A title\n> Body line.\n\n> [!warning]-\n> Only body.")).toBe("> A title\n> Body line.\n\n> Only body.\n");
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
