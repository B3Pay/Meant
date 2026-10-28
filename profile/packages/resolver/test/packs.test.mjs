// Step 4: pack matching by Candid subtyping against binds.requires, with the D-019 relaxation (spec section 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { icrc1, icrc2, LEDGER_DID, resolve, codes, byCode, errors, node } from "./helpers.mjs";
import { compileInterface, matchPack } from "../src/index.mjs";

/** The ICRC-1 fragment itself is the smallest interface the pack matches; edit it to build variants. */
const FRAGMENT = icrc1.binds.requires;
const edit = (src, from, to) => {
  assert.ok(src.includes(from), `fixture drifted: ${from}`);
  return src.replace(from, to);
};
const matches = async (pack, did) => {
  const { iface, failure } = await compileInterface(did, "canister");
  assert.ok(iface, JSON.stringify(failure));
  return matchPack(iface, pack);
};

test("the pack matches the interface it was written from", async () => {
  const m = await matches(icrc1, FRAGMENT);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
  assert.deepEqual(m.relaxed, []);
});

test("the ICRC-1 pack matches an interface with extra methods", async () => {
  const did = edit(FRAGMENT, "service : {", "service : {\n  icrc1_name : () -> (text) query;\n  my_admin_thing : (record { x : nat }) -> ();\n  icrc1_metadata : () -> (vec record { text; text }) query;");
  const m = await matches(icrc1, did);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
  const r = await resolve(did, { packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(r.profiles[0].status, "applied");
  assert.equal(r.resolved.methods.my_admin_thing.tags.effect.origin, "default", "extra methods get only the default effect");
});

test("it matches an interface whose TransferError has an extra case (D-019), and the extra case falls back to the pack default", async () => {
  const did = edit(FRAGMENT, "  GenericError : record { error_code : nat; message : text };\n};", "  GenericError : record { error_code : nat; message : text };\n  Frozen : record { until : nat64 };\n  Maintenance;\n};");
  const { iface } = await compileInterface(did, "canister");
  const m = await matchPack(iface, icrc1);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
  assert.deepEqual(m.relaxed, [{ at: "icrc1_transfer->(0).Err", cases: ["Frozen", "Maintenance"] }]);
  // Strict Candid subtyping would have refused it.
  assert.equal((await matchPack(iface, icrc1, { resultVariants: "strict" })).matched, false);

  const r = await resolve(did, { packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.match(byCode(r, "I_PACK_MATCHED")[0].message, /D-019: icrc1_transfer->\(0\)\.Err has extra cases Frozen, Maintenance/);
  // The pack sets default: "fail"; the cases it does not know are reported at info level and carry no annotations.
  const unclassified = byCode(r, "W_OUTCOME_UNCLASSIFIED");
  assert.deepEqual(unclassified.map((d) => d.severity), ["info", "info"]);
  assert.deepEqual(unclassified.map((d) => d.message.match(/"([^"]+)"/)[1]).sort(), ["Err.Frozen", "Err.Maintenance"]);
  const frozen = node(r.resolved.methods.icrc1_transfer.results[0], "Err", "Frozen");
  assert.equal(frozen.tags, undefined);
  assert.equal(r.resolved.methods.icrc1_transfer.tags.outcome.args.default, "fail");
});

test("it does not match an interface missing icrc1_transfer", async () => {
  const did = edit(FRAGMENT, "  icrc1_transfer : (TransferArgs) -> (variant { Ok : nat; Err : TransferError });\n", "");
  const m = await matches(icrc1, did);
  assert.equal(m.matched, false);
  assert.deepEqual(m.reasons, [{ at: "icrc1_transfer", message: 'method "icrc1_transfer" is missing from the canister' }]);
});

test("it does not match an interface with a required extra argument field", async () => {
  const did = edit(FRAGMENT, "  created_at_time : opt nat64;\n};", "  created_at_time : opt nat64;\n  reason : text;\n};");
  const m = await matches(icrc1, did);
  assert.equal(m.matched, false);
  assert.equal(m.reasons.length, 1);
  assert.equal(m.reasons[0].at, "icrc1_transfer(0)");
  assert.match(m.reasons[0].message, /field "reason" \(text\) is required by the canister but missing from the pack fragment/);
});

test("an extra optional argument field is fine; a field of another type is not", async () => {
  const optional = edit(FRAGMENT, "  created_at_time : opt nat64;\n};", "  created_at_time : opt nat64;\n  reason : opt text;\n};");
  assert.equal((await matches(icrc1, optional)).matched, true);
  const retyped = edit(FRAGMENT, "  amount : nat;\n  fee", "  amount : text;\n  fee");
  const m = await matches(icrc1, retyped);
  assert.equal(m.matched, false);
  assert.equal(m.reasons[0].at, "icrc1_transfer(0).amount");
  const lossy = edit(FRAGMENT, "  fee : opt nat;", "  fee : opt text;");
  assert.equal((await matches(icrc1, lossy)).matched, false, "the unusual opt rules would have let this through and dropped the fee");
});

test("a changed mode, a missing result or a narrower result type do not match", async () => {
  const update = edit(FRAGMENT, "icrc1_balance_of : (Account) -> (nat) query", "icrc1_balance_of : (Account) -> (nat)");
  const m1 = await matches(icrc1, update);
  assert.equal(m1.matched, false);
  assert.match(m1.reasons[0].message, /is update in the canister but query in the pack fragment/);
  const noResult = edit(FRAGMENT, "icrc1_fee : () -> (nat) query", "icrc1_fee : () -> () query");
  assert.equal((await matches(icrc1, noResult)).matched, false);
  const wider = edit(FRAGMENT, "icrc1_decimals : () -> (nat8) query", "icrc1_decimals : () -> (nat16) query");
  assert.equal((await matches(icrc1, wider)).matched, false, "a nat16 result is not a nat8");
  const intResult = edit(FRAGMENT, "icrc1_fee : () -> (nat) query", "icrc1_fee : () -> (int) query");
  assert.equal((await matches(icrc1, intResult)).matched, false, "an int result is not a nat");
});

test("a result that is a subtype of the fragment's matches: more fields, narrower numbers, fewer error cases", async () => {
  let did = edit(FRAGMENT, "icrc1_fee : () -> (nat) query", "icrc1_fee : () -> (nat) query");
  did = edit(did, "  BadBurn : record { min_burn_amount : nat };\n", ""); // fewer cases
  did = edit(did, "icrc1_decimals : () -> (nat8) query", "icrc1_decimals : () -> (nat8) query");
  const m = await matches(icrc1, did);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
  // The pack names Err.BadBurn; the service lacks it. That is skipped, not an error.
  const r = await resolve(did, { packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  const skipped = byCode(r, "I_PACK_ANNOTATION_SKIPPED").map((d) => d.message);
  assert.ok(skipped.some((m) => /no case "BadBurn"/.test(m)), skipped.join("\n"));
  assert.equal(node(r.resolved.methods.icrc1_transfer.results[0], "Err", "BadFee", "expected_fee").tags.amount.profile, "icrc1");
});

test("a service narrower than the fragment in an argument: skipped annotations, optional template segments render empty", async () => {
  // No memo field at all: allowed by subtyping (the pack's extra argument field is dropped on decode).
  const did = edit(FRAGMENT, "  memo : opt blob;\n", "");
  const m = await matches(icrc1, did);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
  const r = await resolve(did, { packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  const skipped = byCode(r, "I_PACK_ANNOTATION_SKIPPED").map((d) => `${d.at}: ${d.message}`);
  assert.ok(skipped.some((s) => s.startsWith("icrc1_transfer(0).memo: bytes")), skipped.join("\n"));
  assert.ok(skipped.some((s) => /intent: \{memo\} is absent/.test(s)), skipped.join("\n"));
  assert.ok(r.resolved.methods.icrc1_transfer.tags.intent, "the intent stays; its [ with memo {memo}] segment is empty");
  assert.equal(node(r.resolved.methods.icrc1_transfer.args[0]).fields.memo, undefined);
});

test("a pack annotation that does not hold on this service is dropped, and so is an idempotency that loses its stamp", async () => {
  // An Account that has gained an optional field no longer has the shape the account tag needs.
  const widened = edit(FRAGMENT, "type Account = record { owner : principal; subaccount : opt blob };", "type Account = record { owner : principal; subaccount : opt blob; label : opt text };");
  const r = await resolve(widened, { packs: [icrc1] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  const dropped = byCode(r, "I_PACK_ANNOTATION_SKIPPED").map((d) => d.message);
  assert.ok(dropped.some((s) => /^account dropped: E_TAG_NOT_APPLICABLE/.test(s)), dropped.join("\n"));
  assert.equal(node(r.resolved.methods.icrc1_balance_of.args[0]).tags?.account, undefined, "no account tag where it does not apply");
  assert.equal(r.resolved.methods.icrc1_transfer.tags.idempotency.profile, "icrc1");
});

test("an explicit pack that does not match is an error; a candidate pack that does not match is only reported", async () => {
  const did = edit(FRAGMENT, "  icrc1_transfer : (TransferArgs) -> (variant { Ok : nat; Err : TransferError });\n", "");
  let r = await resolve(did, { profiles: [icrc1] });
  assert.equal(r.ok, false);
  const e = byCode(r, "E_PACK_NOT_MATCHED");
  assert.equal(e.length, 1);
  assert.equal(e[0].profile, "icrc1");
  assert.match(e[0].message, /method "icrc1_transfer" is missing from the canister/);
  assert.equal(r.profiles[0].status, "not_matched");
  assert.deepEqual(r.resolved.profiles, [], "a pack that does not match is not listed as applied");

  r = await resolve(did, { packs: [icrc1] });
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r).filter((c) => c.includes("PACK")), ["I_PACK_NOT_MATCHED"]);
  assert.equal(byCode(r, "I_PACK_NOT_MATCHED")[0].severity, "info");
});

test("each pack is judged on its own: icrc1 applies to an ICRC-1-only ledger, icrc2 does not", async () => {
  const r = await resolve(FRAGMENT, { packs: [icrc1, icrc2] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.resolved.profiles.map((p) => p.name), ["icrc1"]);
  assert.deepEqual(r.profiles.map((p) => `${p.name}:${p.status}`), ["icrc1:applied", "icrc2:not_matched"]);
  const r2 = await resolve(LEDGER_DID, { packs: [icrc1, icrc2] });
  assert.deepEqual(r2.resolved.profiles.map((p) => p.name), ["icrc1", "icrc2"]);
});

test("a pack whose binds.requires does not compile is reported as E_CANDID", async () => {
  const broken = structuredClone(icrc1);
  broken.name = "broken";
  broken.binds.requires = "service : { oops : (";
  const r = await resolve(FRAGMENT, { packs: [broken] });
  assert.equal(r.ok, false);
  const d = byCode(r, "E_CANDID");
  assert.equal(d.length, 1);
  assert.equal(d[0].at, "binds.requires");
});

test("a service class (init arguments) is matched on its service type", async () => {
  const did = `type LedgerArg = record { name : text }; ${FRAGMENT.replace("service : {", "service : (LedgerArg) -> {")}`;
  const m = await matches(icrc1, did);
  assert.equal(m.matched, true, JSON.stringify(m.reasons));
});
