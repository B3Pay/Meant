import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeArguments } from "../src/decode.mjs";
import { ConsentError } from "../src/errors.mjs";
import { ALICE, BOB, encodeCall, hexOf, icrc1, icrc2, subaccountText } from "./helpers.mjs";

const transfer = icrc1.methods.icrc1_transfer;

test("decode: icrc1_transfer arguments become a lossless tree aligned with the resolved form", () => {
  const bytes = encodeCall(
    "icrc1_transfer",
    `(record { to = record { owner = principal "${ALICE}"; subaccount = opt ${subaccountText(7)} }; amount = 123_456_789_012_345_678_901 : nat; memo = opt blob "hi"; fee = opt (10_000 : nat); from_subaccount = null; created_at_time = opt (1_791_547_200_000_000_000 : nat64) })`,
  );
  const [arg] = decodeArguments(transfer, bytes);
  assert.deepEqual(Object.keys(arg), Object.keys(transfer.args[0].fields), "keys follow the resolved form's field order");
  assert.equal(arg.amount, "123456789012345678901", "a nat above 2^64 is a decimal string, not a number");
  assert.equal(arg.fee, "10000");
  assert.equal(arg.created_at_time, "1791547200000000000", "nat64 is a decimal string too");
  assert.equal(arg.from_subaccount, null, "an absent optional is null");
  assert.ok(arg.memo instanceof Uint8Array);
  assert.equal(hexOf(arg.memo), "6869");
  assert.equal(arg.to.owner, ALICE);
  assert.equal(arg.to.subaccount.length, 32);
  assert.equal(arg.to.subaccount[31], 7);
});

test("decode: the tree survives JSON.stringify with bigint-free output", () => {
  const bytes = encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${BOB}"; subaccount = null }; amount = 18_446_744_073_709_551_616 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`);
  const [arg] = decodeArguments(transfer, bytes);
  const json = JSON.parse(JSON.stringify(arg));
  assert.equal(json.amount, "18446744073709551616");
  assert.equal(json.to.subaccount, null);
});

test("decode: variants, vectors, nested optionals and every integer width", () => {
  const node = {
    candid: "record",
    fields: {
      a: { candid: "nat8" },
      b: { candid: "int8" },
      c: { candid: "nat16" },
      d: { candid: "int16" },
      e: { candid: "nat32" },
      f: { candid: "int32" },
      g: { candid: "nat64" },
      h: { candid: "int64" },
      i: { candid: "int" },
      j: { candid: "float64" },
      k: { candid: "bool" },
      l: { candid: "text" },
      m: { candid: "vec", element: { candid: "nat" } },
      n: { candid: "variant", cases: { Ok: { candid: "nat" }, Nothing: { candid: "null" }, Pair: { candid: "record", fields: { x: { candid: "text" }, y: { candid: "int", optional: true } } } } },
      o: { candid: "vec", element: { candid: "record", fields: { p: { candid: "blob" } } } },
      q: { candid: "null" },
    },
  };
  const did = `service : { f : (record { a : nat8; b : int8; c : nat16; d : int16; e : nat32; f : int32; g : nat64; h : int64; i : int; j : float64; k : bool; l : text; m : vec nat; n : variant { Ok : nat; Nothing; Pair : record { x : text; y : opt int } }; o : vec record { p : blob }; q : null }) -> () }`;
  const bytes = encodeCall(
    "f",
    `(record { a = 255 : nat8; b = -128 : int8; c = 65_535 : nat16; d = -32_768 : int16; e = 4_294_967_295 : nat32; f = -2_147_483_648 : int32; g = 18_446_744_073_709_551_615 : nat64; h = -9_223_372_036_854_775_808 : int64; i = -170_141_183_460_469_231_731_687_303_715_884_105_728 : int; j = 1.5 : float64; k = true; l = "h\\u{e9}llo"; m = vec { 1; 2; 340_282_366_920_938_463_463_374_607_431_768_211_456 }; n = variant { Pair = record { x = "p"; y = null } }; o = vec { record { p = blob "\\00\\ff" }; record { p = blob "" } }; q = null })`,
    did,
  );
  const [v] = decodeArguments({ args: [node] }, bytes);
  assert.deepEqual(
    { ...v, o: v.o.map((e) => ({ p: [...e.p] })) },
    {
      a: "255", b: "-128", c: "65535", d: "-32768", e: "4294967295", f: "-2147483648", g: "18446744073709551615", h: "-9223372036854775808",
      i: "-170141183460469231731687303715884105728", j: 1.5, k: true, l: "héllo",
      m: ["1", "2", "340282366920938463463374607431768211456"],
      n: { tag: "Pair", value: { x: "p", y: null } },
      o: [{ p: [0, 255] }, { p: [] }],
      q: null,
    },
  );
  const bare = decodeArguments({ args: [node] }, encodeCall("f", `(record { a = 1 : nat8; b = 1 : int8; c = 1 : nat16; d = 1 : int16; e = 1 : nat32; f = 1 : int32; g = 1 : nat64; h = 1 : int64; i = 1 : int; j = 0.0 : float64; k = false; l = ""; m = vec {}; n = variant { Nothing }; o = vec {}; q = null })`, did))[0];
  assert.deepEqual(bare.n, { tag: "Nothing", value: null }, "a bare case has a null value");
  assert.deepEqual(bare.m, []);
});

test("decode: positional fields (#id keys) and a record with no fields", () => {
  const node = { candid: "record", fields: { "#0": { candid: "text" }, "#1": { candid: "nat" }, empty: { candid: "record" } } };
  const did = `service : { f : (record { text; nat; empty : record {} }) -> () }`;
  const [v] = decodeArguments({ args: [node] }, encodeCall("f", `(record { "a"; 7; empty = record {} })`, did));
  assert.deepEqual(v, { "#0": "a", "#1": "7", empty: {} });
});

test("decode: several arguments, and the wire may carry fewer optional fields than the signature", () => {
  const node = [{ candid: "principal" }, { candid: "record", fields: { x: { candid: "nat" }, y: { candid: "text", optional: true } } }];
  const did = `service : { f : (principal, record { x : nat }) -> () }`;
  const bytes = encodeCall("f", `(principal "${ALICE}", record { x = 3 })`, did);
  const out = decodeArguments({ args: node }, bytes);
  assert.deepEqual(out, [ALICE, { x: "3", y: null }], "an optional field missing on the wire is absent");
});

test("decode: a field named like Object.prototype members stays an own property", () => {
  const node = { candid: "record", fields: { __proto__: undefined, toString: { candid: "nat" } } };
  Object.defineProperty(node.fields, "__proto__", { value: { candid: "nat" }, enumerable: true });
  const did = `service : { f : (record { toString : nat; __proto__ : nat }) -> () }`;
  const [v] = decodeArguments({ args: [node] }, encodeCall("f", `(record { toString = 1; __proto__ = 2 })`, did));
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(v, "__proto__").value, "2");
  assert.equal(v.toString, "1");
});

test("decode: refuses what the bytes cannot be (E_DECODE) and never guesses", () => {
  const good = encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 1 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`);
  const cases = {
    "empty input": new Uint8Array(0),
    "wrong magic": Uint8Array.from([1, 2, 3, 4, 0]),
    truncated: good.slice(0, good.length - 3),
    "trailing bytes": Uint8Array.from([...good, 0]),
    "an argument of the wrong type": encodeCall("f", `("text")`, "service : { f : (text) -> () }"),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.throws(() => decodeArguments(transfer, bytes), (e) => e instanceof ConsentError && e.code === "E_DECODE", name);
  }
});

test("decode: a missing required argument is refused", () => {
  const none = encodeCall("f", `()`, "service : { f : () -> () }");
  assert.throws(() => decodeArguments(transfer, none), (e) => e instanceof ConsentError && e.code === "E_DECODE");
});

test("decode: extra trailing arguments on the wire are ignored, as the canister would", () => {
  const two = encodeCall("f", `(principal "${ALICE}", "extra")`, "service : { f : (principal, text) -> () }");
  assert.deepEqual(decodeArguments({ args: [{ candid: "principal" }] }, two), [ALICE]);
});

test("decode: size limits are enforced and reported as E_TOO_LARGE", () => {
  const big = new Uint8Array(3 * 1024 * 1024);
  assert.throws(() => decodeArguments(transfer, big), (e) => e.code === "E_TOO_LARGE");
  const long = encodeCall("f", `(vec { ${Array.from({ length: 50 }, (_, i) => i).join("; ")} })`, "service : { f : (vec nat) -> () }");
  assert.throws(() => decodeArguments({ args: [{ candid: "vec", element: { candid: "nat" } }] }, long, { maxElements: 10 }), (e) => e.code === "E_TOO_LARGE");
});

test("decode: positions the resolved form cannot type are refused, not guessed (E_UNSUPPORTED_TYPE)", () => {
  const bytes = encodeCall("f", `(null)`, "service : { f : (null) -> () }");
  for (const node of [{ candid: "record", recursive: true }, { candid: "func" }, { candid: "service" }, { candid: "vec", recursive: true }]) {
    assert.throws(() => decodeArguments({ args: [node] }, bytes), (e) => e instanceof ConsentError && e.code === "E_UNSUPPORTED_TYPE", node.candid);
  }
});

test("decode: a cut refuses the call only when the call's value reaches it (spec section 12, rule 12)", () => {
  // the shape of NNS manage_neuron: a cycle in one case, a call that uses another case
  const did = `type Tree = variant { Leaf : nat; Node : record { left : Tree; right : Tree } };
    service : { f : (variant { Plain : nat; Deep : Tree }, opt Tree, vec Tree) -> () }`;
  const cut = { candid: "variant", recursive: true };
  const method = {
    args: [{ candid: "variant", cases: { Plain: { candid: "nat" }, Deep: cut } }, { ...cut, optional: true }, { candid: "vec", element: cut }],
  };
  const call = (text) => decodeArguments(method, encodeCall("f", text, did));
  assert.deepEqual(call(`(variant { Plain = 5 }, null, vec {})`), [{ tag: "Plain", value: "5" }, null, []], "no value at a cut: decoded");
  for (const [text, at] of [
    [`(variant { Deep = variant { Leaf = 1 } }, null, vec {})`, "argument 0.Deep"],
    [`(variant { Plain = 5 }, opt variant { Leaf = 1 }, vec {})`, "argument 1"],
    [`(variant { Plain = 5 }, null, vec { variant { Leaf = 1 } })`, "argument 2[0]"],
  ]) {
    assert.throws(() => call(text), (e) => e instanceof ConsentError && e.code === "E_UNSUPPORTED_TYPE" && e.message.startsWith(`${at}: `), text);
  }
  // the bytes at an unused cut are skipped, never read as some type: a wrong type there still decodes the rest exactly
  const other = encodeCall("f", `(variant { Plain = 5 }, null, vec {})`, "service : { f : (variant { Plain : nat; Deep : text }, opt nat, vec bool) -> () }");
  assert.deepEqual(decodeArguments(method, other), [{ tag: "Plain", value: "5" }, null, []]);
});

test("decode: every update method of the ICRC packs decodes its own didc encoding", () => {
  const cases = {
    icrc1_transfer: [icrc1, `(record { to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`],
    icrc2_approve: [icrc2, `(record { spender = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; expires_at = opt (9 : nat64); expected_allowance = null; memo = null; fee = null; from_subaccount = null; created_at_time = null })`],
    icrc2_transfer_from: [icrc2, `(record { from = record { owner = principal "${ALICE}"; subaccount = null }; to = record { owner = principal "${BOB}"; subaccount = null }; amount = 5 : nat; spender_subaccount = null; memo = null; fee = null; created_at_time = null })`],
  };
  for (const [method, [resolved, text]] of Object.entries(cases)) {
    const [arg] = decodeArguments(resolved.methods[method], encodeCall(method, text));
    assert.equal(arg.amount, "5", method);
  }
});

test("decode: arbitrary bytes either decode or raise a ConsentError (nothing else escapes)", () => {
  let seed = 20261009;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 3000; i++) {
    const bytes = new Uint8Array(Math.floor(rnd() * 64));
    for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rnd() * 256);
    if (rnd() < 0.5 && bytes.length > 4) bytes.set([0x44, 0x49, 0x44, 0x4c]); // "DIDL": get past the magic often
    try {
      decodeArguments(transfer, bytes);
    } catch (e) {
      assert.ok(e instanceof ConsentError, `seed 20261009 iteration ${i}: ${e?.stack ?? e}`);
    }
  }
});
