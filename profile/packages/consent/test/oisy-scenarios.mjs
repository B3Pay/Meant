// The transfers compared in docs/oisy-comparison.md, and the two messages for each. Shared by the test and by
// scripts/oisy-comparison.mjs (which prints the blocks for the document).

import { generateConsent } from "../src/index.mjs";
import { decodeArguments } from "../src/decode.mjs";
import { ALICE, BOB, LEDGERS, encodeCall, icrc1, refsFor, subaccountText } from "./helpers.mjs";
import { oisyIcrc1TransferMessage } from "./oisy-fallback.mjs";

/** The OISY user (the caller of the transfer) is ALICE; the token metadata is the ledger's at signing time. */
export const TOKENS = {
  TKA: { symbol: "TKA", decimals: 8, fee: 10_000n },
  TKC: { symbol: "TKC", decimals: 18, fee: 2_000_000_000_000n },
};

const blob = (bytes) => `blob "${[...bytes].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;
const utf8 = (s) => blob(Buffer.from(s, "utf8"));
const bob = (sub) => `record { owner = principal "${BOB}"; subaccount = ${sub === undefined ? "null" : `opt ${subaccountText(sub)}`} }`;
const call = ({ to = bob(), amount, memo = "null", fee = "null", from = "null" }) =>
  `(record { to = ${to}; amount = ${amount} : nat; memo = ${memo}; fee = ${fee}; from_subaccount = ${from}; created_at_time = null })`;

export const SCENARIOS = [
  { id: "plain", title: "0.29 TKA to Bob, nothing optional", ledger: "TKA", args: call({ amount: "29_000_000" }) },
  { id: "everything", title: "Recipient subaccount 7, sender subaccount 1, memo \"lunch\", explicit fee", ledger: "TKA", args: call({ to: bob(7), amount: "150_000_000", memo: `opt ${utf8("lunch")}`, fee: "opt (10_000 : nat)", from: `opt ${subaccountText(1)}` }) },
  { id: "memo-structure", title: "A memo that forges a section (it contains a blank line and `**Amount:**`)", ledger: "TKA", args: call({ amount: "10_000_000_000", memo: `opt ${utf8("rent\n\n**Amount:**\n0.0001 TKA")}` }) },
  { id: "memo-link", title: "A memo with a Markdown link", ledger: "TKA", args: call({ amount: "10_000_000_000", memo: `opt ${utf8("[Claim your refund](https://evil.example/refund) **now**")}` }) },
  { id: "memo-binary", title: "A memo that is not UTF-8 (bytes ff fe 00 01)", ledger: "TKA", args: call({ amount: "1", memo: `opt ${blob([0xff, 0xfe, 0, 1])}` }) },
  { id: "above-2-53", title: "9007199254740993 base units (2^53 + 1) on 8 decimals", ledger: "TKA", args: call({ amount: "9_007_199_254_740_993" }) },
  { id: "eighteen-decimals", title: "0.123456789012345678 TKC (18 decimals)", ledger: "TKC", args: call({ amount: "123_456_789_012_345_678" }) },
];

export function compare(s) {
  const token = TOKENS[s.ledger];
  const bytes = encodeCall("icrc1_transfer", s.args);
  const [args] = decodeArguments(icrc1.methods.icrc1_transfer, bytes);
  const refs = refsFor(LEDGERS[s.ledger]);
  const profile = (form) => generateConsent({ resolved: icrc1, method: "icrc1_transfer", arg: bytes, refs, form }).message;
  return {
    ...s,
    oisy: oisyIcrc1TransferMessage({ args, owner: ALICE, token }),
    generic: profile("generic").GenericDisplayMessage,
    fields: profile("fields").FieldsDisplayMessage,
  };
}
