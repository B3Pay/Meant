// Step 1: Candid argument bytes -> a value tree aligned with the resolved form's positions.
//
// Codec: @candid-core/schema 0.5.0 `decodeArgs` (schema-directed, with the Candid coercion relation and explicit
// resource budgets). The expected schema is built from the method's resolved-form tree, so the decoder never
// trusts the types the bytes claim: an argument is read as the signature says or the call is refused.
//
// Value tree (lossless; the same shape at every position of the resolved form):
//   nat, int, nat8..nat64, int8..int64   decimal string       (D-006: never a JavaScript number)
//   float32, float64                     number
//   bool, text                           boolean, string
//   null, reserved                       null
//   principal                            canonical text
//   blob (vec nat8)                      Uint8Array
//   opt T                                null when absent, else the value of T
//   record                               plain object keyed exactly like the resolved form's `fields`
//   variant                              { tag: <key of the resolved form's `cases`>, value }   (value null for a bare tag)
//   vec T                                array
//
// Limits of the resolved form, refused (E_UNSUPPORTED_TYPE) rather than guessed:
//   - a value that reaches a position with `recursive: true` (the resolver cut a cycle or a depth of 8 there; the type
//     below is unknown). The position is decoded as `reserved`, which every Candid type is a subtype of, so the bytes
//     there are skipped without trusting their type; a call whose value lies there (the case is chosen, the `opt` is
//     present, the field exists, the `vec` has an element) is refused when the value tree is built. A call whose value
//     never goes there gets its message (spec section 12, rule 12; D-042);
//   - `func` and `service` positions anywhere in the method (the resolved form does not carry their signatures);
//   - nested `opt` (`opt opt T` collapses to one `optional` flag in the resolved form).

import { c } from "@candid-core/schema";
import { decodeArgs } from "@candid-core/schema/codec";
import { bytesOf } from "./bytes.mjs";
import { CODES, fail } from "./errors.mjs";
import { entriesOf } from "./resolved.mjs";

/** A consent message is for one ingress message at most (IC limit: 2 MiB). */
export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxElements: 100_000 });

const INTEGERS = new Set(["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"]);
const FLOATS = new Set(["float32", "float64"]);
const PRIMITIVES = new Set(["null", "bool", "text", "principal", "reserved", "empty", ...INTEGERS, ...FLOATS]);
const MAX_NODE_DEPTH = 64;

/** The codec's name for a resolved-form key: `#123` has no name, so the codec's `_123_` convention carries the id. */
const codecName = (key) => (/^#(0|[1-9][0-9]{0,9})$/.test(key) ? `_${key.slice(1)}_` : key);

const NO_OPT_BOX = new Set(["null", "reserved"]); // `opt null` and `opt reserved` are boxed by the codec

/** Build the codec schema for one position of the resolved form. */
export function schemaFor(node, where = "argument", depth = 0) {
  if (node === null || typeof node !== "object" || typeof node.candid !== "string") {
    fail(CODES.RESOLVED_FORM, `${where}: not a resolved-form position`);
  }
  if (depth > MAX_NODE_DEPTH) fail(CODES.UNSUPPORTED_TYPE, `${where}: nested deeper than ${MAX_NODE_DEPTH}`);
  const inner = node.recursive === true ? c.reserved : innerSchema(node, where, depth);
  return node.optional === true ? c.opt(inner) : inner;
}

function innerSchema(node, where, depth) {
  const kind = node.candid;
  if (PRIMITIVES.has(kind)) return c[kind];
  switch (kind) {
    case "blob":
      return c.blob();
    case "vec": {
      if (node.element === undefined) fail(CODES.UNSUPPORTED_TYPE, `${where}: vec without an element type`);
      return c.vec(schemaFor(node.element, `${where}[]`, depth + 1));
    }
    case "record": {
      const fields = Object.create(null);
      for (const [key, child] of entriesOf(node.fields)) fields[codecName(key)] = schemaFor(child, `${where}.${key}`, depth + 1);
      return c.record(fields);
    }
    case "variant": {
      const arms = Object.create(null);
      for (const [key, child] of entriesOf(node.cases)) arms[codecName(key)] = schemaFor(child, `${where}.${key}`, depth + 1);
      return c.variant(arms);
    }
    default:
      fail(CODES.UNSUPPORTED_TYPE, `${where}: ${kind} positions cannot be decoded (the resolved form carries no signature for them)`);
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Own enumerable property, also for a key like "__proto__" (assignment would set the prototype instead). */
export function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Codec value -> value tree. `node` is the resolved-form position the schema was built from. */
export function toTree(node, v, where = "argument") {
  if (node.recursive === true) {
    if (node.optional === true && v === null) return null;
    fail(CODES.UNSUPPORTED_TYPE, `${where}: the resolved form cuts this ${node.candid} at a cycle (recursive: true), so its type below is unknown`);
  }
  if (node.optional === true) {
    if (v === null) return null;
    if (NO_OPT_BOX.has(node.candid)) v = v.some; // boxed opt null / opt reserved
  }
  const kind = node.candid;
  if (INTEGERS.has(kind)) return String(v);
  if (FLOATS.has(kind) || kind === "bool" || kind === "text" || kind === "principal" || kind === "blob") return v;
  if (kind === "null" || kind === "reserved") return null;
  if (kind === "vec") return v.map((e, i) => toTree(node.element, e, `${where}[${i}]`));
  if (kind === "record") {
    const out = {};
    for (const [key, child] of entriesOf(node.fields)) setOwn(out, key, toTree(child, v[codecName(key)], `${where}.${key}`));
    return out;
  }
  if (kind === "variant") {
    const cases = entriesOf(node.cases);
    const hit = cases.find(([key]) => codecName(key) === v.tag);
    if (hit === undefined) fail(CODES.DECODE, `${where}: the decoder returned the case ${JSON.stringify(v.tag)}, which the resolved form lacks`);
    return { tag: hit[0], value: hasOwn(v, "value") ? toTree(hit[1], v.value, `${where}.${hit[0]}`) : null };
  }
  fail(CODES.UNSUPPORTED_TYPE, `${where}: cannot convert ${kind}`);
}

/**
 * Decode the Candid-encoded argument tuple of a call against a resolved-form method.
 *
 * @param {{ args: object[] }} method  an entry of `resolved.methods`
 * @param {Uint8Array | ArrayBuffer | number[]} arg  the bytes of the call's argument (the `arg` of the ICRC-21 request)
 * @param {{ maxBytes?: number, maxDepth?: number, maxElements?: number }} [limits]
 * @returns {unknown[]} one value tree per argument, in order
 * @throws {ConsentError} E_DECODE, E_TOO_LARGE, E_UNSUPPORTED_TYPE, E_RESOLVED_FORM
 */
export function decodeArguments(method, arg, limits = {}) {
  const bytes = bytesOf(arg);
  if (bytes === null) fail(CODES.DECODE, "the argument is not bytes: a Uint8Array, an ArrayBuffer or an array of integers 0 to 255");
  const opts = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length > opts.maxBytes) fail(CODES.TOO_LARGE, `the argument is ${bytes.length} bytes; the limit for a consent message is ${opts.maxBytes}`);
  const schemas = method.args.map((node, i) => schemaFor(node, `argument ${i}`));
  const r = decodeArgs(schemas, bytes, opts);
  if (!r.ok) {
    const first = r.issues[0];
    const code = first.code === "resource_limit_exceeded" ? CODES.TOO_LARGE : CODES.DECODE;
    fail(code, `the argument bytes do not decode as the method's signature: ${first.code} at ${first.path}: ${first.message}`);
  }
  return r.values.map((v, i) => toTree(method.args[i], v, `argument ${i}`));
}
