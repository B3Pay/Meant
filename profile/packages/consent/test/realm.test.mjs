// Bytes made in another realm (a node:vm context here; an iframe, an extension's content script, or a test
// environment's TextEncoder in practice) fail `instanceof Uint8Array` in this one. The generator takes them as the
// same bytes, and still refuses everything that is not bytes, including arrays it used to wrap modulo 256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CODES, ConsentError, decodeArguments, icrc21ConsentMessage, toJson } from "../src/index.mjs";
import { snsValidatorRendering } from "../src/sns.mjs";
import { LEDGERS, encodeCall, icrc1, refsFor } from "./helpers.mjs";
import { DAPP_DID, dapp } from "./sns-helpers.mjs";

const other = vm.createContext({});
const foreign = (bytes) => vm.runInContext(`new Uint8Array(${JSON.stringify([...bytes])})`, other);
const foreignBuffer = (bytes) => vm.runInContext(`new Uint8Array(${JSON.stringify([...bytes])}).buffer`, other);
const golden = JSON.parse(readFileSync(new URL("./golden/transfer-tka-basic.json", import.meta.url), "utf8"));
const ARG = Uint8Array.from(golden.arg_hex.match(/../g), (h) => parseInt(h, 16));
const message = (arg, form = "generic") =>
  icrc21ConsentMessage({ method: golden.method, arg, user_preferences: golden[form].request.user_preferences }, { resolved: icrc1, refs: refsFor(LEDGERS[golden.ledger.id]) });

test("the fixtures really are another realm's bytes", () => {
  assert.equal(foreign([1]) instanceof Uint8Array, false);
  assert.equal(foreignBuffer([1]) instanceof ArrayBuffer, false);
});

test("icrc21ConsentMessage gives the golden message for another realm's Uint8Array or ArrayBuffer", () => {
  for (const form of ["generic", "fields"]) {
    assert.deepEqual(toJson(message(ARG, form)), golden[form].response, form);
    for (const arg of [foreign(ARG), foreignBuffer(ARG), ARG.buffer, [...ARG]]) assert.deepEqual(toJson(message(arg, form)), golden[form].response, form);
  }
});

test("an array is bytes only when every element is an integer 0 to 255; nothing is wrapped modulo 256", () => {
  for (const arg of [[...ARG.slice(0, -1), 256], [-1, ...ARG.slice(1)], [1.5], ["68"], [null], "4449444c", 42, null, {}, new Uint16Array(ARG), new DataView(ARG.buffer)]) {
    const r = message(arg);
    assert.ok("Err" in r, JSON.stringify(arg)?.slice(0, 40));
    assert.deepEqual(r.diagnostics.map((d) => [d.code, /^request\.arg must be bytes/.test(d.message)]), [[CODES.REQUEST, true]]);
  }
  // decodeArguments alone: the same refusal, under the code its callers (the SNS rendering) report
  assert.throws(() => decodeArguments(icrc1.methods[golden.method], [0x44, 0x49, 0x44, 0x4c + 256]), (e) => e instanceof ConsentError && e.code === CODES.DECODE && /not bytes/.test(e.message));
});

test("toJson writes another realm's Uint8Array as hex, like this realm's", () => {
  assert.deepEqual(toJson({ memo: foreign([0, 255, 16]) }), { memo: { hex: "00ff10" } });
  assert.deepEqual(toJson({ memo: new Uint8Array([0, 255, 16]) }), { memo: { hex: "00ff10" } });
  assert.deepEqual(toJson({ n: new Uint16Array([1]) }), { n: { 0: 1 } }, "other typed arrays are not bytes");
});

test("the SNS validator rendering takes another realm's payload as the same bytes", () => {
  const payload = encodeCall("pause", "()", DAPP_DID);
  const want = snsValidatorRendering({ payload, resolved: dapp, method: "pause" });
  assert.ok("Ok" in want, JSON.stringify(want));
  assert.deepEqual(snsValidatorRendering({ payload: foreign(payload), resolved: dapp, method: "pause" }), want);
  assert.deepEqual(snsValidatorRendering({ payload: foreignBuffer(payload), resolved: dapp, method: "pause" }), want);
  assert.match(snsValidatorRendering({ payload: [...payload.slice(0, -1), 300], resolved: dapp, method: "pause" }).Err, /^E_DECODE: the argument is not bytes/);
});
