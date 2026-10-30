# Meant next to the usual tools

The same calls done three ways: by hand, with the libraries people use today (viem, ethers, @dfinity/utils,
@icp-sdk/canisters, and the DFINITY ledger's own ICRC-21 endpoint), and with the published `@meantjs` 0.3.0
packages and the `meant-format` 0.2.0 crate. One script runs them all, checks every claim below, and writes
[`results.md`](results.md).

```sh
npm ci
npm run fetch   # PocketIC 16.0.0 and the DFINITY ICRC ledger, every file sha256-checked against artifacts.json
npm start       # about 5 seconds; writes results.md
```

Node 22 or later. `cargo` is optional: with it, the amounts table gets a Rust column (`rust/`, `meant-format`
from crates.io, pinned in `rust/Cargo.lock`), and the run fails if the Rust crate and the JavaScript package ever
disagree. PocketIC is pinned for linux-x64 and darwin-arm64.

**No mainnet.** The ledgers are the pinned DFINITY ICRC ledger wasm (`ledger-suite-icrc-2026-03-09`) on a local
PocketIC instance, holding test tokens. While it runs, `fetch` refuses every host but this machine
(`src/world.mjs`). The EIP-712 keys are made for the run and thrown away. No eval task is used.

## What is compared

| Section | Same input for every tool | Measured |
|---|---|---|
| 1. Amounts (`src/units.mjs`) | 8 texts a person or an agent might write, on 8- and 18-decimal tokens | the base units each tool returns, or its refusal |
| 2. ICRC-21 consent (`src/consent.mjs`) | the same argument bytes of 6 calls | the raw Candid value, the text the DFINITY ledger itself returns, Meant's text |
| 3. EIP-712 (`src/eip712.mjs`) | 2 real signing requests (Permit2, DAI's permit) and 3 malicious variants | whether viem and ethers sign, what Meant shows or refuses, the digests |
| 4. Retry after a lost reply (`src/retry.mjs`) | one transfer whose reply is dropped after the ledger ran it, then one retry | how many times the ledger paid, what the caller was told |
| 5. Decimals (`src/retry.mjs`) | "send 1.5" on a 6-decimal ledger | what the recipient got |

## What it shows

Facts, observed in the run that wrote `results.md` (each one is checked by the run, so a run where it stops holding
fails):

- **The DFINITY ledger's own consent text rounds.** Its ICRC-21 endpoint shows `1.000000000000000001 TKC` (18
  decimals, like ckETH) as `1 TKC`, `1234567890.12345678 TKA` as `1234567890.1234567 TKA`, and an approval of
  2^128 - 1 base units as `3402823669209384700000000000000 TKA`. Its FieldsDisplay form refuses amounts above u64.
  Meant's text for the same bytes shows every amount exactly, from the ICRC-1 and ICRC-2 packs.
- **A lost reply and one retry pay twice.** With `IcrcLedgerCanister.transfer` and its default (no
  `created_at_time`), or a new stamp per attempt, Bob received 0.58 TKA for a 0.29 TKA payment. With a kept stamp
  the ledger paid once, and the app was told the transfer failed (`Duplicate`, thrown as an error). With
  `@meantjs/tools` the ledger paid once, the second commit sent the same bytes and answered `already_done`,
  preparing the call again returned the same preview, and `@meantjs/reconcile` found the original block.
- **Libraries disagree about what an amount means.** On an 8-decimal token, viem's `parseUnits` rounds
  `1.123456789` to `1.12345679` and turns `0.000000001` into 0; `TokenAmountV2.fromString` of @dfinity/utils reads
  `1,5` as 15. ethers refuses the first two. Meant refuses all three, in JavaScript and in Rust alike, and checks
  the symbol in `1.5 ICP` against the ledger's.
- **Signing libraries sign anything well-formed.** viem (local account) and ethers sign a Permit2 request for
  the wrong chain, for a contract one digit off Permit2's address, and for a struct named `PermitSingle` with
  another type hash. Meant refuses all three before showing anything, and shows the two valid requests in words
  ("Unlimited USDC", "Signature expires: Never") with the digest viem and ethers compute.
- **Decimals read, not assumed.** "1.5" sent with ICP's 8-decimal helper to a 6-decimal ledger paid 150 tokens.
  The profile names where decimals come from (`query:icrc1_decimals`), and the tools read them from the ledger.
- **Where the native way is better:** the ledger's own text names the sender and the fee; the packs' texts do not.

Assumptions:

- The "by hand" column and the 8-decimal helper are illustrations of known kinds of bugs, not measurements of any
  app.
- The rounding in the ledger's consent text looks like a conversion through a 64-bit float: the shown amounts keep
  15 to 17 significant digits.
- The ckETH and ckERC20 ledgers on mainnet run the same DFINITY ledger code, so their consent texts would round the
  same way. Not checked: this demo never talks to mainnet.

Open:

- Browser wallets (MetaMask, OISY and others) were not tested; they may check chains or contracts themselves.
- Whether Meant's tool words make agents safer is the preregistered eval's question. This run tests no model.
- The ledger's rounding could be reported to DFINITY (the owner's call).
