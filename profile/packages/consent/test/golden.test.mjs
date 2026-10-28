// Golden tests: every ICRC-1 / ICRC-2 update method on 8, 6 and 18 decimal ledgers.
//
// Three independent checks per case:
//   1. the committed JSON equals what the code produces now (regression);
//   2. the hand-worked `expect` of cases.mjs holds (so the JSON cannot just record a bug);
//   3. the reply encodes, and the Rust candid crates decode it against the standard's ICRC-21.did.
// test/golden/REVIEW.md is the by-eye review copy; a test keeps it in step with the JSON.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { decode } from "@dfinity/didc";
import { encodeConsentResponse, icrc21ConsentMessage, toJson } from "../src/index.mjs";
import { LEDGERS, encodeCall, hexOf, icrc1, icrc2, refsFor, inspectMarkdown as inspect } from "./helpers.mjs";
import { buildGolden, renderReview } from "./golden/build.mjs";
import { CASES } from "./golden/cases.mjs";

const dir = new URL("./golden/", import.meta.url);
const stored = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), "utf8"));
const ICRC21_DID = readFileSync(new URL("./upstream/icrc21/ICRC-21.did", import.meta.url), "utf8");

const matches = (actual, expected, what) => {
  if (expected instanceof RegExp) assert.match(actual, expected, what);
  else assert.equal(actual, expected, what);
};

test("golden: the case list, the JSON files and the review file are in step", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, CASES.map((c) => c.id).sort());
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, "case ids are unique");
  assert.equal(readFileSync(new URL("REVIEW.md", dir), "utf8"), renderReview(CASES), "run `npm run golden -w packages/consent`, read the REVIEW.md diff, commit");
});

test("golden: coverage - every update method on every ledger, and every scenario the task lists", () => {
  for (const method of ["icrc1_transfer", "icrc2_approve", "icrc2_transfer_from"]) {
    for (const ledger of ["TKA", "TKB", "TKC"]) {
      assert.ok(CASES.some((c) => c.method === method && c.ledger === ledger), `${method} on ${ledger}`);
    }
  }
  const has = (name, pred) => assert.ok(CASES.some(pred), name);
  has("a memo", (c) => /memo = opt/.test(c.args));
  has("a subaccount", (c) => /subaccount = opt/.test(c.args));
  has("an expiry", (c) => /expires_at = opt/.test(c.args));
  has("an expiry with a time zone", (c) => /expires_at = opt/.test(c.args) && c.utcOffsetMinutes);
  has("an expiry that is not whole seconds", (c) => /expires_at = opt \(1_791_547_200_500_000_000/.test(c.args));
  has("an 18-decimal amount above nat64", (c) => c.ledger === "TKC" && /above-nat64/.test(c.id));
  has("an amount above nat64 on 8 decimals", (c) => c.ledger === "TKA" && /above-nat64|unlimited/.test(c.id));
  has("the last amount that fits nat64", (c) => /last-nat64/.test(c.id));
  for (const method of ["icrc1_transfer", "icrc2_approve", "icrc2_transfer_from"]) {
    has(`a Markdown-hostile memo on ${method}`, (c) => c.method === method && /evil\.example/.test(c.expect.memo ?? ""));
  }
  has("an absent optional", (c) => /memo = null/.test(c.args));
  has("a non-UTF-8 memo", (c) => /memo = opt blob "\\ff/.test(c.args));
  has("an explicit fee", (c) => /fee = opt/.test(c.args));
});

for (const c of CASES) {
  test(`golden ${c.id}`, () => {
    const g = stored(c.id);

    // the call: the bytes are what the Rust candid crates make of the textual arguments
    assert.equal(g.arg_hex, hexOf(encodeCall(c.method, c.args)), "arg_hex");

    // 1. regression: the committed JSON is what the code produces now
    assert.deepEqual(buildGolden(c), g);

    // 2. the hand-worked expectations
    const fields = g.fields.response.Ok.consent_message.FieldsDisplayMessage;
    const generic = g.generic.response.Ok.consent_message.GenericDisplayMessage;
    matches(fields.intent, c.expect.intent, "fields intent");
    const paragraph = generic.split("\n\n")[1];
    matches(paragraph, c.expect.sentence, "generic paragraph");
    const title = { icrc1_transfer: "Send tokens", icrc2_approve: "Approve spending", icrc2_transfer_from: "Transfer using allowance" }[c.method];
    assert.ok(generic.startsWith(`# ${title}\n\n`), "generic title");
    assert.ok(fields.intent.startsWith(`${title}: `), "fields intent starts with the title");
    const rows = new Map(fields.fields);
    for (const [label, value] of Object.entries(c.expect.rows ?? {})) assert.deepEqual(rows.get(label), value, `row ${label}`);
    if (c.expect.labels) assert.deepEqual(fields.fields.map(([l]) => l), c.expect.labels, "row labels, in template order");
    // the generic list repeats the same fields, in the same order
    const listed = generic.split("\n\n").slice(2).join("\n\n").split("\n").map((l) => /^- \*\*(.*):\*\* /.exec(l)?.[1]);
    assert.deepEqual(listed, fields.fields.map(([l]) => l), "generic list = fields rows");
    // times: the fields form is never zone-sensitive; the generic form reports the offset it applied
    assert.equal(g.fields.response.Ok.metadata.utc_offset_minutes, null);
    const showsTime = /expires_at = opt/.test(c.args);
    assert.equal(g.generic.response.Ok.metadata.utc_offset_minutes, showsTime ? (c.utcOffsetMinutes ?? 0) : null);
    // the idempotency stamp is not part of any message
    assert.doesNotMatch(generic + fields.intent, /1791547200|created/i);
    // nothing state-dependent
    assert.doesNotMatch(generic + fields.intent, /balance|available|remaining/i);
    // the hostile memo is inert in the generic form (CommonMark reference parser) and verbatim in the fields form
    if (c.expect.memo !== undefined) {
      const { types, codes } = inspect(generic);
      for (const bad of ["link", "image", "html_inline", "html_block", "emph", "heading2"]) assert.ok(!types.has(bad), bad);
      assert.equal(codes.filter((x) => x === c.expect.memo).length, 2, "the memo is one code span in the paragraph and one in the list");
      assert.deepEqual(rows.get("Memo"), { Text: { content: c.expect.memo } });
    }
    // an amount that fits nat64 is a TokenAmount, one that does not is Text - never a rounded TokenAmount
    const amountRow = [...rows].find(([l]) => /^(Amount|Allowance|amount)$/.test(l))[1];
    if ("TokenAmount" in amountRow) assert.ok(BigInt(amountRow.TokenAmount.amount) <= 2n ** 64n - 1n);

    // 3. the reply is a valid icrc21_consent_message_response of the standard
    for (const form of ["fields", "generic"]) {
      const response = icrc21ConsentMessage(
        { method: c.method, arg: encodeCall(c.method, c.args), user_preferences: g[form].request.user_preferences },
        { resolved: c.pack === "icrc1" ? icrc1 : icrc2, refs: refsFor(LEDGERS[c.ledger]) },
      );
      const bytes = encodeConsentResponse(response);
      const text = decode({ idl: ICRC21_DID, input: Buffer.from(bytes).toString("hex"), serviceMethod: "icrc21_canister_call_consent_message", inputFormat: "hex", targetFormat: "candid" });
      assert.match(text, /variant\s*\{\s*Ok = record/, form);
      assert.match(text, form === "fields" ? /FieldsDisplayMessage = record/ : /GenericDisplayMessage = "/, form);
      assert.deepEqual(toJson(response), g[form].response, form);
    }
  });
}
