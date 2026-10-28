// A `principal` position with no value tag (profile spec 5.3 has no tag for it) is an input in its textual form, read
// exactly: checksum checked, canonical text out, the value candid-core's encoder takes. Before, every method with
// such a position was skipped ("no rule for a principal position without a value tag").
import { test } from "node:test";
import assert from "node:assert/strict";
import { c } from "@candid-core/schema";
import { encodeArgs } from "@candid-core/schema/codec";
import { buildToolPlans, displayValue, readToolInput, toolDefinitions } from "../src/index.mjs";
import { ICRC1, PACKS } from "./helpers.mjs";

const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const label = (text) => ({ describe: { args: { label: text }, origin: "author", profile: "test" } });

/** icrc1_transfer with `to` a bare principal: an update method with a stamp, an intent and outcome classes. */
const transfer = structuredClone(ICRC1.methods.icrc1_transfer);
transfer.args[0].fields.to = { candid: "principal", tags: label("Recipient") };
const RESOLVED = {
  ...structuredClone(ICRC1),
  methods: {
    owner_balance: { mode: "query", args: [{ candid: "principal" }], results: [{ candid: "nat" }], tags: {} },
    lookup: {
      mode: "query",
      args: [{ candid: "record", fields: { who: { candid: "principal", tags: label("Who") }, backup: { candid: "principal", optional: true } } }],
      results: [{ candid: "nat" }],
      tags: {},
    },
    many: { mode: "query", args: [{ candid: "record", fields: { who: { candid: "vec", element: { candid: "principal" } } } }], results: [{ candid: "nat" }], tags: {} },
    send_to_principal: transfer,
  },
};

test("untagged principal positions are inputs; a vec of principals is a JSON array of them (D-050)", () => {
  const { plans, skipped } = buildToolPlans(RESOLVED);
  assert.deepEqual([...plans.keys()], ["lookup", "many", "owner_balance", "prepare_send_to_principal"]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(readToolInput(plans.get("many"), { who: [LEDGER, " AAAAA-AA "] }).value, { who: [LEDGER, "aaaaa-aa"] });
  assert.deepEqual(plans.get("owner_balance").params.map((p) => [p.name, p.optional]), [["principal", false]]);
  assert.deepEqual(plans.get("lookup").params.map((p) => [p.name, p.optional]), [["who", false], ["backup", true]]);
  assert.ok(plans.get("prepare_send_to_principal").params.some((p) => p.name === "to"));
});

test("the tool schema describes the textual form, with a pattern every accepted input matches", () => {
  const defs = new Map(toolDefinitions(RESOLVED).map((d) => [d.name, d]));
  const who = defs.get("lookup").inputSchema.properties.who;
  assert.equal(who.type, "string");
  assert.match(who.description, /^Who\. A principal \(a canister or user id\) in its textual form: .* For example "ryjl3-tyaaa-aaaaa-aaaba-cai" or "aaaaa-aa"\.$/);
  assert.deepEqual(defs.get("lookup").inputSchema.required, ["who"]);
  assert.match(defs.get("lookup").inputSchema.properties.backup.description, /Optional: leave it out for none\.$/);
  const pattern = new RegExp(who.pattern, "u");
  for (const ok of [LEDGER, "aaaaa-aa", "2vxsx-fae", " RYJL3-TYAAA-AAAAA-AAABA-CAI "]) assert.match(ok, pattern);
  for (const bad of ["", "ryjl3tyaaaaaaaaaaabacai", "ryjl3-tyaaa-aaaaa-aaaba-ca1"]) assert.doesNotMatch(bad, pattern);
  assert.ok(defs.get("prepare_send_to_principal").inputSchema.properties.to.description.startsWith("Recipient. A principal"));
});

test("readToolInput reads the canonical text, checks the checksum, and the value encodes", () => {
  const { plans } = buildToolPlans(RESOLVED);
  const root = readToolInput(plans.get("owner_balance"), { principal: ` ${LEDGER.toUpperCase()} ` });
  assert.deepEqual(root, { value: LEDGER, identity: [["principal", LEDGER]] });
  assert.equal(encodeArgs([c.principal], [root.value]).ok, true);

  const rec = readToolInput(plans.get("lookup"), { who: "aaaaa-aa" });
  assert.deepEqual(rec.value, { backup: null, who: "aaaaa-aa" });
  assert.equal(encodeArgs([c.record({ who: c.principal, backup: c.opt(c.principal) })], [rec.value]).ok, true);

  const typo = readToolInput(plans.get("lookup"), { who: "ryjl3-tyaaa-aaaaa-aaaba-cai", backup: "ryjl3-tyaaa-aaaaa-aaabb-cai" });
  assert.deepEqual(typo.issues.map((i) => [i.param, i.code]), [["backup", "E_PRINCIPAL"]]);
  assert.deepEqual(readToolInput(plans.get("lookup"), { who: 7 }).issues.map((i) => [i.param, i.code]), [["who", "E_TYPE"]]);

  const send = readToolInput(plans.get("prepare_send_to_principal"), { to: LEDGER, amount: "1.5" }, { refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" } });
  assert.equal(send.value.to, LEDGER);
  assert.equal(send.value.amount, 150000000n);
  assert.equal(send.value.created_at_time, null, "the stamp is the layer's");
});

test("displayValue shows an untagged principal as its text", () => {
  assert.equal(displayValue({ candid: "principal" }, LEDGER), LEDGER);
});

test("the pack tools are unchanged: they have no bare principal position", () => {
  assert.deepEqual(toolDefinitions(PACKS), toolDefinitions(PACKS)); // a fresh copy each time
  assert.deepEqual(buildToolPlans(PACKS).skipped, []);
});
