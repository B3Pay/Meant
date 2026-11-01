// The ICRC-21 envelope vectors of the Rust port (rust/tests/icrc21_envelope.rs, D-061): whole requests, as Candid
// bytes, with what `handleConsentRequest` answers for each. Pure: scripts/generate-golden.mjs writes vectors.json,
// test/icrc21-envelope.test.mjs checks that it is in step, and the Rust test checks that the crate answers the same.
//
// The requests: every golden call (test/golden/cases.mjs) as its golden asks for it, then, on a few of them, the
// preferences the envelope reads (language tags, offsets, a missing device spec, the fields form, the language policy),
// and requests that fail before or after decoding. `rust` says what the crate answers where it differs on purpose:
// "same", or the code it answers with instead ("E_FORM": the crate writes the generic form only).

import { CASES } from "../golden/cases.mjs";
import { LEDGERS, encodeCall, hexOf, icrc1, icrc2, refsFor } from "../helpers.mjs";
import { decodeConsentResponse, encodeConsentRequest, handleConsentRequest, toJson } from "../../src/index.mjs";

const GENERIC = { GenericDisplay: null };
const prefs = (language, utc_offset_minutes = null, device_spec = GENERIC) => ({ metadata: { language, utc_offset_minutes }, device_spec });

/** Preference variants, applied to the calls named in VARIED. */
const VARIANTS = [
  ["en-US", prefs("en-US")],
  ["en_GB", prefs("en_GB")],
  ["de-CH", prefs("de-CH")],
  ["not-a-tag", prefs("x")],
  ["offset-90", prefs("en", -90)],
  ["offset-out-of-range", prefs("en", 2000)],
  ["offset-int16-min", prefs("en", -32768)],
  ["offset-int16-max", prefs("en", 32767)],
  ["no-device-spec", prefs("en", null, null)],
  ["fields", prefs("en", null, { FieldsDisplay: null }), "E_FORM"],
];
const VARIED = new Set(["transfer-tka-basic", "approve-tka-expiry-utc", "transfer-from-tka-basic"]);

function vector(id, pack, ledgerId, requestBytes, { policy, rust = "same" } = {}) {
  const ledger = LEDGERS[ledgerId];
  const context = { resolved: pack === "icrc1" ? icrc1 : icrc2, refs: refsFor(ledger), ...(policy ? { languagePolicy: policy } : {}) };
  const response = handleConsentRequest(requestBytes, context);
  return {
    id,
    pack,
    ledger: { id: ledgerId, ...ledger },
    ...(policy ? { policy } : {}),
    request_hex: hexOf(requestBytes),
    response: toJson(decodeConsentResponse(response)),
    response_hex: hexOf(response),
    rust,
  };
}

export function buildEnvelopeVectors() {
  const out = [];
  const varied = new Set();
  for (const c of CASES) {
    const arg = encodeCall(c.method, c.args);
    const request = (user_preferences) => encodeConsentRequest({ method: c.method, arg, user_preferences });
    out.push(vector(c.id, c.pack, c.ledger, request(prefs("en", c.utcOffsetMinutes ?? null))));
    if (!VARIED.has(c.id)) continue;
    varied.add(c.id);
    for (const [name, p, rust] of VARIANTS) out.push(vector(`${c.id}--${name}`, c.pack, c.ledger, request(p), { rust }));
    out.push(vector(`${c.id}--policy-error-de`, c.pack, c.ledger, request(prefs("de")), { policy: "error" }));
    out.push(vector(`${c.id}--policy-error-en`, c.pack, c.ledger, request(prefs("en-AU")), { policy: "error" }));
    out.push(vector(`${c.id}--unknown-method`, c.pack, c.ledger, encodeConsentRequest({ method: "nope", arg, user_preferences: prefs("en") })));
    out.push(vector(`${c.id}--arg-does-not-decode`, c.pack, c.ledger, encodeConsentRequest({ method: c.method, arg: arg.slice(0, -1), user_preferences: prefs("en") })));
    out.push(vector(`${c.id}--request-truncated`, c.pack, c.ledger, request(prefs("en")).slice(0, -3)));
  }
  for (const id of VARIED) if (!varied.has(id)) throw new Error(`icrc21-envelope: no golden case ${id}`);
  out.push(vector("not-candid", "icrc1", "TKA", new Uint8Array([0x00, 0xff])));
  out.push(vector("another-type", "icrc1", "TKA", new TextEncoder().encode("DIDL\x00\x01\x71\x02hi")));
  return { format: "candid-profile-icrc21-envelope-vectors", version: 1, vectors: out };
}

export const envelopeJson = (v) => `${JSON.stringify(v, null, 2)}\n`;
