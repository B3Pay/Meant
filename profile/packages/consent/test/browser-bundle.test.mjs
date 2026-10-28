// The main entry must run in a browser: bundled by esbuild for the browser platform, it must build (esbuild refuses
// a Node built-in there), pull in no `node:*` module, and reference no Node global (Buffer, process). The SNS
// renderings, which hash with node:crypto, are the `./sns` subpath and stay out of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Bundle `file` for the browser; returns esbuild's result with the minified output text (comments dropped). */
async function browserBundle(file) {
  return build({
    entryPoints: [file],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
}

/** The Node built-ins and globals a bundle of `file` would need, as readable strings; [] for a browser-safe entry. */
async function nodeOnly(file) {
  let result;
  try {
    result = await browserBundle(file);
  } catch (error) {
    return (error.errors ?? [{ text: String(error) }]).map((e) => `${e.location?.file ?? "?"}: ${e.text}`);
  }
  const found = Object.keys(result.metafile.inputs).filter((p) => p.startsWith("node:") || p.includes("(disabled):"));
  const text = result.outputFiles[0].text;
  for (const global of ["Buffer", "process"]) if (new RegExp(`\\b${global}\\b`).test(text)) found.push(`global ${global}`);
  return found;
}

test("consent's main entry bundles for the browser with no node:* import and no Node global", async () => {
  assert.deepEqual(await nodeOnly(entry("../src/index.mjs")), []);
});

test("the EVM subpaths (./evm, ./erc7730) bundle for the browser too", async () => {
  assert.deepEqual(await nodeOnly(entry("../src/evm.mjs")), []);
  assert.deepEqual(await nodeOnly(entry("../src/erc7730.mjs")), []);
});

test("the check sees a Node built-in: the ./sns subpath imports node:crypto", async () => {
  const found = await nodeOnly(entry("../src/sns.mjs"));
  assert.ok(found.some((f) => f.includes("node:crypto")), found.join("\n"));
});
