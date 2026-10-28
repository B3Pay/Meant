import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeArguments } from "../src/decode.mjs";
import { resolvePath, valuesAt } from "../src/paths.mjs";
import { BOB, encodeCall, icrc1, icrc2, subaccountText, syntheticResolved } from "./helpers.mjs";

const transferBytes = encodeCall(
  "icrc1_transfer",
  `(record { to = record { owner = principal "${BOB}"; subaccount = opt ${subaccountText(3)} }; amount = 5 : nat; memo = null; fee = opt (7 : nat); from_subaccount = null; created_at_time = null })`,
);
const transfer = icrc1.methods.icrc1_transfer;
const values = decodeArguments(transfer, transferBytes);
const at = (rel) => {
  const p = resolvePath(transfer, rel);
  assert.equal(p.error, undefined, rel);
  return valuesAt(p, values);
};

test("paths: a field of the single argument, with or without the (0) prefix", () => {
  assert.deepEqual(at("amount"), ["5"]);
  assert.deepEqual(at("(0).amount"), ["5"]);
  assert.deepEqual(at("fee"), ["7"]);
  assert.deepEqual(at("to.owner"), [BOB]);
  assert.equal(at("to")[0].owner, BOB);
});

test("paths: an absent optional gives no values, also when it is on the way", () => {
  assert.deepEqual(at("memo"), []);
  assert.deepEqual(at("from_subaccount"), []);
  assert.deepEqual(at("created_at_time"), []);
  assert.equal(at("to.subaccount").length, 1);
});

test("paths: the raw id spelling reaches the same position", () => {
  const p = resolvePath(transfer, "amount");
  const byId = resolvePath(transfer, "#3573748184");
  assert.equal(byId.error, undefined);
  assert.equal(byId.steps[0].key, p.steps[0].key);
});

test("paths: unknown fields, a missing index and an index out of range are reported, not thrown", () => {
  assert.match(resolvePath(transfer, "nope").error, /no field or case "nope"/);
  assert.match(resolvePath(transfer, "amount.deeper").error, /no field or case/);
  assert.match(resolvePath(transfer, "(3).amount").error, /out of range/);
  const two = syntheticResolved("f", [{ candid: "nat" }, { candid: "nat" }]).methods.f;
  assert.match(resolvePath(two, "x").error, /must start with \(i\)/);
  assert.equal(resolvePath(two, "(1)").error, undefined);
  assert.match(resolvePath(transfer, "amount[]").error, /"\[\]" applied to nat/);
});

test("paths: variant cases select by tag, vectors fan out, absent elements drop", () => {
  const resolved = syntheticResolved("f", [
    {
      candid: "record",
      fields: {
        v: { candid: "variant", cases: { A: { candid: "nat" }, B: { candid: "text" } } },
        xs: { candid: "vec", element: { candid: "record", fields: { n: { candid: "nat", optional: true } } } },
        names: { candid: "vec", element: { candid: "text" } },
      },
    },
  ]);
  const m = resolved.methods.f;
  const did = `service : { f : (record { v : variant { A : nat; B : text }; xs : vec record { n : opt nat }; names : vec text }) -> () }`;
  const v = decodeArguments(m, encodeCall("f", `(record { v = variant { A = 9 }; xs = vec { record { n = opt 1 }; record { n = null }; record { n = opt 3 } }; names = vec { "a"; "b" } })`, did));
  const get = (rel) => valuesAt(resolvePath(m, rel), v);
  assert.deepEqual(get("v.A"), ["9"]);
  assert.deepEqual(get("v.B"), [], "another case is selected: absent");
  assert.deepEqual(get("xs[].n"), ["1", "3"]);
  assert.deepEqual(get("names[]"), ["a", "b"]);
  assert.deepEqual(get("xs[]").length, 3);
});

test("paths: ICRC-2 placeholders of the pack templates resolve", () => {
  const approve = icrc2.methods.icrc2_approve;
  for (const rel of ["spender", "amount", "expected_allowance", "expires_at", "from_subaccount", "memo"]) {
    assert.equal(resolvePath(approve, rel).error, undefined, rel);
  }
  const tf = icrc2.methods.icrc2_transfer_from;
  for (const rel of ["amount", "from", "to", "spender_subaccount", "memo"]) assert.equal(resolvePath(tf, rel).error, undefined, rel);
});
