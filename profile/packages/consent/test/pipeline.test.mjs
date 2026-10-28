// The whole path: a .did and the packs go through the real resolver (packages/resolver), the resolved form and
// Candid argument bytes go into the consent generator. No hand-made resolved form here.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { generateConsent, icrc21ConsentMessage, toJson } from "../src/index.mjs";
import { ALICE, BOB, LEDGERS, LEDGER_DID, SPENDER, encodeCall, icrc1, icrc2, refsFor, subaccountText } from "./helpers.mjs";

const validateSchema = await createSchemaValidator();
const packs = (await loadPacks()).map(({ doc }) => ({ doc }));
const resolve = async (did, profiles = []) => {
  const r = await resolveService({ did, validateSchema, profiles, packs });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
  return r.resolved;
};
const ledger = await resolve(LEDGER_DID);
const prefs = (spec) => ({ metadata: { language: "en", utc_offset_minutes: null }, device_spec: spec });

test("pipeline: the real ledger .did plus the packs resolves to the same positions as the committed fixtures", () => {
  for (const [resolved, method] of [[icrc1, "icrc1_transfer"], [icrc2, "icrc2_approve"], [icrc2, "icrc2_transfer_from"]]) {
    assert.deepEqual(ledger.methods[method].tags.intent, resolved.methods[method].tags.intent, method);
    for (const [key, node] of Object.entries(resolved.methods[method].args[0].fields)) {
      assert.deepEqual(ledger.methods[method].args[0].fields[key].tags, node.tags, `${method}.${key}`);
    }
  }
});

test("pipeline: consent messages are identical from the real resolver output and from the fixtures", () => {
  const merged = { ...icrc1, methods: { ...icrc1.methods, ...icrc2.methods } };
  const calls = {
    icrc1_transfer: `(record { to = record { owner = principal "${BOB}"; subaccount = opt ${subaccountText(7)} }; amount = 150_000_000 : nat; memo = opt blob "lunch"; fee = opt (10_000 : nat); from_subaccount = opt ${subaccountText(1)}; created_at_time = opt (1_791_547_200_000_000_000 : nat64) })`,
    icrc2_approve: `(record { spender = record { owner = principal "${SPENDER}"; subaccount = null }; amount = 5_000_000 : nat; expires_at = opt (1_791_547_200_000_000_000 : nat64); expected_allowance = opt (1 : nat); memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    icrc2_transfer_from: `(record { from = record { owner = principal "${ALICE}"; subaccount = null }; to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; spender_subaccount = opt ${subaccountText(2)}; memo = null; fee = null; created_at_time = null })`,
  };
  for (const [method, text] of Object.entries(calls)) {
    for (const form of ["fields", "generic"]) {
      const input = { method, arg: encodeCall(method, text), refs: refsFor(LEDGERS.TKB), form };
      assert.deepEqual(generateConsent({ ...input, resolved: ledger }).message, generateConsent({ ...input, resolved: merged }).message, `${method} ${form}`);
    }
  }
});

test("pipeline: ICRC-21 consent through the real ledger resolution, both forms, for all three update methods", () => {
  const calls = {
    icrc1_transfer: `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 29_000_000 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    icrc2_approve: `(record { spender = record { owner = principal "${SPENDER}"; subaccount = null }; amount = 5 : nat; expires_at = null; expected_allowance = null; memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    icrc2_transfer_from: `(record { from = record { owner = principal "${ALICE}"; subaccount = null }; to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; spender_subaccount = null; memo = null; fee = null; created_at_time = null })`,
  };
  for (const [method, text] of Object.entries(calls)) {
    for (const spec of [{ GenericDisplay: null }, { FieldsDisplay: null }]) {
      const r = icrc21ConsentMessage({ method, arg: encodeCall(method, text), user_preferences: prefs(spec) }, { resolved: ledger, refs: refsFor(LEDGERS.TKA) });
      assert.ok(r.Ok, `${method}: ${JSON.stringify(toJson(r))}`);
    }
  }
});

test("pipeline: any method, not only transfers - the tokens example (type: addresses, nested placeholder amount.e8s)", async () => {
  const did = await readFile(new URL("../../../examples/tokens.did", import.meta.url), "utf8");
  const profile = JSON.parse(await readFile(new URL("../../../examples/tokens.profile.json", import.meta.url), "utf8"));
  const resolved = await resolve(did, [{ doc: profile }]);
  const send = icrc21ConsentMessage(
    { method: "send", arg: encodeCall("send", `(record { to = principal "${BOB}"; amount = record { e8s = 250_000_000 : nat64 }; memo = opt blob "thanks"; created_at = null })`, did), user_preferences: prefs({ FieldsDisplay: null }) },
    { resolved },
  );
  assert.deepEqual(send.Ok.consent_message.FieldsDisplayMessage, {
    intent: `Send TOK: Send 2.5 TOK to ${BOB} with memo thanks`,
    fields: [
      ["Amount", { TokenAmount: { decimals: 8, amount: 250000000n, symbol: "TOK" } }],
      ["to", { Text: { content: BOB } }],
      ["memo", { Text: { content: "thanks" } }],
    ],
  });
  const balance = icrc21ConsentMessage({ method: "balance", arg: encodeCall("balance", `(principal "${ALICE}")`, did), user_preferences: prefs(null) }, { resolved });
  assert.equal(balance.Ok.consent_message.GenericDisplayMessage, `# Call balance\n\n- **Argument 1:** \`${ALICE}\``);
});

test("pipeline: a canister with no profile at all still gets a consent message for every method", async () => {
  const did = await readFile(new URL("../../../examples/tokens.did", import.meta.url), "utf8");
  const bare = await resolve(did);
  assert.equal(bare.methods.send.tags.intent, undefined);
  const arg = encodeCall("send", `(record { to = principal "${BOB}"; amount = record { e8s = 250_000_000 : nat64 }; memo = opt blob "thanks"; created_at = null })`, did);
  const g = icrc21ConsentMessage({ method: "send", arg, user_preferences: prefs(null) }, { resolved: bare });
  assert.equal(
    g.Ok.consent_message.GenericDisplayMessage,
    ["# Call send", "", `- **to:** \`${BOB}\``, '- **memo:** `blob "\\74\\68\\61\\6e\\6b\\73"`', "- **amount.e8s:** `250000000`"].join("\n"),
  );
  const f = icrc21ConsentMessage({ method: "send", arg, user_preferences: prefs({ FieldsDisplay: null }) }, { resolved: bare });
  assert.equal(f.Ok.consent_message.FieldsDisplayMessage.intent, "Call send");
});
