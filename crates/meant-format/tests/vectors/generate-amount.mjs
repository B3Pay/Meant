// Generates amount.json: the answers of the JavaScript reference implementation
// (@candid-core/profile-format, in the candid-profile repository) for a fixed,
// seeded set of inputs. tests/parity.rs requires the meant-format crate to give the
// same answer for every case: the same value, or the same error code and
// message.
//
//   node crates/meant-format/tests/vectors/generate-amount.mjs <path to a candid-profile checkout>
//
// Run it from the repository root. It writes crates/meant-format/tests/vectors/amount.json
// and records the candid-profile commit, the package version, and the Node and
// Unicode versions it ran on. The cases are a pure function of SEED, so the
// output changes only when the reference's answers (or this script) change.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEED = 20261027;
const OUT = "crates/meant-format/tests/vectors/amount.json";

const profileRoot = process.argv[2];
if (!profileRoot) {
  console.error("usage: node crates/meant-format/tests/vectors/generate-amount.mjs <candid-profile checkout>");
  process.exit(64);
}
const formatDir = resolve(profileRoot, "packages/format");
const { parseAmount, displayAmount } = await import(
  pathToFileURL(join(formatDir, "src/index.mjs")).href
);
const pkg = JSON.parse(readFileSync(join(formatDir, "package.json"), "utf8"));
const commit = execFileSync("git", ["-C", profileRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

// mulberry32: small, seedable, and the same on every Node.
let state = SEED >>> 0;
function next() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(next() * n);
const pick = (xs) => xs[int(xs.length)];
const digits = (n) => Array.from({ length: n }, () => String(int(10))).join("");

const TYPES = ["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"];
const SYMBOLS = [null, "ICP", "ckBTC", "1INCH", "TKA", "USDC", "Ξ ETH", "x"];
const DECIMALS = [0, 1, 2, 6, 8, 9, 18, 30, 255];
// JavaScript whitespace, and look-alikes that are not: U+0085, U+200B, U+180E.
const SPACES = [" ", "\t", "\n", "\u000b", " ", " ", " ", " ", " ", "　", "﻿", "\u0085", "​", "᠎"];
// Symbols as a person or an attacker might type them: case changes, a Kelvin
// sign, a Cyrillic I and C, a fullwidth letter.
const TYPED_SYMBOLS = ["ICP", "icp", "IcP", "ckbtc", "CKBTC", "Kelvin", "ІCP", "СKBTC", "1inch", "usdc", "ＵSDC", "Ξ eth", "Ξ  ETH", "X", "TKAA", "TK"];
const BOUNDS = [
  "0", "-0", "-1", "127", "128", "-128", "-129", "255", "256", "32767", "32768", "-32768", "-32769",
  "65535", "65536", "2147483647", "2147483648", "-2147483648", "-2147483649", "4294967295",
  "4294967296", "9223372036854775807", "9223372036854775808", "-9223372036854775808",
  "-9223372036854775809", "18446744073709551615", "18446744073709551616",
];

function answer(fn) {
  try {
    return { ok: fn() };
  } catch (e) {
    if (typeof e?.code !== "string") throw e;
    return { err: e.code, msg: e.message };
  }
}
const opts = (d, sym, candid) => ({ decimals: d, symbol: sym ?? undefined, candid });
const parseCase = (input, d, sym, candid) => ({
  in: input, d, sym, candid, ...answer(() => parseAmount(input, opts(d, sym, candid))),
});
const displayCase = (value, d, sym, candid) => ({
  in: value, d, sym, candid, ...answer(() => displayAmount(value, opts(d, sym, candid))),
});

const parse = [];
const display = [];

// The JavaScript package's own unit-test inputs.
const CURATED = [
  "1.5", "1.5 ICP", "1 icp", "0.5", "0.00000001", "007.5", "  2  ", "1.5\tICP", "0", "12",
  "0.12345678", "0.123456789", "0.123456780", "1.000000000", "-1", "-0", "-1.25",
  "", " ", "abc", "1,5", "1,000.5", "1_000", "1.", ".5", "1e3", "+1", "--1", "1.2.3", "1 .5",
  "０１", "1٫5", "0x10", "ICP 1", "1ICP", "NaN", "Infinity", "1 TKAA", "1 TK", "1 tka",
  "15 1INCH", "1 ckbtc", "1 CKBTC", "1 Kelvin", "184467440737.09551615",
  "184467440737.09551616", "1.000000000000000001", "18.446744073709551615",
];
for (const input of CURATED) {
  for (const [d, sym, candid] of [[8, "ICP", "nat"], [8, "TKA", "int"], [0, null, "nat"], [18, "ckETH", "nat"], [8, "ICP", "nat64"]]) {
    parse.push(parseCase(input, d, sym, candid));
  }
}
for (const sp of SPACES) {
  parse.push(parseCase(`${sp}1.5${sp}ICP${sp}`, 8, "ICP", "nat"));
  parse.push(parseCase(`1.5${sp}ICP`, 8, "ICP", "nat"));
  parse.push(parseCase(`${sp}2`, 0, null, "nat"));
}
for (const v of BOUNDS) {
  for (const candid of TYPES) {
    parse.push(parseCase(v, 0, null, candid));
    display.push(displayCase(v, 0, null, candid));
  }
  for (const candid of ["nat8", "int8", "nat64", "int64"]) {
    parse.push(parseCase(`${v}.5`, 1, null, candid));
  }
}
// The length bound counts UTF-16 code units: exactly at it, and one over.
const emoji = "\u{1F600}";
for (const input of ["1".repeat(1024), "1".repeat(1025), " ".repeat(1021) + "1.5", emoji.repeat(512), emoji.repeat(512) + " "]) {
  parse.push(parseCase(input, 0, null, "nat"));
}
for (const value of ["1".repeat(1024), "1".repeat(1025), emoji.repeat(512), emoji.repeat(513)]) {
  display.push(displayCase(value, 0, null, "nat"));
}
// decimals 255, and 18-decimal values past 2^64.
for (const v of ["1" + "0".repeat(254) + "1", "123456789012345678901234567890123456789", "18446744073709551616"]) {
  for (const d of [18, 255]) {
    display.push(displayCase(v, d, "Z", "nat"));
    parse.push(parseCase(displayAmount(v, { decimals: d, symbol: "Z" }), d, "Z", "nat"));
  }
}

// Seeded structured inputs: sign, whole, fraction, separator, symbol, spacing.
for (let i = 0; i < 700; i++) {
  const d = pick(DECIMALS);
  const sym = pick(SYMBOLS);
  const candid = next() < 0.5 ? "nat" : pick(TYPES);
  const sign = pick(["", "", "", "", "", "-", "+", "--"]);
  const whole = next() < 0.05 ? "" : digits(1 + int(next() < 0.8 ? 6 : 40));
  const fracLen = int(Math.min(d, 40) + 3);
  const frac = next() < 0.4 ? "" : "." + (next() < 0.1 ? "0".repeat(fracLen) : digits(fracLen));
  const typed = next() < 0.5 ? "" : pick(SPACES.slice(0, next() < 0.8 ? 1 : SPACES.length)) + pick(next() < 0.6 && sym ? [sym] : TYPED_SYMBOLS);
  const pad = () => (next() < 0.8 ? "" : pick(SPACES));
  parse.push(parseCase(pad() + sign + whole + frac + typed + pad(), d, sym, candid));
}
// Seeded noise from a small alphabet.
const NOISE = ["0", "1", "9", "00", "-", ".", "+", "e", ",", "_", " ", " ", "\u0085", "ICP", "icp", "K", "０"];
for (let i = 0; i < 150; i++) {
  const input = Array.from({ length: int(9) }, () => pick(NOISE)).join("");
  parse.push(parseCase(input, pick(DECIMALS), pick(SYMBOLS), pick(TYPES)));
}

// Display: seeded canonical values, and malformed ones.
for (let i = 0; i < 300; i++) {
  const mag = next() < 0.1 ? "0" : String(1 + int(9)) + digits(int(next() < 0.7 ? 20 : 80));
  const negative = mag !== "0" && next() < 0.3;
  display.push(displayCase((negative ? "-" : "") + mag, pick(DECIMALS), pick(SYMBOLS), next() < 0.5 ? pick(["nat", "int"]) : pick(TYPES)));
}
for (const bad of ["", "01", "-01", "+1", "1.5", " 1", "1 ", "1_000", "１", "-", "--1", "0x1", "1e3"]) {
  display.push(displayCase(bad, 8, "ICP", "int"));
}

const symbol = [];
for (const sym of [
  "", "ICP", " ICP", "ICP ", " ICP", "ICP　", "I\nCP", "ICP‮", "­ICP", "IC​P",
  "ICP﻿", "\u0085ICP", "⁠", "a b", "\u{E0041}tag", "\u{13430}", "x".repeat(32),
  "x".repeat(33), emoji.repeat(32), emoji.repeat(33), "Ξ ETH", "ok-sym_1.2", "ICṔ", "؀",
]) {
  const r = answer(() => displayAmount("0", { decimals: 0, symbol: sym }));
  symbol.push(r.err ? { sym, err: r.err, msg: r.msg } : { sym, ok: true });
}
const candid = [];
for (const name of [...TYPES, "text", "float64", "Nat", "nat128", "", " nat", "reserved"]) {
  const r = answer(() => parseAmount("1", { decimals: 0, candid: name }));
  candid.push(r.err ? { name, err: r.err, msg: r.msg } : { name, ok: r.ok });
}

const lines = (cases) => cases.map((c) => "    " + JSON.stringify(c)).join(",\n");
const source = {
  repository: "https://github.com/b3hr4d/candid-profile",
  commit,
  package: `${pkg.name}@${pkg.version}`,
  node: process.version,
  unicode: process.versions.unicode,
  seed: SEED,
};
writeFileSync(
  OUT,
  `{\n  "source": ${JSON.stringify(source)},\n` +
    `  "parse": [\n${lines(parse)}\n  ],\n` +
    `  "display": [\n${lines(display)}\n  ],\n` +
    `  "symbol": [\n${lines(symbol)}\n  ],\n` +
    `  "candid": [\n${lines(candid)}\n  ]\n}\n`,
);
console.log(`${OUT}: ${parse.length} parse, ${display.length} display, ${symbol.length} symbol, ${candid.length} candid cases from ${source.package} at ${commit.slice(0, 12)}`);
