// Reading a tool call's inputs into the Candid argument (#16, item 2), and showing values back.
//
// Every input is text in human units, read by the format library (profile spec 5.3), so nothing is rounded. The
// argument comes back in candid-core's domain shapes, the value `encodeArgs` (and so ic-reactor) takes: `T | null`
// for an opt, `bigint` for nat, int, nat64 and int64, `number` for the narrower integers, `Uint8Array` for a blob,
// a principal as its canonical text (candid-core's `Principal` is a branded string), `string` for text, `boolean`
// for bool, an object for a record and `{ tag, value }` for a variant. A method with more than one argument gets the
// argument tuple, an array.
//
// Beyond the value tags (D-050, proposal w6-adoption.md item 2): a `text` position reads the text as given, within
// its `text` tag's `max_len` and `pattern`; a `bool` position reads "true" or "false"; and a record, variant or vec
// position with no value tag is one input given as JSON (an object, `{ "tag", "value" }`, an array) whose leaves are
// text read by these same rules.

import { CODES, FormatError, VALUE_TAGS, asUint8Array, formatterFor, ownerOf, parseDuration, principalFromText, principalToText, resolveName } from "@meantjs/format";

const NARROW = new Set(["nat8", "nat16", "nat32", "int8", "int16", "int32"]);
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export const hex = (bytes) => {
  let s = "";
  for (const b of bytes) s += HEX[b];
  return s;
};
const isZero = (bytes) => bytes === null || bytes === undefined || bytes.every((b) => b === 0);

const PRINCIPAL_EXAMPLES = ["ryjl3-tyaaa-aaaaa-aaaba-cai", "aaaaa-aa"];
/** The format library's bound on any text it parses (bounded work, profile spec 11.6). */
const MAX_INPUT_CHARS = 1024;

/** `safeParse` over a reader's `parse`: a FormatError becomes `{ ok: false, error }`, as the format library's do. */
const safely = (parse) => (input) => {
  try {
    return { ok: true, value: parse(input) };
  } catch (e) {
    if (e instanceof FormatError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
};

/**
 * A `principal` position with no value tag reads its one textual form: lowercase base32 in groups of five with a
 * CRC-32 checksum, so it needs no profile meaning to be read exactly (profile spec 5.3 has no tag for it, and an
 * agent tool falls back to raw Candid where a stale profile's value tags are dropped, section 7; a principal on its
 * own renders as its text, section 12 rule 4).
 * The value is the canonical text, candid-core's `Principal`. Same shape as a format-library Formatter.
 */
const PRINCIPAL_READER = Object.freeze({
  tag: "principal",
  args: Object.freeze({}),
  candid: "principal",
  parse(input) {
    if (typeof input !== "string") throw new FormatError(CODES.TYPE, `principal must be a string, got ${typeof input}`);
    return principalToText(principalFromText(input.trim()));
  },
  safeParse: (input) => safely(PRINCIPAL_READER.parse)(input),
  describe: () => ({
    summary: `A principal (a canister or user id) in its textual form: groups of five letters a to z and digits 2 to 7 separated by dashes, ending with a shorter group, with a checksum that catches a mistyped character. For example ${PRINCIPAL_EXAMPLES.map((e) => `"${e}"`).join(" or ")}.`,
    examples: [...PRINCIPAL_EXAMPLES],
    // necessary only: everything parse accepts matches it; the checksum is checked by parse
    pattern: "^\\s*[A-Za-z2-7]{5}(?:-[A-Za-z2-7]{5})*(?:-[A-Za-z2-7]{1,5})?\\s*$",
  }),
});

/** Inclusive bounds of the Candid integer types; null is unbounded. */
const INTEGER_BOUNDS = {
  nat: [0n, null],
  nat8: [0n, 2n ** 8n - 1n],
  nat16: [0n, 2n ** 16n - 1n],
  nat32: [0n, 2n ** 32n - 1n],
  nat64: [0n, 2n ** 64n - 1n],
  int: [null, null],
  int8: [-(2n ** 7n), 2n ** 7n - 1n],
  int16: [-(2n ** 15n), 2n ** 15n - 1n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
};

/**
 * An integer position with no value tag but a `describe` reads decimal digits as they are: no unit, no conversion,
 * within the Candid type's bounds (an action id, a page size). The profile's words say what the number is; without
 * them a bare number means nothing to an agent, so such a position stays without a rule.
 * The value is the canonical decimal text, as the format library's are. Same shape as a format-library Formatter.
 */
function integerReader(candid) {
  const [min, max] = INTEGER_BOUNDS[candid];
  const signed = min === null || min < 0n;
  const digits = signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/;
  const range = max === null ? (min === null ? "of any size" : `from ${min} up`) : `from ${min} to ${max}`;
  const examples = signed ? ["1", "-42"] : ["1", "42"];
  const reader = {
    tag: "integer",
    args: Object.freeze({}),
    candid,
    parse(input) {
      if (typeof input !== "string") throw new FormatError(CODES.TYPE, `${candid} must be a string of decimal digits, got ${typeof input}`);
      if (input.length > MAX_INPUT_CHARS) throw new FormatError(CODES.TOO_LONG, `the number is longer than ${MAX_INPUT_CHARS} characters`);
      const text = input.trim();
      if (!digits.test(text)) {
        if (!signed && /^-[1-9][0-9]*$/.test(text)) throw new FormatError(CODES.RANGE, `${text} is negative but the Candid type ${candid} is unsigned`);
        throw new FormatError(CODES.SYNTAX, `cannot read ${JSON.stringify(text)} as a whole number: write decimal digits only, without a unit, separators, an exponent or leading zeros`);
      }
      const v = BigInt(text);
      if ((min !== null && v < min) || (max !== null && v > max)) throw new FormatError(CODES.RANGE, `${text} is outside the range of the Candid type ${candid}, ${range}`);
      return v.toString();
    },
    safeParse: (input) => safely(reader.parse)(input),
    describe: () => ({
      summary: `A whole number in decimal digits, ${range}, written as it is: no unit, separators, exponent or leading zeros. For example ${examples.map((e) => `"${e}"`).join(" or ")}.`,
      examples: [...examples],
      // necessary only: everything parse accepts matches it; the range is checked by parse
      pattern: signed ? "^\\s*(?:0|-?[1-9][0-9]*)\\s*$" : "^\\s*(?:0|[1-9][0-9]*)\\s*$",
    }),
  };
  return Object.freeze(reader);
}
const INTEGER_READERS = Object.fromEntries(Object.keys(INTEGER_BOUNDS).map((t) => [t, integerReader(t)]));
/** The Candid integer types. */
export const INTEGER_TYPES = new Set(Object.keys(INTEGER_BOUNDS));

/** The longest text a `text` position without a `max_len` takes (bounded work, profile spec 11.6). */
export const MAX_TEXT_CHARS = 1024;
/** The longest `text.pattern` the tool layer runs, and the shapes it refuses to run (see `patternWithoutRule`). */
const MAX_PATTERN_CHARS = 256;

/**
 * Why a `text.pattern` is not run, or undefined. A pattern is the profile author's code, run on input an agent wrote,
 * and JavaScript's regular expressions backtrack: a quantified group that holds a quantifier (`(a+)+`), a back
 * reference or a lookaround can take exponential time. Those are refused, and so is a pattern that does not compile.
 * This bounds the classic blowups, not every slow pattern (a linear-time engine would; open in D-050).
 */
function patternWithoutRule(pattern) {
  if (typeof pattern !== "string") return "the text pattern is not a string";
  if (pattern.length > MAX_PATTERN_CHARS) return `the text pattern is longer than ${MAX_PATTERN_CHARS} characters`;
  try {
    new RegExp(pattern, "u");
  } catch (e) {
    return `the text pattern is not an ECMAScript regular expression: ${e.message}`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return "the text pattern has a back reference";
  // escapes and character classes are one character each; what is left is groups, quantifiers and literals
  let s = pattern.replace(/\\./gsu, "x").replace(/\[[^\]]*\]/gu, "x");
  if (/\(\?<?[=!]/.test(s)) return "the text pattern has a lookaround";
  s = s.replace(/\(\?(?::|<[A-Za-z][A-Za-z0-9]*>)/gu, "(");
  // innermost group first: a group holding a variable quantifier that is itself quantified can blow up; otherwise it
  // stands for one character, repeated when it repeats, and the group around it is looked at next
  const VARIABLE = /[*+?]|\{\d+,/u;
  // `?` and `{0,1}` take a group at most once; `*`, `+`, `{n}` with n > 1 and `{n,}` repeat it
  const repeats = (q) => q === "*" || q === "+" || (q?.startsWith("{") && (/,\}$/u.test(q) || Math.max(...q.slice(1, -1).split(",").map(Number)) > 1));
  for (let m; (m = /\(([^()]*)\)(\{\d+(?:,\d*)?\}|[*+?])?/u.exec(s)) !== null; ) {
    const [whole, inner, outer] = m;
    const varies = VARIABLE.test(inner);
    if (varies && repeats(outer)) return "the text pattern repeats a group that repeats (it could take exponential time)";
    s = s.slice(0, m.index) + (varies || (outer !== undefined && VARIABLE.test(outer)) ? "x*" : "x") + s.slice(m.index + whole.length);
  }
  return undefined;
}

const codePoints = (text) => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/**
 * A `text` position reads the text as given (D-050): nothing is trimmed or changed. It must be well-formed Unicode (a
 * lone surrogate has no UTF-8 encoding), at most `text.max_len` (and `range.max_len`) characters, counted as code
 * points as JSON Schema counts them, and MAX_TEXT_CHARS when no `max_len` is given; at least `range.min_len`; and
 * matched by `text.pattern` (an unanchored ECMAScript expression, as JSON Schema's `pattern`) when there is one.
 * `format: "url"` needs an absolute http or https URL, `format: "email"` one `@` between non-empty parts without
 * spaces; `plain` and `markdown` take any text. Same shape as a format-library Formatter, plus `isValue` for `named`.
 * @throws {FormatError} E_ARG when the tag's pattern is one the layer does not run
 */
function textReader(node) {
  const t = node.tags?.text?.args ?? {};
  const r = node.tags?.range?.args ?? {};
  const limits = [t.max_len, r.max_len].filter((n) => Number.isInteger(n));
  const max = limits.length ? Math.min(...limits) : MAX_TEXT_CHARS;
  const min = Number.isInteger(r.min_len) ? r.min_len : 0;
  const why = t.pattern === undefined ? undefined : patternWithoutRule(t.pattern);
  if (why) throw new FormatError(CODES.ARG, why);
  const pattern = t.pattern === undefined ? null : new RegExp(t.pattern, "u");
  const format = t.format ?? "plain";
  const reader = {
    tag: "text",
    args: Object.freeze({ ...t }),
    candid: "text",
    parse(input) {
      if (typeof input !== "string") throw new FormatError(CODES.TYPE, `text must be a string, got ${typeof input}`);
      if (input.length > 2 * max) throw new FormatError(CODES.MAX_LEN, `the text is longer than ${max} characters`); // before counting
      if (!input.isWellFormed()) throw new FormatError(CODES.UTF8, "the text has a lone surrogate, which has no UTF-8 encoding");
      const n = codePoints(input);
      if (n > max) throw new FormatError(CODES.MAX_LEN, `the text is ${n} characters, longer than ${max}`);
      if (n < min) throw new FormatError(CODES.RANGE, `the text is ${n} characters, shorter than ${min}`);
      if (pattern !== null && !pattern.test(input)) throw new FormatError(CODES.SYNTAX, `the text does not match the pattern ${t.pattern}`);
      if (format === "url" && !isWebUrl(input)) throw new FormatError(CODES.SYNTAX, "the text must be an absolute http or https URL");
      if (format === "email" && !/^[^@\s]+@[^@\s]+$/u.test(input)) throw new FormatError(CODES.SYNTAX, "the text must be an email address: one @ between non-empty parts, without spaces");
      return input;
    },
    safeParse: (input) => safely(reader.parse)(input),
    /** For a `named` position (spec 5.3): only text the pattern matches is a value; without a pattern, no text is. */
    isValue: (input) => pattern !== null && reader.safeParse(input).ok,
    describe: () => ({
      summary: `Text, exactly as given${format === "url" ? ": an absolute http or https URL" : format === "email" ? ": an email address" : format === "markdown" ? " (Markdown)" : ""}, at most ${max} characters${min ? ` and at least ${min}` : ""}${pattern ? `, matching the pattern ${t.pattern}` : ""}.`,
      examples: [],
      ...(pattern ? { pattern: t.pattern } : {}),
    }),
  };
  return Object.freeze(reader);
}

function isWebUrl(text) {
  try {
    const u = new URL(text);
    return (u.protocol === "https:" || u.protocol === "http:") && u.href.length > 0 && !/\s/u.test(text);
  } catch {
    return false;
  }
}

/** A `bool` position reads "true" or "false" (D-050), and nothing else: no "yes", "1" or other case. */
const BOOL_READER = Object.freeze({
  tag: "bool",
  args: Object.freeze({}),
  candid: "bool",
  parse(input) {
    if (typeof input !== "string") throw new FormatError(CODES.TYPE, `bool must be the text "true" or "false", got ${typeof input}`);
    const text = input.trim();
    if (text === "true") return true;
    if (text === "false") return false;
    throw new FormatError(CODES.SYNTAX, `cannot read ${JSON.stringify(input.slice(0, 32))} as a bool: write true or false`);
  },
  safeParse: (input) => safely(BOOL_READER.parse)(input),
  describe: () => ({ summary: 'Yes or no, written "true" or "false".', examples: ["true", "false"], pattern: "^\\s*(?:true|false)\\s*$" }),
});

/**
 * What a position with no value tag is read as, if anything: `principal` for a principal (its one textual form),
 * `integer` for an integer the profile describes, `text` for text, `bool` for a bool. Undefined otherwise.
 */
export function untaggedReading(node) {
  if (node?.candid === "principal") return "principal";
  if (node?.candid === "text") return "text";
  if (node?.candid === "bool") return "bool";
  if (Object.hasOwn(INTEGER_READERS, node?.candid ?? "") && Object.hasOwn(node.tags ?? {}, "describe")) return "integer";
  return undefined;
}

const valueTagOf = (node) => VALUE_TAGS.find((t) => Object.hasOwn(node?.tags ?? {}, t));
/** What a position is read as when it is one text input: its value tag, else `untaggedReading`. */
export const readAs = (node) => valueTagOf(node) ?? untaggedReading(node);

/**
 * How one input is read: the format library's formatter for a value-tagged position, the principal or integer reader
 * for an untagged position `untaggedReading` names, or null when the position has none of them (it is not an input).
 * @throws {FormatError} as `formatterFor` does (a missing ref, a bad tag argument)
 */
export function inputReader(node, refs = {}) {
  const f = formatterFor(node, { refs });
  if (f !== null) return f;
  switch (untaggedReading(node)) {
    case "principal":
      return PRINCIPAL_READER;
    case "integer":
      return INTEGER_READERS[node.candid];
    case "text":
      return textReader(node);
    case "bool":
      return BOOL_READER;
    default:
      return null;
  }
}

/** A format-library value as candid-core's value for the position. */
export function toCandid(node, value) {
  if (node.candid === "principal" || node.candid === "text" || node.candid === "bool") return value; // canonical text, the text, a boolean
  if (typeof value === "string") return NARROW.has(node.candid) ? Number(value) : BigInt(value);
  return value; // account { owner, subaccount }, subaccount and bytes (Uint8Array)
}

/** What an input adds to the identity of an intent (spec 5.3: the converted arguments; a relative time by its duration). */
function identityOf(f, input, value) {
  switch (f.tag) {
    case "timestamp": {
      // `+PT24H` moves with the clock; its duration does not ("+P7D" and "+PT168H" are one intent)
      const text = input.trim();
      return text.startsWith("+") ? `rel:${parseDuration(text.slice(1), { unit: f.args.unit, candid: f.candid })}` : value;
    }
    case "account":
      return `${value.owner}|${isZero(value.subaccount) ? "" : hex(value.subaccount)}`;
    case "subaccount":
      return isZero(value) ? null : hex(value); // "#0" is the same account as no subaccount
    case "bytes":
      return hex(value);
    default:
      return value;
  }
}

/** The most elements one `vec` input takes, and the most values one nested input holds (bounded work, spec 11.6). */
export const MAX_VEC_ITEMS = 256;
export const MAX_NESTED_VALUES = 4096;
const COMPOSITE = new Set(["record", "variant", "vec"]);
const NO_VALUE = new Set(["null", "reserved"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * How a field inside a nested input is filled: `param` (read from the input), `auto` (an `auto` default of null) or
 * `hidden` (`ui.hidden`), both left null and not part of the input; or why it has no rule. The same rules as the
 * top-level fields (plan.mjs), less the idempotency stamp, which is a top-level field.
 */
export function nestedRole(name, node) {
  const tags = node.tags ?? {};
  const def = tags.default?.args;
  if (def !== undefined && def.value !== "null") return { skip: `${name}: a default value other than null has no rule` };
  if (def?.mode === "auto") return node.optional ? { role: "auto" } : { skip: `${name}: an auto default needs an optional position` };
  if (tags.ui?.args?.hidden === true) return node.optional ? { role: "hidden" } : { skip: `${name}: a hidden position must be optional` };
  return { role: "param" };
}

/**
 * Why a position has no rule as an input, or undefined: a position `readAs` names is one text; a record, variant or
 * vec with no value tag is read as JSON (D-050) when every position inside it has a rule. `null` and `reserved`
 * positions take no input. Labels that are numbers (`#3`, tuples) have no rule: their JSON spelling is not settled.
 */
export function inputWithoutRule(node, at) {
  if (readAs(node) === "text") {
    // a pattern the layer does not run is found here, when the tools are made, not when an agent first types
    try {
      textReader(node);
    } catch (e) {
      return `${at}: ${e.message}`;
    }
  }
  if (readAs(node)) return undefined;
  if (node.recursive) return `${at}: a recursive position has no rule`;
  if (NO_VALUE.has(node.candid)) return undefined;
  if (!COMPOSITE.has(node.candid)) {
    return `${at}: no rule for a ${node.candid} position without a value tag${INTEGER_TYPES.has(node.candid) ? " or a describe" : ""}`;
  }
  if (node.candid === "vec") return inputWithoutRule(node.element ?? {}, `${at}[]`);
  const members = Object.entries((node.candid === "record" ? node.fields : node.cases) ?? {});
  if (node.candid === "variant" && members.length === 0) return `${at}: a variant without cases has no rule`;
  for (const [name, child] of members) {
    if (name.startsWith("#")) return `${at}.${name}: a numbered ${node.candid === "record" ? "field" : "case"} has no rule`;
    if (node.candid === "record") {
      const c = nestedRole(`${at}.${name}`, child);
      if (c.skip) return c.skip;
      if (c.role !== "param") continue;
    }
    const why = inputWithoutRule(child, `${at}.${name}`);
    if (why) return why;
  }
  return undefined;
}

/**
 * One text input at a position `readAs` names: `{ value, identity }` or `{ issue }`.
 */
function readLeaf(node, text, { refs, now, names }) {
  let f;
  try {
    f = inputReader(node, refs);
  } catch (e) {
    return { issue: { code: e.code ?? "E_ARG", message: e.message } };
  }
  const named = node.tags?.named?.args;
  if (named) {
    const found = readName(f, named, names[named.set], text, now);
    if (found.issue) return { issue: found.issue };
    if (found.value !== undefined) {
      // the entry's value is already the position's Candid value, in the canister's own units (an amount in base
      // units): it is sent as it is, never read again as typed input. Its identity is the one the same value typed
      // has, so a name and the value it stands for are one intent.
      const id = identityOf(f, "", forFormat(f, found.value));
      return { value: found.value, identity: typeof id === "number" ? String(id) : plain(id) };
    }
  }
  const r = f.safeParse(text, { now });
  if (!r.ok) return { issue: r.error };
  return { value: toCandid(node, r.value), identity: identityOf(f, text, r.value) };
}

/**
 * One input at any position with a rule (`inputWithoutRule`): a text, or for a record, variant or vec JSON whose
 * leaves are texts. Issues go to `ctx.issues` with their path; the result is `{ value, identity }`, or undefined after
 * an issue.
 */
function readInput(node, input, path, param, ctx) {
  const issue = (code, message) => {
    ctx.issues.push({ param, path, code, message });
    return undefined;
  };
  if (++ctx.count > MAX_NESTED_VALUES) {
    if (ctx.count === MAX_NESTED_VALUES + 1) issue(CODES.TOO_LONG, `${param} holds more than ${MAX_NESTED_VALUES} values`);
    return undefined;
  }
  if (input === undefined || input === null) {
    if (node.optional || NO_VALUE.has(node.candid)) return { value: null, identity: null };
    return issue("E_MISSING", `${path} is required`);
  }
  if (readAs(node)) {
    if (typeof input !== "string") return issue("E_TYPE", `${path} must be text, got ${Array.isArray(input) ? "an array" : typeof input}`);
    const r = readLeaf(node, input, ctx);
    return r.issue ? issue(r.issue.code, r.issue.message) : r;
  }
  switch (node.candid) {
    case "null":
    case "reserved":
      return issue("E_TYPE", `${path} takes no value: leave it out`);
    case "record": {
      if (!isObject(input)) return issue("E_TYPE", `${path} must be a JSON object with the fields ${Object.keys(node.fields ?? {}).join(", ")}`);
      const fields = Object.entries(node.fields ?? {});
      const inputs = new Set(fields.filter(([name, f]) => nestedRole(name, f).role === "param").map(([name]) => name));
      for (const key of Object.keys(input)) if (!inputs.has(key)) issue("E_UNKNOWN_PARAM", `${path} has no input ${key}; its inputs are ${[...inputs].join(", ") || "none"}`);
      const value = [];
      const identity = [];
      for (const [name, f] of fields) {
        if (!inputs.has(name)) {
          value.push([name, null]);
          continue;
        }
        const r = readInput(f, Object.hasOwn(input, name) ? input[name] : undefined, `${path}.${name}`, param, ctx);
        if (r === undefined) continue;
        value.push([name, r.value]);
        identity.push([name, r.identity]);
      }
      // entries, not assignments: a field named `__proto__` must become an own property
      return { value: Object.fromEntries(value), identity };
    }
    case "variant": {
      const cases = node.cases ?? {};
      const names = Object.keys(cases);
      const shape = `{ "tag": one of ${names.join(", ")}, "value": its value }`;
      if (!isObject(input) || typeof input.tag !== "string") return issue("E_TYPE", `${path} must be a JSON object ${shape}`);
      for (const key of Object.keys(input)) if (key !== "tag" && key !== "value") return issue("E_UNKNOWN_PARAM", `${path} must be ${shape}; ${key} is not one of its keys`);
      if (!Object.hasOwn(cases, input.tag)) return issue("E_TYPE", `${path}: ${JSON.stringify(input.tag.slice(0, 64))} is not a case; the cases are ${names.join(", ")}`);
      const arm = cases[input.tag];
      const r = readInput(arm, Object.hasOwn(input, "value") ? input.value : undefined, `${path}.${input.tag}`, param, ctx);
      if (r === undefined) return undefined;
      // candid-core's domain shape: a null-payload arm is a bare { tag }
      const bare = arm.candid === "null" && !arm.optional;
      return { value: bare ? { tag: input.tag } : { tag: input.tag, value: r.value }, identity: [input.tag, r.identity] };
    }
    case "vec": {
      if (!Array.isArray(input)) return issue("E_TYPE", `${path} must be a JSON array`);
      if (input.length > MAX_VEC_ITEMS) return issue(CODES.TOO_LONG, `${path} has ${input.length} elements; at most ${MAX_VEC_ITEMS} are read`);
      const value = [];
      const identity = [];
      let ok = true;
      for (const [i, element] of input.entries()) {
        const r = readInput(node.element, element, `${path}[${i}]`, param, ctx);
        if (r === undefined) ok = false;
        else (value.push(r.value), identity.push(r.identity));
      }
      return ok ? { value, identity } : undefined;
    }
    default:
      return issue("E_TYPE", `${path}: no rule for a ${node.candid} position`);
  }
}

/**
 * @param {object} plan  a plan from `buildToolPlans` (the tool)
 * @param {unknown} input  the tool call's arguments, without `canister_id`
 * @param {{ refs?: Record<string, unknown>, now?: bigint, names?: Record<string, { name: string, value: unknown, show?: unknown, kind?: unknown }[]> }} [context]
 *   the canister's dynamic tag values; its clock (ns), for relative times; the entries of each names set a `named`
 *   input may use (spec 5.3, D-045), read when the call is prepared
 * @returns {{ value: unknown, identity: [string, unknown][] } | { issues: { param: string, path: string, code: string, message: string }[] }}
 *   `value` is the method's single argument (undefined for a method without one; the argument tuple, an array, for a
 *   method with more than one; for a tool per case, the case `{ tag, value }` around its payload), with the stamp left null; `identity` is what the inputs add to the intent's
 *   identity. Issue codes are the format library's, plus E_INPUT (not an object), E_UNKNOWN_PARAM, E_MISSING and
 *   E_TYPE (an input that is not text, or JSON of the wrong shape for a record, variant or vec input), and for a
 *   `named` input E_NAMES_UNREAD (its set's names were not read), E_NAME_NOT_FOUND and E_NAME_AMBIGUOUS (several
 *   entries have the name: ask the person which). An issue inside a JSON input names its place in `path`
 *   (`$args[0].command.Follow.followees[1].id`).
 */
export function readToolInput(plan, input, { refs = {}, now, names = {} } = {}) {
  const object = input === undefined || input === null ? {} : input;
  if (typeof object !== "object" || Array.isArray(object)) {
    return { issues: [{ param: "", path: "$args", code: "E_INPUT", message: `the inputs must be an object with ${plan.params.map((p) => p.name).join(", ") || "no properties"}` }] };
  }
  const issues = [];
  const params = new Set(plan.params.map((p) => p.name));
  for (const key of Object.keys(object)) {
    if (!params.has(key)) issues.push({ param: key, path: "$args", code: "E_UNKNOWN_PARAM", message: `unknown input ${key}; the inputs are ${[...params].join(", ") || "none"}` });
  }
  // field-keyed maps never assign to a plain object: a field may be named `__proto__` (a valid Candid label)
  const values = new Map();
  const identity = [];
  for (const p of plan.params) {
    // own properties only: a field may be named `toString` or `constructor`, and omitting it must read as omitted
    const given = Object.hasOwn(object, p.name) ? object[p.name] : undefined;
    if (given === undefined || given === null) {
      if (p.optional) {
        values.set(p.name, null);
        identity.push([p.name, null]);
      } else issues.push({ param: p.name, path: p.path, code: "E_MISSING", message: `${p.name} is required` });
      continue;
    }
    if (readAs(p.node) && typeof given !== "string") {
      issues.push({ param: p.name, path: p.path, code: "E_TYPE", message: `${p.name} must be text, got ${Array.isArray(given) ? "an array" : typeof given}` });
      continue;
    }
    const r = readInput(p.node, given, p.path, p.name, { refs, now, names, issues, count: 0 });
    if (r === undefined) continue;
    values.set(p.name, r.value);
    identity.push([p.name, r.identity]);
  }
  if (issues.length > 0) return { issues };
  if (plan.argNodes?.length > 1) return { value: plan.fields.map((field) => (field.role === "param" ? values.get(field.name) : null)), identity };
  if (plan.argNode === undefined) return { value: undefined, identity };
  const value = plan.rootParam
    ? values.get(plan.params[0].name)
    : plan.rootNull
      ? null
      : Object.fromEntries(plan.fields.map((field) => [field.name, field.role === "param" ? values.get(field.name) : null]));
  if (plan.case === undefined) return { value, identity };
  // a tool per case (D-053): the payload goes into its case, a null payload as candid-core's bare { tag }; the case is
  // part of the intent, so two cases with the same inputs are two intents
  const bare = plan.caseNode.candid === "null" && plan.caseNode.optional !== true;
  return { value: bare ? { tag: plan.case } : { tag: plan.case, value }, identity: [[plan.case, identity]] };
}

/**
 * A `named` input (spec 5.3, D-045): text that is a value of the position is read as that value; other text is a name,
 * and the one entry of the set with that name gives the value, already the position's Candid value (`{ value }`).
 * A `text` position's values are the texts its pattern matches; without a pattern none is, so every text is looked up,
 * and text that names no entry is passed on as text (spec 5.3, W_NAMED_UNPATTERNED).
 */
function readName(f, named, entries, text, now) {
  const isValue = f.isValue ?? ((t) => f.safeParse(t, { now }).ok);
  // a value always wins (spec 5.3), so typed values never depend on the names list being read
  if (isValue(text)) return {};
  if (!Array.isArray(entries)) return { issue: { code: "E_NAMES_UNREAD", message: `the names of set ${named.set} were not read, so a name cannot be used here` } };
  const r = resolveName(entries, text, { isValue, by: named.by });
  if (r.error === "not_found") {
    if (f.tag === "text") return {};
    return { issue: { code: "E_NAME_NOT_FOUND", message: `"${text}" is not a value here, and no ${named.set} has that name` } };
  }
  if (r.error === "ambiguous") {
    const which = r.entries.map((e) => JSON.stringify(plain(named.by === "show" ? e.show : e.value))).join(", ");
    return { issue: { code: "E_NAME_AMBIGUOUS", message: `${r.entries.length} entries of ${named.set} are named "${text}" (${which}): ask the person which one` } };
  }
  return { value: r.value };
}

/** Set the stamp field of a prepared argument. */
export const withStamp = (plan, value, stamp) => (plan.idempotency ? { ...value, [plan.stampField]: stamp } : value);

/** The method's whole argument tuple, for `encode` and `call`: empty, the one argument, or the tuple `value` is. */
export const argTuple = (plan, value) => (plan.argNodes?.length > 1 ? value : plan.argNode === undefined ? [] : [value]);

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** A candid-core value as the format library takes it. */
function forFormat(f, value) {
  if (f.tag === "amount" || f.tag === "timestamp" || f.tag === "duration") return typeof value === "number" ? BigInt(value) : value;
  return value;
}

/**
 * A candid-core value as JSON-safe data for a model and a person: a value-tagged position becomes `{ text, raw }`
 * (`text` from the format library, `raw` the base units, ns or hex), bigints become decimal strings, blobs hex.
 * A value the profile cannot display (a missing ref, a value out of range) keeps its raw form and says why.
 */
export function displayValue(node, value, refs = {}, names = {}) {
  if (value === null || value === undefined) return null;
  const named = node?.tags?.named?.args;
  const entries = named ? names[named.set] : undefined;
  if (Array.isArray(entries)) {
    // the name of the one entry this value belongs to, beside the value (spec 5.3: the value is always shown)
    const shown = displayValue({ ...node, tags: { ...node.tags, named: undefined } }, value, refs);
    const owner = ownerOf(entries, value, { by: named.by }); // compared as Candid values: an account by owner and subaccount
    return owner ? { ...(shown !== null && typeof shown === "object" ? shown : { raw: shown }), name: owner.name } : shown;
  }
  if (node === undefined) return plain(value);
  let f = null;
  try {
    f = formatterFor(node, { refs });
  } catch (e) {
    return { raw: plain(value), error: e.message };
  }
  if (f !== null) {
    const r = f.safeDisplay(forFormat(f, value));
    const bytes = asUint8Array(value); // from any realm
    const raw = bytes !== null ? hex(bytes) : f.tag === "account" ? { owner: value.owner, subaccount: value.subaccount ? hex(value.subaccount) : null } : plain(value);
    return r.ok ? { text: r.value, raw } : { raw, error: r.error.message };
  }
  switch (node.candid) {
    case "record": {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayValue(node.fields?.[k], v, refs, names)]));
    }
    case "variant":
      return { tag: value.tag, value: displayValue(node.cases?.[value.tag], value.value, refs, names) };
    case "vec":
      return Array.isArray(value) ? value.map((v) => displayValue(node.element, v, refs, names)) : plain(value);
    default:
      return plain(value);
  }
}

/** A prepared argument as `displayValue` shows it; for a method with more than one argument, each in turn. */
export function displayArguments(plan, value, refs = {}, names = {}) {
  if (plan.argNodes?.length > 1) return plan.argNodes.map((node, i) => displayValue(node, value[i], refs, names));
  return displayValue(plan.argNode, value, refs, names);
}

function plain(value) {
  if (typeof value === "bigint") return value.toString();
  const bytes = asUint8Array(value); // from any realm
  if (bytes !== null) return hex(bytes);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}
