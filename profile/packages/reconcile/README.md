# @meantjs/reconcile

Consumer rule 1 (`docs/profile-v0.md` section 5.3, outcome handling rules for consumers) without a transport: after an
unknown outcome, before any new attempt, is the original in the ledger's ICRC-3 history? One dependency:
`@meantjs/format` (principal text to bytes).

```sh
npm install @meantjs/reconcile
```

- **Runs on:** Node 22 or later and browsers: no Node built-in, no `Buffer` (`test/browser-bundle.test.mjs`).
- **Module format:** ES modules only, with hand-written TypeScript declarations for every entry.
- **Spec:** [Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md). **Licence:** Apache-2.0.
- **Versions:** the five Candid Profile packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`,
  `/reconcile`) release together under one version and pin each other exactly; in 0.x a minor is breaking,
  and so is any change to generated text ([releasing](https://github.com/B3Pay/Meant/blob/main/profile/docs/releasing.md)).

```js
import { expectedTransaction, matchBlocks } from "@meantjs/reconcile";

const expected = expectedTransaction("icrc1_transfer", arg, callerText, { minting });  // minting: icrc1_minting_account
// Read the blocks yourself (certified, archives followed): every index from `floor` to `logLength - 1`.
const r = matchBlocks(blocks, expected, { logLength, floor, inFlight: true, ledgerTime, windowNs });  // windowNs: the ledger's TX_WINDOW + PERMITTED_DRIFT
r.status; // "found" (r.block) | "absent" (r.closedBy) | "not_yet" (r.openUntil) | "unreadable" (r.reason, r.lookalike?)
```

| Input | Shape |
|---|---|
| `arg` | the call's argument record as candid-core values: `amount`, `created_at_time`, `fee` bigint; accounts `{ owner: <principal text>, subaccount: Uint8Array \| null }`; `memo` Uint8Array or null |
| `blocks` | `[{ id: bigint, block }]`, `block` an ICRC-3 value in `{ tag, value }` form (`Map`, `Array`, `Nat`, `Text`, `Blob`) |

Rules, all in the safe direction (`src/index.mjs` header):

- An absent field is part of the match: an empty memo is not no memo. An optional Nat (`fee`, `expires_at`,
  `expected_allowance`) in another shape equals nothing, not even an absent one.
- The operation is the block's `btype` when it has one (`1xfer`, `2xfer`, `1mint`, `1burn`, `2approve`; ICRC-3 makes
  it authoritative), else the legacy `tx.op`. An unknown `btype` matches nothing, and a `btype` that is present but
  not Text makes the block unreadable (no fallback to `tx.op`). A transfer also needs the btype its
  method leaves (`1xfer` for `icrc1_transfer`, `2xfer` for `icrc2_transfer_from`) when the block has one.
- A transfer from the minting account is a `mint`, one to it a `burn` (the same for a `transfer_from` from or to it);
  a spender's own `transfer_from` matches only under a `2xfer` btype, with or without `spender` in the block: ICRC-3 lets an `icrc1_transfer` block carry `tx.spender` too, so a legacy block (no btype) reads the same and is a lookalike. A mint or burn through `transfer_from` with no `spender` in the block stays a lookalike: another spender's call reads the same.
  A block with a `spender` the call does not have is another call.
- A legacy `xfer` block with neither `btype` nor `spender` is the `icrc1_transfer`'s, by the owner's decision of
  2026-10-19 (#29 review). ICRC-3 would also let another principal's `icrc2_transfer_from` with the caller's exact
  stamp, amount, accounts, fee and memo leave such a block, so the match accepts that case. **Fact:** the pinned
  DFINITY ledger writes no `btype` and records `spender` in every `transfer_from` block (the key set in
  `test/reconcile.test.mjs:1-6`), so there such a block can only be the transfer. Treating it as a lookalike would
  leave every `icrc1_transfer` on that ledger held for a person to review. In the accepted case the funds still moved
  where the call asked, so a `found` cannot pay twice.
- A call whose subaccount is not bytes maps to no block (`undefined`), so no side is dropped from the match.
- A block with the call's stamp and amount from the call's account (or from an account it cannot read) in another
  shape is a **lookalike**: `unreadable`
  with that block, never `absent`. An amount above u64::MAX counts as u64::MAX (the DFINITY ledger's u64 build caps
  an approval and writes the capped amount). A block of the same operation naming another recipient or spender is
  another call. `notOriginal` takes blocks the person rejected out of the next read.
- `absent` only when nothing can still land: every send answered (`answered`), a TooOld (`too_old`), or the
  ledger's clock past stamp + `windowNs` (`window_passed`). `windowNs` is the ledger's own window (spec section 5.3,
  `idempotency`: the ledger defines it); without it nothing closes by the clock and the answer is `not_yet` with a `reason`.
  `DEDUP_WINDOW_NS` (24 h 2 min, the DFINITY ledger's default) is exported for a caller that has checked its ledger
  uses it. Otherwise `not_yet`. Without a ledger clock, the later of `ledgerTimeAtLeast` and the tip block's time stands in.
- Blocks that do not cover `floor..logLength-1`, or a block in that range whose operation or amount (or stamp, when
  it has one) cannot be read, are `unreadable`.

Tests: `test/reconcile.test.mjs`, on blocks built in the shapes W2 recorded from the pinned DFINITY ledger wasm
(`docs/status/W2.md`, 2026-10-09). **Fact:** each rule above has a test that fails when the rule is removed
(memo lenience, mint mapping, u64 cap, the window, the coverage check, `btype`, the spender rule, unreadable blocks). **Not observed on a real ledger:** a `burn`,
a spender's own `transfer_from`, a mint through `transfer_from` and a `btype` block; they follow ICRC-1/2/3 as written.

Arm C's own matcher (`packages/mcp-adapters/src/arm-c/history.mjs`) does not use this module yet: that is an arm C
change under D-015, proposed in `docs/proposals/w3b-reconcile-module.md`.
