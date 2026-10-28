// The ICRC-21 types (topics/ICRC-21/ICRC-21.did of dfinity/wg-identity-authentication, commit pinned in
// test/upstream/icrc21/SOURCE.json) as @candid-core/schema schemas, and the conversion between the JS shapes
// this package uses and the shapes of the codec.
//
// JS shape (what `icrc21ConsentMessage` takes and returns):
//   variant   { Tag: payload }                  a bare case is { Tag: null }
//   opt T     null when absent, else the value
//   nat, nat64   bigint            nat8, int16   number            blob   Uint8Array
//   vec record { text; Value }   array of [label, value] pairs
// Codec shape: variants are { tag, value } (a bare case is { tag }).

import { c } from "@candid-core/schema";
import { decode, encode } from "@candid-core/schema/codec";
import { asUint8Array } from "@meantjs/format";
import { CODES, fail } from "./errors.mjs";

const Metadata = c.record({ language: c.text, utc_offset_minutes: c.opt(c.int16) });
const DeviceSpec = c.variant({ GenericDisplay: c.null, FieldsDisplay: c.null });
const MessageSpec = c.record({ metadata: Metadata, device_spec: c.opt(DeviceSpec) });
export const RequestSchema = c.record({ method: c.text, arg: c.blob(), user_preferences: MessageSpec });

const TokenAmount = c.record({ decimals: c.nat8, amount: c.nat64, symbol: c.text });
const TimestampSeconds = c.record({ amount: c.nat64 });
const DurationSeconds = c.record({ amount: c.nat64 });
const TextValue = c.record({ content: c.text });
const Value = c.variant({ TokenAmount, TimestampSeconds, DurationSeconds, Text: TextValue });
const ConsentMessage = c.variant({
  GenericDisplayMessage: c.text,
  FieldsDisplayMessage: c.record({ intent: c.text, fields: c.vec(c.tuple([c.text, Value])) }),
});
const ConsentInfo = c.record({ consent_message: ConsentMessage, metadata: Metadata });
const ErrorInfo = c.record({ description: c.text });
const Icrc21Error = c.variant({
  UnsupportedCanisterCall: ErrorInfo,
  ConsentMessageUnavailable: ErrorInfo,
  InsufficientPayment: ErrorInfo,
  GenericError: c.record({ error_code: c.nat, description: c.text }),
});
export const ResponseSchema = c.variant({ Ok: ConsentInfo, Err: Icrc21Error });

// ------------------------------------------------------------------------------------------ shape conversion

function toCodec(schema, v, where) {
  switch (schema.kind) {
    case "variant": {
      const keys = v !== null && typeof v === "object" ? Object.keys(v) : [];
      if (keys.length !== 1 || !Object.hasOwn(schema.arms, keys[0])) fail(CODES.REQUEST, `${where}: expected a variant with exactly one of ${Object.keys(schema.arms).join(", ")}`);
      const arm = schema.arms[keys[0]];
      return arm.kind === "primitive" && arm.primitive === "null" ? { tag: keys[0] } : { tag: keys[0], value: toCodec(arm, v[keys[0]], `${where}.${keys[0]}`) };
    }
    case "record":
      return Object.fromEntries(Object.entries(schema.fields).map(([k, s]) => [k, toCodec(s, v?.[k], `${where}.${k}`)]));
    case "tuple":
      return schema.elements.map((s, i) => toCodec(s, v?.[i], `${where}[${i}]`));
    case "vec":
      return v.map((e, i) => toCodec(schema.inner, e, `${where}[${i}]`));
    case "opt":
      return v === null || v === undefined ? null : toCodec(schema.inner, v, where);
    default:
      return v;
  }
}

function fromCodec(schema, v) {
  switch (schema.kind) {
    case "variant": {
      const arm = schema.arms[v.tag];
      return { [v.tag]: arm.kind === "primitive" && arm.primitive === "null" ? null : fromCodec(arm, v.value) };
    }
    case "record":
      return Object.fromEntries(Object.entries(schema.fields).map(([k, s]) => [k, fromCodec(s, v[k])]));
    case "tuple":
      return schema.elements.map((s, i) => fromCodec(s, v[i]));
    case "vec":
      return v.map((e) => fromCodec(schema.inner, e));
    case "opt":
      return v === null ? null : fromCodec(schema.inner, v);
    default:
      return v;
  }
}

/** The widths the JS shape accepts for the numbers the codec wants as bigint. */
function widen(schema, v) {
  switch (schema.kind) {
    case "primitive":
      return schema.primitive === "nat" || schema.primitive === "nat64" ? (typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v) : v;
    case "variant":
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schema.arms[k] ? widen(schema.arms[k], x) : x]));
    case "record":
      return Object.fromEntries(Object.entries(schema.fields).map(([k, s]) => [k, widen(s, v?.[k])]));
    case "tuple":
      return schema.elements.map((s, i) => widen(s, v?.[i]));
    case "vec":
      return Array.isArray(v) ? v.map((e) => widen(schema.inner, e)) : v;
    case "opt":
      return v === null || v === undefined ? null : widen(schema.inner, v);
    default:
      return v;
  }
}

function run(schema, value, what) {
  const r = encode(schema, toCodec(schema, widen(schema, value), what));
  if (!r.ok) fail(CODES.REQUEST, `${what} does not match the ICRC-21 type: ${r.issues[0].code} at ${r.issues[0].path}: ${r.issues[0].message}`);
  return r.bytes;
}

/**
 * Candid-encode an `icrc21_consent_message_response` (the reply of `icrc21_canister_call_consent_message`).
 * @param {{ Ok: object } | { Err: object }} response  the JS shape of `icrc21ConsentMessage`'s result
 * @returns {Uint8Array}
 */
export function encodeConsentResponse(response) {
  return run(ResponseSchema, response, "response");
}

/** Decode a Candid-encoded `icrc21_consent_message_response` into the JS shape. */
export function decodeConsentResponse(bytes) {
  const r = decode(ResponseSchema, bytes);
  if (!r.ok) fail(CODES.DECODE, `not an icrc21_consent_message_response: ${r.issues[0].code} at ${r.issues[0].path}`);
  return fromCodec(ResponseSchema, r.value);
}

/** Candid-encode an `icrc21_consent_message_request` (the argument of the ICRC-21 call). */
export function encodeConsentRequest(request) {
  return run(RequestSchema, request, "request");
}

/** Decode the argument of `icrc21_canister_call_consent_message` into the JS shape. Throws E_REQUEST on bytes that are not one. */
export function decodeConsentRequest(bytes) {
  const r = decode(RequestSchema, bytes, { maxBytes: 2 * 1024 * 1024 + 4096 });
  if (!r.ok) fail(CODES.REQUEST, `not an icrc21_consent_message_request: ${r.issues[0].code} at ${r.issues[0].path}: ${r.issues[0].message}`);
  return fromCodec(RequestSchema, r.value);
}

const HEX_DIGITS = new TextEncoder().encode("0123456789abcdef");
const ascii = new TextDecoder();
/**
 * Lowercase hex of the bytes (no Buffer: this module runs in a browser too). The digits go into one byte array and
 * are decoded once, so a blob near the 2 MiB request limit costs two buffers, not a string per byte.
 */
function hex(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[2 * i] = HEX_DIGITS[bytes[i] >> 4];
    out[2 * i + 1] = HEX_DIGITS[bytes[i] & 15];
  }
  return ascii.decode(out);
}

/** JSON-safe copy of a JS-shape value: bigint as a decimal string (D-006), Uint8Array as { hex }. For fixtures and logs. */
export function toJson(value) {
  if (typeof value === "bigint") return value.toString();
  const bytes = asUint8Array(value); // from any realm
  if (bytes !== null) return { hex: hex(bytes) };
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return value;
}
