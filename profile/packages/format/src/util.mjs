import { CODES, fail } from "./errors.mjs";

/** Bound on the length of any text this package parses (bounded work, spec §11.6). */
export const MAX_INPUT_CHARS = 1024;

const DEC_INT = /^-?(?:0|[1-9][0-9]*)$/;

/** The Candid integer types the value tags apply to, with their inclusive bounds (null = unbounded). */
export const INT_TYPES = Object.freeze({
  nat: { signed: false, min: 0n, max: null },
  nat8: { signed: false, min: 0n, max: 2n ** 8n - 1n },
  nat16: { signed: false, min: 0n, max: 2n ** 16n - 1n },
  nat32: { signed: false, min: 0n, max: 2n ** 32n - 1n },
  nat64: { signed: false, min: 0n, max: 2n ** 64n - 1n },
  int: { signed: true, min: null, max: null },
  int8: { signed: true, min: -(2n ** 7n), max: 2n ** 7n - 1n },
  int16: { signed: true, min: -(2n ** 15n), max: 2n ** 15n - 1n },
  int32: { signed: true, min: -(2n ** 31n), max: 2n ** 31n - 1n },
  int64: { signed: true, min: -(2n ** 63n), max: 2n ** 63n - 1n },
});

/** @param {string} candid @param {string[]} allowed */
export function intType(candid, allowed, tag) {
  if (!allowed.includes(candid)) {
    fail(CODES.TAG_TYPE, `the ${tag} tag applies to ${allowed.join(", ")}, not ${candid}`);
  }
  return INT_TYPES[candid];
}

export function checkLength(text, what) {
  if (text.length > MAX_INPUT_CHARS) fail(CODES.TOO_LONG, `${what} is longer than ${MAX_INPUT_CHARS} characters`);
}

export function requireString(input, what) {
  if (typeof input !== "string") fail(CODES.TYPE, `${what} must be a string, got ${typeof input}`);
  checkLength(input, what);
  return input;
}

/**
 * A base-unit integer as a bigint. Accepts a canonical decimal string or a bigint. A JavaScript
 * number is rejected whatever its value: big integers must never pass through a double (D-006).
 */
export function toBigInt(value, what = "value") {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    if (value.length > MAX_INPUT_CHARS) fail(CODES.TOO_LONG, `${what} is too long`);
    if (!DEC_INT.test(value)) fail(CODES.SYNTAX, `${what} must be a canonical decimal integer string, got ${JSON.stringify(value)}`);
    if (value === "-0") fail(CODES.SYNTAX, `${what} must not be "-0"`);
    return BigInt(value);
  }
  fail(CODES.TYPE, `${what} must be a decimal string or a bigint, not ${typeof value} (integers are never passed as JavaScript numbers)`);
}

export function checkRange(v, type, what) {
  if (!type.signed && v < 0n) fail(CODES.RANGE, `${what} ${v} is negative but the Candid type is unsigned`);
  if (type.min !== null && v < type.min) fail(CODES.RANGE, `${what} ${v} is below the minimum ${type.min} of the Candid type`);
  if (type.max !== null && v > type.max) fail(CODES.RANGE, `${what} ${v} is above the maximum ${type.max} of the Candid type`);
}

// ---------------------------------------------------------------- bytes helpers

const HEX = "0123456789abcdef";

export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += HEX[b >>> 4] + HEX[b & 15];
  return out;
}

/** Strict hex: even length, hex digits only, either case. Returns null when invalid. */
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (key) => Object.getOwnPropertyDescriptor(TypedArrayPrototype, key).get;
const typedArrayTag = intrinsic(Symbol.toStringTag);
const viewBuffer = intrinsic("buffer");
const viewOffset = intrinsic("byteOffset");
const viewLength = intrinsic("byteLength");
const bufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached")?.get;
/**
 * Whether the buffer is a detached ArrayBuffer (a SharedArrayBuffer never is). Where `ArrayBuffer.prototype.detached`
 * is missing (older browsers), a view of a detached buffer cannot be constructed, so trying one is the test.
 */
const isDetached = (buffer) => {
  if (bufferDetached !== undefined) {
    try {
      return bufferDetached.call(buffer) === true;
    } catch {
      return false;
    }
  }
  try {
    new Uint8Array(buffer, 0, 0);
    return false;
  } catch {
    return true;
  }
};

/**
 * The value as a Uint8Array of this realm, or null. Accepts a Uint8Array made in another realm (a `node:vm`
 * context, an iframe, a test environment's TextEncoder) by reading its typed-array kind from the internal slot,
 * which a plain object (or `Object.create(Uint8Array.prototype)`) cannot fake, and viewing the same memory (no
 * copy). The memory is read through the same intrinsic getters, never `value.buffer` and friends, which an own
 * property could override to show other bytes than the view holds. Other typed arrays, DataViews, Proxies and
 * views of a detached buffer are not bytes.
 */
export function asUint8Array(value) {
  if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== "Uint8Array") return null;
  const buffer = viewBuffer.call(value);
  if (isDetached(buffer)) return null;
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype) return value;
  try {
    return new Uint8Array(buffer, viewOffset.call(value), viewLength.call(value));
  } catch {
    return null;
  }
}

/** Uint8Array (from any realm), or an array of integers 0..255 (the JSON form of a blob). */
export function toBytes(value, what = "bytes") {
  const view = asUint8Array(value);
  if (view !== null) return view;
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value);
  return fail(CODES.TYPE, `${what} must be a Uint8Array or an array of byte values`);
}

/**
 * Characters that must never be shown inline in a consent or tool text: control characters (Cc),
 * format characters such as bidirectional overrides and zero-width joiners (Cf), and line and
 * paragraph separators (Zl, Zp).
 */
export const UNSAFE_DISPLAY_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
