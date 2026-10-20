import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

// After a build, copy the plugin into a vault to try it: the folder named by TEXTFOLD_BRIDGE_PLUGIN_DIR, or else by
// "pluginDir" in local.config.json (git-ignored, so a vault's path never goes into the repository), such as
// {"pluginDir": "~/Vault/.obsidian/plugins/textfold-bridge"}. With neither, the build only writes main.js.
const expand = p => (p && p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);
const local = existsSync("local.config.json") ? JSON.parse(await readFile("local.config.json", "utf8")) : {};
const vaultDir = expand(process.env.TEXTFOLD_BRIDGE_PLUGIN_DIR ?? local.pluginDir ?? null);

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: "main.js",
  minify: process.argv.includes("--prod"),
  sourcemap: process.argv.includes("--prod") ? false : "inline",
  logLevel: "info"
});

if (vaultDir) {
  await mkdir(vaultDir, { recursive: true });
  await Promise.all(["main.js", "manifest.json", "styles.css"].map(f => copyFile(f, path.join(vaultDir, f))));
}
