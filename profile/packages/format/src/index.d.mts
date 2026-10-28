// Types for @meantjs/format. Hand-written; the source is plain ES modules (src/*.mjs).
// test/types.test.mjs keeps the declared names equal to the runtime exports, and `npm run types` compiles a consumer
// against these declarations under strict TypeScript.

/** The value tags (spec §5.1). */
export type ValueTag = "amount" | "timestamp" | "duration" | "account" | "subaccount" | "bytes";
export type TimeUnit = "ns" | "us" | "ms" | "s";
export type BytesEncoding = "utf8" | "hex" | "base64";
/** Bytes as the library takes them: a Uint8Array (from any realm) or an array of byte values. */
export type ByteInput = Uint8Array | readonly number[];
/** An ICRC-1 account as `parseAccount` returns it: `subaccount` null is the default subaccount. */
export interface Account {
  owner: string;
  subaccount: Uint8Array | null;
}

/** The stable rejection codes; `FormatError.code` is one of them. */
export const CODES: Readonly<{
  TYPE: "E_TYPE";
  SYNTAX: "E_SYNTAX";
  RANGE: "E_RANGE";
  TOO_LONG: "E_TOO_LONG";
  ARG: "E_ARG";
  TAG_TYPE: "E_TAG_TYPE";
  TAG_CONFLICT: "E_TAG_CONFLICT";
  REF_UNRESOLVED: "E_REF_UNRESOLVED";
  EXCESS_PRECISION: "E_EXCESS_PRECISION";
  NEGATIVE: "E_NEGATIVE";
  SYMBOL_MISMATCH: "E_SYMBOL_MISMATCH";
  INEXACT: "E_INEXACT";
  CALENDAR_UNIT: "E_CALENDAR_UNIT";
  NEEDS_NOW: "E_NEEDS_NOW";
  CHECKSUM: "E_CHECKSUM";
  CHECKSUM_MISSING: "E_CHECKSUM_MISSING";
  NOT_CANONICAL: "E_NOT_CANONICAL";
  PRINCIPAL: "E_PRINCIPAL";
  HEX: "E_HEX";
  BASE64: "E_BASE64";
  UTF8: "E_UTF8";
  LENGTH: "E_LENGTH";
  MAX_LEN: "E_MAX_LEN";
}>;
export type FormatErrorCode = (typeof CODES)[keyof typeof CODES];

/** Every rejection in this package. `message` says how to fix the input. */
export declare class FormatError extends Error {
  constructor(code: FormatErrorCode, message: string);
  name: "FormatError";
  code: FormatErrorCode;
}

export interface AmountOptions {
  decimals: number | bigint | string;
  symbol?: string;
  /** The Candid type, for the sign and range (default `nat`). */
  candid?: string;
}
/** "1.5" or "1.5 ICP" to base units as a decimal string. Excess precision throws; nothing is rounded. */
export function parseAmount(input: string, options: AmountOptions): string;
/** Base units to "1.5 ICP". A number is refused: pass a decimal string or a bigint. */
export function displayAmount(value: string | bigint, options: AmountOptions): string;

/** An integer between units; to a coarser unit it must be an exact multiple (E_INEXACT otherwise). */
export function convertUnit(value: string | bigint, from: TimeUnit, to: TimeUnit): string;
/** A clock reading in ns floored to `unit`, as `parseTimestamp` applies it to `now`. */
export function alignNow(nowNs: bigint, unit: TimeUnit): bigint;
/** An RFC 3339 time, or "+" and an ISO 8601 duration from `now` (ns, required then). Returns the count of `unit`. */
export function parseTimestamp(input: string, options: { unit: TimeUnit; candid?: string; now?: bigint }): string;
/** Canonical RFC 3339 UTC, for example "2026-10-09T12:00:00.5Z". */
export function displayTimestamp(value: string | bigint, options: { unit: TimeUnit; candid?: string }): string;
/** An ISO 8601 duration of W, D, H, M and S ("PT24H"); returns the count of `unit`. */
export function parseDuration(input: string, options: { unit: TimeUnit; candid?: string }): string;
/** Canonical ISO 8601: "P1D", "PT1H30M", "PT0S". */
export function displayDuration(value: string | bigint, options: { unit: TimeUnit; candid?: string }): string;

/** ICRC-1 account text; the checksum is verified and non-canonical text is refused. */
export function parseAccount(input: string): Account;
/** An account in the ICRC-1 textual encoding; a subaccount absent, null or all zero is the default. */
export function displayAccount(account: { owner: string | Uint8Array; subaccount?: ByteInput | null }): string;
/** Canonical principal text to its bytes; the CRC-32 must match. */
export function principalFromText(text: string): Uint8Array;
/** Up to 29 bytes to canonical principal text. */
export function principalToText(bytes: Uint8Array): string;
/** "#n", a decimal n, or 64 hex characters to 32 bytes. */
export function parseSubaccount(input: string): Uint8Array;
/** "#n" when the first 24 bytes are zero, else 64 lowercase hex characters. */
export function displaySubaccount(value: ByteInput): string;
/** Text in the tag's encoding to bytes; `maxLen` is the tag's `max_len`. */
export function parseBytes(input: string, options: { encoding: BytesEncoding; maxLen?: number }): Uint8Array;
export function displayBytes(value: ByteInput, options: { encoding: BytesEncoding }): string;
/**
 * The value as a Uint8Array of this realm, viewing the same memory, or null. Accepts a Uint8Array made in another
 * realm (an iframe, a `node:vm` context), which fails `instanceof Uint8Array`; refuses other typed arrays, DataViews,
 * look-alike objects and views of a detached buffer.
 */
export function asUint8Array(value: unknown): Uint8Array | null;

/** The text a position reads, in words, with examples that parse there. */
export interface Description {
  summary: string;
  examples: string[];
  /** An ECMAScript regular expression every accepted input matches (amount and subaccount only). */
  pattern?: string;
}

export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: { code: FormatErrorCode; message: string } };

/** What `parse` returns per tag: base units or a unit count as a decimal string, an account, or bytes. */
export type ParsedValue = string | Account | Uint8Array;

/** One position's formatter: `formatterFor` returns it with the tag's arguments resolved. */
export interface Formatter {
  readonly tag: ValueTag;
  readonly candid: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Throws FormatError. */
  parse(input: string, context?: { now?: bigint }): ParsedValue;
  /** Throws FormatError. */
  display(value: unknown): string;
  safeParse(input: string, context?: { now?: bigint }): SafeResult<ParsedValue>;
  safeDisplay(value: unknown): SafeResult<string>;
  describe(): Description;
}

/** A position of a resolved form, as far as formatting reads it. */
export interface FormatNode {
  candid: string;
  tags?: Record<string, { args?: Record<string, unknown> } | undefined>;
  [key: string]: unknown;
}

/** The value tags, in spec order. */
export const VALUE_TAGS: readonly ValueTag[];
/**
 * The formatter of a position, or null when it has no value tag (show it as Candid text). Throws FormatError for a
 * missing ref, an invalid tag argument, a tag that does not fit the Candid type, or two value tags.
 *
 * @param options.refs dynamic tag values keyed by their `from`: `{ "query:icrc1_decimals": 8 }`
 * @param options.now default clock for relative timestamps, ns since the Unix epoch
 */
export function formatterFor(node: FormatNode, options?: { refs?: Record<string, unknown>; now?: bigint }): Formatter | null;
/** `Formatter.describe` without a formatter; `accepts` keeps only the examples it returns true for. */
export function describeInput(tag: ValueTag, args: Readonly<Record<string, unknown>>, candid: string, options?: { accepts?: (input: string) => boolean }): Description;

/** One entry of a names set (spec section 5.3, D-045), as the set's method lists it. */
export interface NameEntry<V = unknown> {
  name: string;
  value: V;
  show?: unknown;
  kind?: unknown;
}
/** The result of resolveName: the input itself when it is a value, the one matching entry's value, or why not. */
export type NameResolution<V = unknown> =
  | { value: string; direct: true }
  | { value: V | unknown; entry: NameEntry<V> }
  | { error: "not_found" }
  | { error: "ambiguous"; entries: NameEntry<V>[] };
/** Unicode NFKC, the default full lowercase mapping, White_Space runs made one space, then trimmed. */
export function normalizeName(text: string): string;
/** Resolves a person's or an agent's text against a set's entries by the rule of spec section 5.3. */
export function resolveName<V>(
  entries: NameEntry<V>[],
  input: string,
  opts?: { isValue?: (text: string) => boolean; kind?: (kind: unknown) => boolean; by?: "value" | "show" },
): NameResolution<V>;
/** The one entry with a name that a value belongs to, compared as Candid values (an account by owner and subaccount). */
export function ownerOf<V>(entries: NameEntry<V>[], value: unknown, opts?: { by?: "value" | "show" }): NameEntry<V> | undefined;
/** A named position's display: the one owning entry's name beside the shown value, or the value alone. */
export function nameOf<V>(entries: NameEntry<V>[], value: V, opts?: { by?: "value" | "show"; show?: (value: unknown) => string }): string;
