// `didToDocAttributes` through the compiled WebAssembly. The response for the
// reviewed fixture is compared with the golden the Rust-native tests pin
// (crates/candid-core-wasm/tests/goldens/attributes.doc-attributes.json), so
// the same code compiled twice gives the same document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { didToContract, didToDocAttributes } from "../lib/index.js";

const HERE = new URL(".", import.meta.url).pathname;
const GOLDENS = path.join(HERE, "..", "..", "tests", "goldens");
const FIXTURE = readFileSync(path.join(GOLDENS, "attributes.did"), "utf8");
const GOLDEN = readFileSync(path.join(GOLDENS, "attributes.doc-attributes.json"), "utf8");

test("the fixture's response equals the Rust-native golden", async () => {
  const result = await didToDocAttributes(FIXTURE);
  assert.deepEqual(result, JSON.parse(GOLDEN));
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, GOLDEN);
});

test("the contract is the one didToContract hands out", async () => {
  const result = await didToDocAttributes({ source: FIXTURE });
  const envelope = await didToContract({ source: FIXTURE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.contract, envelope.contract);
  const send = result.doc_attributes.items.find((item) => item.name === "send");
  assert.deepEqual(
    send.attributes.map((attribute) => attribute.name),
    ["intent", "effect", "amount", "bytes", "outcome"],
  );
});

test("a malformed attribute fails with its code and place", async () => {
  const result = await didToDocAttributes(
    "service : {\n  /// @amount(decimals = 08)\n  m : () -> ();\n}",
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((issue) => [issue.code, issue.path, issue.phase]),
    [["doc_attribute_malformed", "actor.methods[0]", "parse"]],
  );
  assert.match(result.diagnostics[0].message, /^doc line 1 of actor\.methods\[0\]: @amount: /);
});

test("a compile failure passes through", async () => {
  const result = await didToDocAttributes("service : { m : (missing) -> () }");
  assert.equal(result.ok, false);
  assert.notEqual(result.diagnostics[0].code, "doc_attribute_malformed");
});
