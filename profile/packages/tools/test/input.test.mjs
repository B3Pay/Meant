import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolPlans, displayValue, readToolInput } from "../src/index.mjs";
import { LEDGERS, PACKS, encodeArgsFor } from "./helpers.mjs";

const { plans } = buildToolPlans(PACKS);
const refs = LEDGERS[0].refs;
const OWNER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const NOW = 1791547200123456789n;

test("readToolInput: human units to candid-core's value, never rounded", () => {
  const r = readToolInput(plans.get("prepare_icrc1_transfer"), { to: OWNER, amount: "1.5 TKA", memo: "hi", from_subaccount: "#7" }, { refs });
  assert.deepEqual(r.value, {
    to: { owner: OWNER, subaccount: null },
    fee: null,
    memo: new Uint8Array([104, 105]),
    from_subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)),
    created_at_time: null,
    amount: 150000000n,
  });
  // the value encodes with candid-core once the stamp is set
  assert.ok(encodeArgsFor("icrc1_transfer", { ...r.value, created_at_time: NOW }).length > 0);
});

test("readToolInput: a whole-argument input (balance_of's account)", () => {
  const r = readToolInput(plans.get("icrc1_balance_of"), { account: OWNER }, { refs });
  assert.deepEqual(r.value, { owner: OWNER, subaccount: null });
});

test("readToolInput: issues with the format library's codes, every one at once", () => {
  const r = readToolInput(plans.get("prepare_icrc1_transfer"), { amount: "1.000000000", memo: 5, colour: "red" }, { refs });
  assert.deepEqual(
    r.issues.map((i) => [i.param, i.path, i.code]),
    [
      ["colour", "$args", "E_UNKNOWN_PARAM"],
      ["to", "$args[0].to", "E_MISSING"],
      ["memo", "$args[0].memo", "E_TYPE"],
      ["amount", "$args[0].amount", "E_EXCESS_PRECISION"],
    ],
  );
  assert.equal(readToolInput(plans.get("prepare_icrc1_transfer"), [], { refs }).issues[0].code, "E_INPUT");
  assert.equal(readToolInput(plans.get("prepare_icrc1_transfer"), { to: OWNER, amount: "1" }).issues[0].code, "E_REF_UNRESOLVED");
});

test("readToolInput: a relative time needs the clock, and counts by its duration in the identity", () => {
  const approve = plans.get("prepare_icrc2_approve");
  const base = { spender: OWNER, amount: "1" };
  assert.equal(readToolInput(approve, { ...base, expires_at: "+P7D" }, { refs }).issues[0].code, "E_NEEDS_NOW");
  const a = readToolInput(approve, { ...base, expires_at: "+P7D" }, { refs, now: NOW });
  const b = readToolInput(approve, { ...base, expires_at: "+PT168H" }, { refs, now: NOW + 5_000_000_000n });
  assert.deepEqual(a.identity, b.identity);
  assert.notEqual(a.value.expires_at, b.value.expires_at);
  assert.equal(a.value.expires_at, NOW + 7n * 86_400n * 1_000_000_000n);
});

test("readToolInput: inputs that convert to the same value are the same intent", () => {
  const t = plans.get("prepare_icrc1_transfer");
  const id = (input) => readToolInput(t, input, { refs }).identity;
  assert.deepEqual(id({ to: OWNER, amount: "1.5" }), id({ to: OWNER, amount: "1.50 tka" }));
  assert.deepEqual(id({ to: OWNER, amount: "1", from_subaccount: "#0" }), id({ to: OWNER, amount: "1" }));
  assert.notDeepEqual(id({ to: OWNER, amount: "1", memo: "a" }), id({ to: OWNER, amount: "1", memo: "b" }));
});

test("displayValue: formatted and raw, JSON-safe", () => {
  const allowance = plans.get("icrc2_allowance").results[0];
  assert.deepEqual(displayValue(allowance, { allowance: 150000000n, expires_at: null }, refs), { allowance: { text: "1.5 TKA", raw: "150000000" }, expires_at: null });
  assert.deepEqual(displayValue(allowance, { allowance: 1n, expires_at: 1791547200000000000n }, refs).expires_at, { text: "2026-10-09T12:00:00Z", raw: "1791547200000000000" });
  // a missing ref keeps the raw value and says why
  assert.equal(displayValue(allowance, { allowance: 1n, expires_at: null }).allowance.raw, "1");
  assert.ok(JSON.stringify(displayValue(allowance, { allowance: 1n, expires_at: null })));
});

test("readToolInput: an omitted optional field named like an Object.prototype member reads as omitted (#37 review)", () => {
  const amount = { candid: "nat", optional: true, tags: { amount: { args: { decimals: 0 } } } };
  const plan = { params: ["toString", "constructor", "hasOwnProperty"].map((name) => ({ name, node: amount, optional: true, path: `$args[0].${name}` })), argNode: {}, rootParam: false };
  plan.fields = plan.params.map((p) => ({ name: p.name, node: p.node, role: "param", optional: true }));
  const r = readToolInput(plan, {});
  assert.equal(r.issues, undefined, JSON.stringify(r.issues));
  assert.deepEqual(Object.entries(r.value), [["toString", null], ["constructor", null], ["hasOwnProperty", null]]);
  assert.equal(readToolInput(plan, { toString: "5" }).value.toString, 5n);
});
