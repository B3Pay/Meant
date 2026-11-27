# Meant profiles

**What a contract call or a signature means, written down once, for AI agents, wallets and the people who approve
them: on EVM chains first, and on the Internet Computer.**

An EIP-712 request says `uint256 amount` and `address spender`. It does not say that the amount is in USDC's 6
decimals, that this spender may take the tokens until next year, or that an x402 payment reaches its payee only when
the spender is x402's proxy. An AI agent that holds a key signs what it is handed. A profile writes that meaning down
once, bound to the contract, and Meant generates from it:

- **A guard in front of an agent's EVM signer** (`@meantjs/consent/guard`): it wraps a viem account or x402's client
  signer so that it signs only a request a profile reads and whose grant (token, spender or payee, most, until when)
  fits the terms the person confirmed for the task. Profiles ship for x402's `exact` and `upto` payments, Permit2,
  EIP-2612, DAI's permit and USDC's EIP-3009 messages.
- **Consent text and clear signing:** exact words for a signing request or a call, values never rounded (too many
  decimals is an error), and an ERC-7730 file with its ERC-8176 `descriptorHash`.
- **On the Internet Computer:** ICRC-21 consent messages for any method, and agent tools with amounts in human units,
  a preview a person confirms, retries that cannot pay twice and classified outcomes.
- **Display and input formatting** for web UIs, on both.

This folder holds the spec, Meant Profile v0, with its JSON Schema, the standard packs and contract profiles (ERC-20,
EIP-2612, Permit2, DAI's permit, USDC, x402; ICRC-1 and ICRC-2), and the `@meantjs` packages that read them. For a
canister, profiles bind to the interface ids of [`meant`](../README.md), the compiler from `.did` to a canonical
Contract graph at the root of this repository (`@meantjs/schema` and `@meantjs/cli` on npm); an EVM contract's
profile carries its own ABI and EIP-712 types. Meant is a B3Pay project.

## Status

- The spec is **Draft 0.2**, with two bindings (spec section 1.1): EVM contracts (section 15) and Internet Computer
  canisters. What the guard uses is stable within v0: EIP-712 messages and their consent text, what a request grants,
  the `fixed` pin, and the EIP-712 packs and contract profiles. ABI calls, the `erc20` pack and the ERC-7730 export
  are experimental. Breaking changes are expected before v1, each with a decision and a changelog entry.
- **0.8.0 is on npm** (2026-11-02), published from this repository with provenance (`docs/releasing.md`).
- **Put it in front of an agent's EVM key:** [`examples/evm-signing-check`](examples/evm-signing-check) is a
  signing check a wallet can copy, on `@meantjs/consent` and `@meantjs/profile` 0.8.0. It replays 16 x402 and Permit2
  requests on a local EVM that runs Base Sepolia's USDC, Permit2 and x402 code: the bare key signs all 11 bad ones,
  the check signs none of them and all 4 real ones ([the run](examples/evm-signing-check/results.md)).
- **The guard in front of a signer** (since 0.7.0): `@meantjs/consent/guard` wraps an EVM signer, a viem account or
  x402's client signer, so that it signs only a typed message whose grant fits the terms the user confirmed.
- **Terms the user confirms** (spec section 5.3, since 0.4.0): a profile says what a transfer or approve grants (who
  may take the tokens, how many, until when), and `@meantjs/consent/terms` checks a request against terms the user
  confirmed for one task, so a request that fits them needs no second yes and one that does not is refused with its
  reasons.
- **x402 payments** (spec section 15.9, since 0.5.0): profiles of USDC's EIP-3009 authorizations and of x402's
  Permit2 payments. The tag `fixed` pins that payment's spender to x402's proxy, the contract that sends the tokens to
  the payee the signature names, so consent refuses a request whose pinned field holds another address (`E_FIXED`).
  Since 0.6.0 they also read x402's usage-based `upto` payment, whose grant is the most it can cost, and USDC's
  EIP-2612 permit, which never ends, and they cover more of x402's networks.
- **EVM contracts and EIP-712 messages** (spec section 15, since 0.2.0 and 0.3.0): consent text for a call or a
  signature and an ERC-7730 clear-signing file with its ERC-8176 `descriptorHash`. Not yet on EVM: agent tools,
  outcomes over reverts, idempotency by nonce and reconcile from receipts. Solana is planned, not supported.
- **Internet Computer:** ICRC-21 consent messages for any method, agent tools and ICRC-3 reconcile. Ready for ICP MCP
  (spec section 8.2, since 0.7.0): `meant-profile api-doc` writes the text of a canister's `get_api_doc` query from
  its profile, and [`examples/icp-mcp`](examples/icp-mcp) is a canister that serves its profile, that guide and
  ICRC-21 consent messages from one profile. Since 0.8.0 the packages depend on the compiler under its new names,
  `@meantjs/cli` and `@meantjs/schema`.
- **Try it** in B3Forge: open the [playground](https://forge.b3pay.net/playground), fetch any ICRC ledger by its
  canister id and switch to Profile.
- **See it next to the usual tools:** [`examples/meant-vs-native`](examples/meant-vs-native) runs the published
  packages against hand-written code, viem, ethers, @dfinity/utils, @icp-sdk/canisters and the DFINITY ledger's own
  ICRC-21 endpoint, on PocketIC, and writes [what it found](examples/meant-vs-native/results.md).

## Packages

| Package | What it does |
|---|---|
| [`@meantjs/profile`](packages/resolver) | Validates profiles of an EVM contract (ABI, EIP-712 messages) or a Candid service, matches packs, merges layers and emits the resolved form that consumers read; ships the standard packs and contract profiles; the `meant-profile` CLI |
| [`@meantjs/format`](packages/format) | Exact parse and display for the six value tags (`amount`, `timestamp`, `duration`, `account`, `subaccount`, `bytes`), on EVM integers and Candid values |
| [`@meantjs/consent`](packages/consent) | For EVM: consent text for an EIP-712 signing request, the terms check and the guard in front of a signer; consent text for calldata and the ERC-7730 file (experimental). For a canister: ICRC-21 consent messages for any method |
| [`@meantjs/tools`](packages/tools) | For a canister (EVM calls not yet): MCP tool definitions, input in human units, a preview a person confirms before every send, and the retry and reconcile rules |
| [`@meantjs/reconcile`](packages/reconcile) | For an ICP ledger (EVM not yet): after an unknown outcome, before any new attempt, is the original already in its ICRC-3 history? |

The five libraries release together under one version and pin each other exactly ([releasing](docs/releasing.md)).

## Quick start

```sh
cd profile
npm ci
npm run validate   # checks packs/*.profile.json and examples/ against the schema and their interfaces
npm test
```

```
PASS packs/permit2.profile.json  (0 error, 0 warning, 0 info)
     profile_id   candid-profile:v0:sha256:145c940e…
     interface_id candid-profile:evm-abi:v0:sha256:e013c202…  [4 methods, 40 annotations]
```

A profile annotation looks like this, on Permit2's `PermitSingle` message: the amount is in the token
`details.token` names, and from 2^160 − 1 up it reads as unlimited.

```json
{ "at": "PermitSingle(0).details.amount", "tag": "amount",
  "args": { "token": "details.token", "threshold": "1461501637330902918203684832716283019655932542975" } }
```

On the Internet Computer the same tag reads a ledger's decimals and symbol from its own queries:

```json
{ "at": "icrc1_transfer(0).amount", "tag": "amount",
  "args": { "decimals": { "from": "query:icrc1_decimals" }, "symbol": { "from": "query:icrc1_symbol" } } }
```

A canister can serve its own profile as the public custom section `icp:public candid:profile`, which a client reads
with `candid:service` in one certified request (spec section 8.1).

## Read next

| | |
|---|---|
| [`docs/profile-v0.md`](docs/profile-v0.md) | The spec: two bindings (section 1.1), EVM contracts and EIP-712 messages (section 15), addresses, the 19 tags, templates, binding, precedence, security |
| [`spec/profile-v0.schema.json`](spec/profile-v0.schema.json) | The JSON Schema of a profile |
| [`packs/`](packs) | The standard packs and contract profiles: ERC-20, EIP-2612, Permit2, DAI's permit, USDC, x402; ICRC-1 and ICRC-2 |
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
