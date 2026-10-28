// EVM ABI positions (spec section 15, D-054): the integer types uint8 to uint256 and int8 to int256, byte types, and
// the amount tag's `threshold` and `message`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, describeInput, displayAmount, formatterFor, parseAmount } from "../src/index.mjs";

const MAX256 = (2n ** 256n - 1n).toString();
const amount = (abi, args) => formatterFor({ abi, tags: { amount: { args } } });
const err = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

test("an ABI integer type bounds an amount: uint256 takes 78 digits, uint8 and int256 their own ranges", () => {
  const f = amount("uint256", { decimals: 18, symbol: "WETH" });
  assert.equal(f.candid, "uint256");
  assert.equal(f.parse("1.5 WETH"), "1500000000000000000");
  assert.equal(f.display(MAX256), `${MAX256.slice(0, -18)}.${MAX256.slice(-18)} WETH`);
  assert.equal(f.safeDisplay((2n ** 256n).toString()).error.code, CODES.RANGE);
  assert.match(f.safeDisplay((2n ** 256n).toString()).error.message, /of the ABI type$/);
  assert.equal(parseAmount("255", { decimals: 0, candid: "uint8" }), "255");
  assert.equal(err(() => parseAmount("256", { decimals: 0, candid: "uint8" })), CODES.RANGE);
  assert.equal(parseAmount("-1.5", { decimals: 1, candid: "int256" }), "-15");
  assert.equal(err(() => parseAmount("-1", { decimals: 0, candid: "uint256" })), CODES.NEGATIVE);
  assert.equal(err(() => parseAmount("1", { decimals: 0, candid: "uint7" })), CODES.TAG_TYPE);
  // the described grammar is the signed one for intN
  assert.match(describeInput("amount", { decimals: 2 }, "int128").summary, /"-" for a negative amount/);
});

test("threshold and message: a value at or above the threshold displays as the message and the symbol", () => {
  const f = amount("uint256", { decimals: 6, symbol: "USDC", threshold: MAX256 });
  assert.equal(f.display(MAX256), "Unlimited USDC");
  const below = (2n ** 256n - 2n).toString();
  assert.equal(f.display(below), `${below.slice(0, -6)}.${below.slice(-6)} USDC`);
  assert.deepEqual(f.args, { decimals: 6, symbol: "USDC", threshold: MAX256, message: "Unlimited" });
  const max = amount("uint256", { decimals: 6, threshold: "1000000", message: "Max" });
  assert.equal(max.display("1000000"), "Max");
  assert.equal(max.display("999999"), "0.999999");
  // display only: the input grammar is the same, and a number at the threshold still parses to its base units
  assert.equal(max.parse("1"), "1000000");
  assert.equal(displayAmount("5", { decimals: 0, symbol: "ICP", candid: "nat", threshold: "5" }), "Unlimited ICP");
  for (const args of [{ decimals: 6, threshold: "-1" }, { decimals: 6, threshold: "1e6" }, { decimals: 6, message: "Max" }, { decimals: 6, threshold: "1", message: " Max" }, { decimals: 6, threshold: "1", message: "" }]) {
    assert.equal(err(() => amount("uint256", args)), CODES.ARG, JSON.stringify(args));
  }
});

test("timestamps and durations on uint32 to uint256 and int72 to int256; bytes on bytes and bytesN", () => {
  const t = formatterFor({ abi: "uint48", tags: { timestamp: { args: { unit: "s", epoch: "unix" } } } });
  assert.equal(t.display("1709191632"), "2024-02-29T07:27:12Z");
  assert.equal(formatterFor({ abi: "uint256", tags: { duration: { args: { unit: "s" } } } }).display("8250"), "PT2H17M30S");
  assert.equal(err(() => formatterFor({ abi: "uint16", tags: { timestamp: { args: { unit: "s" } } } })), CODES.TAG_TYPE);
  const b4 = formatterFor({ abi: "bytes4", tags: { bytes: { args: { encoding: "hex" } } } });
  assert.deepEqual(b4.parse("0xdeadbeef"), new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(b4.safeParse("0xdead").error.code, CODES.LENGTH);
  assert.equal(formatterFor({ abi: "bytes", tags: { bytes: { args: { encoding: "utf8" } } } }).display(new TextEncoder().encode("hi")), "hi");
  // ICRC tags do not fit EVM types
  assert.equal(err(() => formatterFor({ abi: "bytes32", tags: { subaccount: { args: {} } } })), CODES.TAG_TYPE);
  assert.equal(err(() => formatterFor({ abi: "address", tags: { amount: { args: { decimals: 6 } } } })), CODES.TAG_TYPE);
  assert.equal(formatterFor({ abi: "address" }), null);
});
