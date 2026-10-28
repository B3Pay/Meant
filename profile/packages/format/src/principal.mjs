// Principal text <-> bytes, and the CRC-32 and base32 pieces shared with the ICRC-1 account text.
//
// Implemented here, with no dependency, because it is ~60 lines, the algorithm is fixed by the
// Internet Computer interface specification ("textual ids": lowercase base32 without padding of
// CRC-32 big-endian followed by the bytes, in groups of five separated by dashes), and it is
// checked in the tests against the official ICRC-1 vectors, well-known canister ids, node:zlib's
// CRC-32 and an independent big-integer base32 encoder. See README.md for why not
// @dfinity/principal (deprecated) or @icp-sdk/core (large).

import { CODES, fail } from "./errors.mjs";
import { MAX_INPUT_CHARS, asUint8Array } from "./util.mjs";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const MAX_PRINCIPAL_BYTES = 29;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, the zlib polynomial) as an unsigned 32-bit integer. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const crc32BigEndian = (bytes) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, crc32(bytes), false);
  return out;
};

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes) {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Strict decode of lowercase base32 without padding; null on a bad character, length or spare bit. */
function base32Decode(text) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return null; // a stray character or non-zero padding bits
  return Uint8Array.from(out);
}

/** The ICRC-1 checksum of an account: base32(CRC-32(owner bytes ++ subaccount bytes)), 7 characters. */
export function accountChecksum(ownerBytes, subaccount) {
  const all = new Uint8Array(ownerBytes.length + subaccount.length);
  all.set(ownerBytes, 0);
  all.set(subaccount, ownerBytes.length);
  return base32Encode(crc32BigEndian(all));
}

/** Canonical principal text for up to 29 bytes. */
export function principalToText(input) {
  const bytes = asUint8Array(input);
  if (bytes === null) fail(CODES.TYPE, "principal bytes must be a Uint8Array");
  if (bytes.length > MAX_PRINCIPAL_BYTES) fail(CODES.PRINCIPAL, `a principal is at most ${MAX_PRINCIPAL_BYTES} bytes, got ${bytes.length}`);
  const crc = crc32BigEndian(bytes);
  const all = new Uint8Array(4 + bytes.length);
  all.set(crc, 0);
  all.set(bytes, 4);
  return base32Encode(all).match(/.{1,5}/g).join("-");
}

/**
 * Principal text to bytes. Case-insensitive; the dashes must be exactly where the canonical text
 * puts them, and the CRC-32 must match. Anything else throws E_PRINCIPAL.
 */
export function principalFromText(text) {
  if (typeof text !== "string") fail(CODES.TYPE, `principal must be a string, got ${typeof text}`);
  if (text.length > MAX_INPUT_CHARS) fail(CODES.TOO_LONG, "principal text is too long");
  const lower = text.toLowerCase();
  const decoded = base32Decode(lower.replaceAll("-", ""));
  if (decoded === null) fail(CODES.PRINCIPAL, `${JSON.stringify(text)} is not a principal: it must be base32 (a to z, 2 to 7) in groups of five separated by dashes`);
  if (decoded.length < 4) fail(CODES.PRINCIPAL, `${JSON.stringify(text)} is not a principal: too short`);
  const data = decoded.subarray(4);
  if (data.length > MAX_PRINCIPAL_BYTES) fail(CODES.PRINCIPAL, `${JSON.stringify(text)} is not a principal: more than ${MAX_PRINCIPAL_BYTES} bytes`);
  const expected = crc32BigEndian(data);
  if (!decoded.subarray(0, 4).every((b, i) => b === expected[i])) {
    fail(CODES.PRINCIPAL, `${JSON.stringify(text)} is not a principal: the checksum does not match (a character was probably mistyped)`);
  }
  const canonical = principalToText(data);
  if (lower !== canonical) fail(CODES.PRINCIPAL, `${JSON.stringify(text)} is not a canonical principal: dashes must separate groups of five, as in "${canonical}"`);
  return Uint8Array.from(data);
}
