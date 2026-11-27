<p align="center">
  <a href="https://b3pay.net/docs/meant/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="website/assets/meant-lockup-dark.svg">
      <img alt="Meant" src="website/assets/meant-lockup-light.svg" width="194" height="48">
    </picture>
  </a>
</p>

<p align="center">
  <strong>What you meant is what runs.</strong><br>
  The meaning layer for contract calls and signing requests, EVM first: what each value means,<br>
  what each call or signature grants, and what an AI agent's key may sign.
</p>

<p align="center">
  <a href="https://b3pay.net/docs/meant/">Docs</a> ·
  <a href="https://b3pay.net/docs/meant/quickstart-evm.html">Quickstart</a> ·
  <a href="#packages">Packages</a> ·
  <a href="https://b3pay.net/docs/meant/status.html">Status</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

An x402 payment asks a wallet to sign `value: 25000000`. The EIP-712 request does not say that
USDC counts in units of 10<sup>-6</sup>, so that is 25 USDC, nor that the signature pays `to` once
and whoever holds it can submit it. A wallet shows the raw numbers, and an AI agent's key signs
whatever it is handed. A Candid interface has the same gap: `amount : nat` does not say that 1 ICP
is 10<sup>8</sup> base units.

A **profile** bound to a contract's interface writes the meaning down once, and from it come:

- **A guard in front of an AI agent's EVM signer.** The person confirms a task's terms once, on
  the wallet's own screen; the key then signs only an EIP-712 request a profile reads and whose
  grant fits those [terms](https://b3pay.net/docs/meant/confirmed-terms.html). Profiles for x402,
  Permit2, EIP-2612, DAI's permit and USDC ship with it.
- **Consent text.** For an EIP-712 signing request, matched by its type hash; experimental for EVM
  calls and ERC-7730 clear-signing files; ICRC-21 messages for any method on the Internet Computer.
- **Agent tools** (Internet Computer). Amounts in human units, converted exactly, a preview the
  person confirms before every send, retries that cannot pay twice, and a class for every result.
- **Display and input formatting** for amounts, times, durations, accounts, subaccounts and bytes,
  by one rule that refuses excess precision rather than rounding it.

## How it works

| Step | What happens |
| --- | --- |
| **1. Read** | An ABI and its EIP-712 types, or a `.did`, become a validated graph with an `interface_id`. |
| **2. Describe** | A profile bound to that id says what each value means and what each call or signature grants. |
| **3. Confirm** | The owner confirms a task's terms once. The model never does. |
| **4. Guard** | The key signs only a request that fits those terms; consent text shows what it does. |

## Quick start

**EVM signing.** Check an x402 payment against the terms the person confirmed:

```sh
npm install --save-exact @meantjs/profile@0.9.0 @meantjs/consent@0.9.0
```

```js
import { createSchemaValidator, validateProfile } from "@meantjs/profile";
import { eip712Consent } from "@meantjs/consent/evm";
import { readTerms, termsGate } from "@meantjs/consent/terms";
import usdc from "@meantjs/profile/packs/usdc-domain-usdc.profile.json" with { type: "json" };

const { resolved } = await validateProfile(usdc, { validateSchema: await createSchemaValidator(), resolved: true });
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const wallet = {
  tokens: { USDC: { address: USDC, decimals: 6 } },
  apps: { "Weather API": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" },
  now: BigInt(Date.parse("2025-02-27T16:00:00Z")) * 1_000_000n,
};

// The person confirms the task's terms once, on the wallet's own screen.
const gate = termsGate();
gate.confirm(gate.propose(readTerms({ token: "USDC", to: "Weather API", max_amount: "0.05", expires_by: "1 day" }, wallet)));
gate.read();

// The API's 402 answer asks for 25 USDC instead of 0.01 (x402's EIP-3009 example, Base Sepolia).
const typedData = {
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] },
  primaryType: "TransferWithAuthorization",
  domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
  message: {
    from: "0x857b06519E91e3A54538791bDbb0E22373e36b66", to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    value: "25000000", validAfter: "1740672089", validBefore: "1740672154",
    nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
  },
};
const consent = eip712Consent({ resolved, typedData, chainId: 84532 });
console.log(gate.check(consent.grant, wallet, consent.digest));
// { fits: false, reasons: [ 'the request allows 25 USDC, the terms say at most 0.05 USDC' ] }
```

`guardSigner` from `@meantjs/consent/guard` puts the same check inside a viem account or x402's
client signer, so that the agent cannot sign anything else.

**Values.** Read and show values exactly:

```sh
npm install --save-exact @meantjs/format
```

```js
import { parseAmount } from "@meantjs/format";

parseAmount("1.5 ICP", { decimals: 8, symbol: "ICP" }); // "150000000"
parseAmount("1.123456789", { decimals: 8 }); // throws E_EXCESS_PRECISION: never rounded
```

**Candid in TypeScript**, with no Rust toolchain:

```sh
npm install --save-exact @meantjs/schema
npm install --save-dev --save-exact @meantjs/cli   # .did to TypeScript
```

**Candid in Rust:**

```toml
[dependencies]
meant = "=0.1.0"
```

From a clone of this repository, the `meant` binary compiles a `.did` file and validates a Contract:

```sh
cargo run --bin meant -- compile ./service.did
cargo run --bin meant -- validate ./contract.json
```

Each has a quickstart on the site: [EVM signing](https://b3pay.net/docs/meant/quickstart-evm.html),
[profiles](https://b3pay.net/docs/meant/quickstart-profiles.html),
[TypeScript](https://b3pay.net/docs/meant/quickstart-typescript.html) and
[Rust](https://b3pay.net/docs/meant/quickstart-rust.html).

## Packages

| Package | Version | What it is |
| --- | --- | --- |
| [`meant`](docs/interface-layer.md) | [![crates.io](https://img.shields.io/crates/v/meant)](https://crates.io/crates/meant) | The Rust compiler and model: a `.did` file to a canonical, validated Contract graph with content-addressed identities, and the `meant` binary |
| [`@meantjs/schema`](crates/meant-ts/ts/) | [![npm](https://img.shields.io/npm/v/@meantjs/schema)](https://www.npmjs.com/package/@meantjs/schema) | Typed schemas, validation and a Candid binary codec from the same graph, with no runtime dependencies |
| [`@meantjs/cli`](crates/meant-wasm/npm/) | [![npm](https://img.shields.io/npm/v/@meantjs/cli)](https://www.npmjs.com/package/@meantjs/cli) | The compiler and generator as WebAssembly: a `.did` file to a TypeScript module, with no Rust toolchain |
| [The profile packages](profile/) | [![npm](https://img.shields.io/npm/v/@meantjs/profile)](https://www.npmjs.com/package/@meantjs/profile) | The Meant Profile spec, its standard packs, and five packages released together, `@meantjs/profile`, `format`, `consent`, `tools` and `reconcile`, which resolve profiles and generate consent text, a signer's guard, tools and formatting from them |
| [`meant-format`](crates/meant-format/) | [![crates.io](https://img.shields.io/crates/v/meant-format)](https://crates.io/crates/meant-format) | The profile's `amount` tag in Rust, with no dependencies and `no_std` |

The crates and the two npm families version independently.

## Status

Everything here is pre-1.0. Any release before 1.0 may change the public API, the serialized
shapes, the canonical bytes and every identity computed over them, so pin exact versions:
`meant = "=0.1.0"`, `npm install --save-exact`. The profile spec is Draft 0.2; a breaking change
to anything stable within v0 is a decision row and a breaking-change note in the changelog.

- **EVM contracts:** what a signer's guard uses is stable within v0 (D-065): profiles of EIP-712
  messages, x402 and Permit2 included, their consent text, what a signature grants, and the
  terms check and guard. ABI calls, the ERC-20 pack and ERC-7730 files are experimental.
- **Internet Computer:** supported. Candid interfaces, the ICRC-1 and ICRC-2 packs, ICRC-21
  consent, agent tools, reconcile and PocketIC.
- **Solana:** planned, not supported yet.

> **Renamed.** The crate `candid-core` is now `meant` (`use meant::…`, binary `meant`), and the
> npm pair `@candid-core/schema` and `@candid-core/cli` is now `@meantjs/schema` and
> `@meantjs/cli`, whose command is `meant`. The Contract format and its `candid-core:` identity
> prefixes are unchanged. [Details](docs/interface-layer.md#name-and-version).

## Documentation

- **[The website](https://b3pay.net/docs/meant/):** what Meant is, the quickstarts, the guides and
  the reference.
- **[The interface layer in detail](docs/interface-layer.md):** what each identity claims, the
  command line, Cargo features, browsers and WASM, the platform APIs and bounded parsing.
- **[Profiles](profile/README.md):** the spec, the standard packs and the five packages.
- **Design:** [architecture](docs/architecture.md), [the Contract graph](docs/contract-graph.md),
  [canonicalization v1](docs/canonicalization-v1.md),
  [artifact identity v1](docs/artifact-identity-v1.md),
  [doc attributes v1](docs/doc-attributes.md) and the [foundation ADRs](docs/adrs/README.md).
- **Evidence:** [release verification gates](docs/verification.md) and
  [benchmarks](docs/benchmarks.md).
- **Releases:** the [changelog](CHANGELOG.md) and [how a release is made](docs/releasing.md).

## Repository layout

```text
src/                  the meant crate: model, validation, canonicalization, compiler, CLI
examples/             runnable Rust examples
crates/meant-ts/      the TypeScript generator; @meantjs/schema is in ts/
crates/meant-wasm/    @meantjs/cli, the compiler and generator as WebAssembly
crates/meant-format/  meant-format, the amount tag in Rust
profile/              the profile spec, packs and packages (a synced copy, see below)
website/              the source of b3pay.net/docs/meant
docs/                 design documents, ADRs, verification and release procedures
tests/, benches/      the test suites and the benchmarks
fuzz/                 the fuzz targets, a workspace of their own
```

## Contributing

Issues and pull requests are welcome. `profile/` and its two workflows are a synced copy of the
profile's working repository, so a maintainer applies an accepted change there and the next sync
brings it back ([how that folder is made](profile/README.md#how-this-folder-is-made)). The checks to
run before a pull request are in [CLAUDE.md](CLAUDE.md#verification-battery).

## License

Apache-2.0 ([LICENSE](LICENSE)). Meant is a B3Pay project.
