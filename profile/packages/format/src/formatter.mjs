// formatterFor(node): the one entry point for consumers (arm C, the ICRC-21 consent generator).
//
// `node` is a position from the resolved form (docs/profile-v0.md §10): its `candid` type and its
// `tags`. The function picks the value tag at that position and returns a { parse, display } pair
// bound to the tag's arguments. Dynamic arguments such as { "from": "query:icrc1_decimals" } are
// resolved by the caller (the library does no I/O) and passed in `refs`, keyed by the `from` string.

import { CODES, FormatError, fail } from "./errors.mjs";
import { AMOUNT_TYPES, DEFAULT_THRESHOLD_MESSAGE, checkDecimals, checkMessage, checkSymbol, checkThreshold, displayAmount, parseAmount } from "./amount.mjs";
import { TIME_TYPES, checkTimeLabels, displayDuration, displayTimestamp, parseDuration, parseTimestamp, unitFactor } from "./time.mjs";
import { displayAccount, parseAccount } from "./account.mjs";
import { displaySubaccount, parseSubaccount } from "./subaccount.mjs";
import { BYTES_ENCODINGS, checkMaxLen, displayBytes, parseBytes } from "./bytes.mjs";
import { INT_TYPES, listTypes } from "./util.mjs";

/** The byte types: Candid's blob, the EVM ABI's bytes and bytes1 to bytes32 (spec section 15). */
const BYTE_TYPES = ["blob", "bytes", ...Array.from({ length: 32 }, (_, i) => `bytes${i + 1}`)];

/** The tags that give a position a text form, in spec §5.1. */
export const VALUE_TAGS = Object.freeze(["amount", "timestamp", "duration", "account", "subaccount", "bytes"]);

/** A dynamic value ({ from }) replaced by the caller-supplied one; literals pass through. */
function resolveArg(arg, refs, where) {
  if (arg === null || typeof arg !== "object" || Array.isArray(arg)) return arg;
  const from = arg.from;
  if (typeof from !== "string") fail(CODES.ARG, `${where} is an object without a "from" string`);
  if (from === "now" || from === "caller") fail(CODES.ARG, `${where}: { "from": "${from}" } is not valid here (only default.value may use it)`);
  if (!Object.hasOwn(refs, from)) {
    fail(CODES.REF_UNRESOLVED, `${where} needs the value of "${from}", which the caller did not supply (call it once per canister and pass it in \`refs\`)`);
  }
  return refs[from];
}

function requireCandid(node, allowed, tag) {
  if (!allowed.includes(node.candid)) fail(CODES.TAG_TYPE, `the ${tag} tag applies to ${listTypes(allowed)}, not ${node.candid}`);
}

function requireUnit(unit, tag) {
  if (unit === undefined) fail(CODES.ARG, `the ${tag} tag needs a unit`);
  unitFactor(unit);
  return unit;
}

/**
 * @typedef {object} Formatter
 * @property {string} tag  the value tag: amount, timestamp, duration, account, subaccount or bytes
 * @property {string} candid  the Candid type of the position (`opt` is the node's `optional` flag, not handled here)
 * @property {Readonly<Record<string, unknown>>} args  the tag's arguments with dynamic values resolved
 * @property {(input: string, ctx?: { now?: bigint }) => any} parse  throws FormatError. amount, timestamp,
 *   duration: decimal string in base units / tagged unit; account: { owner, subaccount }; subaccount, bytes: Uint8Array
 * @property {(value: any) => string} display  throws FormatError
 * @property {(input: string, ctx?: { now?: bigint }) => { ok: true, value: any } | { ok: false, error: { code: string, message: string } }} safeParse
 * @property {(value: any) => { ok: true, value: string } | { ok: false, error: { code: string, message: string } }} safeDisplay
 * @property {() => Description} describe  the text this formatter reads, in words, with examples (see `describeInput`)
 */

/**
 * @typedef {object} Description
 * @property {string} summary  one paragraph for a form hint or a tool input's description
 * @property {string[]} examples  inputs `parse` accepts (a relative time needs `now`)
 * @property {string} [pattern]  an ECMAScript regular expression every accepted input matches (JSON Schema `pattern`).
 *   A necessary condition only: a matching input can still be refused (a range, a checksum). Given for amount and
 *   subaccount, whose grammar is regular.
 */

/**
 * @param {{ candid: string, tags?: Record<string, { args?: Record<string, unknown> }> }} node
 * @param {{ refs?: Record<string, unknown>, now?: bigint, token?: { decimals: number | bigint | string, symbol?: string } }} [options]
 *   `refs`: resolved dynamic values keyed by their `from` string, for example
 *   `{ "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }`.
 *   `now`: default clock (nanoseconds, bigint) for relative timestamps; `parse(input, { now })` overrides it.
 *   `token`: for an amount whose `token` argument names the token by a field (spec section 15.9), the decimals and
 *   symbol of the token that field holds in this value; the caller reads them, as it resolves `refs`.
 * @returns {Formatter | null}  null when the position has no value tag (render it as Candid text, spec §6)
 */
export function formatterFor(node, { refs = {}, now: defaultNow, token } = {}) {
  if (node !== null && typeof node === "object" && node.candid === undefined && typeof node.abi === "string") node = { ...node, candid: node.abi }; // an EVM position (spec section 15)
  if (node === null || typeof node !== "object" || typeof node.candid !== "string") fail(CODES.TYPE, "node must be a resolved-form position with a `candid` type (or an EVM position's `abi` type)");
  const tags = node.tags ?? {};
  const present = VALUE_TAGS.filter((t) => Object.hasOwn(tags, t));
  if (present.length === 0) return null;
  if (present.length > 1) fail(CODES.TAG_CONFLICT, `a position cannot carry more than one value tag, found ${present.join(", ")}`);
  const tag = present[0];
  const raw = tags[tag]?.args ?? {};
  const arg = (name) => resolveArg(raw[name], refs, `${tag}.${name}`);

  let args;
  let parse;
  let display;
  switch (tag) {
    case "amount": {
      requireCandid(node, AMOUNT_TYPES, tag);
      let decimals;
      let symbol;
      if (raw.token !== undefined) {
        // The token is the one a field of the value names (spec section 15.9): its metadata comes with the value.
        if (typeof raw.token !== "string" || raw.token === "") fail(CODES.ARG, "amount token must be a relative path to an address");
        if (raw.decimals !== undefined || raw.symbol !== undefined) fail(CODES.ARG, "an amount with a token takes that token's decimals and symbol, not its own");
        if (token === undefined || token === null || typeof token !== "object") {
          fail(CODES.REF_UNRESOLVED, `amount.token: the amount is in the token at ${JSON.stringify(raw.token)}; pass that token's decimals and symbol as \`token\``);
        }
        decimals = checkDecimals(token.decimals);
        symbol = checkSymbol(token.symbol);
      } else {
        if (raw.decimals === undefined) fail(CODES.ARG, "the amount tag needs decimals");
        decimals = checkDecimals(arg("decimals"));
        symbol = checkSymbol(arg("symbol"));
      }
      const threshold = checkThreshold(raw.threshold);
      const message = checkMessage(raw.message);
      if (message !== undefined && threshold === undefined) fail(CODES.ARG, "amount message needs a threshold");
      const o = { decimals, symbol, candid: node.candid, threshold, message };
      args = { decimals, symbol, ...(raw.token === undefined ? {} : { token: raw.token }), ...(threshold === undefined ? {} : { threshold: threshold.toString(), message: message ?? DEFAULT_THRESHOLD_MESSAGE }) };
      parse = (input) => parseAmount(input, o);
      display = (value) => displayAmount(value, o);
      break;
    }
    case "timestamp": {
      requireCandid(node, TIME_TYPES, tag);
      if (raw.epoch !== undefined && raw.epoch !== "unix") fail(CODES.ARG, `timestamp epoch must be "unix", got ${JSON.stringify(raw.epoch)}`);
      const unit = requireUnit(arg("unit"), tag);
      const threshold = checkThreshold(raw.threshold, "timestamp");
      const message = checkMessage(raw.message, "timestamp message");
      if ((threshold === undefined) !== (message === undefined)) fail(CODES.ARG, "a timestamp threshold and its message go together: give both or neither");
      const labels = checkTimeLabels(raw.labels);
      const o = { unit, candid: node.candid };
      const shown = { ...o, threshold, message, labels: raw.labels };
      args = {
        unit,
        epoch: "unix",
        ...(threshold === undefined ? {} : { threshold: threshold.toString(), message }),
        ...(labels === undefined ? {} : { labels: Object.fromEntries([...labels].map(([k, v]) => [k.toString(), v])) }),
      };
      parse = (input, ctx = {}) => parseTimestamp(input, { ...o, now: ctx.now ?? defaultNow });
      display = (value) => displayTimestamp(value, shown);
      break;
    }
    case "duration": {
      requireCandid(node, TIME_TYPES, tag);
      const unit = requireUnit(arg("unit"), tag);
      const o = { unit, candid: node.candid };
      args = { unit };
      parse = (input) => parseDuration(input, o);
      display = (value) => displayDuration(value, o);
      break;
    }
    case "account": {
      requireCandid(node, ["record"], tag);
      if (raw.encoding !== undefined && raw.encoding !== "icrc1") fail(CODES.ARG, `account encoding must be "icrc1", got ${JSON.stringify(raw.encoding)}`);
      args = { encoding: "icrc1" };
      parse = (input) => parseAccount(input);
      display = (value) => displayAccount(value);
      break;
    }
    case "subaccount": {
      requireCandid(node, ["blob"], tag);
      args = {};
      parse = (input) => parseSubaccount(input);
      display = (value) => displaySubaccount(value);
      break;
    }
    case "bytes": {
      requireCandid(node, BYTE_TYPES, tag);
      const encoding = arg("encoding");
      if (!BYTES_ENCODINGS.includes(encoding)) fail(CODES.ARG, `the bytes tag needs encoding utf8, hex or base64, got ${JSON.stringify(encoding)}`);
      const maxLen = raw.max_len;
      args = { encoding, ...(maxLen === undefined ? {} : { max_len: maxLen }) };
      const size = /^bytes(\d+)$/.exec(node.candid)?.[1]; // bytesN holds exactly N bytes
      parse = (input) => {
        const b = parseBytes(input, { encoding, maxLen });
        if (size !== undefined && b.length !== Number(size)) fail(CODES.LENGTH, `${node.candid} holds exactly ${size} bytes, got ${b.length}`);
        return b;
      };
      display = (value) => displayBytes(value, { encoding });
      break;
    }
  }

  const safe = (fn) => (...a) => {
    try {
      return { ok: true, value: fn(...a) };
    } catch (e) {
      if (e instanceof FormatError) return { ok: false, error: { code: e.code, message: e.message } };
      throw e;
    }
  };
  // Keep only the examples this position accepts: a range (nat8, nat32 in ns) or a max_len can refuse one. A relative time
  // is checked against the formatter's own clock when it was given one (`parse` uses it), else against a fixed instant
  // (2026-01-01T00:00:00Z), since describing must not read a clock.
  const description = describeInput(tag, args, node.candid, { accepts: (x) => safe(parse)(x, { now: defaultNow ?? DESCRIBE_NOW }).ok });
  return Object.freeze({
    tag,
    candid: node.candid,
    args: Object.freeze(args),
    describe: () => ({ ...description, examples: [...description.examples] }),
    parse,
    display,
    safeParse: safe(parse),
    safeDisplay: safe(display),
  });
}

// ---------------------------------------------------------------- describe

/** The Candid types each value tag applies to (the `requireCandid` calls in `formatterFor`). */
const CANDID_OF = { amount: AMOUNT_TYPES, timestamp: TIME_TYPES, duration: TIME_TYPES, account: ["record"], subaccount: ["blob"], bytes: BYTE_TYPES };
/** 2026-01-01T00:00:00Z in ns: the reference instant relative examples are checked against. */
const DESCRIBE_NOW = 1_767_225_600_000_000_000n;

// ECMAScript syntax characters only: escaping anything else (such as "-") is an error under the `u` flag, which JSON
// Schema validators such as Ajv use.
const reEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** The symbol as `parseAmount` compares it: ASCII letters in either case, everything else exactly. */
const symbolPattern = (symbol) => [...symbol].map((c) => (/[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : reEscape(c))).join("");
const quoted = (xs) => xs.map((x) => JSON.stringify(x)).join(", ");

/** The grammar in words (no examples), candidate examples, and a pattern where the grammar is regular. */
function grammar(tag, args, candid) {
  const signed = INT_TYPES[candid]?.signed === true;
  const finer = (what) => (args.unit === "ns" ? "" : ` Stored in ${args.unit}: a ${what} finer than that is an error, not rounded.`);
  switch (tag) {
    case "amount": {
      const { decimals: d, symbol } = args;
      const examples = d === 0 ? ["1", "250"] : ["1", d === 1 ? "1.5" : "1.25"];
      if (symbol !== undefined) examples.push(`${examples[1]} ${symbol}`);
      return {
        words:
          `Amount in ${symbol === undefined ? "the token's units" : symbol}: ` +
          (d === 0 ? "a whole number (this token has no decimal places)" : `a decimal number with at most ${d} digit${d === 1 ? "" : "s"} after the point`) +
          (symbol === undefined ? "" : `, optionally followed by the symbol ${symbol}`) +
          `. Digits on both sides of a point, no thousands separators or exponents${signed ? ', "-" for a negative amount' : ""}. ` +
          "Never rounded: more digits after the point is an error, even zeros.",
        examples,
        pattern:
          `^\\s*${signed ? "-?" : ""}[0-9]+${d === 0 ? "" : `(?:\\.[0-9]{1,${d}})?`}` + (symbol === undefined ? "" : `(?:\\s+${symbolPattern(symbol)})?`) + "\\s*$",
      };
    }
    case "timestamp":
      return {
        words:
          'Time in RFC 3339 with an explicit zone, or relative to the current time as "+" and an ISO 8601 duration with ' +
          "weeks, days, hours, minutes and seconds only (no years or months; the seconds may have a fraction)." +
          finer("time"),
        examples: ["2026-12-25T10:00:00Z", "+PT24H", "+P7D"],
      };
    case "duration":
      return {
        words:
          `ISO 8601 duration with weeks, days, hours, minutes and seconds only (no years or months); the seconds may have a fraction${signed ? '; "-" for a negative duration' : ""}.` +
          finer("duration"),
        examples: ["PT24H", "P7D", "PT1M30S"],
      };
    case "account":
      return {
        words: 'ICRC-1 account in text form: a principal for its default subaccount, or "principal-checksum.subaccounthex" for another subaccount.',
        examples: ["aaaaa-aa", "2vxsx-fae"],
      };
    case "subaccount":
      return {
        words: 'Subaccount as "#n" or n (a number below 2^64 without leading zeros, stored as 32 big-endian bytes), or as exactly 64 hex characters, optionally after "0x".',
        examples: ["#0", "#7", "0".repeat(63) + "1"],
        pattern: "^\\s*(?:#?(?:0|[1-9][0-9]*)|(?:0[xX])?[0-9a-fA-F]{64})\\s*$",
      };
    case "bytes": {
      const max = args.max_len === undefined || args.max_len === null ? "" : ` At most ${args.max_len} bytes after encoding.`;
      if (args.encoding === "hex") return { words: `Bytes as hexadecimal, an even number of digits, optionally after "0x".${max}`, examples: ["0x1a2b", "1a2b"] };
      if (args.encoding === "base64") return {
          words: `Bytes as standard base64 (RFC 4648: A-Z, a-z, 0-9, "+" and "/"; not the URL-safe "-" and "_"), with "=" padding or none, no spaces or line breaks, and the unused bits of the last character zero.${max}`,
          examples: ["aGk="],
        };
      return { words: `Text, stored as its UTF-8 bytes. Text that starts with "0x" is read as hex bytes instead.${max}`, examples: ["invoice 42", "0x1a2b"] };
    }
  }
  throw new Error(`no description for the ${tag} tag`);
}

/**
 * The input grammar of a value tag in words (spec §5.3), with the tag's resolved arguments filled in, so a form hint,
 * a tool schema and the parser share one description. The summary quotes exactly the examples kept.
 *
 * @param {string} tag
 * @param {Readonly<Record<string, any>>} args  the tag's arguments, dynamic values resolved (`Formatter.args`)
 * @param {string} candid
 * @param {{ accepts?: (input: string) => boolean }} [options]  keeps only the examples it accepts (`Formatter.describe`
 *   passes its own parser, so a range or `max_len` that refuses an example leaves it out); default: all of them
 * @returns {Description}
 */
export function describeInput(tag, args, candid, { accepts = () => true } = {}) {
  // The same checks and normalisation formatterFor applies (decimals may arrive as "0" or 0n), so arguments it would
  // refuse are refused here too, never described as another grammar.
  if (VALUE_TAGS.includes(tag)) {
    requireCandid({ candid }, CANDID_OF[tag], tag);
    const a = args ?? {};
    if (tag === "amount") args = { ...a, decimals: checkDecimals(a.decimals), symbol: checkSymbol(a.symbol) };
    if (tag === "timestamp" || tag === "duration") requireUnit(a.unit, tag);
    if (tag === "timestamp" && a.epoch !== undefined && a.epoch !== "unix") fail(CODES.ARG, `timestamp epoch must be "unix", got ${JSON.stringify(a.epoch)}`);
    if (tag === "account" && a.encoding !== undefined && a.encoding !== "icrc1") fail(CODES.ARG, `account encoding must be "icrc1", got ${JSON.stringify(a.encoding)}`);
    if (tag === "bytes") {
      if (!BYTES_ENCODINGS.includes(a.encoding)) fail(CODES.ARG, `the bytes tag needs encoding utf8, hex or base64, got ${JSON.stringify(a.encoding)}`);
      checkMaxLen(a.max_len);
    }
  }
  const g = grammar(tag, args, candid);
  const examples = g.examples.filter((x) => accepts(x));
  return {
    summary: g.words + (examples.length > 0 ? ` For example ${quoted(examples)}.` : ""),
    examples,
    ...(g.pattern === undefined ? {} : { pattern: g.pattern }),
  };
}
