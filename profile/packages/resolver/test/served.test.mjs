// readServedProfile (spec section 8.1, D-048): the bytes a canister serves as `icp:public candid:profile`, refused with
// E_SERVED when only a served profile could get them wrong; the rest is resolveService's, as for any profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readServedProfile, resolveService, SERVED_MAX_BYTES, SERVED_METADATA, SERVED_SECTION } from "../src/index.mjs";
import * as browser from "../src/browser.mjs";
import { read, readJson, validateSchema } from "./helpers.mjs";

const ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const OTHER = "mxzaz-hqaaa-aaaar-qaada-cai";
const author = await readJson("examples/tokens.profile.json");
const did = await read("examples/tokens.did");
const utf8 = (s) => new TextEncoder().encode(s);
const served = (doc) => utf8(JSON.stringify(doc));
const refusal = (r) => {
  assert.equal(r.ok, false);
  assert.equal(r.doc, null);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, "E_SERVED");
  assert.equal(r.diagnostics[0].severity, "error");
  return r.diagnostics[0].message;
};

test("the section and the metadata name are the ones the spec names", () => {
  assert.equal(SERVED_SECTION, "icp:public candid:profile");
  assert.equal(SERVED_METADATA, "candid:profile");
  assert.equal(SERVED_MAX_BYTES, 1048576);
  assert.equal(browser.readServedProfile, readServedProfile, "the browser entry has it too");
});

test("an author canister profile served as UTF-8 JSON is read, and resolves like the file", async () => {
  const r = readServedProfile(served(author), { canisterId: ID });
  assert.deepEqual(r, { ok: true, doc: author, diagnostics: [] });
  const fromServed = await resolveService({ did, validateSchema, profiles: [{ doc: r.doc }] });
  const fromFile = await resolveService({ did, validateSchema, profiles: [{ doc: author }] });
  assert.equal(fromServed.ok, true);
  assert.deepEqual(fromServed, fromFile);
});

test("binds.canister_id, when given, must be the canister that served it", () => {
  const bound = { ...author, binds: { ...author.binds, canister_id: ID } };
  assert.equal(readServedProfile(served(bound), { canisterId: ID }).ok, true);
  assert.match(refusal(readServedProfile(served(bound), { canisterId: OTHER })), /bound to canister "ryjl3-tyaaa-aaaaa-aaaba-cai", but mxzaz-hqaaa-aaaar-qaada-cai served it/);
});

test("only an author canister profile can be served", () => {
  assert.match(refusal(readServedProfile(served({ ...author, origin: "third_party" }), { canisterId: ID })), /origin "author", not "third_party"/);
  assert.match(refusal(readServedProfile(served({ ...author, origin: undefined }), { canisterId: ID })), /not null/);
  assert.match(refusal(readServedProfile(served({ ...author, kind: "pack" }), { canisterId: ID })), /kind "canister", not "pack"/);
});

test("bytes that are not one UTF-8 JSON object of at most 1 MiB are refused", () => {
  assert.match(refusal(readServedProfile(new Uint8Array([0x7b, 0xff, 0x7d]), { canisterId: ID })), /not UTF-8/);
  assert.match(refusal(readServedProfile(utf8(`﻿${JSON.stringify(author)}`), { canisterId: ID })), /byte order mark/);
  assert.match(refusal(readServedProfile(utf8("{ not json"), { canisterId: ID })), /not JSON/);
  assert.match(refusal(readServedProfile(utf8("[]"), { canisterId: ID })), /not a JSON object/);
  assert.match(refusal(readServedProfile(utf8("null"), { canisterId: ID })), /not a JSON object/);
  assert.match(refusal(readServedProfile("{}", { canisterId: ID })), /not bytes/);
  const padded = JSON.stringify({ ...author, description: "x".repeat(SERVED_MAX_BYTES) });
  assert.match(refusal(readServedProfile(utf8(padded), { canisterId: ID })), /over the 1048576/);
  // exactly at the limit is read (the padding brings the document to 1 MiB on the dot)
  const base = JSON.stringify({ ...author, description: "" });
  const exact = JSON.stringify({ ...author, description: "x".repeat(SERVED_MAX_BYTES - utf8(base).length) });
  assert.equal(utf8(exact).length, SERVED_MAX_BYTES);
  assert.equal(readServedProfile(utf8(exact), { canisterId: ID }).ok, true);
});

test("the label names the input, and a call without the canister's id is a programming error", () => {
  const r = readServedProfile(utf8("[]"), { canisterId: ID, label: `${ID}/metadata/candid:profile` });
  assert.equal(r.diagnostics[0].at, `${ID}/metadata/candid:profile`);
  assert.equal(readServedProfile(utf8("[]"), { canisterId: ID }).diagnostics[0].at, "candid:profile");
  assert.throws(() => readServedProfile(served(author)), TypeError);
  assert.throws(() => readServedProfile(served(author), { canisterId: "" }), TypeError);
  // null: the module is not installed yet, so the binding to a canister cannot be checked
  const bound = { ...author, binds: { ...author.binds, canister_id: OTHER } };
  assert.equal(readServedProfile(served(bound), { canisterId: null }).ok, true);
});

test("a served profile that does not fit the interface the canister serves is stale, as any profile (spec section 7)", async () => {
  const r = readServedProfile(served(author), { canisterId: ID });
  const changed = did.replace("e8s : nat64", "e8s : text");
  assert.notEqual(changed, did);
  const out = await resolveService({ did: changed, validateSchema, profiles: [{ doc: r.doc, label: SERVED_METADATA }] });
  assert.equal(out.ok, false);
  assert.deepEqual(out.profiles.map((p) => p.status), ["stale"]);
  assert.ok(out.diagnostics.some((d) => d.code === "E_STALE"));
});
