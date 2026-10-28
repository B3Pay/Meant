// Turning one value of the tree into text, and into an ICRC-21 `Value`.
//
// Formatting goes through `formatterFor` of @meantjs/format for every tagged position
// (spec section 6: "rendered with the formatter of the tag at that position"); nothing here converts a unit,
// a decimal or an account by itself. An untagged position renders as Candid text.
//
// A formatter can fail on a value (for example a 5-byte subaccount, which no ledger accepts). The value is then
// shown as raw Candid text instead of hiding it, and the failure is recorded in `diagnostics`. A formatter that
// cannot be built (a dynamic ref the caller did not supply, a bad tag argument) is a configuration error and
// stops the message: showing a number without its decimals would be worse than no message.

import { FormatError, convertUnit, displayTimestamp, formatterFor } from "@meantjs/format";
import { CODES, ConsentError, fail } from "./errors.mjs";
import { entriesOf } from "./resolved.mjs";
import { visible } from "./text.mjs";

const U64_MAX = 2n ** 64n - 1n;
const CONFIG_CODES = new Set(["E_REF_UNRESOLVED", "E_ARG", "E_TAG_TYPE", "E_TAG_CONFLICT", "E_TYPE"]);

/** Budget for the text of one message: a consent message is read by a person (ICRC-21: short and concise). */
export const MAX_MESSAGE_CHARS = 32 * 1024;

export class Renderer {
  /** Set while `plainTupleText` runs: no formatter applies. */
  #plain = false;

  /**
   * @param {{ refs?: Record<string, unknown>, utcOffsetMinutes?: number | null, diagnostics?: object[] }} options
   *   `refs`: the resolved dynamic values, keyed by their `from` string (for example `query:icrc1_decimals`).
   *   `utcOffsetMinutes`: when a number, timestamps are shown in that zone (the generic form); otherwise in UTC.
   */
  constructor({ refs = {}, utcOffsetMinutes = null, diagnostics = [] } = {}) {
    this.refs = refs;
    this.utcOffsetMinutes = utcOffsetMinutes;
    this.diagnostics = diagnostics;
    this.chars = 0;
    this.formatters = new WeakMap();
    /** Set when a timestamp was shown in the requested zone, so the response can say the text is zone-sensitive. */
    this.usedZone = false;
  }

  /** @returns {import("@meantjs/format").Formatter | null} */
  formatter(node) {
    if (this.formatters.has(node)) return this.formatters.get(node);
    let f;
    try {
      f = formatterFor(node, { refs: this.refs });
    } catch (e) {
      if (e instanceof FormatError && CONFIG_CODES.has(e.code)) throw new ConsentError(e.code, e.message, { cause: e });
      throw e;
    }
    this.formatters.set(node, f);
    return f;
  }

  charge(text) {
    this.chars += text.length;
    if (this.chars > MAX_MESSAGE_CHARS) fail(CODES.TOO_LARGE, `the message would exceed ${MAX_MESSAGE_CHARS} characters; it is never truncated`);
    return text;
  }

  /**
   * Plain display text of one value, not yet escaped for any format: the formatter of its tag, or Candid text
   * (spec section 6; a bare principal is its canonical text).
   * @param {object} node  the resolved-form position
   * @param {unknown} value  its value (a tree node, never absent)
   * @param {string} where  for diagnostics
   */
  text(node, value, where) {
    const shown = this.#formatted(node, value, where);
    if (shown !== null) return this.charge(shown);
    // An untagged principal is its canonical text, as everywhere else on the Internet Computer. Inside a composite it
    // stays `principal "..."` so that the Candid text of the composite is still Candid.
    if (node.candid === "principal") return this.charge(value);
    return this.charge(this.#raw(node, value, where));
  }

  /** Candid text of a whole argument tuple (the "raw arguments" of spec section 11 item 1), tagged children formatted. */
  tupleText(nodes, values) {
    return this.charge(`(${nodes.map((n, i) => this.#child(n, values[i], `argument ${i}`)).join(", ")})`);
  }

  /**
   * Candid text of a whole argument tuple with no formatter applied: base units, nanoseconds, blobs as bytes. A view
   * that does not depend on the profile's units, for a reader who checks the profile itself (spec section 11 item 1).
   */
  plainTupleText(nodes, values) {
    this.#plain = true;
    try {
      return this.charge(`(${nodes.map((n, i) => this.#child(n, values[i], `argument ${i}`)).join(", ")})`);
    } finally {
      this.#plain = false;
    }
  }

  /** The formatter's text, or null when the position has no value tag or the formatter refuses the value. */
  #formatted(node, value, where) {
    if (this.#plain) return null;
    const f = this.formatter(node);
    if (f === null) return null;
    try {
      return f.tag === "timestamp" && this.utcOffsetMinutes !== null ? this.#zoned(f, value) : f.display(value);
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      this.diagnostics.push({ code: "W_FORMAT_FALLBACK", at: where, message: `the ${f.tag} formatter refused the value (${e.code}: ${e.message}); it is shown as raw Candid text` });
      return null;
    }
  }

  /** A timestamp in the requested zone: the instant shifted by whole minutes, then shown with the library's calendar code. */
  #zoned(f, value) {
    const offset = this.utcOffsetMinutes;
    const local = BigInt(convertUnit(value, f.args.unit, "ns")) + BigInt(offset) * 60_000_000_000n;
    const utc = displayTimestamp(local, { unit: "ns", candid: "int" });
    this.usedZone = true;
    return `${utc.slice(0, -1).replace("T", " ")} ${zoneName(offset)}`;
  }

  /** A child of a composite: absent is `null`, a tagged child uses its formatter, any other is raw (`opt` marks a present optional). */
  #child(node, value, where) {
    if (node.optional === true && value === null) return "null";
    const shown = this.#formatted(node, value, where);
    if (shown !== null) return shown;
    const raw = this.#raw(node, value, where);
    return node.optional === true ? `opt ${raw}` : raw;
  }

  #raw(node, value, where) {
    switch (node.candid) {
      case "null":
      case "reserved":
        return "null";
      case "bool":
        return value ? "true" : "false";
      case "text":
        return candidString(value);
      case "principal":
        return `principal "${value}"`;
      case "blob":
        return `blob "${[...value].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;
      case "float32":
      case "float64":
        return Number.isNaN(value) ? "nan" : value === Infinity ? "inf" : value === -Infinity ? "-inf" : String(value);
      case "vec":
        return value.length === 0 ? "vec {}" : `vec { ${value.map((e, i) => this.#child(node.element, e, `${where}[${i}]`)).join("; ")} }`;
      case "record": {
        const parts = entriesOf(node.fields).map(([key, child]) => `${candidLabel(key)} = ${this.#child(child, value[key], `${where}.${key}`)}`);
        return parts.length === 0 ? "record {}" : `record { ${parts.join("; ")} }`;
      }
      case "variant": {
        const arm = entriesOf(node.cases).find(([key]) => key === value.tag);
        const key = arm === undefined ? String(value.tag) : arm[0];
        if (arm === undefined || (arm[1].candid === "null" && arm[1].optional !== true)) return `variant { ${candidLabel(key)} }`;
        return `variant { ${candidLabel(key)} = ${this.#child(arm[1], value.value, `${where}.${key}`)} }`;
      }
      default:
        return String(value); // integers (decimal strings)
    }
  }

  /**
   * The ICRC-21 `Value` of one value (spec section 12). Falls back to `Text` whenever the typed form cannot carry
   * the value exactly: an amount above nat64 or negative or without a symbol, a timestamp or duration that is not a
   * whole number of seconds, below zero or above nat64.
   *
   * @returns {{ TokenAmount: object } | { TimestampSeconds: object } | { DurationSeconds: object } | { Text: { content: string } }}
   */
  icrc21Value(node, value, where) {
    const f = this.formatter(node);
    if (f !== null && typeof value === "string") {
      const typed = this.#typed(f, value);
      if (typed !== null) return typed;
    }
    return { Text: { content: this.text(node, value, where) } };
  }

  #typed(f, value) {
    try {
      if (f.tag === "amount") {
        const amount = BigInt(value);
        const { decimals, symbol } = f.args;
        if (amount < 0n || amount > U64_MAX || typeof symbol !== "string") return null;
        f.display(value); // the library must accept the value too (type range), or it is shown as raw text
        return { TokenAmount: { decimals, amount, symbol } };
      }
      if (f.tag === "timestamp" || f.tag === "duration") {
        const seconds = BigInt(convertUnit(value, f.args.unit, "s")); // throws E_INEXACT when not whole seconds
        if (seconds < 0n || seconds > U64_MAX) return null;
        f.display(value);
        return f.tag === "timestamp" ? { TimestampSeconds: { amount: seconds } } : { DurationSeconds: { amount: seconds } };
      }
    } catch (e) {
      if (e instanceof FormatError) return null;
      throw e;
    }
    return null;
  }
}

/** `UTC`, `UTC+02:00`, `UTC-05:30`. */
export function zoneName(offsetMinutes) {
  if (offsetMinutes === 0) return "UTC";
  const abs = Math.abs(offsetMinutes);
  return `UTC${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** A Candid text literal: quotes, backslashes and invisible characters escaped. */
function candidString(s) {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${visible(escaped)}"`;
}

/** A record field or variant case label as Candid writes it: an identifier, a number for `#id`, else quoted. */
function candidLabel(key) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return key;
  if (/^#(0|[1-9][0-9]*)$/.test(key)) return key.slice(1);
  return candidString(key);
}
