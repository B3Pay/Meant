// A Uint8Array made in another realm (a node:vm context here; an iframe, or jsdom's TextEncoder under a test
// runner) fails `instanceof Uint8Array` in this one. The format functions accept it as bytes all the same, and
// still refuse every value that is not a Uint8Array, however it is dressed up.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CODES, FormatError, displayAccount, displayBytes, principalFromText, principalToText } from "../src/index.mjs";

const other = vm.createContext({});
const foreign = (bytes) => vm.runInContext(`new Uint8Array(${JSON.stringify([...bytes])})`, other);
const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};

test("the fixture really is another realm's Uint8Array", () => {
  const b = foreign([1, 2]);
  assert.equal(b instanceof Uint8Array, false);
  assert.equal(ArrayBuffer.isView(b), true);
});

test("displayBytes accepts another realm's Uint8Array and shows the same text", () => {
  const bytes = new TextEncoder().encode("héllo");
  for (const encoding of ["utf8", "hex", "base64"]) {
    assert.equal(displayBytes(foreign(bytes), { encoding }), displayBytes(bytes, { encoding }));
  }
});

test("principalToText and displayAccount accept another realm's Uint8Array", () => {
  const owner = principalFromText(LEDGER);
  assert.equal(principalToText(foreign(owner)), LEDGER);
  const sub = new Uint8Array(32);
  sub[31] = 1;
  assert.equal(displayAccount({ owner: foreign(owner), subaccount: foreign(sub) }), displayAccount({ owner, subaccount: sub }));
});

test("a view of part of a buffer gives exactly those bytes", () => {
  const whole = vm.runInContext("new Uint8Array([9, 104, 105, 9])", other);
  const part = vm.runInContext("(w) => w.subarray(1, 3)", other)(whole);
  assert.equal(displayBytes(part, { encoding: "hex" }), "0x6869");
});

test("a view's own properties cannot make it show other bytes than it holds", () => {
  const spoofed = vm.runInContext(
    `const a = new Uint8Array([1, 2, 3]);
     Object.defineProperty(a, "buffer", { value: new Uint8Array([9, 9, 9, 9]).buffer });
     Object.defineProperty(a, "byteOffset", { value: 1 });
     Object.defineProperty(a, "byteLength", { value: 1 });
     a`,
    other
  );
  assert.equal(displayBytes(spoofed, { encoding: "hex" }), "0x010203");
});

test("a view of a detached buffer is refused, not shown as empty", () => {
  const here = new Uint8Array([1, 2]);
  structuredClone(here.buffer, { transfer: [here.buffer] });
  const there = vm.runInContext("const b = new Uint8Array([1, 2]); b.buffer.transfer(); b", other);
  for (const view of [here, there]) assert.equal(code(() => displayBytes(view, { encoding: "hex" })), CODES.TYPE);
});

test("a detached view is refused where ArrayBuffer.prototype.detached is missing (older browsers)", async () => {
  const { execFileSync } = await import("node:child_process");
  const index = new URL("../src/index.mjs", import.meta.url).href;
  const script = `
    delete ArrayBuffer.prototype.detached;
    const vm = await import("node:vm");
    const { displayBytes } = await import(${JSON.stringify(index)});
    const here = new Uint8Array([1, 2]);
    structuredClone(here.buffer, { transfer: [here.buffer] });
    const there = vm.runInContext("delete ArrayBuffer.prototype.detached; const b = new Uint8Array([1, 2]); b.buffer.transfer(); b", vm.createContext({}));
    const codes = [here, there].map((v) => { try { displayBytes(v, { encoding: "hex" }); return "none"; } catch (e) { return e.code ?? e.name; } });
    const live = displayBytes(new Uint8Array([1, 2]), { encoding: "hex" });
    console.log(JSON.stringify({ detachedGetter: "detached" in ArrayBuffer.prototype, codes, live }));`;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.deepEqual(out, { detachedGetter: false, codes: [CODES.TYPE, CODES.TYPE], live: "0x0102" });
});

test("other typed arrays, DataViews and look-alikes are still refused", () => {
  const fakes = [
    new Uint16Array([1, 2]),
    vm.runInContext("new Int8Array([1, 2])", other),
    new DataView(new ArrayBuffer(2)),
    { length: 2, 0: 1, 1: 2, [Symbol.toStringTag]: "Uint8Array" },
    Object.create(Uint8Array.prototype),
    new Proxy(new Uint8Array([1, 2]), {}),
    Object.defineProperty(new Uint16Array([1, 2]), Symbol.toStringTag, { value: "Uint8Array" }),
  ];
  for (const fake of fakes) {
    assert.equal(code(() => displayBytes(fake, { encoding: "hex" })), CODES.TYPE);
    assert.equal(code(() => principalToText(fake)), CODES.TYPE);
  }
});
