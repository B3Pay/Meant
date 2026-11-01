// examples/icp-mcp (D-061): the files the canister embeds are what build.mjs writes from the .did and the profile,
// the guide states what the profile says, and the manifest is what DFINITY's discoverability guide asks for. The
// canister itself runs on PocketIC in packages/consent/pocketic/test/icp-mcp.test.mjs.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "../examples/icp-mcp/build.mjs";
import { isPrincipalText, manifest } from "../examples/icp-mcp/manifest.mjs";

const read = (f) => readFile(new URL(`../examples/icp-mcp/${f}`, import.meta.url), "utf8");

test("icp-mcp: the committed resolved form and guide are what build.mjs writes", async () => {
  for (const [name, text] of Object.entries(await build())) {
    assert.equal(await read(name), text, `${name}: run node examples/icp-mcp/build.mjs, review the diff, commit`);
  }
});

test("icp-mcp: the profile binds the canister's interface, and the guide says what an agent must do", async () => {
  const resolved = JSON.parse(await read("icp-mcp.resolved.json"));
  const profile = JSON.parse(await read("icp-mcp.profile.json"));
  assert.equal(resolved.interface_id, profile.binds.interface_id);
  assert.deepEqual(resolved.profiles.map((p) => [p.name, p.origin]), [["icp-mcp-example", "author"]]);
  const guide = await read("api-doc.md");
  assert.match(guide, /Ask the person to confirm before any call marked so below \(`send`\)/);
  assert.match(guide, /`send\(0\)\.amount\.e8s`: Amount; an amount of TOK in base units \(8 decimals\)/);
  assert.match(guide, /`Err\.TooOld`, `Err\.CreatedInFuture`: `retry_new`/);
  assert.match(guide, /`icrc21_canister_call_consent_message` \(update\)[\s\S]*call it as an update, not a query/);
  assert.doesNotMatch(guide, /without an idempotency stamp/, "every update is stamped or a read-only update");
});

test("icp-mcp: the ic-architecture manifest", () => {
  const m = manifest("ryjl3-tyaaa-aaaaa-aaaba-cai");
  assert.equal(m.version, "1.0.0");
  assert.deepEqual(Object.keys(m.canisters[0]), ["id", "name", "role", "description"]);
  assert.match(m.canisters[0].description, /get_api_doc first/);
  for (const bad of [undefined, "", "not a principal", "RYJL3-TYAAA-AAAAA-AAABA-CAI"]) assert.throws(() => manifest(bad), TypeError);
});

// Review on B3Pay/Meant#321: the checksum, not only the shape. The verdicts are @icp-sdk/core 6.1.0's
// (Principal.fromText(t).toText() === t), which agreed with isPrincipalText on 180,619 texts when this was written.
test("icp-mcp: a canister id is checked with its checksum, so a typo that keeps the shape is refused", () => {
  const valid = ["ryjl3-tyaaa-aaaaa-aaaba-cai", "aaaaa-aa", "2vxsx-fae", "un4fu-tqaaa-aaaab-qadjq-cai", "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae"];
  const typos = ["ryjl3-tyaaa-aaaaa-aaaba-caa", "ryjl3-tyaaa-aaaaa-aaaab-cai", "ryjl3-tyaab-aaaaa-aaaba-cai", "ryjl3tyaaaaaaaaaabacai", "ryjl3-tyaaa-aaaaa-aaaba-cai-"];
  for (const t of valid) assert.equal(isPrincipalText(t), true, t);
  for (const t of typos) {
    assert.equal(isPrincipalText(t), false, t);
    assert.throws(() => manifest(t), /checksum included/, t);
  }
});
