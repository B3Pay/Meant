// `@meantjs/profile/address` is the dependency-free entry a browser bundle may import (consent uses it): its
// module graph must hold only this package's own relative modules, with no Node built-in and no package import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPECIFIER = /\b(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every module reachable from `entry` by static or literal dynamic import, and every non-relative specifier met. */
async function graph(entry) {
  const seen = new Set();
  const external = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const m of source.matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith("./") || spec.startsWith("../")) queue.push(path.resolve(path.dirname(file), spec));
      else external.push(`${path.relative(PKG, file)}: ${spec}`);
    }
  }
  return { modules: [...seen].map((f) => path.relative(PKG, f)).sort(), external };
}

test("the address entry is exported and imports nothing outside its own two modules", async () => {
  const pkg = JSON.parse(await readFile(path.join(PKG, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./address"], { types: "./src/address.d.mts", default: "./src/address.mjs" });
  const { modules, external } = await graph(path.join(PKG, "src/address.mjs"));
  assert.deepEqual(external, []);
  assert.deepEqual(modules, ["src/address.mjs", "src/idl.mjs"]);
});

test("the address entry bundles for the browser with no node:* import and no Node global", async () => {
  const result = await build({
    entryPoints: [path.join(PKG, "src/address.mjs")],
    absWorkingDir: PKG,
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), ["src/address.mjs", "src/idl.mjs"]);
  for (const global of ["Buffer", "process"]) assert.doesNotMatch(result.outputFiles[0].text, new RegExp(`\\b${global}\\b`));
});

test("the walker sees a Node built-in when there is one (the resolver barrel has several)", async () => {
  const { external } = await graph(path.join(PKG, "src/index.mjs"));
  assert.ok(external.some((e) => e.endsWith(": node:fs/promises")), external.join("\n"));
});

test("the address entry gives the helpers consent needs, the same functions the barrel exports", async () => {
  const address = await import("@meantjs/profile/address");
  const barrel = await import("@meantjs/profile");
  assert.equal(address.parseRelPath, barrel.parseRelPath);
  assert.equal(address.idlHash, barrel.idlHash);
  assert.equal(address.U32_MAX, 4294967295);
  assert.equal(address.idlHash("amount"), 3_573_748_184);
  assert.deepEqual(address.parseRelPath("(0).to.owner")?.index, 0);
});
