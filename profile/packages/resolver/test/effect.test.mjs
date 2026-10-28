// The effect tag against the method mode (spec section 5.3), including the read-only update of D-038.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interfaceIdOf, canisterProfile, resolve, byCode, errors, validateSchema } from "./helpers.mjs";
import { validateProfile } from "../src/index.mjs";

const DID = `
service : {
  get_q : () -> (nat) query;
  get_cq : () -> (nat) composite_query;
  get_u : () -> (nat);
  ping : (nat) -> () oneway;
}
`;
const interfaceId = await interfaceIdOf(DID);
const READ_UPDATE = { kind: "read", irreversible: false, replicated: true };

/** Resolve one effect annotation on one method; returns the result with its effect diagnostics. */
async function effectOn(method, args) {
  const r = await resolve(DID, { profiles: [canisterProfile({ interfaceId, annotations: [{ at: method, tag: "effect", args }] })] });
  return { r, e: byCode(r, "E_EFFECT_MODE"), w: byCode(r, "W_EFFECT_MODE") };
}

test("a read-only update is valid on an update method: no error, no W_EFFECT_MODE, and the resolved form keeps replicated", async () => {
  const { r, e, w } = await effectOn("get_u", READ_UPDATE);
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(e, []);
  assert.deepEqual(w, []);
  assert.deepEqual(r.resolved.methods.get_u.tags.effect.args, READ_UPDATE);
});

test("the single-profile validator accepts the same form, and the schema allows replicated: false", async () => {
  for (const args of [READ_UPDATE, { kind: "read", irreversible: false, replicated: false }]) {
    const doc = canisterProfile({ interfaceId, annotations: [{ at: "get_q", tag: "effect", args }] });
    if (args.replicated) doc.annotations[0].at = "get_u";
    const v = await validateProfile(doc, { validateSchema, did: DID });
    assert.ok(!v.diagnostics.some((d) => d.code === "E_SCHEMA" || d.code === "E_EFFECT_MODE"), JSON.stringify(v.diagnostics));
    assert.equal(v.ok, true);
  }
});

test("the schema keeps kind and irreversible required and replicated a boolean", async () => {
  for (const args of [{ kind: "read", replicated: true }, { irreversible: false, replicated: true }, { kind: "read", irreversible: false, replicated: "yes" }]) {
    const doc = canisterProfile({ interfaceId, annotations: [{ at: "get_u", tag: "effect", args }] });
    const v = await validateProfile(doc, { validateSchema, did: DID });
    assert.equal(v.ok, false);
    assert.ok(v.diagnostics.every((d) => d.code === "E_SCHEMA"), JSON.stringify(v.diagnostics));
  }
});

test("replicated: true on a query, a composite query or a oneway method is E_EFFECT_MODE", async () => {
  for (const method of ["get_q", "get_cq", "ping"]) {
    const { r, e } = await effectOn(method, READ_UPDATE);
    assert.equal(r.ok, false, method);
    assert.equal(e.length, 1, `${method}: ${JSON.stringify(r.diagnostics)}`);
    assert.match(e[0].message, /applies to update methods/);
  }
});

test("a oneway read-only update keeps W_EFFECT_MODE beside its error", async () => {
  const { w } = await effectOn("ping", READ_UPDATE);
  assert.equal(w.length, 1);
});

test("replicated: true with another kind or with irreversible: true is E_EFFECT_MODE on an update method", async () => {
  for (const args of [
    { kind: "write", irreversible: false, replicated: true },
    { kind: "transfer", irreversible: true, replicated: true },
    { kind: "read", irreversible: true, replicated: true },
  ]) {
    const { r, e, w } = await effectOn("get_u", args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(e.length, 1, `${JSON.stringify(args)}: ${JSON.stringify(r.diagnostics)}`);
    assert.match(e[0].message, /needs kind "read" and irreversible: false/);
    // A read that fails the form is still a plain read on an update method.
    assert.equal(w.length, args.kind === "read" ? 1 : 0, JSON.stringify(args));
  }
});

test("replicated: true with a write on a query reports each broken rule once: the kind, the mode and the form", async () => {
  const { e } = await effectOn("get_q", { kind: "write", irreversible: true, replicated: true });
  assert.equal(e.length, 3, JSON.stringify(e));
});

test("a plain read on an update or a oneway method keeps W_EFFECT_MODE; replicated: false is the same as absent", async () => {
  for (const [method, args] of [
    ["get_u", { kind: "read", irreversible: false }],
    ["get_u", { kind: "read", irreversible: false, replicated: false }],
    ["ping", { kind: "read", irreversible: false }],
  ]) {
    const { r, e, w } = await effectOn(method, args);
    assert.equal(r.ok, true, `${method} ${JSON.stringify(args)}: ${JSON.stringify(errors(r))}`);
    assert.deepEqual(e, []);
    assert.equal(w.length, 1, `${method} ${JSON.stringify(args)}`);
  }
});

test("the existing rules are unchanged: a non-read query is E_EFFECT_MODE, a read query is fine", async () => {
  assert.equal((await effectOn("get_cq", { kind: "write", irreversible: true })).e.length, 1);
  const { r, e, w } = await effectOn("get_q", { kind: "read", irreversible: false });
  assert.equal(r.ok, true);
  assert.deepEqual([...e, ...w], []);
});

test("replicated: false on a query or a oneway method is the same as absent: no E_EFFECT_MODE", async () => {
  for (const method of ["get_q", "ping"]) {
    const { r, e } = await effectOn(method, { kind: "read", irreversible: false, replicated: false });
    assert.equal(r.ok, true, `${method}: ${JSON.stringify(errors(r))}`);
    assert.deepEqual(e, []);
  }
});

test("on the pinned ledger, icrc21_canister_call_consent_message takes the read-only update form with no warning", async () => {
  const { readFile } = await import("node:fs/promises");
  const did = await readFile(new URL("./fixtures/ledger.did", import.meta.url), "utf8");
  const id = await interfaceIdOf(did);
  const at = "icrc21_canister_call_consent_message";
  const r = await resolve(did, { profiles: [canisterProfile({ interfaceId: id, annotations: [{ at, tag: "effect", args: READ_UPDATE }] })] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual([...byCode(r, "E_EFFECT_MODE"), ...byCode(r, "W_EFFECT_MODE")], []);
  assert.deepEqual(r.resolved.methods[at].tags.effect.args, READ_UPDATE);
});
