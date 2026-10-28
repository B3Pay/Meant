// The shipped schema's validator is compiled ahead of time (data/profile-v0.validate.mjs, scripts/data.mjs) so that a
// page needs no CSP 'unsafe-eval'. It must answer exactly as ajv's run-time compile of the same schema does: the same
// verdict and the same errors, on every profile in this repository and on mutations of each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSchemaValidator } from "@meantjs/profile";
import * as browser from "@meantjs/profile/browser";
const { schemaDiagnostics } = browser;
import schema from "@meantjs/profile/schema.json" with { type: "json" };
import { validate as precompiled } from "../data/profile-v0.validate.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const ucs2length = require("ajv/dist/runtime/ucs2length.js").default;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** ajv's run-time compile, with the options src/schema-core.mjs uses. */
const runtime = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/** Every *.profile.json in the repository outside node_modules and the resolver's own data/ copies. */
async function profiles(dir = ROOT, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !["node_modules", ".git", "data", "target"].includes(e.name)) await profiles(p, out);
    else if (e.isFile() && e.name.endsWith(".profile.json")) out.push(p);
  }
  return out.sort();
}

/** Documents near `doc`: each key removed, each value replaced by wrong types, strings at and past length limits. */
function* mutations(doc, depth = 0) {
  yield doc;
  if (depth > 3 || doc === null || typeof doc !== "object") return;
  const entries = Array.isArray(doc) ? doc.map((v, i) => [i, v]) : Object.entries(doc);
  const set = (k, v) => (Array.isArray(doc) ? doc.map((x, i) => (i === k ? v : x)) : { ...doc, [k]: v });
  if (!Array.isArray(doc)) yield { ...doc, unexpected_key: 1 };
  for (const [k, v] of entries.slice(0, 12)) {
    if (!Array.isArray(doc)) {
      const { [k]: _gone, ...rest } = doc;
      yield rest;
    }
    for (const wrong of [null, 7, -1.5, "", "x", true, [], {}]) yield set(k, wrong);
    if (typeof v === "string") {
      // a surrogate pair counts as one character, a lone surrogate as one: the precompiled code counts them itself
      for (const n of [0, 1, 9, 10, 31, 32, 33, 59, 60, 61, 79, 80, 81, 499, 500, 501]) {
        yield set(k, "🙂".repeat(n));
        yield set(k, "a".repeat(Math.max(n - 1, 0)) + "\ud800");
      }
    }
    for (const inner of mutations(v, depth + 1)) if (inner !== v) yield set(k, inner);
  }
}

// The public copy of this repository (D-051) holds the packs, the example and the test fixtures; the private one adds
// the wallet's and the eval's profiles. Measured 2026-10-27: 43,589 documents from 21 profiles here, 36,620 of them
// invalid; 10,643 from 5 in the copy, 9,319 invalid.
const PUBLIC_COPY = !existsSync(path.join(ROOT, "eval"));

test("the precompiled validator answers as ajv's run-time compile does, errors included", async () => {
  const files = await profiles();
  assert.ok(files.length >= (PUBLIC_COPY ? 5 : 15), files.join("\n"));
  let checked = 0;
  let invalid = 0;
  for (const file of files) {
    const doc = JSON.parse(await readFile(file, "utf8"));
    for (const m of mutations(doc)) {
      const want = runtime(m);
      assert.equal(precompiled(m), want, path.relative(ROOT, file));
      assert.deepEqual(precompiled.errors, runtime.errors, path.relative(ROOT, file));
      checked++;
      if (!want) invalid++;
    }
  }
  assert.ok(checked > (PUBLIC_COPY ? 10_000 : 30_000) && invalid > checked / 2, `${checked} checked, ${invalid} invalid`);
});

test("its string length counts code points as ajv's runtime ucs2length does", async () => {
  const text = await readFile(new URL("../data/profile-v0.validate.mjs", import.meta.url), "utf8");
  const local = new Function(`${text.slice(text.lastIndexOf("function ucs2length"))}\nreturn ucs2length;`)();
  for (const s of ["", "a", "🙂", "🙂🙂", "\ud800", "\udc00", "\ud800\ud800", "\udc00\ud800", "a\ud800b", "é漢字", "🙂x\ud83d"]) {
    assert.equal(local(s), ucs2length(s), JSON.stringify(s));
  }
});

test("createSchemaValidator gives the precompiled validator for the shipped schema, in any key order or as a path", async () => {
  const reordered = Object.fromEntries(Object.entries(structuredClone(schema)).reverse());
  for (const v of [await createSchemaValidator(), await createSchemaValidator(schema), await createSchemaValidator(reordered), await browser.createSchemaValidator(), await browser.createSchemaValidator(reordered)]) {
    assert.equal(v.name, "own", "the precompiled validator's wrapper");
    assert.equal(v.errors, null);
    assert.equal(v({ kind: "pack" }), false);
    assert.deepEqual(v.errors, runtime({ kind: "pack" }) ? null : runtime.errors);
  }
  const other = await createSchemaValidator({ ...schema, title: "another schema" });
  assert.notEqual(other.name, "own", "another schema is compiled by ajv at run time");
  assert.equal(other({ kind: "pack" }), false);
});

test("each validator keeps its own errors, as each run-time compile did", async () => {
  const a = await createSchemaValidator();
  const b = await createSchemaValidator();
  assert.equal(a({ kind: "pack" }), false);
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  assert.equal(b(pack), true);
  assert.equal(b.errors, null);
  assert.ok(a.errors.length > 0);
  assert.deepEqual(schemaDiagnostics(a).map((d) => d.code), a.errors.map(() => "E_SCHEMA"));
});
