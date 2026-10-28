// `bytes` (spec §5.3): a blob shown and read as utf8, hex or base64.
//
//   utf8    input is plain text encoded as UTF-8; input starting with 0x is read as hex.
//           Display is the decoded text when the bytes are valid UTF-8 without control
//           characters, else 0x followed by lowercase hex.
//   hex     input and display carry a 0x prefix (the prefix is optional on input).
//   base64  RFC 4648 standard alphabet; padding optional on input, always written on display.
//   max_len counts bytes after encoding.
//
// Two display rules go beyond the literal text so that parse(display(x)) = x always holds and so
// that nothing misleading is shown (both are listed in docs/proposals/w3a-spec-5-3-clarifications.md):
//   - utf8 text that itself starts with 0x/0X is displayed as hex, because as text it would be read back as hex;
//   - besides control characters (Cc), text with format characters (Cf, for example bidirectional
//     overrides, zero-width joiners and the byte order mark) or line and paragraph separators
//     (Zl, Zp) is displayed as hex.

import { CODES, fail } from "./errors.mjs";
import { UNSAFE_DISPLAY_CHAR, bytesToHex, hexToBytes, toBytes } from "./util.mjs";

export const BYTES_ENCODINGS = ["utf8", "hex", "base64"];

/** Bound on the size of a text input (bounded work, spec §11.6). */
const MAX_BYTES_INPUT_CHARS = 4 * 1024 * 1024;
const HEX_PREFIX = /^0[xX]/;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function base64Encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Strict: standard alphabet, canonical padding or none, no stray characters, zero spare bits. */
function base64Decode(text) {
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(text);
  if (!m) {
    fail(CODES.BASE64, "not base64: use the standard alphabet (A-Z, a-z, 0-9, + and /) with no spaces, line breaks or URL-safe characters");
  }
  const [, body, pad] = m;
  const rem = body.length % 4;
  if (rem === 1) fail(CODES.BASE64, "not base64: the length is impossible (one character too many or too few)");
  if (pad && (rem === 0 || pad.length !== 4 - rem)) fail(CODES.BASE64, "not base64: the '=' padding is wrong");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i++) {
    acc = (acc << 6) | B64_VALUE[body.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      out[o++] = (acc >> (bits - 8)) & 255;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) fail(CODES.BASE64, "not canonical base64: the unused trailing bits must be zero");
  return out;
}

function parseHex(text, what) {
  const bytes = hexToBytes(text.replace(HEX_PREFIX, ""));
  if (bytes === null) fail(CODES.HEX, `${what} is not hexadecimal: use an even number of digits 0-9 and a-f, for example "0x1a2b" (no spaces)`);
  return bytes;
}

export function checkMaxLen(maxLen) {
  if (maxLen === undefined || maxLen === null) return null;
  let n = maxLen;
  if (typeof n === "bigint" || (typeof n === "string" && /^(?:0|[1-9][0-9]*)$/.test(n))) n = Number(n);
  if (!Number.isSafeInteger(n) || n < 0) fail(CODES.ARG, `max_len must be a non-negative integer, got ${String(maxLen)}`);
  return n;
}

/**
 * @param {string} input
 * @param {{ encoding: "utf8"|"hex"|"base64", maxLen?: number }} opts  `maxLen` is the tag's max_len, in bytes
 * @returns {Uint8Array}
 */
export function parseBytes(input, { encoding, maxLen } = {}) {
  if (!BYTES_ENCODINGS.includes(encoding)) fail(CODES.ARG, `bytes encoding must be one of ${BYTES_ENCODINGS.join(", ")}, got ${JSON.stringify(encoding)}`);
  const max = checkMaxLen(maxLen);
  if (typeof input !== "string") fail(CODES.TYPE, `bytes input must be a string, got ${typeof input}`);
  if (input.length > MAX_BYTES_INPUT_CHARS) fail(CODES.TOO_LONG, `bytes input is longer than ${MAX_BYTES_INPUT_CHARS} characters`);
  let bytes;
  if (encoding === "utf8") {
    if (HEX_PREFIX.test(input)) bytes = parseHex(input, "text starting with 0x (read as hex)");
    else {
      // TextEncoder would replace a lone surrogate with U+FFFD without saying so.
      if (!input.isWellFormed()) fail(CODES.UTF8, "the text contains an unpaired surrogate and cannot be encoded as UTF-8");
      bytes = new TextEncoder().encode(input);
    }
  } else if (encoding === "hex") {
    bytes = parseHex(input, "the value");
  } else {
    bytes = base64Decode(input);
  }
  if (max !== null && bytes.length > max) fail(CODES.MAX_LEN, `the value is ${bytes.length} bytes after encoding but at most ${max} are allowed`);
  return bytes;
}

/**
 * @param {Uint8Array | number[]} value
 * @param {{ encoding: "utf8"|"hex"|"base64" }} opts
 * @returns {string}
 */
export function displayBytes(value, { encoding } = {}) {
  if (!BYTES_ENCODINGS.includes(encoding)) fail(CODES.ARG, `bytes encoding must be one of ${BYTES_ENCODINGS.join(", ")}, got ${JSON.stringify(encoding)}`);
  const bytes = toBytes(value, "bytes");
  if (encoding === "hex") return `0x${bytesToHex(bytes)}`;
  if (encoding === "base64") return base64Encode(bytes);
  let text;
  try {
    // ignoreBOM keeps a leading U+FEFF in the string instead of silently dropping its three bytes
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return `0x${bytesToHex(bytes)}`;
  }
  if (UNSAFE_DISPLAY_CHAR.test(text) || HEX_PREFIX.test(text)) return `0x${bytesToHex(bytes)}`;
  return text;
}
