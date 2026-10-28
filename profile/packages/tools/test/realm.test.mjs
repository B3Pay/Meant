// Bytes made in another realm (a node:vm context here; an iframe or an extension's content script in practice) fail
// `instanceof Uint8Array` in this one. displayValue shows them as it shows this realm's bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { displayValue } from "../src/index.mjs";
import icrc1 from "../../../fixtures/icrc1.resolved.json" with { type: "json" };

const other = vm.createContext({});
const foreign = (bytes) => vm.runInContext(`new Uint8Array(${JSON.stringify([...bytes])})`, other);
const transfer = icrc1.methods.icrc1_transfer.args[0];
const HI = new TextEncoder().encode("hi");

test("the fixture really is another realm's Uint8Array", () => {
  assert.equal(foreign(HI) instanceof Uint8Array, false);
});

test("displayValue: another realm's bytes, tagged or not, read as this realm's do", () => {
  const memo = transfer.fields.memo;
  assert.deepEqual(displayValue(memo, foreign(HI)), displayValue(memo, HI));
  assert.deepEqual(displayValue(memo, HI), { text: "hi", raw: "6869" });
  for (const node of [undefined, { candid: "blob" }]) {
    assert.equal(displayValue(node, foreign([0, 255])), "00ff");
    assert.equal(displayValue(node, new Uint8Array([0, 255])), "00ff");
  }
  const to = { owner: "ryjl3-tyaaa-aaaaa-aaaba-cai", subaccount: foreign(new Uint8Array(32).fill(7)) };
  assert.deepEqual(displayValue(transfer.fields.to, to), displayValue(transfer.fields.to, { ...to, subaccount: new Uint8Array(32).fill(7) }));
  assert.equal(displayValue(undefined, new Uint16Array([1, 2])).constructor, Object, "other typed arrays are not bytes");
});
