import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decode, encode } from "@dfinity/didc";
import {
  decodeConsentRequest,
  decodeConsentResponse,
  encodeConsentRequest,
  encodeConsentResponse,
  handleConsentRequest,
  icrc21ConsentMessage,
  toJson,
} from "../src/index.mjs";
import { ALICE, BOB, LEDGERS, SPENDER, encodeCall, icrc1, icrc2, refsFor, sha256, subaccountText, syntheticResolved, tag } from "./helpers.mjs";

const upstream = (name) => readFileSync(new URL(`./upstream/icrc21/${name}`, import.meta.url), "utf8");
const ICRC21_DID = upstream("ICRC-21.did");
const METHOD = "icrc21_canister_call_consent_message";

/** The resolved form of an ICRC-2 ledger: both packs, as the resolver would merge them. */
const ledger = { ...icrc1, methods: { ...icrc1.methods, ...icrc2.methods } };
const TKA = refsFor(LEDGERS.TKA);

const transferBytes = encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 29_000_000 : nat; memo = opt blob "hi"; fee = null; from_subaccount = null; created_at_time = null })`);
const request = (over = {}) => ({
  method: "icrc1_transfer",
  arg: transferBytes,
  user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { GenericDisplay: null } },
  ...over,
});
const withPrefs = (metadata, device_spec) => request({ user_preferences: { metadata: { language: "en", utc_offset_minutes: null, ...metadata }, device_spec } });
const run = (req, context = {}) => icrc21ConsentMessage(req, { resolved: ledger, refs: TKA, ...context });

const squash = (text) => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/;\s*([}\)])/g, " $1").trim();
const didcDecode = (bytes) => decode({ idl: ICRC21_DID, input: Buffer.from(bytes).toString("hex"), serviceMethod: METHOD, inputFormat: "hex", targetFormat: "candid" });

// ------------------------------------------------------------------------------------------ the standard's .did

test("upstream: the committed ICRC-21.did is the file recorded in SOURCE.json", () => {
  const source = JSON.parse(upstream("SOURCE.json"));
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  for (const [name, meta] of Object.entries(source.files)) {
    const text = upstream(name);
    assert.equal(sha256(text), meta.sha256, name);
    assert.equal(Buffer.byteLength(text), meta.bytes, name);
  }
  assert.equal(source.files["ICRC-21.did"].url.includes(source.commit), true);
});

test("upstream: the standard prefers a fallback message to an error (the rule the language policy follows)", () => {
  assert.match(ICRC21_DID, /If the message is not available for the given user_preferences any fallback message should be used\. Providing a\s+\/\/ message should be preferred over sending an icrc21_error\./);
  assert.match(ICRC21_DID, /The metadata must match the consent_message provided\./);
});

test("wire: a Fields response decodes against the standard's .did with every name and type (nat8, nat64, int16)", () => {
  const bytes = encodeConsentResponse({
    Ok: {
      consent_message: {
        FieldsDisplayMessage: {
          intent: "Send",
          fields: [
            ["Amount", { TokenAmount: { decimals: 8, amount: 29000000n, symbol: "TKA" } }],
            ["At", { TimestampSeconds: { amount: 1791547200n } }],
            ["For", { DurationSeconds: { amount: 86400n } }],
            ["Memo", { Text: { content: "hi" } }],
          ],
        },
      },
      metadata: { language: "en", utc_offset_minutes: -90 },
    },
  });
  assert.equal(
    squash(didcDecode(bytes)),
    squash(`( variant { Ok = record {
      metadata = record { utc_offset_minutes = opt (-90 : int16); language = "en"; };
      consent_message = variant { FieldsDisplayMessage = record {
        fields = vec {
          record { "Amount"; variant { TokenAmount = record { decimals = 8 : nat8; amount = 29_000_000 : nat64; symbol = "TKA"; } }; };
          record { "At"; variant { TimestampSeconds = record { amount = 1_791_547_200 : nat64 } }; };
          record { "For"; variant { DurationSeconds = record { amount = 86_400 : nat64 } }; };
          record { "Memo"; variant { Text = record { content = "hi" } }; };
        };
        intent = "Send"; } };
    } }, )`),
  );
});

test("wire: a Generic response and every error variant decode against the standard's .did", () => {
  const generic = encodeConsentResponse({ Ok: { consent_message: { GenericDisplayMessage: "# Hi" }, metadata: { language: "en-US", utc_offset_minutes: null } } });
  assert.equal(squash(didcDecode(generic)), squash(`( variant { Ok = record { metadata = record { utc_offset_minutes = null; language = "en-US"; }; consent_message = variant { GenericDisplayMessage = "# Hi" }; } }, )`));
  const errors = {
    UnsupportedCanisterCall: [{ UnsupportedCanisterCall: { description: "d" } }, 'UnsupportedCanisterCall = record { description = "d" }'],
    ConsentMessageUnavailable: [{ ConsentMessageUnavailable: { description: "d" } }, 'ConsentMessageUnavailable = record { description = "d" }'],
    InsufficientPayment: [{ InsufficientPayment: { description: "d" } }, 'InsufficientPayment = record { description = "d" }'],
    GenericError: [{ GenericError: { error_code: 1100n, description: "d" } }, 'GenericError = record { description = "d"; error_code = 1_100 : nat }'],
  };
  for (const [name, [err, text]] of Object.entries(errors)) {
    const bytes = encodeConsentResponse({ Err: err });
    assert.equal(squash(didcDecode(bytes)), squash(`( variant { Err = variant { ${text} } }, )`), name);
  }
});

test("wire: requests encoded by the Rust crates (from the .did) decode, and the JS shape round-trips", () => {
  const arg = `blob "${[...transferBytes].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;
  const encodeText = (spec, offset) =>
    Uint8Array.from(
      Buffer.from(encode({ idl: ICRC21_DID, input: `(record { method = "icrc1_transfer"; arg = ${arg}; user_preferences = record { metadata = record { language = "en-US"; utc_offset_minutes = ${offset} }; device_spec = ${spec} } })`, targetFormat: "hex", withType: { kind: "methodParams", name: METHOD } }), "hex"),
    );
  const a = decodeConsentRequest(encodeText("opt variant { FieldsDisplay }", "opt (-60 : int16)"));
  assert.equal(a.method, "icrc1_transfer");
  assert.deepEqual([...a.arg], [...transferBytes]);
  assert.deepEqual(a.user_preferences, { metadata: { language: "en-US", utc_offset_minutes: -60 }, device_spec: { FieldsDisplay: null } });
  const b = decodeConsentRequest(encodeText("null", "null"));
  assert.deepEqual(b.user_preferences, { metadata: { language: "en-US", utc_offset_minutes: null }, device_spec: null });
  const again = encodeConsentRequest(a);
  assert.deepEqual(decodeConsentRequest(again), a);
  assert.throws(() => decodeConsentRequest(Uint8Array.from([1, 2, 3])), (e) => e.code === "E_REQUEST");
});

test("wire: handleConsentRequest takes the canister's argument bytes and returns the reply bytes", () => {
  const bytes = encodeConsentRequest(request({ user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } }));
  const reply = handleConsentRequest(bytes, { resolved: ledger, refs: TKA });
  const out = decodeConsentResponse(reply);
  assert.equal(out.Ok.consent_message.FieldsDisplayMessage.intent, `Send tokens: Send 0.29 TKA to ${ALICE} with memo hi`);
  assert.match(squash(didcDecode(reply)), /^\(variant \{ Ok = record \{ metadata = record \{ utc_offset_minutes = null; language = "en"/);
  const bad = decodeConsentResponse(handleConsentRequest(Uint8Array.from([0, 1, 2]), { resolved: ledger, refs: TKA }));
  assert.ok("UnsupportedCanisterCall" in bad.Err);
});

// ------------------------------------------------------------------------------------------ forms and preferences

test("device_spec: GenericDisplay, FieldsDisplay, absent (generic) and malformed", () => {
  assert.ok("GenericDisplayMessage" in run(withPrefs({}, { GenericDisplay: null })).Ok.consent_message);
  assert.ok("FieldsDisplayMessage" in run(withPrefs({}, { FieldsDisplay: null })).Ok.consent_message);
  assert.ok("GenericDisplayMessage" in run(withPrefs({}, null)).Ok.consent_message);
  assert.ok("GenericDisplayMessage" in run(withPrefs({}, undefined)).Ok.consent_message);
  assert.ok("FieldsDisplayMessage" in run(withPrefs({}, "FieldsDisplay")).Ok.consent_message);
  assert.ok("UnsupportedCanisterCall" in run(withPrefs({}, { Braille: null })).Err);
});

test("language: English variants are answered as asked; anything else gets English and says so (the standard prefers a message to an error)", () => {
  for (const tagged of ["en", "en-US", "en-GB", "EN-us", "en_AU"]) {
    assert.equal(run(withPrefs({ language: tagged }, null)).Ok.metadata.language, tagged.replace("_", "-"), tagged);
  }
  for (const tagged of ["fr", "de-CH", "zh-Hans", "ja", "", "not a tag!", "x".repeat(100)]) {
    const r = run(withPrefs({ language: tagged }, null));
    assert.equal(r.Ok.metadata.language, "en", JSON.stringify(tagged));
    assert.ok("GenericDisplayMessage" in r.Ok.consent_message);
    assert.ok(r.diagnostics.some((d) => d.code === "I_LANGUAGE_FALLBACK"));
  }
  const strict = run(withPrefs({ language: "fr" }, null), { languagePolicy: "error" });
  assert.match(strict.Err.UnsupportedCanisterCall.description, /^E_LANGUAGE: language "fr" is not supported/);
  assert.ok("Ok" in run(withPrefs({ language: "en-GB" }, null), { languagePolicy: "error" }));
});

const approveBytes = (expires) =>
  encodeCall("icrc2_approve", `(record { spender = record { owner = principal "${SPENDER}"; subaccount = null }; amount = 5_000_000 : nat; expires_at = ${expires}; expected_allowance = null; memo = null; fee = null; from_subaccount = null; created_at_time = null })`);
const approve = (expires, prefs, spec, ctx) =>
  run({ method: "icrc2_approve", arg: approveBytes(expires), user_preferences: { metadata: { language: "en", utc_offset_minutes: null, ...prefs }, device_spec: spec } }, ctx);

test("time zone: the generic form shows the zone asked for and says so; absent means UTC", () => {
  const noon = "opt (1_791_547_200_000_000_000 : nat64)"; // 2026-10-09T12:00:00Z
  const utc = approve(noon, {}, { GenericDisplay: null });
  assert.match(utc.Ok.consent_message.GenericDisplayMessage, /until `2026-10-09 12:00:00 UTC`/);
  assert.equal(utc.Ok.metadata.utc_offset_minutes, 0, "the response tells the signer which offset it applied");
  const plus2 = approve(noon, { utc_offset_minutes: 120 }, { GenericDisplay: null });
  assert.match(plus2.Ok.consent_message.GenericDisplayMessage, /until `2026-10-09 14:00:00 UTC\+02:00`/);
  assert.match(plus2.Ok.consent_message.GenericDisplayMessage, /- \*\*Expires at:\*\* `2026-10-09 14:00:00 UTC\+02:00`/);
  assert.equal(plus2.Ok.metadata.utc_offset_minutes, 120);
  const minus = approve(noon, { utc_offset_minutes: -330 }, { GenericDisplay: null });
  assert.match(minus.Ok.consent_message.GenericDisplayMessage, /`2026-10-09 06:30:00 UTC-05:30`/);
  const dateline = approve("opt (1_791_547_200_000_000_000 : nat64)", { utc_offset_minutes: 840 }, { GenericDisplay: null });
  assert.match(dateline.Ok.consent_message.GenericDisplayMessage, /`2026-10-10 02:00:00 UTC\+14:00`/, "the date rolls over");
  const crossing = approve("opt (1_791_502_200_000_000_000 : nat64)", { utc_offset_minutes: 60 }, { GenericDisplay: null }); // 2026-10-08T23:30:00Z
  assert.match(crossing.Ok.consent_message.GenericDisplayMessage, /`2026-10-09 00:30:00 UTC\+01:00`/, "midnight is crossed");
});

test("time zone: the fields form stays UTC seconds and is never zone-sensitive", () => {
  const r = approve("opt (1_791_547_200_000_000_000 : nat64)", { utc_offset_minutes: 120 }, { FieldsDisplay: null });
  const f = r.Ok.consent_message.FieldsDisplayMessage;
  assert.deepEqual(f.fields.find(([l]) => l === "Expires at"), ["Expires at", { TimestampSeconds: { amount: 1791547200n } }]);
  assert.equal(r.Ok.metadata.utc_offset_minutes, null, "absent in the response: the message is not time-zone sensitive");
  assert.equal(f.intent.includes("until 2026-10-09T12:00:00Z"), true, "the intent states the instant in UTC, with its zone");
});

test("time zone: a message without any time carries no offset, and an absurd offset is ignored with a diagnostic", () => {
  assert.equal(run(withPrefs({ utc_offset_minutes: 120 }, null)).Ok.metadata.utc_offset_minutes, null);
  const absurd = approve("opt (1_791_547_200_000_000_000 : nat64)", { utc_offset_minutes: 20000 }, { GenericDisplay: null });
  assert.match(absurd.Ok.consent_message.GenericDisplayMessage, /`2026-10-09 12:00:00 UTC`/);
  assert.equal(absurd.Ok.metadata.utc_offset_minutes, 0);
  assert.ok(absurd.diagnostics.some((d) => d.code === "W_UTC_OFFSET_IGNORED"));
});

// ------------------------------------------------------------------------------------------ spec section 12 value mapping

const fieldsOf = (r) => Object.fromEntries(r.Ok.consent_message.FieldsDisplayMessage.fields);
const approveFields = (expires, refs = TKA) => fieldsOf(approve(expires, {}, { FieldsDisplay: null }, { refs }));

test("section 12: amount is a TokenAmount when it fits nat64 and a Text when it does not", () => {
  const big = (amount, refs) => fieldsOf(run({ method: "icrc1_transfer", arg: encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = ${amount} : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } }, { refs })).Amount;
  assert.deepEqual(big("18_446_744_073_709_551_615", TKA), { TokenAmount: { decimals: 8, amount: 18446744073709551615n, symbol: "TKA" } }, "2^64 - 1 is the last amount that fits");
  assert.deepEqual(big("18_446_744_073_709_551_616", TKA), { Text: { content: "184467440737.09551616 TKA" } });
  assert.deepEqual(big("18_446_744_073_709_551_616", refsFor(LEDGERS.TKC)), { Text: { content: "18.446744073709551616 TKC" } });
  assert.deepEqual(big("1_000_000_000_000_000_000", refsFor(LEDGERS.TKC)), { TokenAmount: { decimals: 18, amount: 1000000000000000000n, symbol: "TKC" } });
  assert.deepEqual(big("0", refsFor(LEDGERS.TKB)), { TokenAmount: { decimals: 6, amount: 0n, symbol: "TKB" } });
});

test("section 12: timestamp is TimestampSeconds after an exact ns-to-s conversion, else Text in RFC 3339 UTC", () => {
  assert.deepEqual(approveFields("opt (1_791_547_200_000_000_000 : nat64)")["Expires at"], { TimestampSeconds: { amount: 1791547200n } });
  assert.deepEqual(approveFields("opt (1_791_547_200_500_000_000 : nat64)")["Expires at"], { Text: { content: "2026-10-09T12:00:00.5Z" } }, "half a second is not a whole number of seconds");
  assert.deepEqual(approveFields("opt (1_791_547_200_000_000_001 : nat64)")["Expires at"], { Text: { content: "2026-10-09T12:00:00.000000001Z" } }, "one nanosecond too many");
  assert.deepEqual(approveFields("opt (0 : nat64)")["Expires at"], { TimestampSeconds: { amount: 0n } });
  assert.deepEqual(approveFields("opt (18_446_744_073_000_000_000 : nat64)")["Expires at"], { TimestampSeconds: { amount: 18446744073n } }, "year 2554 still fits");
});

const unitResolved = (unitTag, candid = "nat64", unit = "s") =>
  syntheticResolved("f", [{ candid: "record", fields: { x: { candid, tags: { [unitTag]: tag({ unit }), describe: tag({ label: "X" }) } } } }], { intent: tag({ title: "T", template: "Do {x}" }) });
const unitFields = (resolved, candidType, value) =>
  Object.values(fieldsOf(run({ method: "f", arg: encodeCall("f", `(record { x = ${value} : ${candidType} })`, `service : { f : (record { x : ${candidType} }) -> () }`), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } }, { resolved })))[0];

test("section 12: duration is DurationSeconds in whole seconds, else Text in ISO 8601", () => {
  assert.deepEqual(unitFields(unitResolved("duration", "nat64", "s"), "nat64", "86_400"), { DurationSeconds: { amount: 86400n } });
  assert.deepEqual(unitFields(unitResolved("duration", "nat64", "ms"), "nat64", "90_000"), { DurationSeconds: { amount: 90n } });
  assert.deepEqual(unitFields(unitResolved("duration", "nat64", "ms"), "nat64", "1_500"), { Text: { content: "PT1.5S" } });
  assert.deepEqual(unitFields(unitResolved("duration", "int64", "s"), "int64", "-60"), { Text: { content: "-PT1M" } }, "a negative duration does not fit DurationSeconds");
  assert.deepEqual(unitFields(unitResolved("duration", "nat64", "ns"), "nat64", "3_600_000_000_000"), { DurationSeconds: { amount: 3600n } });
});

test("section 12: timestamps before 1970 and in other units follow the same rule", () => {
  assert.deepEqual(unitFields(unitResolved("timestamp", "int64", "s"), "int64", "-1"), { Text: { content: "1969-12-31T23:59:59Z" } });
  assert.deepEqual(unitFields(unitResolved("timestamp", "nat64", "ms"), "nat64", "1_791_547_200_000"), { TimestampSeconds: { amount: 1791547200n } });
  assert.deepEqual(unitFields(unitResolved("timestamp", "nat64", "us"), "nat64", "1_791_547_200_000_001"), { Text: { content: "2026-10-09T12:00:00.000001Z" } });
});

test("section 12: everything else is Text; an amount without a symbol or a negative amount cannot be a TokenAmount", () => {
  const f = fieldsOf(run({ method: "icrc2_transfer_from", arg: encodeCall("icrc2_transfer_from", `(record { from = record { owner = principal "${ALICE}"; subaccount = opt ${subaccountText(9)} }; to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; spender_subaccount = opt ${subaccountText(300 % 256)}; memo = opt blob "m"; fee = null; created_at_time = null })`), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } }));
  for (const label of ["From", "Recipient", "Spender subaccount", "Memo"]) assert.ok(f[label]?.Text !== undefined, `${label} is Text`);
  assert.equal(f["Spender subaccount"].Text.content, "#44");
  const noSymbol = syntheticResolved("f", [{ candid: "record", fields: { x: { candid: "int", tags: { amount: tag({ decimals: 2 }) } } } }], { intent: tag({ title: "T", template: "Do {x}" }) });
  assert.deepEqual(unitFields(noSymbol, "int", "12_345"), { Text: { content: "123.45" } });
  assert.deepEqual(unitFields(noSymbol, "int", "-150"), { Text: { content: "-1.5" } });
  const withSymbol = syntheticResolved("f", [{ candid: "record", fields: { x: { candid: "int", tags: { amount: tag({ decimals: 2, symbol: "EUR" }) } } } }], { intent: tag({ title: "T", template: "Do {x}" }) });
  assert.deepEqual(unitFields(withSymbol, "int", "-150"), { Text: { content: "-1.5 EUR" } });
  assert.deepEqual(unitFields(withSymbol, "int", "150"), { TokenAmount: { decimals: 2, amount: 150n, symbol: "EUR" } });
});

test("section 12: an amount at or above its threshold, and a timestamp shown as words, are Text, never a number", () => {
  const unlimited = syntheticResolved("f", [{ candid: "record", fields: { x: { candid: "nat", tags: { amount: tag({ decimals: 2, symbol: "EUR", threshold: "1000", message: "Unlimited" }) } } } }], { intent: tag({ title: "T", template: "Do {x}" }) });
  assert.deepEqual(unitFields(unlimited, "nat", "999"), { TokenAmount: { decimals: 2, amount: 999n, symbol: "EUR" } });
  assert.deepEqual(unitFields(unlimited, "nat", "1_000"), { Text: { content: "Unlimited EUR" } });
  const words = syntheticResolved("f", [{ candid: "record", fields: { x: { candid: "nat64", tags: { timestamp: tag({ unit: "s", epoch: "unix", threshold: "4102444800", message: "Never", labels: { 0: "Now" } }) } } } }], { intent: tag({ title: "T", template: "Do {x}" }) });
  assert.deepEqual(unitFields(words, "nat64", "0"), { Text: { content: "Now" } });
  assert.deepEqual(unitFields(words, "nat64", "4_102_444_800"), { Text: { content: "Never" } });
  assert.deepEqual(unitFields(words, "nat64", "1"), { TimestampSeconds: { amount: 1n } });
  // the generic form in a time zone shows the words too, not a zoned time
  const generic = run({ method: "f", arg: encodeCall("f", "(record { x = 0 : nat64 })", "service : { f : (record { x : nat64 }) -> () }"), user_preferences: { metadata: { language: "en", utc_offset_minutes: 120 }, device_spec: { GenericDisplay: null } } }, { resolved: words });
  assert.match(generic.Ok.consent_message.GenericDisplayMessage, /Do `Now`/);
});

test("section 12: labels come from describe.label, else the field name", () => {
  const f = approve("null", {}, { FieldsDisplay: null }).Ok.consent_message.FieldsDisplayMessage.fields.map(([l]) => l);
  assert.deepEqual(f, ["Spender", "Allowance"], "icrc2_approve: describe labels of the pack");
  const tf = run({ method: "icrc2_transfer_from", arg: encodeCall("icrc2_transfer_from", `(record { from = record { owner = principal "${ALICE}"; subaccount = null }; to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; spender_subaccount = null; memo = null; fee = null; created_at_time = null })`), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } });
  assert.deepEqual(tf.Ok.consent_message.FieldsDisplayMessage.fields.map(([l]) => l), ["Amount", "From", "Recipient"], "icrc2_transfer_from: describe labels of the pack (D-029)");
  const bare = syntheticResolved("f", [{ candid: "record", fields: { amount: { candid: "nat" }, note: { candid: "text", tags: { describe: tag({ label: "Remark" }) } } } }], { intent: tag({ title: "T", template: "Do {amount} {note}" }) });
  const r = icrc21ConsentMessage({ method: "f", arg: encodeCall("f", `(record { amount = 1; note = "x" })`, "service : { f : (record { amount : nat; note : text }) -> () }"), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } }, { resolved: bare });
  assert.deepEqual(r.Ok.consent_message.FieldsDisplayMessage.fields.map(([l]) => l), ["amount", "Remark"], "no describe.label: the field name is used");
});

// ------------------------------------------------------------------------------------------ errors

const describeErr = (r) => Object.entries(r.Err)[0];

test("errors: the ICRC-21 variants the standard prescribes", () => {
  const unknown = run(request({ method: "icrc1_mint" }));
  assert.equal(describeErr(unknown)[0], "UnsupportedCanisterCall");
  assert.match(unknown.Err.UnsupportedCanisterCall.description, /^E_METHOD_UNKNOWN:/);

  const garbage = run(request({ arg: Uint8Array.from([1, 2, 3]) }));
  assert.equal(describeErr(garbage)[0], "UnsupportedCanisterCall");
  assert.match(garbage.Err.UnsupportedCanisterCall.description, /^E_DECODE:/);

  const big = run(request({ arg: new Uint8Array(3 * 1024 * 1024) }));
  assert.match(big.Err.UnsupportedCanisterCall.description, /^E_TOO_LARGE:/);

  const noRefs = run(request(), { refs: {} });
  assert.deepEqual(Object.keys(noRefs.Err), ["GenericError"]);
  assert.equal(noRefs.Err.GenericError.error_code, 1100n);
  assert.match(noRefs.Err.GenericError.description, /^E_REF_UNRESOLVED:/);

  const recursive = syntheticResolved("f", [{ candid: "record", recursive: true }], {});
  const unavailable = icrc21ConsentMessage({ method: "f", arg: encodeCall("f", "(null)", "service : { f : (null) -> () }"), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: null } }, { resolved: recursive });
  assert.equal(describeErr(unavailable)[0], "ConsentMessageUnavailable");

  for (const bad of [null, {}, { method: 1 }, { method: "m", arg: "x" }, { method: "m", arg: [], user_preferences: {} }]) {
    assert.equal(describeErr(run(bad))[0], "UnsupportedCanisterCall", JSON.stringify(bad));
  }
});

test("errors: descriptions are bounded and never echo more than a developer needs", () => {
  const r = run(request({ method: "x".repeat(5000) }));
  assert.ok(r.Err.UnsupportedCanisterCall.description.length <= 1003);
});

test("errors: a malformed resolved form is a GenericError, not an exception", () => {
  const r = icrc21ConsentMessage(request(), { resolved: { nope: true }, refs: TKA });
  assert.equal(r.Err.GenericError.error_code, 1000n);
});

test("every Ok and Err encodes with the codec and survives a round trip", () => {
  const results = [
    run(withPrefs({}, { GenericDisplay: null })),
    run(withPrefs({}, { FieldsDisplay: null })),
    run(request({ method: "nope" })),
    run(request(), { refs: {} }),
    approve("opt (1_791_547_200_000_000_000 : nat64)", { utc_offset_minutes: 120 }, { GenericDisplay: null }),
  ];
  for (const r of results) {
    const back = decodeConsentResponse(encodeConsentResponse(r));
    assert.deepEqual(toJson(back), toJson(r));
  }
});

test("the diagnostics ride along but are not part of the ICRC-21 result", () => {
  const r = run(withPrefs({ language: "fr" }, null));
  assert.deepEqual(Object.keys(r), ["Ok"]);
  assert.equal(JSON.stringify(toJson(r)).includes("diagnostics"), false);
  assert.ok(r.diagnostics.length > 0);
});

test("provenance rides along (not part of the ICRC-21 result): which profile wrote the words", () => {
  const r = run(withPrefs({}, null));
  assert.deepEqual(r.provenance.intent, { origin: "pack", profile: "icrc1" });
  assert.deepEqual(r.provenance.profiles.map((p) => p.name), ["icrc1"]);
  assert.equal(Object.keys(r).includes("provenance"), false);
  const generic = run({ method: "icrc1_decimals", arg: encodeCall("icrc1_decimals", "()"), user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: null } });
  assert.equal(generic.provenance.intent, null, "a generic intent has no profile behind its words");
  assert.equal(run(request({ method: "nope" })).provenance, null, "no message, no provenance");
});

test("toJson writes a blob near the request limit as lowercase hex", () => {
  const blob = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 131 + 7) & 255;
  const { hex } = toJson(blob);
  assert.equal(hex.length, blob.length * 2);
  assert.equal(hex, Buffer.from(blob).toString("hex"));
  assert.deepEqual(toJson(new Uint8Array([0, 15, 16, 255])), { hex: "000f10ff" });
  assert.deepEqual(toJson(new Uint8Array(0)), { hex: "" });
});
