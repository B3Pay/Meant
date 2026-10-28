// Shared test fixtures: the two pack resolved forms, three ledgers, and candid-core's encoder for the ledger .did
// (built from the envelope W1's tests generated with @candid-core/cli 0.3.0).
import { readFileSync } from "node:fs";
import { schemaFromContract } from "@candid-core/schema/contract";
import { serviceMethods } from "@candid-core/schema";
import { encodeArgs } from "@candid-core/schema/codec";

const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
export const ICRC1 = json("../../../fixtures/icrc1.resolved.json");
export const ICRC2 = json("../../../fixtures/icrc2.resolved.json");
export const PACKS = [ICRC1, ICRC2];

const refs = (decimals, symbol) => ({ "query:icrc1_decimals": decimals, "query:icrc1_symbol": symbol });
export const LEDGERS = [
  { id: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "TKA", refs: refs(8, "TKA") },
  { id: "mxzaz-hqaaa-aaaar-qaada-cai", label: "TKB", refs: refs(6, "TKB") },
  { id: "ss2fx-dyaaa-aaaar-qacoq-cai", label: "TKC", refs: refs(18, "TKC") },
];

const loaded = schemaFromContract(json("../../resolver/test/fixtures/envelopes/ledger.envelope.json"));
if (!loaded.ok) throw new Error("the ledger envelope does not load");
export const METHODS = serviceMethods(loaded.actor);

/** candid-core's encodeArgs for a ledger method's single argument: the bytes ic-reactor sends. */
export function encodeArgsFor(method, value) {
  const r = encodeArgs(METHODS.get(method).args, value === undefined ? [] : [value]);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.issues)}`);
  return r.bytes;
}
