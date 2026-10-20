import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/doc";
import { alignRendered, lcsPairs, locate, norm, piecesOf, piecesText, prepSection, prepUnit, tokenize } from "../src/fold/align";
import { mapUnits, plainText, splitBlocks } from "../src/fold/blocks";
import { FALLBACK_LANGS, foldLanguage, parseLangs, readerLangOf } from "../src/langs";

const unit = {
	id: "p-1a2b3c4d", kind: "paragraph", role: "claim",
	full: "Convex zones keep thermal models simple. They avoid irregular rooms. EnergyPlus runs faster with them.",
	sentences: ["Convex zones keep thermal models simple.", "They avoid irregular rooms.", "EnergyPlus runs faster with them."],
	evidence: [0, 2],
	brief: ["Convex zones keep thermal models simple.", "EnergyPlus runs faster with them."],
	key: "Convex zones keep thermal models simple. EnergyPlus runs faster with convex zones.",
	takeaway: "Convex zones keep thermal models simple",
	topic: "thermal models",
};

describe("tokens and alignment", () => {
	it("splits words, numbers and marks, and notes the spaces", () => {
		expect(tokenize("It's 3.5% faster, isn't it?").map(t => [t.t, t.s ?? 0])).toEqual([["It's", 1], ["3.5%", 1], ["faster", 0], [",", 1], ["isn't", 1], ["it", 0], ["?", 0]]);
	});

	it("matches words without stop words and plural s", () => {
		expect([norm("The"), norm("Zones"), norm("glass"), norm("models")]).toEqual(["", "zone", "glass", "model"]);
		expect(lcsPairs(["a", "b", "", "c"], ["b", "x", "c"])).toEqual([[1, 0], [3, 2]]);
		expect(locate("thermal models", tokenize("keep thermal models simple"))).toEqual([1, 2]);
	});
});

describe("pieces per level", () => {
	const p = prepUnit(unit, ["avoid irregular rooms"]);

	it("gives Full every word, with the Brief sentences as lead and highlights marked", () => {
		const full = piecesOf(p, "full");
		expect(full.map(x => x.t).join(" ")).toBe("Convex zones keep thermal models simple . They avoid irregular rooms . EnergyPlus runs faster with them .");
		expect(full.filter(x => x.hl).map(x => x.t)).toEqual(["avoid", "irregular", "rooms"]);
		expect(full[0].lead).toBe(true);
		expect(full.find(x => x.t === "They")?.lead).toBe(false);
	});

	it("keeps the Brief sentences with their ids, a gap where one was left out", () => {
		const brief = piecesOf(p, "brief");
		expect(piecesText(brief)).toBe("Convex zones keep thermal models simple. … EnergyPlus runs faster with them.");
		expect(brief[0].id).toBe("p-1a2b3c4d:0");
		expect(brief.find(x => x.gap)).toBeTruthy();
		const later = piecesText(piecesOf(prepUnit({ ...unit, evidence: [1] }), "brief"));
		expect(later).toBe("… They avoid irregular rooms. …");
	});

	it("gives the model's words at Key the ids of the author's words they match", () => {
		const key = piecesOf(p, "key");
		const full = piecesOf(p, "full");
		const idOf = (pcs: typeof key, t: string) => pcs.find(x => x.t === t)?.id;
		expect(idOf(key, "EnergyPlus")).toBe(idOf(full, "EnergyPlus"));
		expect(idOf(key, "simple")).toBe(idOf(full, "simple"));
		expect(key.filter(x => x.lead).map(x => x.t).join(" ")).toBe("Convex zones keep thermal models simple");
	});

	it("takes Takeaway as the head of Key and Topic as a run of Takeaway, same ids", () => {
		const key = piecesOf(p, "key");
		const take = piecesOf(p, "takeaway");
		const topic = piecesOf(p, "topic");
		expect(take.map(x => x.id)).toEqual(key.slice(0, take.length).map(x => x.id));
		expect(topic.map(x => x.t)).toEqual(["thermal", "models"]);
		expect(topic.map(x => x.id)).toEqual(take.filter(x => x.t === "thermal" || x.t === "models").map(x => x.id));
	});

	it("marks a highlight at TextFold's words when a phrase is in the paragraph twice", () => {
		const twice = { ...unit, full: "Zones help. Zones help models.", sentences: ["Zones help.", "Zones help models."], evidence: [1] };
		const at = (q: Parameters<typeof prepUnit>[1]) => [...prepUnit(twice, q).hl];
		expect(at(["Zones help"])).toEqual([0, 1]);
		expect(at([{ quote: "Zones help", tokens: [3, 4] }])).toEqual([3, 4]);
		expect(at([{ quote: "Zones help", tokens: [4, 5] }])).toEqual([0, 1]); // words that no longer read as the passage
	});

	it("opens one paragraph at Full on its own", () => {
		expect(piecesOf(p, "takeaway", true).length).toBe(piecesOf(p, "full").length);
	});

	it("gives a section its summary and topic pieces", () => {
		const s = prepSection({ id: "S1", num: "1", title: "Zoning", depth: 1, takeaway: "Convex zoning keeps models simple", topic: "convex zoning", units: [] });
		expect(s.tk.map(x => x.t).join(" ")).toBe("Convex zoning keeps models simple");
		expect(s.tp.map(x => x.id)).toEqual(s.tk.slice(0, 2).map(x => x.id));
	});

	it("finds a rendered paragraph's words among the unit's, extra words left out", () => {
		const rendered = tokenize("Convex zones keep thermal models simple. They avoid irregular rooms (see figure). EnergyPlus runs faster with them.").map(t => t.t);
		const match = alignRendered(rendered, p.toks);
		expect(match[0]).toBe(0);
		expect(match[rendered.indexOf("see")]).toBeUndefined();
		expect(match[rendered.indexOf("EnergyPlus")]).toBe(p.toks.findIndex(t => t.t === "EnergyPlus"));
	});
});

describe("the note's blocks and TextFold's paragraphs", () => {
	const note = [
		"---", "tags: [x]", "---",
		"# Fold test",
		"",
		"Convex zones keep thermal models simple. They avoid irregular rooms. EnergyPlus runs faster with them.",
		"",
		"## Method",
		"",
		"- First we split the plan at its reflex corners.",
		"- Then we merge small pieces into [[Zones|zones]].",
		"",
		"```",
		"code stays out",
		"```",
		"",
		"![[plot.png]]",
	].join("\n");
	const blocks = splitBlocks(note);
	const doc = parseDoc({
		format: "textfold/doc", version: 0, id: "md-fold-test-1", title: "Fold test", authors: [], date: "", source: {}, provenance: { local: false, model: "claude/claude-code/sonnet" },
		sections: [
			{ id: "abstract", num: "", title: "", depth: 1, units: [{ ...unit }] },
			{ id: "S1", num: "1", title: "Method", depth: 1, takeaway: "", topic: "", units: [
				{ id: "p-11111111", kind: "list item", full: "First we split the plan at its reflex corners.", sentences: [], evidence: [], key: "", takeaway: "", topic: "" },
				{ id: "p-22222222", kind: "list item", full: "Then we merge small pieces into zones.", sentences: [], evidence: [], key: "", takeaway: "", topic: "" },
			] },
		],
	})!;

	it("splits the note by blank lines without the metadata cache, front matter left out", () => {
		expect(blocks.map(b => b.type)).toEqual(["heading", "paragraph", "heading", "paragraph", "paragraph", "paragraph"]);
		expect(blocks[0].heading).toBe("Fold test");
	});

	it("uses the metadata cache's sections when given", () => {
		const at = (s: string) => note.indexOf(s);
		const b = splitBlocks(note, [
			{ type: "yaml", start: 0, end: at("# Fold") - 1 },
			{ type: "heading", start: at("# Fold"), end: at("# Fold") + 11 },
			{ type: "list", start: at("- First"), end: at("[[Zones|zones]].") + 16 },
		]);
		expect(b.map(x => x.type)).toEqual(["heading", "list"]);
		expect(b[1].markdown.split("\n")).toHaveLength(2);
	});

	it("reads a block's words as TextFold read them", () => {
		expect(plainText("- Then we merge small pieces into [[Zones|zones]] and **keep** `ids`.")).toBe("Then we merge small pieces into zones and keep ids.");
		expect(plainText("> [!note] Why\n> Because.")).toBe("Why Because.");
	});

	it("puts each paragraph in its block, list items in one list block, and finds the title and sections", () => {
		const list = splitBlocks(note, [
			{ type: "heading", start: note.indexOf("# Fold"), end: note.indexOf("# Fold") + 11 },
			{ type: "paragraph", start: note.indexOf("Convex"), end: note.indexOf("them.") + 5 },
			{ type: "heading", start: note.indexOf("## Method"), end: note.indexOf("## Method") + 9 },
			{ type: "list", start: note.indexOf("- First"), end: note.indexOf("zones]].") + 8 },
			{ type: "code", start: note.indexOf("```"), end: note.indexOf("out\n```") + 7 },
		]);
		const map = mapUnits(list, doc);
		expect(map.titleBlock).toBe(0);
		expect(map.headingSection.get(2)).toBe("S1");
		expect(map.unitBlock.get("p-1a2b3c4d")).toBe(1);
		expect(map.blockUnits.get(3)).toEqual(["p-11111111", "p-22222222"]);
		expect(map.blockUnits.has(4)).toBe(false);
	});
});

describe("languages", () => {
	it("folds in the chosen language, else TextFold's own, else English", () => {
		expect(foldLanguage("de", "fr")).toBe("de");
		expect(foldLanguage("textfold", "fr")).toBe("fr");
		expect(foldLanguage("textfold", null)).toBe("en");
	});

	it("reads TextFold's language list in either shape, and the reader's language", () => {
		expect(parseLangs([{ code: "en", name: "English" }, { code: "de" }])).toEqual([{ code: "en", name: "English" }, { code: "de", name: "de" }]);
		expect(parseLangs({ en: "English", ja: "日本語" })).toEqual([{ code: "en", name: "English" }, { code: "ja", name: "日本語" }]);
		expect(parseLangs({ error: 3 })).toBeNull();
		expect(readerLangOf({ readerLang: "zh-Hant" })).toBe("zh-Hant");
		expect(readerLangOf({ models: [] })).toBeNull();
		expect(FALLBACK_LANGS.map(l => l.code).slice(0, 3)).toEqual(["en", "zh", "zh-Hant"]);
	});
});

describe("settings", () => {
	it("keeps a 0.4 fold language, and lets the old default become TextFold's language", async () => {
		const { migrateSettings } = await import("../src/stored");
		const { languageOptions } = await import("../src/langs");
		expect(migrateSettings({ foldLang: "de", dropAs: "icon" })).toEqual({ language: "de", dropAs: "icon" });
		expect(migrateSettings({ foldLang: "en" })).toEqual({});
		expect(migrateSettings({ language: "fr", foldLang: "de" })).toEqual({ language: "fr" });
		const opts = languageOptions(null);
		expect(Object.keys(opts).slice(0, 2)).toEqual(["textfold", "en"]);
		expect(opts.textfold).toBe("TextFold's language");
	});
});

