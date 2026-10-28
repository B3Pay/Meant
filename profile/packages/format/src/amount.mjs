// `amount` (spec §5.3): exact decimal text <-> base-unit integers.
//
// Values are decimal strings (D-006). Nothing here uses a JavaScript number for an amount, and
// nothing rounds: input with more fractional digits than `decimals` is rejected, even when the
// extra digits are zeros (the literal reading of "more than d fractional digits MUST be rejected").

import { CODES, fail } from "./errors.mjs";
import { UNSAFE_DISPLAY_CHAR, checkRange, intType, requireString, toBigInt } from "./util.mjs";

export const AMOUNT_TYPES = ["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"];

// number, then (after whitespace) an optional symbol. "1.", ".5", "1,5", "1e3" and "+1" do not match.
const AMOUNT_RE = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:\s+(\S(?:.*\S)?))?$/s;

/** ASCII-only case folding: "icp" matches "ICP", but a Kelvin sign never matches "k". */
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** @returns {string | undefined} a validated symbol */
export function checkSymbol(symbol) {
  if (symbol === undefined || symbol === null) return undefined;
  if (typeof symbol !== "string") fail(CODES.ARG, `amount symbol must be a string, got ${typeof symbol}`);
  const n = [...symbol].length;
  if (n < 1 || n > 32) fail(CODES.ARG, `amount symbol must be 1 to 32 characters, got ${n}`);
  if (symbol !== symbol.trim() || UNSAFE_DISPLAY_CHAR.test(symbol) || !symbol.isWellFormed()) {
    fail(CODES.ARG, `amount symbol ${JSON.stringify(symbol)} has surrounding whitespace, control or invisible characters`);
  }
  return symbol;
}

export function checkDecimals(decimals) {
  let d = decimals;
  if (typeof d === "string" && /^(?:0|[1-9][0-9]{0,2})$/.test(d)) d = Number(d);
  if (typeof d === "bigint" && d >= 0n && d <= 255n) d = Number(d);
  if (!Number.isInteger(d) || d < 0 || d > 255) fail(CODES.ARG, `amount decimals must be an integer from 0 to 255, got ${String(decimals)}`);
  return d;
}

/**
 * Parse "1.5" or "1.5 ICP" into a base-unit decimal string.
 *
 * @param {string} input
 * @param {{ decimals: number | bigint | string, symbol?: string, candid?: string }} opts
 * @returns {string}
 */
export function parseAmount(input, { decimals, symbol, candid = "nat" }) {
  const d = checkDecimals(decimals);
  const expected = checkSymbol(symbol);
  const type = intType(candid, AMOUNT_TYPES, "amount");
  const text = requireString(input, "amount").trim();
  const m = AMOUNT_RE.exec(text);
  if (!m) {
    fail(
      CODES.SYNTAX,
      `cannot read ${JSON.stringify(text)} as an amount: write digits with an optional decimal point, for example "1.5"${expected ? ` or "1.5 ${expected}"` : ""}; no thousands separators, exponents or signs other than "-"`,
    );
  }
  const [, sign, whole, frac = "", given] = m;
  if (sign && !type.signed) fail(CODES.NEGATIVE, `negative amounts are not allowed here (the Candid type ${candid} is unsigned)`);
  if (given !== undefined) {
    if (expected === undefined) fail(CODES.SYMBOL_MISMATCH, `this amount has no symbol; remove "${given}" and give the number only`);
    if (asciiLower(given) !== asciiLower(expected)) fail(CODES.SYMBOL_MISMATCH, `the symbol "${given}" is not this token's symbol "${expected}"`);
  }
  if (frac.length > d) {
    fail(
      CODES.EXCESS_PRECISION,
      `${JSON.stringify(text)} has ${frac.length} fractional digits but this token has ${d}; amounts are never rounded, so give at most ${d}`,
    );
  }
  const magnitude = BigInt(whole) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, "0") || "0");
  const v = sign ? -magnitude : magnitude;
  checkRange(v, type, "amount");
  return v.toString();
}

/**
 * Display a base-unit integer as "1.5 ICP": trailing fractional zeros removed, symbol appended.
 *
 * @param {string | bigint} value
 * @param {{ decimals: number | bigint | string, symbol?: string, candid?: string }} opts
 * @returns {string}
 */
export function displayAmount(value, { decimals, symbol, candid = "nat" }) {
  const d = checkDecimals(decimals);
  const sym = checkSymbol(symbol);
  const type = intType(candid, AMOUNT_TYPES, "amount");
  const v = toBigInt(value, "amount");
  checkRange(v, type, "amount");
  const digits = (v < 0n ? -v : v).toString().padStart(d + 1, "0");
  const whole = digits.slice(0, digits.length - d);
  const frac = digits.slice(digits.length - d).replace(/0+$/, "");
  return `${v < 0n ? "-" : ""}${whole}${frac ? `.${frac}` : ""}${sym ? ` ${sym}` : ""}`;
}
