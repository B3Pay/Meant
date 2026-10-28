import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, FormatError, displayBytes, parseBytes } from "../src/index.mjs";
import { SEED, makeRng } from "./helpers/prng.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const bytes = (s) => Uint8Array.from(Buffer.from(s, "utf8"));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};
const U = { encoding: "utf8" };
const H = { encoding: "hex" };
const B = { encoding: "base64" };

test("bytes utf8: plain text is encoded as UTF-8", () => {
  assert.equal(hex(parseBytes("hello", U)), "68656c6c6f");
  assert.equal(hex(parseBytes("", U)), "");
  assert.equal(hex(parseBytes("héllo ✓ 👍", U)), hex(bytes("héllo ✓ 👍")));
  assert.equal(hex(parseBytes(" padded ", U)), hex(bytes(" padded ")), "text is not trimmed: spaces are content");
  assert.equal(hex(parseBytes("a0x", U)), "613078", "0x is only special at the start");
});

test("bytes utf8: input starting with 0x is read as hex", () => {
  assert.equal(hex(parseBytes("0x68656c6c6f", U)), "68656c6c6f");
  assert.equal(hex(parseBytes("0xDEADbeef", U)), "deadbeef");
  assert.equal(hex(parseBytes("0x", U)), "");
  assert.equal(hex(parseBytes("0X0a", U)), "0a", "0X is read as hex too, so it is never silently text");
  assert.equal(code(() => parseBytes("0xZZ", U)), CODES.HEX);
  assert.equal(code(() => parseBytes("0x123", U)), CODES.HEX, "odd number of digits");
  assert.equal(code(() => parseBytes("0x is the prefix", U)), CODES.HEX, "cannot be entered as text");
  assert.equal(code(() => parseBytes("0x12 34", U)), CODES.HEX);
});

test("bytes utf8: display is the text when the bytes are valid UTF-8 without control characters", () => {
  assert.equal(displayBytes(bytes("hello"), U), "hello");
  assert.equal(displayBytes(bytes("héllo ✓ 👍"), U), "héllo ✓ 👍");
  assert.equal(displayBytes(new Uint8Array(0), U), "");
  assert.equal(displayBytes(bytes(" spaced  "), U), " spaced  ");
  assert.equal(displayBytes(bytes("a0x"), U), "a0x");
});

test("bytes utf8: otherwise 0x and lowercase hex", () => {
  assert.equal(displayBytes(unhex("ff"), U), "0xff", "invalid UTF-8");
  assert.equal(displayBytes(unhex("c328"), U), "0xc328", "invalid sequence");
  assert.equal(displayBytes(unhex("eda080"), U), "0xeda080", "an encoded surrogate");
  assert.equal(displayBytes(unhex("00"), U), "0x00", "NUL");
  assert.equal(displayBytes(bytes("a\nb"), U), "0x610a62", "newline is a control character");
  assert.equal(displayBytes(bytes("a\tb"), U), "0x610962");
  assert.equal(displayBytes(unhex("7f"), U), "0x7f", "DEL");
  assert.equal(displayBytes(unhex("c280"), U), "0xc280", "C1 control U+0080");
  assert.equal(displayBytes(bytes("pay‮ALICE"), U).slice(0, 2), "0x", "bidirectional override");
  assert.equal(displayBytes(bytes("a‍b"), U).slice(0, 2), "0x", "zero-width joiner");
  assert.equal(displayBytes(bytes("﻿hi"), U).slice(0, 2), "0x", "byte order mark is kept, not dropped");
  assert.equal(displayBytes(bytes("a b"), U).slice(0, 2), "0x", "line separator");
  assert.equal(displayBytes(unhex("deadBEEF".toLowerCase()), U), "0xdeadbeef");
});

test("bytes utf8: text that starts with 0x is shown as hex so that it reads back unchanged", () => {
  for (const t of ["0xyz", "0x", "0X1", "0x68656c6c6f", "0x is the prefix"]) {
    const original = bytes(t);
    const shown = displayBytes(original, U);
    assert.equal(shown, "0x" + hex(original), t);
    assert.equal(hex(parseBytes(shown, U)), hex(original), t);
  }
});

test("bytes utf8: a lone surrogate is rejected, not replaced", () => {
  assert.equal(code(() => parseBytes("a\ud800b", U)), CODES.UTF8);
  assert.equal(code(() => parseBytes("\udc00", U)), CODES.UTF8);
  assert.equal(hex(parseBytes("👍", U)), "f09f91 8d".replace(" ", ""), "a proper pair is fine");
});

test("bytes hex: 0x prefix on display, optional on input, either case", () => {
  assert.equal(displayBytes(unhex("00ff10"), H), "0x00ff10");
  assert.equal(displayBytes(new Uint8Array(0), H), "0x");
  assert.equal(hex(parseBytes("0x00ff10", H)), "00ff10");
  assert.equal(hex(parseBytes("00FF10", H)), "00ff10");
  assert.equal(hex(parseBytes("0X00Ff10", H)), "00ff10");
  assert.equal(hex(parseBytes("0x", H)), "");
  assert.equal(hex(parseBytes("", H)), "");
});

test("bytes hex: malformed input is rejected", () => {
  for (const bad of ["0x1", "abc", "0xzz", "0x 12", " 0x12", "0x12 ", "0x0x12", "0x-1", "12\n", "٣٣", "0x12_34", "0g11"]) {
    assert.equal(code(() => parseBytes(bad, H)), CODES.HEX, JSON.stringify(bad));
  }
});

test("bytes base64: RFC 4648 test vectors", () => {
  const rfc = [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foob", "Zm9vYg=="], ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"]];
  for (const [plain, enc] of rfc) {
    assert.equal(displayBytes(bytes(plain), B), enc, plain);
    assert.equal(hex(parseBytes(enc, B)), hex(bytes(plain)), enc);
  }
  assert.equal(hex(parseBytes("Zg", B)), "66", "padding is optional on input");
  assert.equal(hex(parseBytes("Zm8", B)), "666f");
  assert.equal(displayBytes(unhex("fbff"), B), "+/8=", "standard alphabet");
});

test("bytes base64: malformed or non-canonical input is rejected", () => {
  for (const bad of ["Z", "Zg=", "Zg===", "Zm8==", "Zm9v=", "=", "====", "Zg==Zg==", "Z=g=", "Zh==", "Zm9", "Zm9=\n", " Zm9v", "Zm9v ", "Zm 9v", "Zm9v\n", "-_8=", "Zm9v!", "ÄÄÄÄ", "Zm8w=="]) {
    const c = code(() => parseBytes(bad, B));
    assert.equal(c, CODES.BASE64, `${JSON.stringify(bad)} -> ${c}`);
  }
});

test("bytes: max_len counts bytes after encoding", () => {
  // "héllo" is 5 characters but 6 bytes
  assert.equal(hex(parseBytes("héllo", { ...U, maxLen: 6 })), hex(bytes("héllo")));
  assert.equal(code(() => parseBytes("héllo", { ...U, maxLen: 5 })), CODES.MAX_LEN);
  // an emoji is one code point, two UTF-16 units and four bytes
  assert.equal(code(() => parseBytes("👍", { ...U, maxLen: 3 })), CODES.MAX_LEN);
  assert.equal(hex(parseBytes("👍", { ...U, maxLen: 4 })), "f09f918d");
  // hex text counts the decoded bytes, not the digits
  assert.equal(hex(parseBytes("0x" + "ab".repeat(32), { ...H, maxLen: 32 })), "ab".repeat(32));
  assert.equal(code(() => parseBytes("0x" + "ab".repeat(33), { ...H, maxLen: 32 })), CODES.MAX_LEN);
  assert.equal(code(() => parseBytes("0x" + "ab".repeat(32), { ...U, maxLen: 31 })), CODES.MAX_LEN, "utf8 input read as hex");
  // base64 text counts the decoded bytes, not the characters
  assert.equal(hex(parseBytes("AAAA", { ...B, maxLen: 3 })), "000000");
  assert.equal(code(() => parseBytes("AAAA", { ...B, maxLen: 2 })), CODES.MAX_LEN);
  assert.equal(hex(parseBytes("", { ...U, maxLen: 0 })), "");
  assert.equal(code(() => parseBytes("a", { ...U, maxLen: 0 })), CODES.MAX_LEN);
  assert.equal(hex(parseBytes("ab", { ...U, maxLen: "2" })), "6162");
  assert.equal(code(() => parseBytes("ab", { ...U, maxLen: -1 })), CODES.ARG);
  assert.equal(code(() => parseBytes("ab", { ...U, maxLen: 1.5 })), CODES.ARG);
});

test("bytes: argument and type checks", () => {
  assert.equal(code(() => parseBytes("x", {})), CODES.ARG);
  assert.equal(code(() => parseBytes("x", { encoding: "ascii" })), CODES.ARG);
  assert.equal(code(() => parseBytes(5, U)), CODES.TYPE);
  assert.equal(code(() => parseBytes(null, U)), CODES.TYPE);
  assert.equal(code(() => displayBytes("hello", U)), CODES.TYPE);
  assert.equal(code(() => displayBytes([1, 2, -1], U)), CODES.TYPE);
  assert.equal(code(() => displayBytes(new Uint8Array(1), { encoding: "base32" })), CODES.ARG);
  assert.equal(displayBytes([104, 105], U), "hi", "a JSON array of byte values");
  assert.equal(code(() => parseBytes("a".repeat(4 * 1024 * 1024 + 1), U)), CODES.TOO_LONG);
});

// ---------------------------------------------------------------- properties

function randomText(rng) {
  const pieces = ["a", "Z", " ", "0", "x", "0x", "é", "✓", "👍", "\n", "\t", "\u0080", "‮", "‍", "﻿", " ", "�", "\u{10ffff}", "￾", "日本", "́"];
  let s = rng.int(4) === 0 ? "0x" : "";
  for (let i = rng.int(8); i > 0; i--) s += rng.pick(pieces);
  return s;
}

test(`property: bytes round-trip through every encoding (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 30);
  for (let i = 0; i < 5000; i++) {
    const x = rng.bytes(rng.int(70));
    for (const enc of ["utf8", "hex", "base64"]) {
      const shown = displayBytes(x, { encoding: enc });
      assert.equal(hex(parseBytes(shown, { encoding: enc })), hex(x), `seed ${SEED + 30}: ${enc} ${hex(x)} -> ${JSON.stringify(shown)}`);
    }
    if (x.length) assert.equal(displayBytes(x, B), Buffer.from(x).toString("base64"), "base64 agrees with Buffer");
    assert.equal(hex(parseBytes(Buffer.from(x).toString("base64"), B)), hex(x));
    assert.equal(hex(parseBytes(Buffer.from(x).toString("base64").replace(/=+$/, ""), B)), hex(x), "unpadded");
  }
});

test(`property: utf8 round-trips for valid text, including text that starts with 0x or has control characters (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 31);
  let shownAsText = 0;
  let shownAsHex = 0;
  for (let i = 0; i < 5000; i++) {
    const original = bytes(randomText(rng));
    const shown = displayBytes(original, U);
    assert.equal(hex(parseBytes(shown, U)), hex(original), `seed ${SEED + 31}: ${hex(original)} -> ${JSON.stringify(shown)}`);
    if (shown.startsWith("0x")) shownAsHex++;
    else {
      shownAsText++;
      assert.equal(hex(bytes(shown)), hex(original), "text display is exactly the decoded text");
    }
  }
  assert.ok(shownAsText > 500 && shownAsHex > 500, `both display forms exercised (${shownAsText} text, ${shownAsHex} hex)`);
});

test(`property: utf8 text input encodes exactly as UTF-8 unless it starts with 0x (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 32);
  for (let i = 0; i < 3000; i++) {
    const t = randomText(rng);
    if (/^0[xX]/.test(t)) continue;
    assert.equal(hex(parseBytes(t, U)), hex(bytes(t)), `seed ${SEED + 32}: ${JSON.stringify(t)}`);
  }
});

test(`property: max_len accepts exactly the values whose decoded length fits (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 33);
  for (let i = 0; i < 3000; i++) {
    const x = rng.bytes(rng.int(40));
    const enc = rng.pick(["hex", "base64"]);
    const text = displayBytes(x, { encoding: enc });
    const maxLen = rng.int(45);
    if (x.length <= maxLen) assert.equal(hex(parseBytes(text, { encoding: enc, maxLen })), hex(x));
    else assert.equal(code(() => parseBytes(text, { encoding: enc, maxLen })), CODES.MAX_LEN, `seed ${SEED + 33}: ${x.length} > ${maxLen} (${enc})`);
  }
});
