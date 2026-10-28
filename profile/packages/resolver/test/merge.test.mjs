// Step 2: multi-profile merge and precedence (spec section 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEDGER_DID, icrc1, icrc2, interfaceIdOf, canisterProfile, resolve, codes, byCode, errors, node, validateSchema } from "./helpers.mjs";
import { resolveService } from "../src/index.mjs";

const interfaceId = await interfaceIdOf(LEDGER_DID);
const amountOf = (r) => node(r.resolved.methods.icrc1_transfer.args[0], "amount");

test("icrc1 and icrc2 on one ledger do not collide; both are listed in the resolved form", async () => {
  const r = await resolve(LEDGER_DID, { packs: [icrc1, icrc2] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.resolved.profiles.map((p) => p.name), ["icrc1", "icrc2"]);
  assert.ok(r.resolved.profiles.every((p) => p.origin === "pack" && /^candid-profile:v0:sha256:[0-9a-f]{64}$/.test(p.profile_id)));
  assert.equal(r.resolved.interface_id, interfaceId);
  const m = r.resolved.methods;
  assert.equal(m.icrc1_transfer.tags.effect.profile, "icrc1");
  assert.equal(m.icrc2_approve.tags.effect.profile, "icrc2");
  assert.equal(node(m.icrc1_transfer.args[0], "amount").tags.amount.profile, "icrc1");
  assert.equal(node(m.icrc2_approve.args[0], "amount").tags.amount.profile, "icrc2");
  assert.ok(!codes(r).includes("W_OVERRIDDEN") && !codes(r).includes("E_CONFLICT") && !codes(r).includes("W_DUPLICATE"), codes(r).join(","));
  // The queries both packs mention (icrc1_symbol, icrc1_decimals) are only referenced, never tagged by icrc2.
  assert.equal(m.icrc1_decimals.tags.effect.origin, "default");
});

test("an author profile overrides a pack tag at the same position (W_OVERRIDDEN); other tags on the position stay", async () => {
  const author = canisterProfile({ interfaceId, annotations: [
    { at: "icrc1_transfer(0).amount", tag: "amount", args: { decimals: 6, symbol: "XYZ" } },
  ] });
  const r = await resolve(LEDGER_DID, { profiles: [author], packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  const amount = amountOf(r);
  assert.deepEqual(amount.tags.amount, { args: { decimals: 6, symbol: "XYZ" }, origin: "author", profile: "mine" });
  assert.equal(amount.tags.describe.profile, "icrc1", "the pack's describe on the same position is kept");
  // Other positions are untouched: the fee still uses the pack's dynamic decimals.
  assert.deepEqual(node(r.resolved.methods.icrc1_transfer.args[0], "fee").tags.amount.args.decimals, { from: "query:icrc1_decimals" });
  const over = byCode(r, "W_OVERRIDDEN");
  assert.equal(over.length, 1, JSON.stringify(over));
  assert.equal(over[0].severity, "warning");
  assert.equal(over[0].profile, "icrc1", "the diagnostic belongs to the overridden profile");
  assert.match(over[0].message, /amount from profile "icrc1" \(pack\) is overridden by profile "mine" \(author\)/);
  // The author layer comes first in the profiles list.
  assert.deepEqual(r.resolved.profiles.map((p) => `${p.name}:${p.origin}`), ["mine:author", "icrc1:pack"]);
});

test("precedence is author > third_party > pack > inferred, whatever order the profiles are given in", async () => {
  const at = "icrc1_transfer(0).amount";
  const mk = (name, origin, decimals) => canisterProfile({ name, origin, interfaceId, annotations: [{ at, tag: "amount", args: { decimals } }] });
  const profiles = [mk("inf", "inferred", 1), mk("third", "third_party", 2), mk("auth", "author", 3)];
  let r = await resolve(LEDGER_DID, { profiles, packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(amountOf(r).tags.amount.profile, "auth");
  assert.deepEqual(r.resolved.profiles.map((p) => p.origin), ["author", "third_party", "pack", "inferred"]);
  assert.equal(byCode(r, "W_OVERRIDDEN").length, 3, "third_party, pack and inferred are all overridden by the author");
  // Without the author, the third party wins; without that, the pack beats the inferred profile.
  r = await resolve(LEDGER_DID, { profiles: profiles.slice(0, 2), packs: [icrc1] });
  assert.equal(amountOf(r).tags.amount.profile, "third");
  r = await resolve(LEDGER_DID, { profiles: profiles.slice(0, 1), packs: [icrc1] });
  assert.equal(amountOf(r).tags.amount.profile, "icrc1");
  assert.equal(byCode(r, "W_OVERRIDDEN")[0].profile, "inf");
});

test("a higher layer beats a lower one even when the lower one is more specific (layer first, then specificity)", async () => {
  // The pack tags the position through a method address; the author through a type: edge. The author still wins.
  const author = canisterProfile({ interfaceId, annotations: [
    { at: "type:TransferArgs.amount", tag: "amount", args: { decimals: 8, symbol: "ICP" } },
  ] });
  const r = await resolve(LEDGER_DID, { profiles: [author], packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(amountOf(r).tags.amount.profile, "mine");
  assert.equal(byCode(r, "W_OVERRIDDEN").length, 1);
});

test("within one layer a method address beats a type: edge, silently", async () => {
  const author = canisterProfile({ interfaceId, annotations: [
    { at: "type:TransferArgs.amount", tag: "amount", args: { decimals: 8, symbol: "ICP" } },
    { at: "icrc1_transfer(0).amount", tag: "amount", args: { decimals: 6, symbol: "XYZ" } },
  ] });
  const r = await resolve(LEDGER_DID, { profiles: [author] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(amountOf(r).tags.amount.args.decimals, 6);
  assert.ok(!codes(r).includes("E_CONFLICT") && !codes(r).includes("W_OVERRIDDEN"));
});

test("two different values for one tag at one position in one layer are E_CONFLICT; the first stays", async () => {
  const mk = (name, decimals) => canisterProfile({ name, interfaceId, annotations: [{ at: "icrc1_transfer(0).amount", tag: "amount", args: { decimals } }] });
  let r = await resolve(LEDGER_DID, { profiles: [mk("one", 6), mk("two", 8)] });
  assert.equal(r.ok, false);
  const c = byCode(r, "E_CONFLICT");
  assert.equal(c.length, 1);
  assert.equal(c[0].profile, "two");
  assert.match(c[0].message, /profile "one".*profile "two"/);
  assert.equal(amountOf(r).tags.amount.args.decimals, 6);
  // Equal values are only a duplicate.
  r = await resolve(LEDGER_DID, { profiles: [mk("one", 6), mk("two", 6)] });
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r).filter((x) => x === "W_DUPLICATE"), ["W_DUPLICATE"]);
});

test("a conflict is also found between a #id spelling and a name spelling, and between two packs of one layer", async () => {
  const amountId = 3573748184;
  const author = canisterProfile({ interfaceId, annotations: [
    { at: "icrc1_transfer(0).amount", tag: "amount", args: { decimals: 6 } },
    { at: `icrc1_transfer(0).#${amountId}`, tag: "amount", args: { decimals: 8 } },
  ] });
  let r = await resolve(LEDGER_DID, { profiles: [author] });
  assert.ok(codes(r).includes("E_CONFLICT"));
  // Two packs that disagree on a position both reach.
  const rival = structuredClone(icrc1);
  rival.name = "icrc1-rival";
  rival.annotations.find((a) => a.at === "icrc1_transfer(0).amount" && a.tag === "amount").args.decimals = 2;
  r = await resolve(LEDGER_DID, { packs: [icrc1, rival] });
  assert.equal(r.ok, false);
  assert.ok(byCode(r, "E_CONFLICT").some((d) => d.profile === "icrc1-rival"), JSON.stringify(byCode(r, "E_CONFLICT")));
});

test("overrides are reported once per overridden annotation, not once per position it reaches", async () => {
  // A pack tag on a type edge cannot exist (packs use method addresses), so use two author-level layers instead:
  // third_party tags the Account edge, the author overrides the same tag through the edge as well.
  const third = canisterProfile({ name: "third", origin: "third_party", interfaceId, annotations: [{ at: "type:Account", tag: "describe", args: { label: "Third" } }] });
  const author = canisterProfile({ name: "auth", interfaceId, annotations: [{ at: "type:Account", tag: "describe", args: { label: "Author" } }] });
  const r = await resolve(LEDGER_DID, { profiles: [third, author] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  const over = byCode(r, "W_OVERRIDDEN");
  assert.equal(over.length, 1, JSON.stringify(over));
  assert.match(over[0].message, /\d+ positions/);
  assert.equal(node(r.resolved.methods.icrc1_balance_of.args[0]).tags.describe.args.label, "Author");
});

test("the stamp lookup of idempotency sees the timestamp tag of another layer", async () => {
  // The author states the idempotency contract; the timestamp tag on the stamp field comes only from the pack.
  const author = canisterProfile({ interfaceId, annotations: [
    { at: "icrc1_transfer", tag: "idempotency", args: { mode: "replay_same_payload", stamp: "created_at_time" } },
  ] });
  let r = await resolve(LEDGER_DID, { profiles: [author] });
  assert.ok(codes(r).includes("E_STAMP_UNTAGGED"), "alone, the stamp field has no timestamp tag");
  r = await resolve(LEDGER_DID, { profiles: [author], packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(r.resolved.methods.icrc1_transfer.tags.idempotency.profile, "mine");
  assert.equal(node(r.resolved.methods.icrc1_transfer.args[0], "created_at_time").tags.timestamp.profile, "icrc1");
});

test("the same document given twice (explicitly and through the pack search) is applied once", async () => {
  const r = await resolve(LEDGER_DID, { profiles: [icrc1], packs: [icrc1, icrc2] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.resolved.profiles.map((p) => p.name), ["icrc1", "icrc2"]);
  assert.ok(!codes(r).includes("W_DUPLICATE"));
});

test("the merged resolved form has the same shape as the single-profile fixtures", async () => {
  const r = await resolve(LEDGER_DID, { packs: [icrc1, icrc2] });
  assert.deepEqual(Object.keys(r.resolved), ["format", "format_version", "interface_id", "profiles", "methods", "diagnostics"]);
  assert.deepEqual(Object.keys(r.resolved.profiles[0]), ["name", "origin", "profile_id"]);
  const t = r.resolved.methods.icrc1_transfer.tags.intent;
  assert.deepEqual(Object.keys(t), ["args", "origin", "profile"]);
  assert.deepEqual(Object.keys(r.resolved.methods.icrc1_fee.tags.effect), ["args", "origin"]);
});

test("a schema-invalid profile is reported and left out", async () => {
  const bad = { format: "candid-profile", name: "bad" };
  const r = await resolveService({ did: LEDGER_DID, validateSchema, profiles: [{ doc: bad }], packs: [{ doc: icrc1 }] });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("E_SCHEMA"));
  assert.deepEqual(r.resolved.profiles.map((p) => p.name), ["icrc1"]);
  assert.equal(r.profiles.find((p) => p.name === "bad").status, "invalid");
});
