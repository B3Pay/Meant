// The differential corpus of the Rust port (test/differential/): it must be what this package answers today, and it
// must reach every outcome it is there to compare. The Rust side is rust/tests/differential.rs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CASE_CALLS, CUTS, buildCorpus, corpusJson } from "./differential/build.mjs";

const stored = readFileSync(new URL("./differential/corpus.json", import.meta.url), "utf8");
const corpus = buildCorpus();

test("differential corpus: the stored file is what the package answers", () => {
  assert.equal(stored, corpusJson(corpus), "run `npm run golden -w packages/consent`, read the diff, commit");
});

test("differential corpus: it reaches the outcomes it compares", () => {
  const outcomes = new Set();
  for (const v of corpus.vectors) {
    outcomes.add(`${v.source} ${"Ok" in v.sns ? "Ok" : v.sns.Err.split(":")[0]}`);
    outcomes.add(`generic ${"Ok" in v.generic ? "Ok" : v.generic.Err}`);
  }
  for (const o of [
    "wide Ok",
    "bare Ok",
    "mangled Ok",
    "wide E_DECODE",
    "wide E_TOO_LARGE",
    "wide E_ARG",
    "wide E_REF_UNRESOLVED",
    "mangled E_UNSUPPORTED_TYPE",
    "mangled E_TAG_CONFLICT",
    "mangled E_INTERNAL",
    "generic Ok",
    "generic E_DECODE",
  ]) {
    assert.ok(outcomes.has(o), `no vector reaches ${o}`);
  }
  const texts = corpus.vectors.filter((v) => "Ok" in v.sns).map((v) => v.sns.Ok).join("\n");
  // every value tag rendered by its formatter at least once, and a refused value shown raw
  for (const [what, re] of [
    ["an amount", /`\d+(\.\d+)? (TKA|ÜNI|Z)`/u],
    ["a timestamp", /`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? UTC`/],
    ["a duration", /`-?P(\d+D)?(T[\d.HMS]+)?`/],
    ["an account with a subaccount", /`[a-z0-9-]+-[a-z2-7]{7}\.[0-9a-f]+`/],
    ["a #n subaccount", /`#\d+`/],
    ["hex bytes", /`0x[0-9a-f]*`/],
    ["a raw blob", /blob "(\\[0-9a-f]{2})+"/],
    ["a float", /\d\.\d+e[-+]\d+|\b0\.1\b/],
  ]) {
    assert.match(texts, re, `no rendering shows ${what}`);
  }
  assert.ok(corpus.vectors.some((v) => v.generic.zone_sensitive === true && v.utc_offset_minutes !== null && v.utc_offset_minutes !== 0), "a zoned timestamp");
});

test("differential corpus: a cut refuses the call only when its value reaches the cut (spec section 12, rule 12)", () => {
  const cuts = corpus.vectors.filter((v) => v.source === "mangled").slice(-CUTS.length);
  assert.equal(cuts.length, CUTS.length);
  CUTS.forEach(([method, , want], i) => {
    const v = cuts[i];
    assert.equal(v.method, method);
    const got = "Ok" in v.generic ? "Ok" : v.generic.Err;
    assert.equal(got, want, `CUTS[${i}]`);
    assert.equal("Ok" in v.sns ? "Ok" : v.sns.Err.split(":")[0], want, `CUTS[${i}] sns`);
  });
});

test("differential corpus: a call takes the intent and effect of the deepest tagged case it holds (spec section 5.2, D-053)", () => {
  for (const source of ["wide", "mangled"]) {
    const calls = corpus.vectors.filter((v) => v.source === source && v.method === "vote").slice(-CASE_CALLS.length);
    CASE_CALLS.forEach(([, wideTitle, effect, mangledTitle], i) => {
      const v = calls[i];
      const title = source === "wide" ? wideTitle : mangledTitle;
      assert.ok(v.generic.Ok.startsWith(`# ${title}\n`), `${source} CASE_CALLS[${i}]: ${v.generic.Ok.split("\n")[0]}`);
      assert.match(v.sns.Ok, new RegExp(`^### ${title}\n`), `${source} CASE_CALLS[${i}] sns`);
      assert.ok(v.sns.Ok.includes(`**Effect:** ${effect}.`), `${source} CASE_CALLS[${i}] effect`);
    });
  }
});
