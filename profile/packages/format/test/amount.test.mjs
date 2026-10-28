import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, FormatError, displayAmount, parseAmount } from "../src/index.mjs";
import { SEED, makeRng } from "./helpers/prng.mjs";

const ICP = { decimals: 8, symbol: "ICP" };
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};

test("amount: the spec examples", () => {
  assert.equal(displayAmount("150000000", ICP), "1.5 ICP");
  assert.equal(displayAmount("100000000", ICP), "1 ICP");
  assert.equal(parseAmount("1.5", ICP), "150000000");
  assert.equal(parseAmount("1.5 ICP", ICP), "150000000");
  assert.equal(parseAmount("1 icp", ICP), "100000000");
  assert.equal(displayAmount("0", ICP), "0 ICP");
  assert.equal(displayAmount("1", ICP), "0.00000001 ICP");
  assert.equal(displayAmount("12345678", ICP), "0.12345678 ICP");
  assert.equal(displayAmount(150000000n, { decimals: 8 }), "1.5", "no symbol: number only");
  assert.equal(displayAmount("7", { decimals: 0, symbol: "X" }), "7 X");
});

test("amount: parsing is exact for typical inputs", () => {
  assert.equal(parseAmount("0.5", ICP), "50000000");
  assert.equal(parseAmount("0.00000001", ICP), "1");
  assert.equal(parseAmount("007.5", ICP), "750000000", "leading zeros are harmless");
  assert.equal(parseAmount("  2  ", ICP), "200000000", "surrounding whitespace is ignored");
  assert.equal(parseAmount("1.5\tICP", ICP), "150000000");
  assert.equal(parseAmount("0", ICP), "0");
  assert.equal(parseAmount("12", { decimals: 0 }), "12");
});

test("amount: 18-decimal amounts above 2^53 and 2^64 round-trip exactly", () => {
  const eth = { decimals: 18, symbol: "ckETH" };
  for (const v of ["9007199254740993", "18446744073709551615", "18446744073709551616", "123456789012345678901234567890123456789"]) {
    const text = displayAmount(v, eth);
    assert.equal(parseAmount(text, eth), v, `${v} -> ${text}`);
  }
  assert.equal(displayAmount("1000000000000000001", eth), "1.000000000000000001 ckETH");
  assert.equal(parseAmount("1.000000000000000001", eth), "1000000000000000001");
  assert.equal(parseAmount("18.446744073709551615", eth), "18446744073709551615");
  assert.equal(displayAmount("9007199254740993", { decimals: 0 }), "9007199254740993", "2^53 + 1 survives");
});

test("amount: decimals 255 works", () => {
  const v = 10n ** 254n + 1n;
  const t = displayAmount(v, { decimals: 255, symbol: "Z" });
  assert.equal(parseAmount(t, { decimals: 255, symbol: "Z" }), v.toString());
});

test("amount: dynamic-looking decimals given as string or bigint are normalised", () => {
  assert.equal(parseAmount("1", { decimals: "8" }), "100000000");
  assert.equal(parseAmount("1", { decimals: 8n }), "100000000");
  assert.equal(code(() => parseAmount("1", { decimals: 256 })), CODES.ARG);
  assert.equal(code(() => parseAmount("1", { decimals: -1 })), CODES.ARG);
  assert.equal(code(() => parseAmount("1", { decimals: 1.5 })), CODES.ARG);
  assert.equal(code(() => parseAmount("1", {})), CODES.ARG);
});

test("amount: signed types accept and display negatives, unsigned types do not", () => {
  const s = { decimals: 2, symbol: "S", candid: "int" };
  assert.equal(parseAmount("-1.25", s), "-125");
  assert.equal(displayAmount("-125", s), "-1.25 S");
  assert.equal(displayAmount("-5", { ...s, decimals: 2 }), "-0.05 S");
  assert.equal(parseAmount("-0", s), "0");
  assert.equal(code(() => parseAmount("-1.25", { ...s, candid: "nat" })), CODES.NEGATIVE);
});

test("amount: Candid type bounds are enforced, not wrapped", () => {
  const n8 = { decimals: 0, candid: "nat8" };
  assert.equal(parseAmount("255", n8), "255");
  assert.equal(code(() => parseAmount("256", n8)), CODES.RANGE);
  const n64 = { decimals: 8, candid: "nat64" };
  assert.equal(parseAmount("184467440737.09551615", n64), "18446744073709551615");
  assert.equal(code(() => parseAmount("184467440737.09551616", n64)), CODES.RANGE);
  const i64 = { decimals: 0, candid: "int64" };
  assert.equal(parseAmount("-9223372036854775808", i64), "-9223372036854775808");
  assert.equal(code(() => parseAmount("-9223372036854775809", i64)), CODES.RANGE);
  assert.equal(code(() => displayAmount("256", n8)), CODES.RANGE);
});

test("amount: only integer Candid types are accepted", () => {
  assert.equal(code(() => parseAmount("1", { decimals: 0, candid: "text" })), CODES.TAG_TYPE);
  assert.equal(code(() => parseAmount("1", { decimals: 0, candid: "float64" })), CODES.TAG_TYPE);
});

test("amount: inputs that are not plain decimals are syntax errors", () => {
  for (const bad of ["", " ", "abc", "1,5", "1,000.5", "1_000", "1.", ".5", "1e3", "+1", "--1", "1.2.3", "1 .5", "０１", "1٫5", "0x10", "ICP 1", "1ICP", "NaN", "Infinity"]) {
    const c = code(() => parseAmount(bad, ICP));
    assert.ok([CODES.SYNTAX, CODES.SYMBOL_MISMATCH].includes(c), `${JSON.stringify(bad)} -> ${c}`);
  }
  assert.equal(code(() => parseAmount(15, ICP)), CODES.TYPE);
  assert.equal(code(() => parseAmount(null, ICP)), CODES.TYPE);
  assert.equal(code(() => parseAmount("1".repeat(2000), ICP)), CODES.TOO_LONG);
});

test("amount: display rejects JavaScript numbers and malformed integers", () => {
  assert.equal(code(() => displayAmount(150000000, ICP)), CODES.TYPE);
  assert.equal(code(() => displayAmount(1.5, ICP)), CODES.TYPE);
  assert.equal(code(() => displayAmount("1.5", ICP)), CODES.SYNTAX);
  assert.equal(code(() => displayAmount("01", ICP)), CODES.SYNTAX);
  assert.equal(code(() => displayAmount("-0", { ...ICP, candid: "int" })), CODES.SYNTAX);
  assert.equal(code(() => displayAmount("-1", ICP)), CODES.RANGE);
  assert.equal(code(() => displayAmount("", ICP)), CODES.SYNTAX);
});

test("amount: a symbol must be a plain label", () => {
  assert.equal(code(() => displayAmount("1", { decimals: 0, symbol: "" })), CODES.ARG);
  assert.equal(code(() => displayAmount("1", { decimals: 0, symbol: "I\nCP" })), CODES.ARG);
  assert.equal(code(() => displayAmount("1", { decimals: 0, symbol: "ICP‮" })), CODES.ARG);
  assert.equal(code(() => displayAmount("1", { decimals: 0, symbol: " ICP" })), CODES.ARG);
  assert.equal(code(() => displayAmount("1", { decimals: 0, symbol: "x".repeat(33) })), CODES.ARG);
  assert.equal(displayAmount("1", { decimals: 0, symbol: "1INCH" }), "1 1INCH");
  assert.equal(parseAmount("15 1INCH", { decimals: 0, symbol: "1INCH" }), "15");
});

test("amount: symbol matching is case-insensitive for ASCII only", () => {
  assert.equal(parseAmount("1 ckbtc", { decimals: 0, symbol: "ckBTC" }), "1");
  assert.equal(parseAmount("1 CKBTC", { decimals: 0, symbol: "ckBTC" }), "1");
  // U+212A KELVIN SIGN lower-cases to "k" under String.prototype.toLowerCase; it must not match.
  assert.equal(code(() => parseAmount("1 cKBTC", { decimals: 0, symbol: "ckBTC" })), CODES.SYMBOL_MISMATCH);
  // Cyrillic Es looks like Latin C.
  assert.equal(code(() => parseAmount("1 СKBTC", { decimals: 0, symbol: "CKBTC" })), CODES.SYMBOL_MISMATCH);
});

// ---------------------------------------------------------------- properties

test(`property: display then parse is the identity (seed ${SEED})`, () => {
  const rng = makeRng();
  for (let i = 0; i < 4000; i++) {
    const decimals = rng.int(4) === 0 ? rng.int(256) : rng.int(31);
    const symbol = rng.bool() ? undefined : rng.pick(["ICP", "ckBTC", "TKA", "1INCH", "x"]);
    const signed = rng.bool();
    const mag = rng.bigint(rng.pick([16, 64, 128, 256]));
    const v = signed && rng.bool() ? -mag : mag;
    const opts = { decimals, symbol, candid: signed ? "int" : "nat" };
    const text = displayAmount(v, opts);
    assert.equal(parseAmount(text, opts), v.toString(), `seed ${SEED}: ${v} d=${decimals} -> ${JSON.stringify(text)}`);
    // the display has no trailing fractional zero and no bare decimal point
    const num = text.split(" ")[0];
    assert.ok(!/\.\d*0$/.test(num) && !num.endsWith("."), `seed ${SEED}: ${text}`);
  }
});

test(`property: parse agrees with an independent string-padding oracle (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 1);
  const digits = (n) => Array.from({ length: n }, () => String(rng.int(10))).join("");
  for (let i = 0; i < 4000; i++) {
    const decimals = rng.int(31);
    const fracLen = rng.int(decimals + 1);
    const whole = digits(1 + rng.int(40)).replace(/^0+(?=\d)/, "");
    const frac = digits(fracLen);
    const text = frac ? `${whole}.${frac}` : whole;
    const expected = (whole + frac.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
    assert.equal(parseAmount(text, { decimals }), expected, `seed ${SEED + 1}: ${text} d=${decimals}`);
  }
});

test(`property: never rounds. Any input with more than d fractional digits is rejected (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 2);
  const digits = (n) => Array.from({ length: n }, () => String(rng.int(10))).join("");
  for (let i = 0; i < 4000; i++) {
    const decimals = rng.int(31);
    const extra = 1 + rng.int(6);
    // include the tricky cases: a 5 that would round up, 9s that would carry, and plain zeros
    const tail = rng.pick(["5", "9".repeat(extra), "0".repeat(extra), digits(extra)]);
    const text = `${digits(1 + rng.int(20))}.${digits(decimals)}${tail}`;
    assert.equal(code(() => parseAmount(text, { decimals })), CODES.EXCESS_PRECISION, `seed ${SEED + 2}: ${text} d=${decimals}`);
  }
});

test(`property: a smaller value never displays as a larger one (display is injective and ordered) (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 3);
  for (let i = 0; i < 1000; i++) {
    const decimals = rng.int(21);
    const v = rng.bigint(100);
    const a = displayAmount(v, { decimals });
    const b = displayAmount(v + 1n, { decimals });
    assert.notEqual(a, b, `seed ${SEED + 3}: ${v} d=${decimals}`);
    assert.ok(BigInt(parseAmount(a, { decimals })) < BigInt(parseAmount(b, { decimals })));
  }
});
