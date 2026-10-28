// Step 3: binding (spec section 7), kept as it was in the validator: rebound when everything still holds, stale otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { read, readJson, resolve, codes, byCode, node, icrc1 } from "./helpers.mjs";

const did = await read("examples/tokens.did");
const tokens = await readJson("examples/tokens.profile.json");
const sendAmount = (r) => node(r.resolved.methods.send.args[0], "amount", "e8s");

test("same interface_id: valid, no binding diagnostics", async () => {
  const r = await resolve(did, { profiles: [tokens] });
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r), []);
  assert.equal(r.profiles[0].status, "applied");
  assert.equal(sendAmount(r).tags.amount.args.decimals, 8);
});

test("a compatible change is rebound: W_REBOUND, tags still apply", async () => {
  const v2 = did.replace("service : {", "service : {\n  version : () -> (text) query;");
  const r = await resolve(v2, { profiles: [tokens] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(byCode(r, "W_REBOUND").map((d) => d.at), ["binds.interface_id"]);
  assert.ok(!codes(r).includes("E_STALE"));
  assert.equal(r.profiles[0].status, "rebound");
  assert.equal(sendAmount(r).tags.amount.args.decimals, 8);
});

test("a breaking change is stale: E_STALE after the specific errors, and value-conversion tags are withheld", async () => {
  const v3 = did.replace("record { e8s : nat64 }", "record { units : nat64 }");
  const r = await resolve(v3, { profiles: [tokens] });
  assert.equal(r.ok, false);
  const c = codes(r);
  assert.ok(c.includes("W_REBOUND") && c.includes("E_ADDR_UNRESOLVED") && c.includes("E_STALE"), c.join(","));
  assert.ok(c.indexOf("W_REBOUND") < c.indexOf("E_ADDR_UNRESOLVED") && c.indexOf("E_ADDR_UNRESOLVED") < c.indexOf("E_STALE"));
  assert.equal(r.profiles[0].status, "stale");
  // Spec section 7: consumers MUST NOT use value-conversion tags of a stale profile; the resolved form leaves them out.
  const send = r.resolved.methods.send;
  const memo = node(send.args[0], "memo");
  assert.equal(memo.tags.bytes, undefined, "bytes is a value-conversion tag");
  assert.equal(node(send.args[0], "created_at").tags?.timestamp, undefined, "so is timestamp");
  // Method-level meaning that does not convert values is kept (intent, effect, default).
  assert.ok(send.tags.effect && send.tags.intent);
  assert.equal(memo.tags.default.args.mode, "suggest");
  const survivors = [];
  JSON.stringify(r.resolved.methods, (k, v) => { if (k === "tags") survivors.push(...Object.keys(v).filter((t) => ["amount", "timestamp", "duration", "account", "subaccount", "bytes"].includes(t))); return v; });
  assert.deepEqual(survivors, [], "no value-conversion tag of the stale profile survives");
});

test("a stale author profile does not take the matching packs down with it", async () => {
  // A ledger-shaped service with the tokens profile bound to a different interface; the pack still applies.
  const staleProfile = structuredClone(tokens);
  staleProfile.annotations = [{ at: "icrc1_transfer(0).no_such_field", tag: "amount", args: { decimals: 8 } }];
  const ledger = icrc1.binds.requires;
  const r = await resolve(ledger, { profiles: [staleProfile], packs: [icrc1] });
  assert.equal(r.ok, false);
  assert.equal(r.profiles.find((p) => p.name === staleProfile.name).status, "stale");
  assert.equal(r.profiles.find((p) => p.name === "icrc1").status, "applied");
  assert.equal(node(r.resolved.methods.icrc1_transfer.args[0], "amount").tags.amount.profile, "icrc1");
});
