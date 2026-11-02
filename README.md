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
  The meaning layer for contract calls: what each value means, what each call does,<br>
  and what each result tells the caller to do next.
</p>

<p align="center">
  <a href="https://b3pay.net/docs/meant/">Docs</a> ·
  <a href="https://b3pay.net/docs/meant/quickstart-profiles.html">Quickstart</a> ·
  <a href="#packages">Packages</a> ·
  <a href="https://b3pay.net/docs/meant/status.html">Status</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

A Candid interface says `amount : nat`. It does not say that 1 ICP is 10<sup>8</sup> base units,
that `created_at_time` makes a retry safe, or that `Err.Duplicate` means the payment already went
through. Agents, wallets and UIs each guess.

Meant compiles the interface into a canonical graph with an identity. A **profile** bound to that
identity writes the meaning down once, and from it come:

- **Agent tools.** Amounts in human units, converted exactly (too many decimals is an error, never
  a rounding), a preview the person confirms before every send, retries that cannot pay twice, and
  a class for every result.
- **A guard in front of an EVM signer** (experimental). It signs only a typed message whose grant
  fits the terms the person [confirmed for the task](https://b3pay.net/docs/meant/confirmed-terms.html).
- **Consent messages.** ICRC-21 for any method, not only `icrc1_transfer`; for EVM contracts,
  consent text for calls and signatures and ERC-7730 clear-signing files (experimental).
- **Display and input formatting** for amounts, times, durations, accounts, subaccounts and bytes,
  by one rule that refuses excess precision rather than rounding it.

## How it works

| Step | What happens |
| --- | --- |
| **1. Compile** | The `.did` becomes a validated Contract graph with an `interface_id`. |
| **2. Describe** | A profile bound to that id says what each value means and what each call does. |
| **3. Generate** | Agent tools, consent messages and formatters come from the resolved profile. |
| **4. Confirm** | The owner approves the exact call. Retries cannot pay twice. |

## Quick start

**Profiles.** Read and show values exactly:

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

Each has a quickstart on the site: [profiles](https://b3pay.net/docs/meant/quickstart-profiles.html),
[TypeScript](https://b3pay.net/docs/meant/quickstart-typescript.html) and
[Rust](https://b3pay.net/docs/meant/quickstart-rust.html).

## Packages

| Package | Version | What it is |
| --- | --- | --- |
| [`meant`](docs/interface-layer.md) | [![crates.io](https://img.shields.io/crates/v/meant)](https://crates.io/crates/meant) | The Rust compiler and model: a `.did` file to a canonical, validated Contract graph with content-addressed identities, and the `meant` binary |
| [`@meantjs/schema`](crates/meant-ts/ts/) | [![npm](https://img.shields.io/npm/v/@meantjs/schema)](https://www.npmjs.com/package/@meantjs/schema) | Typed schemas, validation and a Candid binary codec from the same graph, with no runtime dependencies |
| [`@meantjs/cli`](crates/meant-wasm/npm/) | [![npm](https://img.shields.io/npm/v/@meantjs/cli)](https://www.npmjs.com/package/@meantjs/cli) | The compiler and generator as WebAssembly: a `.did` file to a TypeScript module, with no Rust toolchain |
| [The profile packages](profile/) | [![npm](https://img.shields.io/npm/v/@meantjs/profile)](https://www.npmjs.com/package/@meantjs/profile) | The Meant Profile spec, its standard packs, and five packages released together, `@meantjs/profile`, `format`, `consent`, `tools` and `reconcile`, which resolve profiles and generate tools, consent and formatting from them |
| [`meant-format`](crates/meant-format/) | [![crates.io](https://img.shields.io/crates/v/meant-format)](https://crates.io/crates/meant-format) | The profile's `amount` tag in Rust, with no dependencies and `no_std` |

The crates and the two npm families version independently.

## Status

Everything here is pre-1.0. Any release before 1.0 may change the public API, the serialized
shapes, the canonical bytes and every identity computed over them, so pin exact versions:
`meant = "=0.1.0"`, `npm install --save-exact`. The profile spec is Draft 0.2.

- **Internet Computer:** supported. Candid interfaces, the ICRC-1 and ICRC-2 packs, ICRC-21
  consent and PocketIC.
- **EVM contracts:** experimental. Profiles for Solidity ABIs and EIP-712 messages, x402 payments
  included, consent text for calls and signatures, and ERC-7730 files.
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
