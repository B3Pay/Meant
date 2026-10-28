// Every failure of this package is a ConsentError with a stable `code`. The ICRC-21 entry point maps
// the codes to the ICRC-21 error variants (icrc21.mjs); the lower-level functions throw them.

export class ConsentError extends Error {
  /**
   * @param {string} code  one of CODES
   * @param {string} message  written for a developer, not for the end user (ICRC-21: icrc21_error_info.description)
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConsentError";
    this.code = code;
  }
}

export const CODES = Object.freeze({
  // the call is malformed (ICRC-21 UnsupportedCanisterCall)
  METHOD_UNKNOWN: "E_METHOD_UNKNOWN", // the resolved form has no such method
  DECODE: "E_DECODE", // the argument bytes do not decode against the method's signature
  TOO_LARGE: "E_TOO_LARGE", // the arguments exceed the bounds of a consent message (never truncated)
  LANGUAGE: "E_LANGUAGE", // only with languagePolicy "error": the requested language is not supported
  REQUEST: "E_REQUEST", // the ICRC-21 request itself is malformed
  // this generator cannot describe the call (ICRC-21 ConsentMessageUnavailable)
  UNSUPPORTED_TYPE: "E_UNSUPPORTED_TYPE", // a position the resolved form cannot type (recursive cut, func, service)
  // the profile or the caller's context is wrong (ICRC-21 GenericError)
  RESOLVED_FORM: "E_RESOLVED_FORM", // the resolved form is malformed
  TEMPLATE: "E_TEMPLATE", // the intent template does not parse
  TEMPLATE_PATH: "E_TEMPLATE_PATH", // a placeholder names a position the method does not have
  // pass-through of the format library's configuration errors (a dynamic ref the caller did not supply, a bad tag argument)
  REF_UNRESOLVED: "E_REF_UNRESOLVED",
  ARG: "E_ARG",
  TAG_TYPE: "E_TAG_TYPE",
  TAG_CONFLICT: "E_TAG_CONFLICT",
});

/** ICRC-21 GenericError.error_code values this package uses (a nat chosen by the canister; see the README). */
export const GENERIC_ERROR_CODES = Object.freeze({
  [CODES.RESOLVED_FORM]: 1000n,
  [CODES.TEMPLATE]: 1001n,
  [CODES.TEMPLATE_PATH]: 1002n,
  [CODES.REF_UNRESOLVED]: 1100n,
  [CODES.ARG]: 1101n,
  [CODES.TAG_TYPE]: 1102n,
  [CODES.TAG_CONFLICT]: 1103n,
  INTERNAL: 1999n,
});

export function fail(code, message, options) {
  throw new ConsentError(code, message, options);
}
