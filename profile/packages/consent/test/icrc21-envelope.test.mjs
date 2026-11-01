// The ICRC-21 envelope vectors of the Rust port (test/icrc21-envelope/, D-061): the stored file must be what this
// package answers today, and it must reach every outcome it is there to compare. The Rust side is
// rust/tests/icrc21_envelope.rs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildEnvelopeVectors, envelopeJson } from "./icrc21-envelope/build.mjs";

const stored = readFileSync(new URL("./icrc21-envelope/vectors.json", import.meta.url), "utf8");
const built = buildEnvelopeVectors();

test("icrc21 envelope vectors: the stored file is what the package answers", () => {
  assert.equal(stored, envelopeJson(built), "run `npm run golden -w packages/consent`, read the diff, commit");
});

test("icrc21 envelope vectors: they reach the outcomes they compare", () => {
  const outcome = (r) => ("Ok" in r ? `Ok ${Object.keys(r.Ok.consent_message)[0]} ${r.Ok.metadata.language} ${r.Ok.metadata.utc_offset_minutes ?? "none"}` : `Err ${Object.keys(r.Err)[0]} ${Object.values(r.Err)[0].description.split(":")[0]}`);
  const seen = new Set(built.vectors.map((v) => outcome(v.response)));
  for (const o of [
    "Ok GenericDisplayMessage en none",
    "Ok GenericDisplayMessage en 0",
    "Ok GenericDisplayMessage en -90",
    "Ok GenericDisplayMessage en-US none",
    "Ok GenericDisplayMessage en-GB 0",
    "Ok FieldsDisplayMessage en none",
    "Err UnsupportedCanisterCall E_LANGUAGE",
    "Err UnsupportedCanisterCall E_METHOD_UNKNOWN",
    "Err UnsupportedCanisterCall E_DECODE",
    "Err UnsupportedCanisterCall E_REQUEST",
  ]) {
    assert.ok(seen.has(o) || [...seen].some((s) => s.startsWith(o.replace(/ (none|0)$/, ""))), `no vector reaches ${o}; seen: ${[...seen].join(" | ")}`);
  }
  assert.ok(built.vectors.some((v) => v.rust === "E_FORM"), "the fields form, which the crate does not write");
});
