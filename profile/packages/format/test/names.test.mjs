// The one rule for reading a name (spec section 5.3, D-045), against the shared vectors in spec/names-vectors.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeName, resolveName, nameOf, ownerOf } from "../src/index.mjs";

const vectors = JSON.parse(await readFile(new URL("../../../spec/names-vectors.json", import.meta.url), "utf8"));

test("normalizeName gives every vector's expected text", () => {
  for (const [input, want, why] of vectors.normalize) assert.equal(normalizeName(input), want, why);
});

test("resolveName gives every vector's expected answer", () => {
  const { entries, values, cases } = vectors.resolve;
  const isValue = (t) => values.includes(t);
  for (const c of cases) {
    const got = resolveName(entries, c.input, { isValue, kind: c.kind && ((k) => k === c.kind) });
    const answer = got.direct ? "value" : got.error ?? { match: got.value };
    assert.deepEqual(answer, c.want, JSON.stringify(c));
  }
});

test("nameOf shows the one entry's name beside the value, and the value alone otherwise", () => {
  const { entries } = vectors.resolve;
  assert.equal(nameOf(entries, 4), "Savings (4)");
  assert.equal(nameOf([{ name: "Savings", value: 4, show: "efadq-…-kjy554y.1" }], 4), "Savings (efadq-…-kjy554y.1)");
  assert.equal(nameOf(entries, 7), "7"); // a blank name is no name
  assert.equal(nameOf([...entries, { name: "Other", value: 4 }], 4), "4"); // two entries claim the value
});

test("ownerOf compares Candid values, not their text: two accounts never share a name", () => {
  const dana = { owner: "ryjl3-tyaaa-aaaaa-aaaba-cai", subaccount: null };
  const entries = [{ name: "Dana", value: dana }, { name: "Neuron", value: { id: 27n } }];
  assert.equal(ownerOf(entries, { owner: "aaaaa-aa", subaccount: null }), undefined); // not "[object Object]" for both
  assert.equal(ownerOf(entries, { subaccount: null, owner: "ryjl3-tyaaa-aaaaa-aaaba-cai" })?.name, "Dana"); // field order aside
  assert.equal(ownerOf(entries, { owner: dana.owner, subaccount: new Uint8Array(32).fill(1) }), undefined); // another subaccount
  assert.equal(ownerOf(entries, { id: 27 })?.name, "Neuron"); // a nat64 read as a number or a bigint is one value
  assert.equal(ownerOf([{ name: "A", value: 4 }, { name: "B", value: 4n }], 4), undefined); // two owners: no name
});
