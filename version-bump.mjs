// `npm version <x.y.z>` runs this: copy the new package.json version into manifest.json and map it
// to the current minAppVersion in versions.json, so Obsidian offers each release only to apps it supports.
import { readFileSync, writeFileSync } from "node:fs";

const target = process.env.npm_package_version;
if (!target) throw new Error("Run through `npm version <x.y.z>`, which sets npm_package_version.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
