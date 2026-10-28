// `subaccount` (spec §5.3): a 32-byte blob.
//
//   input:   "#n" or a plain decimal n, 0 <= n < 2^64 (32 bytes, big-endian), or exactly 64 hex
//            characters with an optional 0x prefix (0X is accepted too)
//   display: "#n" if and only if the first 24 bytes are zero, else 64 lowercase hex characters
//
// A 64-character string of decimal digits fits both input forms. It is read as hex, because a
// decimal n < 2^64 has at most 20 digits and a longer decimal is out of range anyway. Decimal
// numbers with leading zeros are rejected so that no decimal string can be mistaken for hex.

import { CODES, fail } from "./errors.mjs";
import { bytesToHex, hexToBytes, requireString, toBytes } from "./util.mjs";

const TWO_64 = 2n ** 64n;
const HEX64 = /^(?:0[xX])?[0-9a-fA-F]{64}$/;
const DECIMAL = /^#?(0|[1-9][0-9]*)$/;
const HEXISH = /^(?:0[xX])?[0-9a-fA-F]+$/;

/** @returns {Uint8Array} 32 bytes */
export function parseSubaccount(input) {
  const text = requireString(input, "subaccount").trim();
  if (HEX64.test(text)) return hexToBytes(text.replace(/^0[xX]/, ""));
  const d = DECIMAL.exec(text);
  if (d) {
    const n = BigInt(d[1]);
    if (n >= TWO_64) fail(CODES.RANGE, `the subaccount number ${d[1]} must be below 2^64 (18446744073709551616); use 64 hex characters for larger values`);
    const out = new Uint8Array(32);
    new DataView(out.buffer).setBigUint64(24, n, false);
    return out;
  }
  const hint = `write "#n" or a plain decimal n with 0 <= n < 2^64, or exactly 64 hex characters (optionally after 0x)`;
  if (/^#?0[0-9]+$/.test(text)) fail(CODES.SYNTAX, `${JSON.stringify(text)} has leading zeros, which would make it ambiguous with hex; ${hint}`);
  if (HEXISH.test(text)) {
    const digits = text.replace(/^0[xX]/, "").length;
    fail(CODES.LENGTH, `${JSON.stringify(text)} has ${digits} hex characters; a hex subaccount has exactly 64. ${hint}`);
  }
  return fail(CODES.SYNTAX, `cannot read ${JSON.stringify(text)} as a subaccount; ${hint}`);
}

/**
 * @param {Uint8Array | number[]} value 32 bytes
 * @returns {string} "#n" when the first 24 bytes are zero, else 64 lowercase hex characters
 */
export function displaySubaccount(value) {
  const b = toBytes(value, "subaccount");
  if (b.length !== 32) fail(CODES.LENGTH, `a subaccount is 32 bytes, got ${b.length}`);
  if (b.subarray(0, 24).every((x) => x === 0)) return `#${new DataView(b.buffer, b.byteOffset, 32).getBigUint64(24, false)}`;
  return bytesToHex(b);
}
