import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, FormatError, displaySubaccount, parseSubaccount } from "../src/index.mjs";
import { SEED, makeRng } from "./helpers/prng.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};
const num = (n) => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setBigUint64(24, BigInt(n), false);
  return hex(b);
};

test("subaccount: #n and plain decimal are 32 bytes big-endian", () => {
  assert.equal(hex(parseSubaccount("#0")), "00".repeat(32));
  assert.equal(hex(parseSubaccount("0")), "00".repeat(32));
  assert.equal(hex(parseSubaccount("#1")), "00".repeat(31) + "01");
  assert.equal(hex(parseSubaccount("1")), "00".repeat(31) + "01");
  assert.equal(hex(parseSubaccount("#256")), "00".repeat(30) + "0100");
  assert.equal(hex(parseSubaccount("7")), "00".repeat(31) + "07");
  assert.equal(hex(parseSubaccount("#18446744073709551615")), "00".repeat(24) + "ff".repeat(8));
  assert.equal(hex(parseSubaccount(" #3 ")), num(3));
});

test("subaccount: exactly 64 hex characters, with an optional 0x, either case", () => {
  const h = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
  assert.equal(hex(parseSubaccount(h)), h);
  assert.equal(hex(parseSubaccount("0x" + h)), h);
  assert.equal(hex(parseSubaccount(h.toUpperCase())), h);
  assert.equal(hex(parseSubaccount("0x" + h.toUpperCase())), h);
  assert.equal(hex(parseSubaccount("00".repeat(32))), "00".repeat(32));
});

test("subaccount: display is #n if and only if the first 24 bytes are zero", () => {
  assert.equal(displaySubaccount(new Uint8Array(32)), "#0");
  assert.equal(displaySubaccount(unhex(num(1))), "#1");
  assert.equal(displaySubaccount(unhex(num(2n ** 64n - 1n))), "#18446744073709551615");
  const justOver = unhex("00".repeat(23) + "01" + "00".repeat(8));
  assert.equal(displaySubaccount(justOver), "00".repeat(23) + "01" + "00".repeat(8), "byte 23 is non-zero: hex");
  assert.equal(displaySubaccount(unhex("ff" + "00".repeat(31))), "ff" + "00".repeat(31));
  assert.equal(displaySubaccount(Array.from({ length: 32 }, (_, i) => (i === 31 ? 9 : 0))), "#9", "JSON array of byte values");
});

test("subaccount: a 64-digit string is hex, not a decimal", () => {
  const digits = "0".repeat(62) + "10";
  assert.equal(hex(parseSubaccount(digits)), digits, "0x10, not decimal ten");
  assert.equal(parseSubaccount(digits)[31], 16);
  assert.equal(code(() => parseSubaccount("#" + digits)), CODES.SYNTAX, "with # it can only be decimal, which has leading zeros");
  const big = "1".repeat(64);
  assert.equal(hex(parseSubaccount(big)), big);
});

test("subaccount: a decimal n >= 2^64 is rejected (spec 5.3 range)", () => {
  assert.equal(code(() => parseSubaccount("18446744073709551616")), CODES.RANGE);
  assert.equal(code(() => parseSubaccount("#18446744073709551616")), CODES.RANGE);
  assert.equal(code(() => parseSubaccount("99999999999999999999999")), CODES.RANGE);
  assert.equal(code(() => parseSubaccount("1" + "0".repeat(62))), CODES.RANGE, "63 digits cannot be hex, so it is a decimal and too big");
  assert.equal(code(() => parseSubaccount("1" + "0".repeat(64))), CODES.RANGE, "65 digits likewise");
});

test("subaccount: anything but 64 hex characters in the hex form is rejected", () => {
  const h = "ab".repeat(32);
  assert.equal(code(() => parseSubaccount(h.slice(1))), CODES.LENGTH);
  assert.equal(code(() => parseSubaccount(h + "a")), CODES.LENGTH);
  assert.equal(code(() => parseSubaccount("0x" + h.slice(2))), CODES.LENGTH);
  assert.equal(code(() => parseSubaccount("ab")), CODES.LENGTH);
  assert.equal(code(() => parseSubaccount("0xab")), CODES.LENGTH);
  assert.equal(code(() => parseSubaccount("1e3")), CODES.LENGTH, "no exponents: this is three hex characters");
  assert.equal(code(() => parseSubaccount("0x")), CODES.SYNTAX);
  assert.equal(code(() => parseSubaccount("zz" + h.slice(2))), CODES.SYNTAX);
  assert.equal(hex(parseSubaccount("0X" + h)), h, "0X is accepted like 0x");
});

test("subaccount: other malformed input", () => {
  for (const bad of ["", "#", "##1", "-1", "+1", "1.5", "#0x10", "#abc", "one", "1 2", "#-1", "٣"]) {
    assert.equal(code(() => parseSubaccount(bad)), CODES.SYNTAX, JSON.stringify(bad));
  }
  assert.equal(code(() => parseSubaccount("007")), CODES.SYNTAX, "leading zeros in a decimal");
  assert.equal(code(() => parseSubaccount("#00")), CODES.SYNTAX);
  assert.equal(code(() => parseSubaccount(1)), CODES.TYPE);
  assert.equal(code(() => parseSubaccount(1n)), CODES.TYPE);
  assert.equal(code(() => parseSubaccount(null)), CODES.TYPE);
});

test("subaccount: display rejects anything that is not 32 bytes", () => {
  assert.equal(code(() => displaySubaccount(new Uint8Array(31))), CODES.LENGTH);
  assert.equal(code(() => displaySubaccount(new Uint8Array(33))), CODES.LENGTH);
  assert.equal(code(() => displaySubaccount(new Uint8Array(0))), CODES.LENGTH);
  assert.equal(code(() => displaySubaccount("#1")), CODES.TYPE);
  assert.equal(code(() => displaySubaccount([256])), CODES.TYPE);
});

// ---------------------------------------------------------------- properties

function random32(rng) {
  const b = rng.bytes(32);
  b.fill(0, 0, rng.int(33)); // 0 to 32 leading zero bytes, so both display forms are common
  if (rng.int(8) === 0) b.fill(0); // all zero
  return b;
}

test(`property: parse(display(x)) = x for every 32-byte value (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 20);
  let short = 0;
  let long = 0;
  for (let i = 0; i < 20000; i++) {
    const x = random32(rng);
    const text = displaySubaccount(x);
    assert.deepEqual(hex(parseSubaccount(text)), hex(x), `seed ${SEED + 20}: ${hex(x)} -> ${text}`);
    const first24Zero = x.subarray(0, 24).every((b) => b === 0);
    assert.equal(text.startsWith("#"), first24Zero, `seed ${SEED + 20}: "#n" iff the first 24 bytes are zero (${hex(x)})`);
    if (first24Zero) short++;
    else long++;
    if (!first24Zero) assert.match(text, /^[0-9a-f]{64}$/);
  }
  assert.ok(short > 1000 && long > 1000, `both display forms exercised (${short} short, ${long} long)`);
});

test(`property: decimal n, "#n" and display agree with BigInt arithmetic (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 21);
  for (let i = 0; i < 5000; i++) {
    const n = rng.bits(rng.int(65));
    assert.equal(hex(parseSubaccount(String(n))), num(n), `seed ${SEED + 21}: ${n}`);
    assert.equal(hex(parseSubaccount(`#${n}`)), num(n));
    assert.equal(displaySubaccount(unhex(num(n))), `#${n}`);
  }
});

test(`property: hex input in any case and with or without 0x gives the same bytes (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 22);
  for (let i = 0; i < 2000; i++) {
    const x = rng.bytes(32);
    const h = hex(x);
    for (const form of [h, "0x" + h, h.toUpperCase(), "0x" + h.toUpperCase()]) assert.equal(hex(parseSubaccount(form)), h, form);
  }
});
