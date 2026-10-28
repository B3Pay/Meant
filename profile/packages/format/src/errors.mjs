// Every rejection in this package is a FormatError with a stable `code`.
// Callers (arm C tool layer, the ICRC-21 generator) switch on `code`; `message` is written for a
// model or a person and says how to fix the input.

export class FormatError extends Error {
  /**
   * @param {string} code  one of CODES
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "FormatError";
    this.code = code;
  }
}

export const CODES = Object.freeze({
  // shared
  TYPE: "E_TYPE", // wrong JavaScript type for an input, for example a number where a decimal string is required
  SYNTAX: "E_SYNTAX", // the text does not match the grammar
  RANGE: "E_RANGE", // outside the range of the Candid type or of the representable calendar
  TOO_LONG: "E_TOO_LONG", // input longer than the bound on work
  ARG: "E_ARG", // a tag argument is missing or invalid
  TAG_TYPE: "E_TAG_TYPE", // the tag does not apply to this Candid type
  TAG_CONFLICT: "E_TAG_CONFLICT", // two formatting tags at one position
  REF_UNRESOLVED: "E_REF_UNRESOLVED", // a dynamic value was not supplied by the caller
  // amount
  EXCESS_PRECISION: "E_EXCESS_PRECISION", // more fractional digits than decimals (never rounded)
  NEGATIVE: "E_NEGATIVE", // negative input for an unsigned Candid type
  SYMBOL_MISMATCH: "E_SYMBOL_MISMATCH", // the symbol in the input is not the token's symbol
  // time
  INEXACT: "E_INEXACT", // the value cannot be represented exactly in the requested unit
  CALENDAR_UNIT: "E_CALENDAR_UNIT", // years and months have no fixed length
  NEEDS_NOW: "E_NEEDS_NOW", // relative time without a `now`
  // account, subaccount, bytes
  CHECKSUM: "E_CHECKSUM", // checksum does not match
  CHECKSUM_MISSING: "E_CHECKSUM_MISSING",
  NOT_CANONICAL: "E_NOT_CANONICAL", // a valid value written in a non-canonical way
  PRINCIPAL: "E_PRINCIPAL", // invalid principal text
  HEX: "E_HEX",
  BASE64: "E_BASE64",
  UTF8: "E_UTF8", // text that cannot be encoded as UTF-8 (lone surrogate)
  LENGTH: "E_LENGTH", // wrong length in bytes
  MAX_LEN: "E_MAX_LEN", // longer than the tag's max_len
});

export function fail(code, message) {
  throw new FormatError(code, message);
}
