// The format library must run in a browser: bundled by esbuild for the browser platform, it must build (esbuild
// refuses a Node built-in there), pull in no `node:*` module, and reference no Node global (Buffer, process).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("format's entry bundles for the browser with no node:* import and no Node global", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(Object.keys(result.metafile.inputs).filter((p) => p.startsWith("node:") || p.includes("(disabled):")), []);
  const text = result.outputFiles[0].text;
  for (const global of ["Buffer", "process"]) assert.doesNotMatch(text, new RegExp(`\\b${global}\\b`), `references ${global}`);
});
