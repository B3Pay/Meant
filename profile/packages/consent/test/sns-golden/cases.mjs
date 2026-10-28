// SNS validator rendering cases: what voters would read for one ExecuteGenericNervousSystemFunction payload each.
//
// `source` picks the resolved form: "icrc1" / "icrc2" are the committed pack fixtures (a DAO-held balance on another
// ledger, moved by a generic function that calls the ledger), "dapp" is test/fixtures/sns-dapp.did with its author
// profile, "bare" is the same dapp with no profile. `encodeAs` encodes the arguments for another method than the one
// the validator is registered for. Every `expect` was worked out by hand; hex is computed with Buffer, not the library.

import { ALICE, BOB, SPENDER } from "../helpers.mjs";

/** The new ledger the dapp is pointed at (a canister id made for the tests). */
export const NEW_LEDGER = "elndr-fyaaa-aaaaa-accjq-cai";
/** The hypothetical dapp's own canister id (made for the tests). */
export const DAPP_ID = "emmff-iaaaa-aaaaa-accja-cai";

const INJECTION = `x\n\n## Payload sha256: \n\n${"0".repeat(64)}\n\n## Payload:\n\nAll good, vote yes`;
const HOSTILE = "**Approved** [details](https://evil.example) <img src=x>";

export const CASES = [
  {
    id: "transfer-tka-basic",
    why: "A balance the DAO holds on another ledger, moved by a generic function that calls icrc1_transfer: the pack's words, the amount in TKA, base units in the Candid block.",
    source: "icrc1",
    ledger: "TKA",
    method: "icrc1_transfer",
    args: `(record { to = record { owner = principal "${BOB}"; subaccount = null }; amount = 150_000_000 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    expect: { title: "Send tokens", sentence: `Send \`1.5 TKA\` to \`${BOB}\``, effect: "transfer, irreversible", raw: ["amount = 150000000", `owner = principal "${BOB}"`] },
  },
  {
    id: "transfer-tkb-heading-injection",
    why: "A memo that imitates governance's own `## Payload sha256:` and `## Payload:` headings. It has line breaks, so it is shown as hex (spec section 5.3) and adds no heading.",
    source: "icrc1",
    ledger: "TKB",
    method: "icrc1_transfer",
    args: `(record { to = record { owner = principal "${BOB}"; subaccount = null }; amount = 1_000 : nat; memo = opt blob "${[...Buffer.from(INJECTION)].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"; fee = null; from_subaccount = null; created_at_time = null })`,
    expect: { title: "Send tokens", sentence: `Send \`0.001 TKB\` to \`${BOB}\` with memo \`0x${Buffer.from(INJECTION).toString("hex")}\``, effect: "transfer, irreversible", raw: ["amount = 1000"], memo: `0x${Buffer.from(INJECTION).toString("hex")}` },
  },
  {
    id: "transfer-tkc-hostile-memo",
    why: "A memo with Markdown emphasis, a link and HTML on one line: one inert code span, nothing parsed.",
    source: "icrc1",
    ledger: "TKC",
    method: "icrc1_transfer",
    args: `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 123_456_789_012_345_678 : nat; memo = opt blob "${HOSTILE.replace(/"/g, '\\"')}"; fee = null; from_subaccount = null; created_at_time = null })`,
    expect: { title: "Send tokens", sentence: `Send \`0.123456789012345678 TKC\` to \`${ALICE}\` with memo \`${HOSTILE}\``, effect: "transfer, irreversible", raw: ["amount = 123456789012345678"], memo: HOSTILE },
  },
  {
    id: "approve-tkb-expiry",
    why: "An approval with an expiry: the time in UTC in the generic layout, nanoseconds in the Candid block.",
    source: "icrc2",
    ledger: "TKB",
    method: "icrc2_approve",
    args: `(record { spender = record { owner = principal "${SPENDER}"; subaccount = null }; amount = 5_000_000 : nat; expires_at = opt (1_791_547_200_000_000_000 : nat64); expected_allowance = null; memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    expect: {
      title: "Approve spending",
      sentence: `Set \`${SPENDER}\`'s allowance to \`5 TKB\`, replacing any existing allowance until \`2026-10-09 12:00:00 UTC\``,
      effect: "approve, reversible",
      raw: ["amount = 5000000", "expires_at = opt 1791547200000000000"],
    },
  },
  {
    id: "dapp-pay-grant",
    why: "The dapp's own transfer method, described by its author profile.",
    source: "dapp",
    method: "pay_grant",
    args: `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 12_345_678_900 : nat; memo = opt blob "grant #42" })`,
    expect: { title: "Pay a grant", sentence: `Pay \`123.456789 GOV\` from the treasury to \`${ALICE}\` with memo \`grant #42\``, effect: "transfer, irreversible", raw: ["amount = 12345678900"] },
  },
  {
    id: "dapp-set-ledger",
    why: "An admin call with one principal argument: the template addresses the whole argument as {(0)}.",
    source: "dapp",
    method: "set_ledger",
    args: `(principal "${NEW_LEDGER}")`,
    expect: { title: "Change the token ledger", sentence: `Use the ledger \`${NEW_LEDGER}\` for all payments from now on`, effect: "admin, reversible", raw: [`(principal "${NEW_LEDGER}")`] },
  },
  {
    id: "dapp-set-claim-window",
    why: "Two timestamps in seconds, shown in UTC.",
    source: "dapp",
    method: "set_claim_window",
    args: "(record { opens_at = 1_791_547_200 : nat64; closes_at = 1_792_152_000 : nat64 })",
    expect: { title: "Set the claim window", sentence: "Accept claims from `2026-10-09 12:00:00 UTC` until `2026-10-16 12:00:00 UTC`", effect: "admin, reversible", raw: ["opens_at = 1791547200", "closes_at = 1792152000"] },
  },
  {
    id: "dapp-set-fee-bps",
    why: "An untagged number: Candid text, no unit invented.",
    source: "dapp",
    method: "set_fee_bps",
    args: "(250 : nat16)",
    expect: { title: "Change the claim fee", sentence: "Charge `250` basis points on each claim", effect: "admin, reversible", raw: ["(250)"] },
  },
  {
    id: "dapp-pause",
    why: "A method with no arguments: the sentence, no list, an empty Candid tuple.",
    source: "dapp",
    method: "pause",
    args: "()",
    expect: { title: "Pause the dapp", sentence: "Stop all claims and payments until a later proposal resumes them", effect: "admin, reversible", raw: ["()"] },
  },
  {
    id: "bare-pay-grant",
    why: "The same dapp with no profile: a generic title, every argument listed, and the effect said to be the default.",
    source: "bare",
    method: "pay_grant",
    args: `(record { to = record { owner = principal "${ALICE}"; subaccount = null }; amount = 12_345_678_900 : nat; memo = null })`,
    expect: { title: "Call pay_grant", sentence: null, effect: "write, irreversible (the default for an update; no profile states an effect)", raw: ["amount = 12345678900"] },
  },
  {
    id: "err-wrong-payload",
    why: "The payload of set_fee_bps sent to the validator of set_ledger: the bytes do not decode, so governance rejects the proposal.",
    source: "dapp",
    method: "set_ledger",
    encodeAs: "set_fee_bps",
    args: "(250 : nat16)",
    expect: { err: /^E_DECODE: / },
  },
  {
    id: "err-missing-ref",
    why: "A validator configured without the ledger's decimals: no amount is shown without its decimals, so the proposal is rejected.",
    source: "icrc1",
    ledger: "TKA",
    noRefs: true,
    method: "icrc1_transfer",
    args: `(record { to = record { owner = principal "${BOB}"; subaccount = null }; amount = 150_000_000 : nat; memo = null; fee = null; from_subaccount = null; created_at_time = null })`,
    expect: { err: /^E_REF_UNRESOLVED: / },
  },
  {
    id: "err-unknown-method",
    why: "A validator registered for a method the profile's interface does not have.",
    source: "dapp",
    method: "upgrade_protocol",
    encodeAs: "pause",
    args: "()",
    expect: { err: /^E_METHOD_UNKNOWN: / },
  },
];

/** Where the wrapped example of REVIEW.md points: the dapp's pay_grant, registered as generic function 1000. */
export const WRAPPED_EXAMPLE = { caseId: "dapp-pay-grant", target: DAPP_ID, targetMethod: "pay_grant", validator: DAPP_ID, validatorMethod: "validate_pay_grant" };
