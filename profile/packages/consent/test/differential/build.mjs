// The differential corpus of the Rust port (rust/tests/differential.rs): many payloads, generated from a seeded
// generator, with what this package answers for each. Pure: scripts/generate-golden.mjs writes the corpus,
// test/differential.test.mjs checks that it is in step, and the Rust test checks that the crate answers the same.
//
// Sources (resolved forms, stored in the corpus so the Rust test needs no resolver):
//   wide     test/fixtures/wide.did with its author profile: every Candid type the resolved form carries, every value tag
//   bare     the same interface with no profile: every method takes the generic intent
//   mangled  the wide form with hand-made faults a resolver would not write (broken templates, two value tags at one
//            position, a recursive cut, a func position, odd profile entries): both versions must fail the same way
//
// Payloads: values generated from the resolved form's types, encoded by @dfinity/didc (the Rust candid crates
// compiled to wasm, independent of the codec this package decodes with); then hostile variants of them: truncated,
// one byte changed, junk appended, another method's payload, and untyped encodings that test Candid's subtyping.

import { readFileSync } from "node:fs";
import { encode } from "@dfinity/didc";
import { createSchemaValidator, resolveService } from "@meantjs/profile";
import { generateConsent } from "../../src/index.mjs";
import { snsValidatorRendering } from "../../src/sns.mjs";
import { ConsentError } from "../../src/errors.mjs";
import { ALICE, BOB, SPENDER, hexOf } from "../helpers.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
export const WIDE_DID = read("../fixtures/wide.did");
const WIDE_PROFILE = JSON.parse(read("../fixtures/wide.profile.json"));

const validateSchema = await createSchemaValidator();
async function resolve(profiles) {
  const r = await resolveService({ did: WIDE_DID, validateSchema, profiles, packs: [] });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
  return r.resolved;
}
const wide = await resolve([{ doc: WIDE_PROFILE }]);
const bare = await resolve([]);

/** Faults a resolver would not write, each named; both versions must answer them alike. */
function mangle(form) {
  const r = structuredClone(form);
  const m = r.methods;
  const describe = (label) => ({ args: { label }, origin: "author", profile: "wide-example" });
  m.echo.tags.intent.args.template = "Say {(0)"; // unclosed placeholder: E_TEMPLATE, generic fallback
  m.echo.tags.effect = { args: { kind: "write" }, origin: "default" }; // a default effect is said to be one
  m.stamp.tags.intent.args.template = "Stamp {(3)}[ and {(9)}]"; // no such argument: E_TEMPLATE_PATH, fallback
  m.numbered.tags.intent.args.title = " \n "; // blank title: the method's label instead
  m.numbered.tags.describe = describe("Number\nthings_now *x* <b>");
  m.sub.args[0].tags.amount = { args: { decimals: 2 }, origin: "author" }; // two value tags at one position: E_TAG_CONFLICT
  m.peek.tags = { effect: { args: { kind: 5 }, origin: "author" } }; // a kind that is not text
  m.schedule.tags.effect = null; // an exception in JavaScript: E_INTERNAL
  // cuts the decoder cannot type: E_UNSUPPORTED_TYPE when the value reaches one, a message when it does not (CUTS)
  m.tag_items.args[1].cases.Named.recursive = true; // a variant case
  m.tag_items.args[0].element.fields.flags.element.recursive = true; // a vec element
  m.numbered.args[0].fields["#7"].recursive = true; // an opt
  m.grid.args[0] = { candid: "func" }; // E_UNSUPPORTED_TYPE
  m.pay.args[0].fields.amount.tags.amount.args = { symbol: "X" }; // no decimals: E_ARG
  m.ordered.args[0].fields.alpha.tags = { timestamp: { args: { unit: "minutes" }, origin: "author" } }; // bad unit: E_ARG
  m.set_keys.args[2].tags.bytes.args.encoding = { from: "now" }; // E_ARG
  m.tune.args[0].tags = { describe: describe("   ") }; // a blank label: the generated one instead
  m.tune.args[1].tags = { describe: describe("x\u202e\ny_z") };
  m.tune.args[2].tags = { describe: describe("a|b~c&d_e \u{1d400}_x _y_ 2_3 \u00fc_\u00f6") }; // Markdown punctuation in profile text
  m.tune.args[3].tags = { describe: describe("\u2028") }; // one line, then blank: the field path instead
  m.tune.args[4].tags = { describe: describe("\u0085") }; // not blank to JavaScript's trim, blank once on one line
  m.stamp.tags.intent.args.title = "\ufeff"; // blank to JavaScript's trim: the generic title instead
  // a tagged case beside the tagged cases of choice, which one call can hold both of (E_CASE_OVERLAP): the method's
  // intent then, and this one's when the call holds no other
  m.vote.args[0].fields.scope.cases.All.tags = { intent: { args: { title: "Side by side" }, origin: "author", profile: "wide-example" } };
  m.vote.args[0].fields.choice.cases.Other.tags = { intent: null, effect: [] }; // not an entry: no case tag
  r.profiles = [{ name: 42, origin: "pack\n## evil", profile_id: 7 }, null, "x", { name: null, origin: ["a", null, 1.5] }];
  delete r.interface_id;
  return r;
}

export const SOURCES = { wide, bare, mangled: mangle(wide) };

// ------------------------------------------------------------------------------------------------ generation

/** mulberry32: a small seeded generator, so the corpus is the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRINCIPALS = [ALICE, BOB, SPENDER, "aaaaa-aa", "2vxsx-fae", "rrkah-fqaaa-aaaaa-aaaaq-cai"];
const TEXT_PIECES = ["a", "Grant", " ", "é", "😀", "\n", "\t", "\\", '"', "`", "``", "*", "_", "[x](y)", "<b>", "#", "1.", "- ", "\u202e", "\u200b", "\u0085", "\ufeff", "\u2028", "0x", "&amp;", "~~", "|"];
const BIG = ["0", "1", "7", "150000000", "123456789012345678", "18446744073709551615", "18446744073709551616", "340282366920938463463374607431768211456"];
const INT_BOUNDS = {
  nat8: [0n, 255n],
  nat16: [0n, 65535n],
  nat32: [0n, 4294967295n],
  nat64: [0n, 18446744073709551615n],
  int8: [-128n, 127n],
  int16: [-32768n, 32767n],
  int32: [-2147483648n, 2147483647n],
  int64: [-9223372036854775808n, 9223372036854775807n],
};
const F32 = ["0.0", "-0.0", "1.5", "0.1", "16777217.0", "3.4028234663852886e38", "1.401298464324817e-45", "-2.5e-10"];
const F64 = ["0.0", "-0.0", "1.5", "0.1", "1e+21", "1e-7", "123456789.125", "5e-324", "1.7976931348623157e308", "-3.14"];
/** Unix seconds: 2026-10-09T12:00:00Z, the epoch, the last second of 9999, and a little before year 0. */
const SECONDS = [1_791_547_200n, 0n, 253_402_300_799n, 1n];

const hasTag = (node, t) => node.tags !== undefined && Object.hasOwn(node.tags, t);
const label = (key) => (key.startsWith("#") ? key.slice(1) : key);

function textLiteral(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return `"${out}"`;
}
const blobLiteral = (bytes) => `blob "${[...bytes].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;

class Gen {
  constructor(seed) {
    this.r = rng(seed);
  }
  pick(xs) {
    return xs[Math.floor(this.r() * xs.length)];
  }
  int(n) {
    return Math.floor(this.r() * n);
  }
  chance(p) {
    return this.r() < p;
  }
  digits(max) {
    let s = String(1 + this.int(9));
    const n = this.int(max);
    for (let i = 0; i < n; i++) s += String(this.int(10));
    return s;
  }
  text() {
    const n = this.int(6);
    let s = "";
    for (let i = 0; i < n; i++) s += this.pick(TEXT_PIECES);
    return s;
  }
  bytes(n) {
    return Uint8Array.from({ length: n }, () => this.int(256));
  }
  time(node) {
    const unit = node.tags.timestamp.args.unit;
    const per = { ns: 1_000_000_000n, us: 1_000_000n, ms: 1_000n, s: 1n }[unit];
    let v = this.pick(SECONDS) * per + (this.chance(0.3) ? BigInt(this.int(1000)) : 0n);
    if (node.candid.startsWith("int") && this.chance(0.4)) v = -v - (this.chance(0.5) ? 62_167_219_200n * per : 0n);
    return this.clamp(node.candid, v);
  }
  clamp(candid, v) {
    const b = INT_BOUNDS[candid];
    if (b === undefined) return candid === "nat" && v < 0n ? -v : v;
    return v < b[0] ? b[0] : v > b[1] ? b[1] : v;
  }
  duration(node) {
    const per = { ns: 1_000_000_000n, us: 1_000_000n, ms: 1_000n, s: 1n }[node.tags.duration.args.unit];
    let v = this.chance(0.3) ? BigInt(this.digits(12)) : this.pick([0n, 1n, 60n, 3600n, 5400n, 86_400n, 604_800n, 90_061n]) * per + (this.chance(0.2) ? 1n : 0n);
    if (node.candid.startsWith("int") && this.chance(0.4)) v = -v;
    return this.clamp(node.candid, v);
  }
  integer(node) {
    if (hasTag(node, "timestamp")) return String(this.time(node));
    if (hasTag(node, "duration")) return String(this.duration(node));
    const candid = node.candid;
    let v;
    if (this.chance(0.4)) v = BigInt(this.pick(BIG));
    else if (this.chance(0.05)) v = BigInt(this.digits(1100));
    else v = BigInt(this.digits(30));
    if (candid.startsWith("int") && this.chance(0.4)) v = -v;
    const b = INT_BOUNDS[candid];
    if (b !== undefined && (v < b[0] || v > b[1])) v = this.pick([b[0], b[1], (b[0] + b[1]) / 2n, 0n]);
    return String(v);
  }
  blob(node, subaccount = false) {
    if (subaccount || hasTag(node, "subaccount") || this.chance(0.2)) {
      const kind = this.int(6);
      if (kind === 0) return new Uint8Array(32);
      if (kind === 1) return Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 + this.int(255) : 0));
      if (kind === 2) return this.bytes(32);
      if (kind === 3) return Uint8Array.from({ length: 32 }, (_, i) => (i >= 24 ? this.int(256) : 0));
      if (kind === 4) return Uint8Array.from({ length: 32 }, (_, i) => (i >= 16 ? 1 + this.int(255) : 0)); // not a #n
      return this.bytes(this.int(40));
    }
    const kind = this.int(4);
    if (kind === 0) return Buffer.from(this.text(), "utf8");
    if (kind === 1) return Buffer.from(`0x${this.text()}`, "utf8");
    return this.bytes(this.int(24));
  }
  /** Candid text of one value for a resolved-form position. */
  value(node, depth = 0, subaccount = false) {
    if (node.optional === true && this.chance(0.35)) return "null";
    const inner = subaccount && node.candid === "blob" ? blobLiteral(this.blob(node, true)) : this.inner(node, depth);
    return node.optional === true ? `opt ${inner}` : inner;
  }
  inner(node, depth) {
    const c = node.candid;
    if (c in INT_BOUNDS || c === "nat" || c === "int") return this.integer(node);
    switch (c) {
      case "float32":
        return this.pick(F32);
      case "float64":
        return this.pick(F64);
      case "bool":
        return this.chance(0.5) ? "true" : "false";
      case "null":
      case "reserved":
        return "null";
      case "text":
        return textLiteral(this.text());
      case "principal":
        return `principal "${this.pick(PRINCIPALS)}"`;
      case "blob":
        return blobLiteral(this.blob(node));
      case "vec": {
        const n = this.chance(0.2) ? 0 : 1 + this.int(3);
        return `vec { ${Array.from({ length: n }, () => this.value(node.element, depth + 1)).join("; ")} }`;
      }
      case "record":
        // the subaccount of an account is 32 bytes mostly, as a ledger's are
        return `record { ${Object.entries(node.fields).map(([k, v]) => `${label(k)} = ${this.value(v, depth + 1, hasTag(node, "account") && k === "subaccount")}`).join("; ")} }`;
      case "variant": {
        const [k, v] = this.pick(Object.entries(node.cases));
        return v.candid === "null" && v.optional !== true ? `variant { ${label(k)} }` : `variant { ${label(k)} = ${this.value(v, depth + 1)} }`;
      }
      default:
        throw new Error(`no generator for ${c}`);
    }
  }
}

const METHODS = Object.keys(wide.methods).filter((m) => m !== "decimals" && m !== "symbol");

const encodeTyped = (method, text) => Uint8Array.from(Buffer.from(encode({ idl: WIDE_DID, input: text, targetFormat: "hex", withType: { kind: "methodParams", name: method } }), "hex"));
const encodeUntyped = (text) => Uint8Array.from(Buffer.from(encode({ idl: WIDE_DID, input: text, targetFormat: "hex" }), "hex"));

/** Untyped encodings: the wire types differ from the method's, so Candid's subtyping decides. */
const UNTYPED = [
  ["pay", `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 5 : nat; extra = "x" })`], // extra field, missing opt fields
  ["pay", `(record { to = record { owner = principal "${ALICE}" }; amount = 5 : int })`], // int is not nat
  ["peek", `(5 : nat, "ignored")`], // an extra argument
  ["grid", `(vec { vec { "a" } })`], // a missing optional argument
  ["echo", `(opt "x")`], // opt text is not text
  ["sub", `(vec { 1 : nat8; 2 : nat8 })`], // vec nat8 is a blob
  ["stamp", `(5 : nat, 6 : nat32, 7 : int64)`], // nat <: int
  ["numbered", `(record { 0 = "a"; 1 = 2 : nat; 7 = opt principal "${BOB}"; 9 = true })`], // an extra field
];

/** The limits of a message: list elements, the character budget (UTF-16 code units, counted as JavaScript does). */
const LIMITS = [
  ["tag_items", `(vec { ${Array(300).fill("record { id = 1; flags = vec {}; note = null }").join("; ")} }, variant { Small })`], // 300 values for one placeholder
  ["grid", `(vec { ${Array(300).fill("vec {}").join("; ")} }, null)`], // 300 list elements in one field
  ["echo", `(${textLiteral("a".repeat(10_500))})`], // fits: the value is charged three times, the whole text is under the budget
  ["echo", `(${textLiteral("a".repeat(10_800))})`], // the values fit the budget, the whole text does not
  ["echo", `(${textLiteral("\u{1f600}".repeat(5_500))})`], // 11,000 UTF-16 code units, 5,500 characters
];

/** Spec section 12 rule 12 on the mangled form's cuts: the code each payload gets (`Ok` when its value avoids every cut). */
export const CUTS = [
  ["tag_items", `(vec {}, variant { Named = record { label = "a"; weight = 1.5 } })`, "E_UNSUPPORTED_TYPE"],
  ["tag_items", `(vec { record { id = 1; flags = vec { true }; note = null } }, variant { Small })`, "E_UNSUPPORTED_TYPE"],
  ["tag_items", `(vec { record { id = 1; flags = vec {}; note = opt "n" } }, variant { Large = 7 })`, "Ok"],
  ["numbered", `(record { 0 = "a"; 1 = 2; 7 = opt principal "${BOB}" })`, "E_UNSUPPORTED_TYPE"],
  ["numbered", `(record { 0 = "a"; 1 = 2; 7 = null })`, "Ok"],
];

/**
 * The intent and effect a call takes from the cases its value holds (spec sections 5.2 and 12, D-053): each payload of
 * `vote`, with the title and effect the wide form gives it and the title the mangled form gives it.
 */
export const CASE_CALLS = [
  [`(record { id = 1; choice = variant { Transfer = record { to = principal "${ALICE}"; amount = 150 } }; scope = null; note = opt "n" })`, "Vote to send", "transfer, irreversible", "Vote to send"],
  [`(record { id = 2; choice = variant { Pause }; scope = opt variant { All }; note = null })`, "Vote to pause", "admin, reversible", "Vote"], // two tagged cases side by side: the method's
  [`(record { id = 3; choice = variant { Nested = variant { Up = 7 } }; scope = null; note = null })`, "Vote up", "write, reversible", "Vote up"], // the deepest intent, the effect above it
  [`(record { id = 4; choice = variant { Nested = variant { Down = 7 } }; scope = null; note = null })`, "Vote either way", "write, reversible", "Vote either way"],
  [`(record { id = 5; choice = variant { Other = "x" }; scope = opt variant { All }; note = opt "n" })`, "Vote", "transfer, irreversible", "Side by side"], // an untagged case: the method's
];

/** Each way a caller can get the refs of `pay`'s dynamic amount wrong (or right in an unusual form). */
const ODD_REFS = [
  {},
  { "query:decimals": 8 },
  { "query:decimals": "8", "query:symbol": "S" },
  { "query:decimals": "08", "query:symbol": "S" },
  { "query:decimals": 8.5, "query:symbol": "S" },
  { "query:decimals": -1, "query:symbol": "S" },
  { "query:decimals": 8, "query:symbol": null },
  { "query:decimals": 8, "query:symbol": 5 },
  { "query:decimals": 8, "query:symbol": " X" },
  { "query:decimals": 8, "query:symbol": "\u202eX" },
];

/** Sound refs for the dynamic amount of `pay`, with assorted decimals and symbols. */
const refsFor = (g) => ({ "query:decimals": g.pick([0, 2, 8, 18, 255]), "query:symbol": g.pick(["TKA", "\u00dcNI", "a b", "`x`", "\u{1f600}", "*B*"]) });

function answer(fn) {
  try {
    return fn();
  } catch (e) {
    return { Err: e instanceof ConsentError ? e.code : "E_INTERNAL" };
  }
}

function vector(source, method, payload, refs, g) {
  const resolved = SOURCES[source];
  const offset = g.chance(0.5) ? null : g.pick([0, 120, -330, 840, -720, 59]);
  const raw = g.chance(0.3);
  const sns = snsValidatorRendering({ payload, resolved, method, refs });
  const generic = answer(() => {
    const r = generateConsent({ resolved, method, arg: payload, refs, form: "generic", utcOffsetMinutes: offset, rawArguments: raw });
    return { Ok: r.message.GenericDisplayMessage, zone_sensitive: r.zoneSensitive };
  });
  return { source, method, refs, utc_offset_minutes: offset, raw_arguments: raw, payload_hex: hexOf(payload), sns: { ...sns }, generic };
}

/** The whole corpus. Deterministic: the same seed gives the same vectors. */
export function buildCorpus() {
  const vectors = [];
  METHODS.forEach((method, mi) => {
    const g = new Gen(20261012 + mi * 7919);
    const valid = [];
    for (const [source, n] of [["wide", 6], ["bare", 2], ["mangled", 2]]) {
      for (let i = 0; i < n; i++) {
        const args = wide.methods[method].args; // the tags steer the values (times, subaccounts); the types are the same
        const payload = encodeTyped(method, `(${args.map((a) => g.value(a)).join(", ")})`);
        valid.push(payload);
        vectors.push(vector(source, method, payload, refsFor(g), g));
      }
    }
    const base = g.pick(valid);
    const flipped = Uint8Array.from(base);
    flipped[g.int(flipped.length)] ^= 1 + g.int(255);
    const hostile = [
      base.slice(0, g.int(base.length)),
      flipped,
      Uint8Array.from([...base, ...g.bytes(1 + g.int(3))]),
      Uint8Array.from(Buffer.from("4449444c0000", "hex")),
    ];
    for (const payload of hostile) vectors.push(vector("wide", method, payload, refsFor(g), g));
    const other = METHODS[(mi + 1) % METHODS.length];
    const args = wide.methods[other].args;
    vectors.push(vector("wide", method, encodeTyped(other, `(${args.map((a) => g.value(a)).join(", ")})`), refsFor(g), g));
  });
  UNTYPED.forEach(([method, text], i) => vectors.push(vector("wide", method, encodeUntyped(text), refsFor(new Gen(i)), new Gen(100 + i))));
  LIMITS.forEach(([method, text], i) => vectors.push(vector("wide", method, encodeTyped(method, text), {}, new Gen(200 + i))));
  for (const source of ["wide", "mangled"]) CASE_CALLS.forEach(([text], i) => vectors.push(vector(source, "vote", encodeTyped("vote", text), {}, new Gen(400 + i))));
  CUTS.forEach(([method, text], i) => vectors.push(vector("mangled", method, encodeTyped(method, text), {}, new Gen(300 + i))));
  const g = new Gen(7);
  const payment = encodeTyped("pay", `(${wide.methods.pay.args.map((a) => g.value(a)).join(", ")})`);
  for (const refs of ODD_REFS) vectors.push(vector("wide", "pay", payment, refs, g));
  return { sources: SOURCES, vectors };
}

/** One vector per line, so a change shows as a change of the vectors it touches. */
export function corpusJson(corpus = buildCorpus()) {
  const lines = corpus.vectors.map((v) => `    ${JSON.stringify(v)}`);
  return `{\n  "sources": ${JSON.stringify(corpus.sources)},\n  "vectors": [\n${lines.join(",\n")}\n  ]\n}\n`;
}
