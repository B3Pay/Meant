// The ICRC-21 entry point: `icrc21_canister_call_consent_message` as a function.
//
// Request  : { method, arg, user_preferences: { metadata: { language, utc_offset_minutes }, device_spec } }
// Response : { Ok: { consent_message, metadata } } | { Err: { UnsupportedCanisterCall | ConsentMessageUnavailable
//            | InsufficientPayment | GenericError } }                       (shapes: see icrc21-codec.mjs)
//
// Behaviors the ICRC-21 text fixes (topics/ICRC-21/ICRC-21.did and icrc_21_consent_msg.md of dfinity/wg-identity-authentication):
//   - "Providing a message should be preferred over sending an icrc21_error": a language other than English gets the
//     English message, and `metadata.language` says "en" ("the metadata must match the consent_message provided").
//     Set `languagePolicy: "error"` to refuse instead (UnsupportedCanisterCall).
//   - A missing `device_spec` falls back to GenericDisplay (the spec: "one of the values defined in this spec").
//   - `utc_offset_minutes` absent in the request: the generic message is in UTC. Absent in the response means the
//     message is not time-zone sensitive; the response carries the applied offset exactly when a time is shown in
//     the generic form. The fields form carries seconds since the epoch and is never zone-sensitive.
//   - The consent message must not depend on state: this function has no network access; dynamic refs (decimals,
//     symbol) are values the caller resolved (spec section 4).

import { bytesOf } from "./bytes.mjs";
import { ConsentError, CODES, GENERIC_ERROR_CODES } from "./errors.mjs";
import { generateConsent } from "./consent.mjs";
import { decodeConsentRequest, encodeConsentResponse } from "./icrc21-codec.mjs";

/** The only language v0 emits (profile `language: "en"`; spec section 1: multi-language templates are a non-goal). */
export const SUPPORTED_LANGUAGE = "en";
const MAX_OFFSET_MINUTES = 24 * 60;
const MAX_DESCRIPTION = 1000;

const BCP47 = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

/**
 * @param {object} request  the ICRC-21 request in the JS shape
 * @param {object} context
 * @param {object} context.resolved  the resolved form of the target canister (docs/profile-v0.md section 10)
 * @param {Record<string, unknown>} [context.refs]  resolved dynamic refs, keyed by `from`: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }
 * @param {"fallback" | "error"} [context.languagePolicy]  default "fallback" (the ICRC-21 preference)
 * @param {boolean} [context.rawArguments]  append the decoded raw arguments (spec section 11 item 1)
 * @param {object} [context.limits]  decoder limits
 * @returns {{ Ok: object } | { Err: object }}  plus two non-enumerable properties on the result: `diagnostics` (what was
 *   adjusted on the way: format fallbacks, language fallback) and `provenance` (`{ intent: { origin, profile } | null, profiles }`,
 *   so a signer can warn when the words come from a profile and not from the canister)
 */
export function icrc21ConsentMessage(request, context) {
  const diagnostics = [];
  const extras = { provenance: null };
  let result;
  try {
    result = { Ok: build(request, context, diagnostics, extras) };
  } catch (e) {
    result = { Err: toIcrc21Error(e) };
    diagnostics.push({ code: e instanceof ConsentError ? e.code : "E_INTERNAL", at: "request", message: String(e?.message ?? e) });
  }
  Object.defineProperty(result, "diagnostics", { value: diagnostics, enumerable: false });
  Object.defineProperty(result, "provenance", { value: extras.provenance, enumerable: false });
  return result;
}

function build(request, context, diagnostics, extras) {
  const { resolved, refs = {}, languagePolicy = "fallback", rawArguments = false, limits } = context ?? {};
  if (request === null || typeof request !== "object") throw new ConsentError(CODES.REQUEST, "the request is not an object");
  const { method, user_preferences: prefs } = request;
  const arg = bytesOf(request.arg);
  if (typeof method !== "string") throw new ConsentError(CODES.REQUEST, "request.method must be text");
  if (arg === null) throw new ConsentError(CODES.REQUEST, "request.arg must be bytes: a Uint8Array, an ArrayBuffer or an array of integers 0 to 255");
  const language = prefs?.metadata?.language;
  if (typeof language !== "string") throw new ConsentError(CODES.REQUEST, "user_preferences.metadata.language must be text");

  // language
  const primary = BCP47.test(language) ? language.split(/[-_]/)[0].toLowerCase() : null;
  if (primary !== SUPPORTED_LANGUAGE && languagePolicy === "error") {
    throw new ConsentError(CODES.LANGUAGE, `language ${JSON.stringify(language.slice(0, 40))} is not supported; this generator writes "${SUPPORTED_LANGUAGE}"`);
  }
  const answeredLanguage = primary === SUPPORTED_LANGUAGE ? language.replace("_", "-") : SUPPORTED_LANGUAGE;
  if (primary !== SUPPORTED_LANGUAGE) diagnostics.push({ code: "I_LANGUAGE_FALLBACK", at: "user_preferences", message: `language ${JSON.stringify(language.slice(0, 40))} is not supported; the message is in "${SUPPORTED_LANGUAGE}" and the metadata says so` });

  // device spec
  const spec = deviceSpecOf(prefs.device_spec);

  // time zone
  let offset = prefs.metadata.utc_offset_minutes ?? null;
  if (offset !== null && (!Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET_MINUTES)) {
    diagnostics.push({ code: "W_UTC_OFFSET_IGNORED", at: "user_preferences", message: `utc_offset_minutes ${String(offset)} is outside +-${MAX_OFFSET_MINUTES}; UTC is used` });
    offset = null;
  }

  const r = generateConsent({ resolved, method, arg, refs, form: spec === "FieldsDisplay" ? "fields" : "generic", utcOffsetMinutes: offset, rawArguments, limits });
  diagnostics.push(...r.diagnostics);
  extras.provenance = r.provenance;
  return {
    consent_message: r.message,
    metadata: { language: answeredLanguage, utc_offset_minutes: r.zoneSensitive ? (offset ?? 0) : null },
  };
}

function deviceSpecOf(spec) {
  if (spec === undefined || spec === null) return "GenericDisplay";
  if (spec === "GenericDisplay" || spec === "FieldsDisplay") return spec;
  const keys = typeof spec === "object" ? Object.keys(spec) : [];
  if (keys.length === 1 && (keys[0] === "GenericDisplay" || keys[0] === "FieldsDisplay")) return keys[0];
  throw new ConsentError(CODES.REQUEST, "device_spec must be GenericDisplay or FieldsDisplay");
}

const clip = (s) => (s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION)}...` : s);

/** ConsentError (or any thrown value) -> the ICRC-21 `icrc21_error` variant. */
export function toIcrc21Error(e) {
  if (!(e instanceof ConsentError)) return { GenericError: { error_code: GENERIC_ERROR_CODES.INTERNAL, description: clip(`internal error: ${String(e?.message ?? e)}`) } };
  const description = clip(`${e.code}: ${e.message}`);
  switch (e.code) {
    case CODES.METHOD_UNKNOWN:
    case CODES.DECODE:
    case CODES.TOO_LARGE:
    case CODES.LANGUAGE:
    case CODES.REQUEST:
      return { UnsupportedCanisterCall: { description } };
    case CODES.UNSUPPORTED_TYPE:
      return { ConsentMessageUnavailable: { description } };
    default:
      return { GenericError: { error_code: GENERIC_ERROR_CODES[e.code] ?? GENERIC_ERROR_CODES.INTERNAL, description } };
  }
}

/**
 * The canister-side wrapper: the Candid-encoded argument of `icrc21_canister_call_consent_message` in, the
 * Candid-encoded `icrc21_consent_message_response` out. A request that does not decode gets an
 * UnsupportedCanisterCall reply, as the ICRC-21 interface prescribes for a malformed call.
 *
 * @param {Uint8Array} requestBytes
 * @param {object} context  as for icrc21ConsentMessage
 * @returns {Uint8Array}
 */
export function handleConsentRequest(requestBytes, context) {
  let response;
  try {
    response = icrc21ConsentMessage(decodeConsentRequest(requestBytes), context);
  } catch (e) {
    response = { Err: toIcrc21Error(e) };
  }
  return encodeConsentResponse(response);
}
