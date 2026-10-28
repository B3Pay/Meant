// One test per rejection rule in docs/profile-v0.md §5.3 (plus the §4 / D-006 rule that big
// integers are never JavaScript numbers). Every case goes through formatterFor on a node of the
// real resolved fixtures, the way arm C and the consent generator will call the library.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, formatterFor } from "../src/index.mjs";
import { loadFixture, nodeAt } from "./helpers/fixtures.mjs";

const icrc1 = loadFixture("icrc1");
const icrc2 = loadFixture("icrc2");
const REFS = { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" };

const amount = formatterFor(nodeAt(icrc1, "icrc1_transfer.arg0.amount"), { refs: REFS });
const created = formatterFor(nodeAt(icrc1, "icrc1_transfer.arg0.created_at_time"));
const to = formatterFor(nodeAt(icrc1, "icrc1_transfer.arg0.to"));
const fromSub = formatterFor(nodeAt(icrc1, "icrc1_transfer.arg0.from_subaccount"));
const memo = formatterFor(nodeAt(icrc1, "icrc1_transfer.arg0.memo"));
const expires = formatterFor(nodeAt(icrc2, "icrc2_approve.arg0.expires_at"));

/** The error code of a rejected parse, failing the test if the input was accepted. */
const rejected = (f, input, ctx) => {
  const r = f.safeParse(input, ctx);
  assert.equal(r.ok, false, `${JSON.stringify(input)} must be rejected, got ${JSON.stringify(r.value)}`);
  return r.error.code;
};

const duration = (unit, candid = "nat64") => formatterFor({ candid, tags: { duration: { args: { unit } } } });

test("§5.3 amount: input with more than d fractional digits is rejected, never rounded", () => {
  for (const input of ["0.123456789", "0.999999995", "1.000000005", "0.000000001", "1.5000000001", "0.000000009 TKA"]) {
    assert.equal(rejected(amount, input), CODES.EXCESS_PRECISION, input);
  }
  assert.equal(amount.parse("0.12345678"), "12345678", "exactly d digits is fine");
});

test("§5.3 amount: negative input is rejected unless the Candid type is signed", () => {
  assert.equal(rejected(amount, "-1"), CODES.NEGATIVE);
  assert.equal(rejected(amount, "-0.00000001 TKA"), CODES.NEGATIVE);
  const signed = formatterFor({ candid: "int", tags: { amount: { args: { decimals: 8, symbol: "TKA" } } } });
  assert.equal(signed.parse("-1"), "-100000000");
});

test("§5.3 amount: a symbol that does not match the token's symbol is rejected (case-insensitively)", () => {
  assert.equal(rejected(amount, "1 ICP"), CODES.SYMBOL_MISMATCH);
  assert.equal(rejected(amount, "1 TKAA"), CODES.SYMBOL_MISMATCH);
  assert.equal(rejected(amount, "1 TK"), CODES.SYMBOL_MISMATCH);
  assert.equal(amount.parse("1 tka"), "100000000");
  assert.equal(amount.parse("1 TKA"), "100000000");
});

test("§5.3 timestamp: a conversion to the tagged unit that is not exact is rejected", () => {
  const seconds = formatterFor({ candid: "nat64", tags: { timestamp: { args: { unit: "s" } } } });
  assert.equal(rejected(seconds, "2026-10-09T12:00:00.5Z"), CODES.INEXACT);
  assert.equal(rejected(seconds, "2026-10-09T12:00:00.000000001Z"), CODES.INEXACT, "an absolute time is never floored");
  assert.equal(rejected(seconds, "+PT0.5S", { now: 0n }), CODES.INEXACT, "a relative duration finer than the unit");
  assert.equal(seconds.parse("2026-10-09T12:00:00Z"), "1791547200");
  assert.equal(created.parse("2026-10-09T12:00:00.000000001Z"), "1791547200000000001", "nanoseconds are exact in a ns field");
});

test("§5.3 timestamp: a relative time is resolved against now floored to the tagged unit", () => {
  const seconds = formatterFor({ candid: "nat64", tags: { timestamp: { args: { unit: "s" } } } });
  const now = 1791547200999999999n; // 12:00:00.999999999, one nanosecond short of 12:00:01
  assert.equal(seconds.parse("+PT24H", { now }), "1791633600", "floor(now) + 86400 s, not an E_INEXACT");
  assert.equal(seconds.parse("+PT0S", { now }), "1791547200", "floored, never rounded up");
  assert.equal(created.parse("+PT24H", { now }), "1791633600999999999", "a ns field keeps the whole clock reading");
});

test("§5.3 timestamp: relative input uses the same duration rules, so years and months are rejected", () => {
  for (const input of ["+P1Y", "+P1M", "+P1Y6M", "+P2M3D"]) assert.equal(rejected(created, input, { now: 0n }), CODES.CALENDAR_UNIT, input);
  assert.equal(rejected(created, "+PT1X", { now: 0n }), CODES.SYNTAX);
  assert.equal(created.parse("+P7D", { now: 0n }), "604800000000000");
  assert.equal(created.parse("+PT24H", { now: 0n }), "86400000000000");
});

test("§5.3 timestamp: relative input without a now is rejected, never resolved against the host clock", () => {
  assert.equal(rejected(created, "+PT24H"), CODES.NEEDS_NOW);
  assert.equal(rejected(expires, "+P1D"), CODES.NEEDS_NOW);
});

test("§5.3 duration: only W, D, H, M (after T) and S are allowed", () => {
  const s = duration("s");
  for (const input of ["PT1X", "P1H", "PT1D", "PT1W", "P1.5D", "PT1.5H", "1D", "PT", "P", "P1DT", "PT1S1M", "pt24h"]) {
    assert.equal(rejected(s, input), CODES.SYNTAX, input);
  }
  assert.equal(s.parse("P1W2DT3H4M5S"), String(7 * 86400 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5));
});

test("§5.3 duration: calendar years and months (P1Y, P1M) are rejected because their length is undefined", () => {
  const s = duration("s");
  for (const input of ["P1Y", "P1M", "P1Y2M", "P1Y1DT1H", "P0M"]) assert.equal(rejected(s, input), CODES.CALENDAR_UNIT, input);
  assert.equal(s.parse("PT1M"), "60", "M after T is minutes");
});

test("§5.3 duration: P1D is exactly 86,400 s", () => {
  assert.equal(duration("s").parse("P1D"), "86400");
  assert.equal(duration("ms").parse("P1D"), "86400000");
  assert.equal(duration("ns").parse("P1D"), "86400000000000");
  assert.equal(duration("s").parse("P1D"), duration("s").parse("PT24H"));
  assert.equal(duration("s").parse("P1W"), duration("s").parse("P7D"));
});

test("§5.3 duration: a conversion that loses precision is rejected", () => {
  assert.equal(rejected(duration("s"), "PT0.5S"), CODES.INEXACT);
  assert.equal(rejected(duration("ms"), "PT0.0001S"), CODES.INEXACT);
  assert.equal(duration("ms").parse("PT0.5S"), "500");
});

test("§5.3 account: the checksum is verified on input", () => {
  const good = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  const text = to.display({ owner: good, subaccount: Uint8Array.from({ length: 32 }, (_, i) => i + 1) });
  assert.deepEqual(to.parse(text).owner, good);
  const [head, tail] = text.split(".");
  const checksum = head.slice(-7);
  const wrong = checksum.slice(0, 6) + (checksum[6] === "a" ? "b" : "a");
  assert.equal(rejected(to, `${head.slice(0, -7)}${wrong}.${tail}`), CODES.CHECKSUM);
  assert.equal(rejected(to, text.slice(0, -1) + (text.endsWith("0") ? "1" : "0")), CODES.CHECKSUM, "a changed subaccount digit");
  assert.equal(rejected(to, `${good}.${tail}`), CODES.CHECKSUM_MISSING);
});

test("§5.3 account: a principal with a bad principal-level checksum is rejected", () => {
  assert.equal(rejected(to, "ryjl3-tyaaa-aaaaa-aaaba-caj"), CODES.PRINCIPAL);
  assert.equal(rejected(to, "aaaaa-ab"), CODES.PRINCIPAL);
});

test("§5.3 subaccount: a decimal n outside 0 <= n < 2^64 is rejected", () => {
  assert.equal(rejected(fromSub, "18446744073709551616"), CODES.RANGE);
  assert.equal(rejected(fromSub, "#18446744073709551616"), CODES.RANGE);
  assert.equal(rejected(fromSub, "-1"), CODES.SYNTAX);
  assert.equal(rejected(fromSub, "#-1"), CODES.SYNTAX);
  assert.equal(fromSub.display(fromSub.parse("18446744073709551615")), "#18446744073709551615", "2^64 - 1 is the largest");
});

test("§5.3 subaccount: a hex form with other than exactly 64 characters is rejected", () => {
  const h = "ab".repeat(32);
  assert.equal(rejected(fromSub, h.slice(0, 63)), CODES.LENGTH);
  assert.equal(rejected(fromSub, h + "0"), CODES.LENGTH);
  assert.equal(rejected(fromSub, "0x" + h.slice(0, 62)), CODES.LENGTH);
  assert.equal(rejected(fromSub, "0x" + h + "00"), CODES.LENGTH);
  assert.equal(rejected(fromSub, "0x"), CODES.SYNTAX);
  assert.equal(Buffer.from(fromSub.parse("0x" + h)).toString("hex"), h);
});

test("§5.3 subaccount: parse(display(x)) = x for the edge values (the full property is in subaccount.test.mjs)", () => {
  const edges = ["00".repeat(32), "00".repeat(31) + "01", "00".repeat(24) + "ff".repeat(8), "00".repeat(23) + "01" + "00".repeat(8), "ff".repeat(32), "01" + "00".repeat(31), "80" + "00".repeat(31)];
  for (const e of edges) {
    const bytes = Uint8Array.from(Buffer.from(e, "hex"));
    assert.equal(Buffer.from(fromSub.parse(fromSub.display(bytes))).toString("hex"), e);
  }
});

test("§5.3 subaccount: display is #n if and only if the first 24 bytes are zero", () => {
  assert.equal(fromSub.display(Uint8Array.from(Buffer.from("00".repeat(31) + "05", "hex"))), "#5");
  assert.match(fromSub.display(Uint8Array.from(Buffer.from("00".repeat(23) + "01" + "00".repeat(8), "hex"))), /^[0-9a-f]{64}$/);
});

test("§5.3 bytes: max_len counts bytes after encoding, so a longer value is rejected", () => {
  const limited = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "utf8", max_len: 5 } } } });
  assert.equal(rejected(limited, "héllo"), CODES.MAX_LEN, "5 characters, 6 bytes");
  assert.equal(rejected(limited, "0x010203040506"), CODES.MAX_LEN, "utf8 input read as hex, 6 bytes");
  assert.equal(limited.parse("héll").length, 5);
  const hexLimited = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "hex", max_len: 2 } } } });
  assert.equal(rejected(hexLimited, "0x010203"), CODES.MAX_LEN);
  const b64Limited = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "base64", max_len: 3 } } } });
  assert.equal(rejected(b64Limited, "AAAAAA=="), CODES.MAX_LEN);
  assert.equal(b64Limited.parse("AAAA").length, 3);
});

test("§5.3 bytes: utf8 input starting with 0x is hex, so malformed hex is rejected rather than taken as text", () => {
  assert.equal(rejected(memo, "0xnothex"), CODES.HEX);
  assert.equal(rejected(memo, "0x123"), CODES.HEX);
  assert.equal(Buffer.from(memo.parse("0x6869")).toString("utf8"), "hi");
});

test("§5.3 bytes: hex and base64 reject text that is not in that encoding", () => {
  const h = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "hex" } } } });
  const b = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "base64" } } } });
  assert.equal(rejected(h, "hello"), CODES.HEX);
  assert.equal(rejected(b, "hello!"), CODES.BASE64);
  assert.equal(rejected(b, "-_-_"), CODES.BASE64);
  assert.equal(h.display(Uint8Array.from([0xde, 0xad])), "0xdead", "hex display carries the 0x prefix");
});

test("§4 / D-006: an integer is never a JavaScript number, in either direction", () => {
  assert.equal(amount.safeDisplay(150000000).error.code, CODES.TYPE);
  assert.equal(amount.safeDisplay(Number.MAX_SAFE_INTEGER).error.code, CODES.TYPE);
  assert.equal(created.safeDisplay(1791547200000000000).error.code, CODES.TYPE);
  assert.equal(amount.safeParse(1.5).error.code, CODES.TYPE);
  assert.equal(created.safeParse(1791547200000000000).error.code, CODES.TYPE);
  assert.equal(amount.safeDisplay("150000000").ok, true);
  assert.equal(amount.safeDisplay(150000000n).ok, true);
});

test("§11.3: no silent rounding or truncation anywhere in value conversion (the Candid type's range is enforced, not wrapped)", () => {
  const nat8 = formatterFor({ candid: "nat8", tags: { amount: { args: { decimals: 0 } } } });
  assert.equal(rejected(nat8, "256"), CODES.RANGE);
  assert.equal(nat8.safeDisplay("256").error.code, CODES.RANGE);
  const nat32 = formatterFor({ candid: "nat32", tags: { timestamp: { args: { unit: "s" } } } });
  assert.equal(rejected(nat32, "2106-02-07T06:28:16Z"), CODES.RANGE);
});
