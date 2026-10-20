import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_URL, dataFolders, loopbackUrl, parseServerFile, processAlive, resolveServer } from "../src/server";

const serverFile = (port: number, pid = process.pid) => JSON.stringify({
	format: "textfold/server", version: 1, url: `http://127.0.0.1:${port}`, port, pid, textfold: "0.10.14", started: "2026-10-20T09:00:00Z",
});

describe("dataFolders", () => {
	it("follows TextFold's app_data() on each system", () => {
		expect(dataFolders("darwin", {}, "/Users/a")).toEqual(["/Users/a/Library/Application Support/TextFold"]);
		expect(dataFolders("linux", {}, "/home/a")).toEqual(["/home/a/.local/share/textfold"]);
		expect(dataFolders("linux", { XDG_DATA_HOME: "/data" }, "/home/a")).toEqual(["/data/textfold"]);
		expect(dataFolders("win32", { LOCALAPPDATA: "/la" }, "/home/a")).toEqual([join("/la", "TextFold")]);
	});

	it("looks in TEXTFOLD_DATA first", () => {
		expect(dataFolders("darwin", { TEXTFOLD_DATA: "/tmp/tf" }, "/Users/a")).toEqual(["/tmp/tf", "/Users/a/Library/Application Support/TextFold"]);
	});
});

describe("loopbackUrl", () => {
	it("accepts 127.0.0.1 and localhost with a port", () => {
		expect(loopbackUrl("http://127.0.0.1:31917")).toBe("http://127.0.0.1:31917");
		expect(loopbackUrl(" http://localhost:3017/ ")).toBe("http://127.0.0.1:3017");
	});

	it("refuses every other address", () => {
		for (const url of ["http://192.168.1.5:3017", "https://127.0.0.1:3017", "http://127.0.0.1", "http://127.0.0.1:3017/p/x", "http://127.0.0.1:99999", "http://127.0.0.1.example.org:3017"])
			expect(loopbackUrl(url)).toBeNull();
	});
});

describe("parseServerFile", () => {
	it("reads a valid file", () => {
		expect(parseServerFile(serverFile(31917, 4242))).toEqual({ url: "http://127.0.0.1:31917", port: 31917, pid: 4242, textfold: "0.10.14", started: "2026-10-20T09:00:00Z" });
	});

	it("refuses other formats, versions, hosts and broken JSON", () => {
		const base = JSON.parse(serverFile(31917)) as Record<string, unknown>;
		expect(parseServerFile(JSON.stringify({ ...base, format: "textfold/notes" }))).toBeNull();
		expect(parseServerFile(JSON.stringify({ ...base, version: 2 }))).toBeNull();
		expect(parseServerFile(JSON.stringify({ ...base, url: "http://10.0.0.2:31917" }))).toBeNull();
		expect(parseServerFile("{\"format\": \"textfold/server\"")).toBeNull();
		expect(parseServerFile("[]")).toBeNull();
	});
});

describe("processAlive", () => {
	it("knows this process runs, and a pid far beyond any in use does not", () => {
		expect(processAlive(process.pid)).toBe(true);
		expect(processAlive(2_000_000_000)).toBe(false);
	});
});

describe("resolveServer", () => {
	let dir = "";
	const probed: string[] = [];
	const answering = (...urls: string[]) => async (url: string) => {
		probed.push(url);
		return urls.includes(url);
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "textfold-bridge-"));
		probed.length = 0;
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("uses the default address when there is no server.json", async () => {
		const r = await resolveServer("auto", "", { folders: [dir], probe: answering(DEFAULT_URL) });
		expect(r).toMatchObject({ url: DEFAULT_URL, source: "default", reachable: true, note: "no server.json found" });
	});

	it("uses a valid server.json whose URL answers", async () => {
		await writeFile(join(dir, "server.json"), serverFile(31918));
		const r = await resolveServer("auto", "", { folders: [dir], probe: answering("http://127.0.0.1:31918") });
		expect(r).toEqual({ url: "http://127.0.0.1:31918", source: "server.json", reachable: true, version: "0.10.14" });
		expect(probed).toEqual(["http://127.0.0.1:31918"]);
	});

	it("skips a stale server.json whose process has ended, without asking its URL", async () => {
		await writeFile(join(dir, "server.json"), serverFile(31918, 2_000_000_000));
		const r = await resolveServer("auto", "", { folders: [dir], probe: answering("http://127.0.0.1:31918") });
		expect(r).toMatchObject({ url: DEFAULT_URL, source: "default", reachable: false });
		expect(r.note).toContain("stale");
		expect(probed).toEqual([DEFAULT_URL]);
	});

	it("skips a stale server.json whose URL does not answer", async () => {
		await writeFile(join(dir, "server.json"), serverFile(31918));
		const r = await resolveServer("auto", "", { folders: [dir], probe: answering(DEFAULT_URL) });
		expect(r).toMatchObject({ url: DEFAULT_URL, source: "default", reachable: true });
		expect(r.note).toContain("does not answer");
	});

	it("skips a file that is not TextFold's and looks in the next folder", async () => {
		const other = await mkdtemp(join(tmpdir(), "textfold-bridge-"));
		try {
			await writeFile(join(dir, "server.json"), "not json");
			await writeFile(join(other, "server.json"), serverFile(31920));
			const r = await resolveServer("auto", "", { folders: [dir, other], probe: answering("http://127.0.0.1:31920") });
			expect(r).toMatchObject({ url: "http://127.0.0.1:31920", source: "server.json", reachable: true });
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});

	it("uses a manual address as set, and only on 127.0.0.1", async () => {
		expect(await resolveServer("manual", "http://localhost:4000", { folders: [dir], probe: answering() }))
			.toEqual({ url: "http://127.0.0.1:4000", source: "manual", reachable: false });
		const remote = await resolveServer("manual", "http://example.org:4000", { folders: [dir], probe: answering("http://example.org:4000") });
		expect(remote.reachable).toBe(false);
		expect(probed).toEqual(["http://127.0.0.1:4000"]);
	});
});
