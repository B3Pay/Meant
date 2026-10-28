// Differential test: for the same bytes, does the Rust candid crate (@dfinity/didc, what a canister decodes with)
// read the arguments of icrc1_transfer the same way as the codec this package uses? A consent message that
// describes a call differently from how the canister reads it would be worse than none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode } from "@dfinity/didc";
import { decodeArguments } from "../src/decode.mjs";
import { ALICE, BOB, LEDGER_DID, icrc1 } from "./helpers.mjs";

const transfer = icrc1.methods.icrc1_transfer;

/** Encode `value` against an ad-hoc signature, to produce bytes whose wire type differs from the ledger's. */
const wire = (recordType, value) =>
  Uint8Array.from(Buffer.from(encode({ idl: `service : { f : (${recordType}) -> () }`, input: `(${value})`, targetFormat: "hex", withType: { kind: "methodParams", name: "f" } }), "hex"));

const rustAccepts = (bytes) => {
  try {
    decode({ idl: LEDGER_DID, input: Buffer.from(bytes).toString("hex"), serviceMethod: "icrc1_transfer", useServiceMethodReturnType: false, inputFormat: "hex", targetFormat: "candid" });
    return true;
  } catch {
    return false;
  }
};
const ours = (bytes) => {
  try {
    return decodeArguments(transfer, bytes)[0];
  } catch (e) {
    if (e.name !== "ConsentError") throw e;
    return null;
  }
};

const to = `to : record { owner : principal; subaccount : opt blob }`;
const toV = `to = record { owner = principal "${BOB}"; subaccount = null }`;

const variants = {
  "the ledger's own signature": [`${to}; amount : nat`, `${toV}; amount = 5 : nat`],
  "fields in another order": [`amount : nat; ${to}`, `amount = 5 : nat; ${toV}`],
  "an extra field": [`${to}; amount : nat; extra : text`, `${toV}; amount = 5 : nat; extra = "x"`],
  "memo as a plain blob (S <: opt T)": [`${to}; amount : nat; memo : blob`, `${toV}; amount = 5 : nat; memo = blob "hi"`],
  "memo as opt text (the unusual opt rule)": [`${to}; amount : nat; memo : opt text`, `${toV}; amount = 5 : nat; memo = opt "hi"`],
  "memo as opt nat8": [`${to}; amount : nat; memo : opt nat8`, `${toV}; amount = 5 : nat; memo = opt (1 : nat8)`],
  "amount as nat64 (not a subtype of nat)": [`${to}; amount : nat64`, `${toV}; amount = 5 : nat64`],
  "amount as int": [`${to}; amount : int`, `${toV}; amount = 5 : int`],
  "amount as text": [`${to}; amount : text`, `${toV}; amount = "5"`],
  "amount as opt nat": [`${to}; amount : opt nat`, `${toV}; amount = opt (5 : nat)`],
  "amount missing": [`${to}`, `${toV}`],
  "to missing": [`amount : nat`, `amount = 5 : nat`],
  "to.owner as text": [`to : record { owner : text; subaccount : opt blob }; amount : nat`, `to = record { owner = "x"; subaccount = null }; amount = 5 : nat`],
  "to.subaccount as vec nat8 inside opt vec nat": [`to : record { owner : principal; subaccount : opt vec nat }; amount : nat`, `to = record { owner = principal "${ALICE}"; subaccount = opt vec { 1 : nat } }; amount = 5 : nat`],
  "fee as nat (S <: opt T)": [`${to}; amount : nat; fee : nat`, `${toV}; amount = 5 : nat; fee = 7 : nat`],
  "created_at_time as opt nat": [`${to}; amount : nat; created_at_time : opt nat`, `${toV}; amount = 5 : nat; created_at_time = opt (1 : nat)`],
};

for (const [name, [type, value]] of Object.entries(variants)) {
  test(`differential: ${name}`, () => {
    const bytes = wire(`record { ${type} }`, `record { ${value} }`);
    const rust = rustAccepts(bytes);
    const mine = ours(bytes);
    assert.equal(mine !== null, rust, `Rust candid ${rust ? "accepts" : "rejects"}; this package ${mine !== null ? "accepts" : "rejects"}`);
    if (mine !== null) assert.equal(mine.amount, "5");
  });
}

test("differential: the unusual opt rule reads a mismatched memo as absent, as the canister does", () => {
  const bytes = wire(`record { to : record { owner : principal; subaccount : opt blob }; amount : nat; memo : opt text }`, `record { ${toV}; amount = 5 : nat; memo = opt "hi" }`);
  assert.equal(rustAccepts(bytes), true);
  assert.equal(ours(bytes).memo, null);
});

test("differential: 3000 mutated encodings are accepted and rejected exactly as Rust candid does, and read the same amount", () => {
  const base = wire(`record { ${to}; amount : nat; memo : opt blob }`, `record { ${toV}; amount = 123456 : nat; memo = opt blob "memo" }`);
  let seed = 20261009;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  let both = 0;
  for (let i = 0; i < 3000; i++) {
    const bytes = Uint8Array.from(base);
    const edits = 1 + Math.floor(rnd() * 3);
    for (let e = 0; e < edits; e++) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.2 ? bytes.slice(0, Math.floor(rnd() * bytes.length)) : bytes;
    const mine = ours(cut);
    const rust = rustAccepts(cut);
    assert.equal(mine !== null, rust, `seed 20261009 iteration ${i}: ${Buffer.from(cut).toString("hex")} (Rust ${rust ? "accepts" : "rejects"})`);
    if (rust) {
      both++;
      const text = decode({ idl: LEDGER_DID, input: Buffer.from(cut).toString("hex"), serviceMethod: "icrc1_transfer", useServiceMethodReturnType: false, inputFormat: "hex", targetFormat: "candid" });
      // The amount, as Rust prints it (digits with underscores), equals ours.
      const rustAmount = /amount = ([0-9_]+) : nat/.exec(text)?.[1]?.replaceAll("_", "");
      assert.equal(rustAmount, mine.amount, `seed 20261009 iteration ${i}: ${Buffer.from(cut).toString("hex")}`);
    }
  }
  assert.ok(both > 100, `only ${both} mutated inputs were accepted by both; the test is not exercising enough`);
});
