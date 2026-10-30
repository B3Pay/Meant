# Meant profiles

**What a canister call means, written down once: units, intent, risk, retry safety and outcomes, for agents,
wallets and the people who approve their calls.**

A Candid interface says `amount : nat`. It does not say that 1 ckBTC is 10^8 base units, that `created_at_time` is in
nanoseconds and makes a retry safe, or that `Err.Duplicate` means the payment already went through. Agents, wallets
and UIs each guess. A profile writes that meaning down once, bound to the interface, and Meant generates from it:

- **Agent tools:** amounts in human units, checked exactly (too many decimals is an error, never a rounding), filled
  defaults, a preview a person confirms, retries that cannot pay twice, and classified outcomes.
- **ICRC-21 consent messages** for any method, not just `icrc1_transfer`.
- **Display and input formatting** for web UIs.

This folder holds the spec, Candid Profile v0, with its JSON Schema, the standard packs for ICRC-1, ICRC-2 and ERC-20, and the
`@meantjs` packages that read them. Profiles bind to the interface ids of [`meant`](../README.md), the compiler from
`.did` to a canonical Contract graph at the root of this repository (`@candid-core/schema` and `@candid-core/cli` on
npm). Meant is a B3Pay project.

## Status

- The spec is **Draft 0.2**. Breaking changes are expected until the preregistered eval reports; its tasks stay
  private so that no model trains on them.
- **0.5.0 is on npm** (2026-10-30), published from this repository with provenance (`docs/releasing.md`).
- **Terms the user confirms** (spec §5.3, since 0.4.0): a profile says what a transfer or approve grants (who may take
  the tokens, how many, until when), and `@meantjs/consent/terms` checks a request against terms the user confirmed
  for one task, so a request that fits them needs no second yes and one that does not is refused with its reasons.
- **x402 payments** (spec §15.9, since 0.5.0): profiles of USDC's EIP-3009 authorizations and of x402's Permit2
  payment. A new tag, `fixed`, pins that payment's spender to x402's proxy, the contract that sends the tokens to the
  payee the signature names, so the grant names the payee; consent refuses a request whose pinned field holds another
  address (`E_FIXED`).
- **Internet Computer first; EVM contracts experimental** (spec §15, on npm since 0.2.0). A profile can describe an EVM
  contract's functions and, since 0.3.0, the EIP-712 messages it asks a wallet to sign (Permit, Permit2). From it come
  consent text for a call or a signature and an ERC-7730 clear-signing file with its ERC-8176 `descriptorHash`. Agent
  tools for EVM calls, and Solana, are planned, not supported.
- **Try it** in B3Forge: open the [playground](https://forge.b3pay.net/playground), fetch any ICRC ledger by its
  canister id and switch to Profile.
- **See it next to the usual tools:** [`examples/meant-vs-native`](examples/meant-vs-native) runs the published
  packages against hand-written code, viem, ethers, @dfinity/utils, @icp-sdk/canisters and the DFINITY ledger's own
  ICRC-21 endpoint, on PocketIC, and writes [what it found](examples/meant-vs-native/results.md).

## Packages

| Package | What it does |
|---|---|
| [`@meantjs/profile`](packages/resolver) | Validates profiles, matches packs to a service, merges layers and emits the resolved form that consumers read; the `candid-profile` CLI |
| [`@meantjs/format`](packages/format) | Exact parse and display for the six value tags: `amount`, `timestamp`, `duration`, `account`, `subaccount` and `bytes` |
| [`@meantjs/consent`](packages/consent) | ICRC-21 consent messages for any method, from a resolved form and the Candid-encoded arguments; for an EVM contract, consent text for calldata and the ERC-7730 file (experimental) |
| [`@meantjs/tools`](packages/tools) | MCP tool definitions, input in human units, a preview a person confirms before every send, and the retry and reconcile rules |
| [`@meantjs/reconcile`](packages/reconcile) | After an unknown outcome, before any new attempt: is the original already in the ledger's ICRC-3 history? |

The five libraries release together under one version and pin each other exactly ([releasing](docs/releasing.md)).

## Quick start

```sh
cd profile
npm ci
npm run validate   # checks packs/*.profile.json and examples/ against the schema and their Candid interfaces
npm test
```

```
PASS packs/icrc1.profile.json  (0 error, 0 warning, 0 info)
     profile_id   candid-profile:v0:sha256:4eaa9312…
     interface_id candid-core:interface:v1:sha256:7fae0dd3…  [5 methods, 29 annotations]
```

A profile annotation looks like this:

```json
{ "at": "icrc1_transfer(0).amount", "tag": "amount",
  "args": { "decimals": { "from": "query:icrc1_decimals" }, "symbol": { "from": "query:icrc1_symbol" } } }
```

A canister can serve its own profile as the public custom section `icp:public candid:profile`, which a client reads
with `candid:service` in one certified request (spec section 8.1).

## Read next

| | |
|---|---|
| [`docs/profile-v0.md`](docs/profile-v0.md) | The spec: addresses, the 19 tags, templates, binding, precedence, security |
| [`spec/profile-v0.schema.json`](spec/profile-v0.schema.json) | The JSON Schema of a profile |
| [`packs/`](packs) | The standard packs, ICRC-1 and ICRC-2 |
| [`docs/open-questions.md`](docs/open-questions.md) | What is not settled yet |
| [`docs/releasing.md`](docs/releasing.md) | How the packages are versioned and published |

Decision numbers such as D-045, and some notes in the sources, point at the project's decision log and design notes,
which are not public yet.

## How this folder is made

It is a reviewed copy of the project's working repository, which also holds the eval. Each update arrives as one pull
request that replaces this folder and the workflows `profile-ci.yml` and `npm-release-profile.yml`, and a check
refuses any copy that holds the eval's private tasks. Issues and pull requests are welcome: a maintainer applies an
accepted change upstream, and the next update brings it back here. A change made only here is undone by the next
update.

## License

Apache-2.0 ([LICENSE](LICENSE)).
