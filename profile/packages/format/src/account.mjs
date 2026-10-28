// `account`, encoding `icrc1` (spec §5.3): the ICRC-1 textual encoding of
// record { owner : principal; subaccount : opt blob }.
//
//   default subaccount (absent or 32 zero bytes):  <principal>
//   any other subaccount:  <principal>-<checksum>.<subaccount hex without leading zeros>
//     checksum = base32 (lowercase, no padding) of CRC-32(principal bytes ++ 32 subaccount bytes)
//
// Source: dfinity/ICRC-1 standards/ICRC-1/TextualEncoding.md. Value shape here:
//   { owner: <principal text>, subaccount: Uint8Array(32) | null }   (null = the default subaccount)

import { CODES, fail } from "./errors.mjs";
import { MAX_INPUT_CHARS, bytesToHex, hexToBytes, requireString, toBytes } from "./util.mjs";
import { accountChecksum, principalFromText, principalToText } from "./principal.mjs";

const CHECKSUM_RE = /^[a-z2-7]{7}$/i;

const isZero = (b) => b.every((x) => x === 0);

/** Owner as principal bytes, from canonical text or bytes. */
function ownerBytes(owner) {
  if (typeof owner === "string") return principalFromText(owner);
  const b = toBytes(owner, "owner");
  principalToText(b); // length check
  return b;
}

/**
 * Parse an ICRC-1 account text. A bare principal is the default subaccount. The checksum is
 * verified, and non-canonical texts (an explicit default subaccount, leading zeros in the
 * subaccount, wrong dashes) are rejected.
 *
 * @param {string} input
 * @returns {{ owner: string, subaccount: Uint8Array | null }}
 */
export function parseAccount(input) {
  const text = requireString(input, "account").trim();
  if (text.length > MAX_INPUT_CHARS) fail(CODES.TOO_LONG, "account is too long");
  const dot = text.indexOf(".");
  if (dot < 0) return { owner: principalToText(principalFromText(text)), subaccount: null };
  if (text.indexOf(".", dot + 1) >= 0) fail(CODES.SYNTAX, `${JSON.stringify(text)} has more than one "."`);

  const left = text.slice(0, dot);
  const hex = text.slice(dot + 1);
  const dash = left.lastIndexOf("-");
  const checksum = dash < 0 ? "" : left.slice(dash + 1);
  if (!CHECKSUM_RE.test(checksum)) {
    fail(CODES.CHECKSUM_MISSING, `${JSON.stringify(text)} has a subaccount but no checksum: the form is <principal>-<checksum>.<subaccount>`);
  }
  if (hex === "") fail(CODES.NOT_CANONICAL, "the default subaccount is written as the bare principal, without a checksum or a dot");
  if (!/^[0-9a-fA-F]+$/.test(hex)) fail(CODES.HEX, `the subaccount ${JSON.stringify(hex)} is not hexadecimal`);
  if (hex.startsWith("0")) fail(CODES.NOT_CANONICAL, "the subaccount must not have leading zeros; they are removed in the canonical text");
  if (hex.length > 64) fail(CODES.LENGTH, `the subaccount is at most 64 hex digits, got ${hex.length}`);

  const owner = principalFromText(left.slice(0, dash));
  const sub = hexToBytes(hex.padStart(64, "0"));
  if (accountChecksum(owner, sub) !== checksum.toLowerCase()) {
    fail(CODES.CHECKSUM, `the checksum ${checksum} does not match this principal and subaccount (a character was probably mistyped)`);
  }
  return { owner: principalToText(owner), subaccount: sub };
}

/**
 * Display an account in the ICRC-1 textual encoding.
 *
 * @param {{ owner: string | Uint8Array, subaccount?: Uint8Array | number[] | null }} account
 *   `subaccount` absent, null or 32 zero bytes means the default subaccount
 * @returns {string}
 */
export function displayAccount(account) {
  if (account === null || typeof account !== "object") fail(CODES.TYPE, "account must be { owner, subaccount }");
  const owner = ownerBytes(account.owner);
  const ownerText = principalToText(owner);
  if (account.subaccount === undefined || account.subaccount === null) return ownerText;
  const sub = toBytes(account.subaccount, "subaccount");
  if (sub.length !== 32) fail(CODES.LENGTH, `a subaccount is 32 bytes, got ${sub.length}`);
  if (isZero(sub)) return ownerText;
  return `${ownerText}-${accountChecksum(owner, sub)}.${bytesToHex(sub).replace(/^0+/, "")}`;
}
