// What a transfer or approve grants (spec section 5.3, D-056): the `grant` of an effect names who may take the tokens,
// how many and until when, as positions in the method's arguments, so that a guard can compare a request with terms
// the user confirmed. The packs' grants for the eight requests of the proposal (docs/proposals/w0-terms-guard.md §1),
// then each way a grant can be wrong (E_GRANT, or the schema), then grants across profiles, packs and rebinding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, validateSchema, icrc2, LEDGER_DID, interfaceIdOf, canisterProfile, resolve, byCode, errors } from "./helpers.mjs";
import { validateProfile } from "../src/index.mjs";

test("the packs' grants: the eight requests of the proposal, as the fixtures carry them", async () => {
  const rows = [
    ["permit2", "messages", "PermitSingle", { spender: "spender", amount: "details.amount", ends: ["details.expiration", "sigDeadline"] }],
    ["permit2", "messages", "PermitTransferFrom", { spender: "spender", amount: "permitted.amount", ends: ["deadline"] }],
    ["erc2612", "messages", "Permit", { spender: "spender", amount: "value" }],
    ["erc2612", "methods", "permit", { spender: "spender", amount: "value" }],
    ["dai-permit", "messages", "Permit", { spender: "spender", amount: "allowed" }],
    ["erc20", "methods", "approve", { spender: "spender", amount: "value" }],
    ["erc20", "methods", "transfer", { to: "to", amount: "value" }],
    ["icrc2", "methods", "icrc2_approve", { spender: "spender", amount: "amount", ends: ["expires_at"] }],
    ["icrc1", "methods", "icrc1_transfer", { to: "to", amount: "amount" }],
  ];
  for (const [pack, side, name, grant] of rows) {
    const fixture = await readJson(`fixtures/${pack}.resolved.json`);
    assert.deepEqual(fixture[side][name].tags.effect.args.grant, grant, `${pack} ${name}`);
  }
  // A batch grants several tokens, so it has no grant in this version (Q5): the check refuses it for want of one.
  const permit2 = await readJson("fixtures/permit2.resolved.json");
  for (const name of ["PermitBatch", "PermitBatchTransferFrom"]) assert.equal(permit2.messages[name].tags.effect.args.grant, undefined, name);
});

test("x402's payments grant one transfer to the payee the message names, until it can no longer be submitted (D-058)", async () => {
  const usdcGrant = { to: "to", amount: "value", ends: ["validBefore"] };
  for (const [pack, name, grant] of [
    ["usdc", "TransferWithAuthorization", usdcGrant],
    ["usdc", "ReceiveWithAuthorization", usdcGrant],
    ["usdc-base-sepolia", "TransferWithAuthorization", usdcGrant],
    ["usdc-base-sepolia", "ReceiveWithAuthorization", usdcGrant],
    ["x402-exact-permit2", "PermitWitnessTransferFrom", { to: "witness.to", amount: "permitted.amount", ends: ["deadline"] }],
  ]) {
    const fixture = await readJson(`fixtures/${pack}.resolved.json`);
    assert.deepEqual(fixture.messages[name].tags.effect.args, { kind: "transfer", irreversible: true, grant }, `${pack} ${name}`);
  }
  // cancelling a payment signature grants nothing, so no terms cover it
  for (const pack of ["usdc", "usdc-base-sepolia"]) {
    const fixture = await readJson(`fixtures/${pack}.resolved.json`);
    assert.deepEqual(fixture.messages.CancelAuthorization.tags.effect.args, { kind: "write", irreversible: true }, pack);
  }
});

// ------------------------------------------------------------------------------------------------ an EIP-712 message

const TYPES = {
  Grant: [
    { name: "spender", type: "address" },
    { name: "pay", type: "Leg" },
    { name: "legs", type: "Leg[]" },
    { name: "all", type: "bool" },
    { name: "until", type: "uint256" },
    { name: "later", type: "uint48" },
    { name: "count", type: "uint256" },
    { name: "delta", type: "int256" },
  ],
  Leg: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};
const message = (effect) => ({
  format: "candid-profile",
  format_version: 0,
  kind: "contract",
  name: "grants",
  origin: "author",
  binds: { eip712: { domain: { name: "Grants" }, types: TYPES }, deployments: [{ chain_id: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }] },
  annotations: [
    { at: "Grant", tag: "intent", args: { title: "Grant", template: "Let {spender} take {pay.amount}" } },
    { at: "Grant", tag: "effect", args: effect },
    { at: "Grant(0).pay.amount", tag: "amount", args: { token: "pay.token", threshold: "1000" } },
    { at: "Grant(0).legs[].amount", tag: "amount", args: { token: "legs[].token" } },
    { at: "Grant(0).delta", tag: "amount", args: { token: "pay.token" } },
    { at: "Grant(0).until", tag: "timestamp", args: { unit: "s", epoch: "unix", threshold: "1000000", message: "Never" } },
    { at: "Grant(0).later", tag: "timestamp", args: { unit: "s", epoch: "unix", labels: { 0: "This block" } } },
  ],
});
const approve = (grant) => message({ kind: "approve", irreversible: false, grant });
const grantErrors = (v) => v.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at, d.message]);

test("a grant on a message: an address, an amount in the token a field names or a bool, and ends at timestamps", async () => {
  for (const grant of [
    { spender: "spender", amount: "pay.amount", ends: ["until", "later"] },
    { spender: "spender", amount: "pay.amount" },
    { spender: "spender", amount: "all" }, // DAI's allowed: true is unlimited, false nothing
    { spender: "(0).spender", amount: "(0).pay.amount", ends: ["(0).until"] }, // a relpath may name the tuple's element
  ]) {
    const v = await validateProfile(approve(grant), { validateSchema, resolved: true });
    assert.deepEqual(grantErrors(v), [], JSON.stringify(grant));
    assert.deepEqual(v.resolved.messages.Grant.tags.effect.args.grant, grant);
  }
  // A transfer may name the one it pays (`to`) or, for a signature someone else submits, its spender.
  for (const grant of [{ to: "spender", amount: "pay.amount" }, { spender: "spender", amount: "pay.amount", ends: ["until"] }]) {
    const v = await validateProfile(message({ kind: "transfer", irreversible: true, grant }), { validateSchema });
    assert.deepEqual(grantErrors(v), [], JSON.stringify(grant));
  }
});

test("E_GRANT: each position where it may not be, and a grant on an effect that grants nothing", async () => {
  const cases = [
    [{ kind: "write", irreversible: true, grant: { spender: "spender", amount: "pay.amount" } }, /transfer or approve, not write/],
    [{ kind: "admin", irreversible: true, grant: { spender: "spender", amount: "pay.amount" } }, /transfer or approve, not admin/],
    [{ kind: "approve", irreversible: false, grant: { to: "spender", amount: "pay.amount" } }, /an approve's grant names a spender/],
    [{ kind: "approve", irreversible: false, grant: { spender: "nobody", amount: "pay.amount" } }, /grant spender "nobody": no field "nobody"/],
    [{ kind: "approve", irreversible: false, grant: { spender: "until", amount: "pay.amount" } }, /grant spender "until" is uint256; it must be an address or carry an account tag/],
    [{ kind: "approve", irreversible: false, grant: { spender: "pay.token", amount: "count" } }, /grant amount "count" is uint256 without an amount tag/],
    [{ kind: "approve", irreversible: false, grant: { spender: "spender", amount: "delta" } }, /grant amount "delta" is int256; an amount granted is never negative/],
    [{ kind: "approve", irreversible: false, grant: { spender: "spender", amount: "legs[].amount" } }, /steps into \[\]: a grant covers one token/],
    [{ kind: "approve", irreversible: false, grant: { spender: "legs[].token", amount: "pay.amount" } }, /steps into \[\]/],
    [{ kind: "approve", irreversible: false, grant: { spender: "spender", amount: "pay.amount", ends: ["until", "count"] } }, /grant ends "count" has no timestamp tag/],
    [{ kind: "approve", irreversible: false, grant: { spender: "spender", amount: "pay.amount", ends: ["(1).until"] } }, /grant ends "\(1\)\.until": index 1 out of range/],
  ];
  for (const [effect, why] of cases) {
    const v = await validateProfile(message(effect), { validateSchema });
    const found = grantErrors(v);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.deepEqual(found[0].slice(0, 2), ["E_GRANT", "Grant"]);
    assert.match(found[0][2], why);
  }
});

test("the schema: exactly one of spender and to, an amount, one to eight ends, nothing else", async () => {
  for (const grant of [
    { spender: "spender", to: "spender", amount: "pay.amount" },
    { amount: "pay.amount" },
    { spender: "spender" },
    { spender: "spender", amount: "pay.amount", ends: [] },
    { spender: "spender", amount: "pay.amount", ends: Array(9).fill("until") },
    { spender: "spender", amount: "pay.amount", token: "pay.token" },
    { spender: "spender", amount: "pay amount" },
  ]) {
    const v = await validateProfile(approve(grant), { validateSchema });
    assert.deepEqual([...new Set(grantErrors(v).map(([code]) => code))], ["E_SCHEMA"], JSON.stringify(grant));
  }
  // The same position twice changes nothing: the grant ends at the latest of them.
  const twice = await validateProfile(approve({ spender: "spender", amount: "pay.amount", ends: ["until", "until"] }), { validateSchema });
  assert.deepEqual(grantErrors(twice), []);
});

// ------------------------------------------------------------------------------------------------ a Candid method

const DID = `
type Account = record { owner : principal; subaccount : opt blob };
type Op = variant { Pay : record { to : Account; amount : nat }; Stop };
service : {
  give : (record { to : Account; amount : nat; signed : int; maybe : opt nat; until : opt nat64; who : principal; op : Op }) -> ();
}
`;
const interfaceId = await interfaceIdOf(DID);
const TAGS = [
  { at: "give(0).to", tag: "account", args: { encoding: "icrc1" } },
  { at: "give(0).amount", tag: "amount", args: { decimals: 8, symbol: "TOK" } },
  { at: "give(0).signed", tag: "amount", args: { decimals: 8, symbol: "TOK" } },
  { at: "give(0).maybe", tag: "amount", args: { decimals: 8, symbol: "TOK" } },
  { at: "give(0).until", tag: "timestamp", args: { unit: "ns", epoch: "unix" } },
  { at: "give(0).op.Pay.to", tag: "account", args: { encoding: "icrc1" } },
  { at: "give(0).op.Pay.amount", tag: "amount", args: { decimals: 8, symbol: "TOK" } },
];
const give = (grant, extra = []) => canisterProfile({ interfaceId, annotations: [...TAGS, { at: "give", tag: "effect", args: { kind: "transfer", irreversible: true, ...(grant ? { grant } : {}) } }, ...extra] });

test("a grant on a Candid method: an account, an amount, and an optional end that may be left out", async () => {
  const r = await resolve(DID, { profiles: [give({ to: "to", amount: "amount", ends: ["until"] })] });
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.resolved.methods.give.tags.effect.args.grant, { to: "to", amount: "amount", ends: ["until"] });
  for (const [grant, why] of [
    [{ to: "who", amount: "amount" }, /grant to "who" is principal; it must be an address or carry an account tag/],
    [{ to: "to", amount: "maybe" }, /grant amount "maybe" is optional, but a grant needs its amount in every call/],
    [{ to: "to", amount: "signed" }, /grant amount "signed" is int; an amount granted is never negative/],
    [{ to: "op.Pay.to", amount: "amount" }, /grant to "op\.Pay\.to" passes through a case of a variant/],
    [{ to: "to", amount: "op.Pay.amount" }, /passes through a case of a variant/],
  ]) {
    const bad = await resolve(DID, { profiles: [give(grant)] });
    assert.deepEqual(errors(bad).map((d) => [d.code, d.at]), [["E_GRANT", "give"]], JSON.stringify(grant));
    assert.match(byCode(bad, "E_GRANT")[0].message, why);
  }
});

test("a grant sits on a method's effect: on a case effect it is E_GRANT in this version", async () => {
  const caseGrant = { at: "give(0).op.Pay", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "op.Pay.to", amount: "op.Pay.amount" } } };
  const r = await resolve(DID, { profiles: [give(null, [caseGrant])] });
  assert.deepEqual(errors(r).map((d) => [d.code, d.at]), [["E_GRANT", "give(0).op.Pay"]]);
  assert.match(byCode(r, "E_GRANT")[0].message, /not of a case, in this version/);
});

test("the tags a grant needs may come from another profile: an author's grant over the ICRC-2 pack's tags", async () => {
  const pack = structuredClone(icrc2);
  delete pack.annotations.find((a) => a.at === "icrc2_approve" && a.tag === "effect").args.grant;
  const ledgerId = await interfaceIdOf(LEDGER_DID);
  const grant = { spender: "spender", amount: "amount", ends: ["expires_at"] };
  const mine = canisterProfile({ interfaceId: ledgerId, annotations: [{ at: "icrc2_approve", tag: "effect", args: { kind: "approve", irreversible: false, grant } }] });
  const r = await resolve(LEDGER_DID, { profiles: [mine], packs: [pack] });
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.resolved.methods.icrc2_approve.tags.effect, { args: { kind: "approve", irreversible: false, grant }, origin: "author", profile: "mine" });
});

test("a pack applied to a ledger without the grant's end loses the grant and keeps its effect", async () => {
  // ICRC-2's ApproveArgs without expires_at still matches the pack (a record with fewer fields), so the end is absent.
  const r = await resolve(LEDGER_DID.replace("expires_at : opt nat64; ", ""), { packs: [icrc2] });
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.resolved.methods.icrc2_approve.tags.effect.args, { kind: "approve", irreversible: false }); // still confirmed
  assert.ok(byCode(r, "I_PACK_ANNOTATION_SKIPPED").some((d) => d.at === "icrc2_approve" && /grant dropped, the effect kept: E_GRANT: grant ends "expires_at"/.test(d.message)), JSON.stringify(r.diagnostics));
  // On the whole ledger the grant stays.
  const whole = await resolve(LEDGER_DID, { packs: [icrc2] });
  assert.deepEqual(whole.resolved.methods.icrc2_approve.tags.effect.args.grant, { spender: "spender", amount: "amount", ends: ["expires_at"] });
});

test("a pack whose amount tag is dropped in a service loses the grant that needs it, and keeps its effect", async () => {
  const ACCOUNT = "type Account = record { owner : principal; subaccount : opt blob };";
  const service = (dec) => `${ACCOUNT}\nservice : { dec : () -> (${dec}) query; give : (record { to : Account; amount : nat }) -> () }`;
  const pack = {
    format: "candid-profile", format_version: 0, kind: "pack", name: "gift", origin: "pack", language: "en",
    binds: { standard: "GIFT-1", spec_url: "https://example.org/gift", requires: service("nat8") },
    annotations: [
      { at: "give(0).to", tag: "account", args: { encoding: "icrc1" } },
      { at: "give(0).amount", tag: "amount", args: { decimals: { from: "query:dec" }, symbol: "GFT" } },
      { at: "give", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount" } } },
    ],
  };
  const kept = await resolve(service("nat8"), { packs: [pack] });
  assert.deepEqual(kept.resolved.methods.give.tags.effect.args.grant, { to: "to", amount: "amount" });
  // A dec that answers two values still matches (extra results), but is no ref: the amount tag goes, then the grant.
  const r = await resolve(service("nat8, text"), { packs: [pack] });
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.resolved.methods.give.tags.effect.args, { kind: "transfer", irreversible: true });
  assert.ok(byCode(r, "I_PACK_ANNOTATION_SKIPPED").some((d) => d.at === "give" && /grant amount "amount" is nat without an amount tag.*a tag it needs was dropped/.test(d.message)), JSON.stringify(r.diagnostics));
});

test("a rebound profile whose grant no longer holds is stale", async () => {
  const moved = DID.replace("until : opt nat64; ", "");
  const doc = canisterProfile({ interfaceId, annotations: [{ at: "give", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount", ends: ["until"] } } }, TAGS[0], TAGS[1]] });
  const r = await resolve(moved, { profiles: [doc] });
  assert.deepEqual(errors(r).map((d) => d.code), ["E_GRANT", "E_STALE"]);
});
