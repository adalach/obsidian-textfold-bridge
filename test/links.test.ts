import { describe, expect, it } from "vitest";
import { buildLink, findPaperIds, levelName, markdownLink, parseLink, readerUrl, withId, withoutId } from "../src/links";

describe("parseLink", () => {
	it("reads every part of a link", () => {
		expect(parseLink("textfold://open?paper=2605.00089&u=S2.SS3.p2&n=n-k3f9a2qx&level=key&lang=zh")).toEqual({
			paper: "2605.00089", u: "S2.SS3.p2", n: "n-k3f9a2qx", level: "key", lang: "zh",
		});
	});

	it("reads a section", () => {
		expect(parseLink("textfold://open?paper=2605.00089&s=S3&level=topic")).toEqual({ paper: "2605.00089", s: "S3", level: "topic" });
		expect(parseLink("textfold://open?paper=x1&s=bad%20id")).toEqual({ paper: "x1" });
	});

	it("needs only the document", () => {
		expect(parseLink("textfold://open?paper=pdf-357ae69fe0759131")).toEqual({ paper: "pdf-357ae69fe0759131" });
	});

	it("decodes URL-encoded values", () => {
		expect(parseLink("textfold://open?paper=zotero-g5482058-8rin8pi4&u=S1%2Ep2")).toEqual({ paper: "zotero-g5482058-8rin8pi4", u: "S1.p2" });
	});

	it("takes the scheme and level in any case, and a slash before the query", () => {
		expect(parseLink("TextFold://open/?paper=x1&level=Takeaway")).toEqual({ paper: "x1", level: "takeaway" });
	});

	it("drops parts it does not know or that are invalid, keeping the document", () => {
		expect(parseLink("textfold://open?paper=x1&level=huge&lang=%3Cb%3E&n=bad id&zoom=3")).toEqual({ paper: "x1" });
	});

	it("is null for other links and for links without a valid document", () => {
		expect(parseLink("https://example.org/?paper=x1")).toBeNull();
		expect(parseLink("textfold://close?paper=x1")).toBeNull();
		expect(parseLink("textfold://open?u=S1.p2")).toBeNull();
		expect(parseLink("textfold://open?paper=../etc/passwd")).toBeNull();
		expect(parseLink("textfold://open?paper=a%20b")).toBeNull();
	});
});

describe("buildLink", () => {
	it("writes the parts in the contract's order", () => {
		expect(buildLink({ paper: "2605.00089", lang: "zh", level: "brief", n: "n-1", u: "S1.p2" }))
			.toBe("textfold://open?paper=2605.00089&u=S1.p2&n=n-1&level=brief&lang=zh");
	});

	it("puts a section after the document", () => {
		expect(buildLink({ paper: "x1", u: "u6", s: "sec-introduction" })).toBe("textfold://open?paper=x1&s=sec-introduction&u=u6");
		expect(readerUrl("http://127.0.0.1:31917", { paper: "x1", s: "S3", level: "takeaway" })).toBe("http://127.0.0.1:31917/p/x1#s=S3&level=takeaway");
	});

	it("round-trips through parseLink", () => {
		const link = { paper: "md-notes-on-x", u: "S3.p2", n: "n-up2cwk6l", level: "topic" as const, lang: "en" };
		expect(parseLink(buildLink(link))).toEqual(link);
	});

	it("encodes values", () => {
		expect(buildLink({ paper: "x1", u: "a&b" })).toBe("textfold://open?paper=x1&u=a%26b");
	});
});

describe("readerUrl", () => {
	const base = "http://127.0.0.1:3017";

	it("opens the document", () => {
		expect(readerUrl(base, { paper: "pdf-357ae69fe0759131" })).toBe("http://127.0.0.1:3017/p/pdf-357ae69fe0759131");
	});

	it("puts the language in the query and the place in the hash", () => {
		expect(readerUrl(`${base}/`, { paper: "2605.00089", u: "S2.p1", level: "key", lang: "zh" }))
			.toBe("http://127.0.0.1:3017/p/2605.00089?lang=zh#u=S2.p1&level=key");
		expect(readerUrl(base, { paper: "2605.00089", n: "n-k3f9a2qx" })).toBe("http://127.0.0.1:3017/p/2605.00089#n=n-k3f9a2qx");
	});

	it("keeps the paragraph after the note, for when the note is gone", () => {
		expect(readerUrl(base, { paper: "x1", n: "n-1", u: "u6", level: "full" })).toBe("http://127.0.0.1:3017/p/x1#n=n-1&u=u6&level=full");
	});
});

describe("markdownLink", () => {
	it("escapes brackets in the label", () => {
		expect(markdownLink("A [new] zoner", { paper: "x1" })).toBe("[A \\[new\\] zoner](textfold://open?paper=x1)");
	});

	it("puts the label on one line, and falls back to the id", () => {
		expect(markdownLink(" Two\nlines ", { paper: "x1" })).toBe("[Two lines](textfold://open?paper=x1)");
		expect(markdownLink("", { paper: "x1" })).toBe("[x1](textfold://open?paper=x1)");
	});
});

describe("levelName", () => {
	it("maps TextFold's stored numbers to names", () => {
		expect([4, 3, 2, 1, 0].map(levelName)).toEqual(["full", "brief", "key", "takeaway", "topic"]);
		expect(levelName(5)).toBeUndefined();
		expect(levelName("2")).toBeUndefined();
	});
});

describe("findPaperIds", () => {
	const note = [
		"---",
		"textfold: pdf-357ae69fe0759131",
		"---",
		"See [Convex Partition Zoner](textfold://open?paper=pdf-357ae69fe0759131&n=n-up2cwk6l) and",
		"[a paragraph](textfold://open?paper=2605.00089&u=S1.p2), <a href=\"textfold://open?paper=md-x\">raw</a>,",
		"a bare one textfold://open?paper=zotero-g1-abc. And not textfold://close?paper=nope or https://open?paper=nope.",
	].join("\n");

	it("lists the frontmatter's document first, then links in order, each once", () => {
		expect(findPaperIds(note, "pdf-357ae69fe0759131")).toEqual(["pdf-357ae69fe0759131", "2605.00089", "md-x", "zotero-g1-abc"]);
	});

	it("reads a list, a link and a number in the frontmatter", () => {
		expect(findPaperIds("", ["b2", "textfold://open?paper=c3&u=S1"])).toEqual(["b2", "c3"]);
		expect(findPaperIds("", 2605.00089)).toEqual(["2605.00089"]);
	});

	it("ignores frontmatter values that are not document ids", () => {
		expect(findPaperIds("", { id: "x" })).toEqual([]);
		expect(findPaperIds("", "not an id")).toEqual([]);
		expect(findPaperIds("", null)).toEqual([]);
	});

	it("finds nothing in a note without TextFold", () => {
		expect(findPaperIds("# A note\n[[Other note]] and https://example.org")).toEqual([]);
	});
});

describe("withId and withoutId", () => {
	it("adds a document to the textfold property, making a list only when needed", () => {
		expect(withId(undefined, "md-a")).toBe("md-a");
		expect(withId("", "md-a")).toBe("md-a");
		expect(withId("pdf-x", "md-a")).toEqual(["pdf-x", "md-a"]);
		expect(withId(["pdf-x"], "md-a")).toEqual(["pdf-x", "md-a"]);
		expect(withId("md-a", "md-a")).toBe("md-a");
	});

	it("removes it again", () => {
		expect(withoutId("md-a", "md-a")).toBeUndefined();
		expect(withoutId(["pdf-x", "md-a"], "md-a")).toBe("pdf-x");
		expect(withoutId(["pdf-x", "md-a", "y"], "md-a")).toEqual(["pdf-x", "y"]);
		expect(withoutId("pdf-x", "md-a")).toBe("pdf-x");
	});
});

describe("turns of a conversation (t=)", () => {
	it("reads a turn only with a note, and only as a number of up to three digits", () => {
		expect(parseLink("textfold://open?paper=2602.07369&n=n-chat1&t=2&lang=en")).toEqual({ paper: "2602.07369", n: "n-chat1", t: 2, lang: "en" });
		expect(parseLink("textfold://open?paper=x1&n=n-1&t=0")).toEqual({ paper: "x1", n: "n-1", t: 0 });
		expect(parseLink("textfold://open?paper=x1&t=2")).toEqual({ paper: "x1" });
		expect(parseLink("textfold://open?paper=x1&n=n-1&t=1000")).toEqual({ paper: "x1", n: "n-1" });
		expect(parseLink("textfold://open?paper=x1&n=n-1&t=-1")).toEqual({ paper: "x1", n: "n-1" });
	});

	it("writes it after the note, and leaves it out without one", () => {
		expect(buildLink({ paper: "x1", n: "n-1", t: 3, lang: "en" })).toBe("textfold://open?paper=x1&n=n-1&t=3&lang=en");
		expect(buildLink({ paper: "x1", u: "u6", t: 3 })).toBe("textfold://open?paper=x1&u=u6");
		expect(parseLink(buildLink({ paper: "x1", n: "n-1", t: 0 }))).toEqual({ paper: "x1", n: "n-1", t: 0 });
	});

	it("puts it after the note in the reader's hash, as the reader reads it", () => {
		expect(readerUrl("http://127.0.0.1:31917", { paper: "x1", n: "n-1", t: 2, lang: "en" })).toBe("http://127.0.0.1:31917/p/x1?lang=en#n=n-1&t=2");
		expect(readerUrl("http://127.0.0.1:31917", { paper: "x1", u: "u6", t: 2 })).toBe("http://127.0.0.1:31917/p/x1#u=u6");
	});
});

