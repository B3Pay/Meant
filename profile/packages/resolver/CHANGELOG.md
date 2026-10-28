# Changelog: @meantjs/profile

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.2.0 (unreleased)

- `intent` and `effect` may sit on a case of a variant in a method's arguments, such as `propose(0).Transfer`
  (spec §5.2, D-053). The resolved form carries them on the case node. New errors: `E_CASE_OVERLAP` (two tagged cases
  of one method that one call can hold both of) and `E_CASE_EFFECT` (a case effect that needs confirmation, or is
  irreversible, under a method effect that does not or is not); `E_TAG_TARGET` for a case tag at any other value
  address; `E_TEMPLATE_PATH` for a case template's placeholder through another case of a variant on its path. A
  profile that 0.1.0 accepts resolves as before.
- EVM contracts, experimental (spec §15, D-054). `kind: "contract"` profiles carry an ABI (`binds.abi`, human-readable
  fragments or JSON entries) and optional `binds.deployments`; EVM packs carry `binds.abi` and apply by selector, with
  their addresses and placeholders rewritten to the contract's parameter names. `resolveService({ abi })` and
  `candid-profile resolve --abi <file>` resolve a contract; its resolved form has `"chain": "evm"`, `abi` nodes, and
  each method's `selector`, `signature` and `state_mutability`. A new standard pack, `erc20`; `loadPacks()` and
  `STANDARD_PACKS` now list it first, and a Candid service skips it. New errors: `E_ABI`, `E_CHAIN`,
  `E_ADDRESS_CHECKSUM`; on a contract, `E_TAG_TARGET` for `idempotency`, `outcome`, `list`, `names` and `named`,
  `E_TAG_NOT_APPLICABLE` for `account` and `subaccount`, and `E_TEMPLATE` for `[ ]` segments.
- `@meantjs/profile/evm`, browser-safe and without dependencies: Keccak-256, ABI fragments (`parseAbi`,
  `parseSignature`, canonical text, selectors, `abiInterfaceId`), a strict ABI codec (`encodeParams`, `encodeCall`,
  `decodeParams`, which refuses anything but the canonical encoding), EIP-55 addresses (`toChecksumAddress`,
  `readAddress`) and EIP-712 digests (`typedDataDigest`).
- The schema: `amount` takes `threshold` and `message` (display only: a value at or above the threshold shows as the
  message and the symbol, "Unlimited USDC").

## 0.1.0 — 2026-10-28

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile`.

- Validates Candid Profile v0 documents against the schema and the service's Candid interface, matches packs by Candid
  subtyping (with the result-variant relaxation), merges layers by precedence and emits the resolved form
  (`resolveService`, `validateProfile`, `matchPack`).
- Takes the service as `.did` source (compiled with `@candid-core/cli` 0.4.0) or as its candid-core `ContractEnvelope`.
- Ships the profile schema and the ICRC-1 and ICRC-2 packs as data (`./schema.json`, `./packs/*`); the Node entry's
  defaults (`createSchemaValidator()`, `loadPacks()`, `candid-profile resolve --packs`) read these copies.
- Entries: `.` (Node), `./browser` (no Node built-in), `./address` (the address grammar, no dependency), and the
  `candid-profile` CLI.
- TypeScript declarations for every entry.
- Names (spec §5.3, D-045): the experimental `names` and `named` tags and their checks (six errors and
  `W_NAMED_UNPATTERNED`).
- Doc annotations (spec §9, proposal `docs/proposals/w1-doc-attributes.md`): `profileFromDocAttributes` turns the tags
  an author writes as `.did` doc comments, as candid-core's `didToDocAttributes` reads them, into an `author` canister
  profile. `DOC_ATTRIBUTES_VERSION` is the doc attributes version it reads (1). It needs a `@candid-core/cli` release
  after 0.3.0 to be fed from `.did` text.
- The shipped schema is compiled ahead of time (`data/profile-v0.validate.mjs`, ajv's standalone code), so
  `createSchemaValidator()` on it generates no code at run time: a page needs no CSP `'unsafe-eval'` (the cli's wasm
  needs `'wasm-unsafe-eval'`). Its answers equal ajv's run-time compile on every profile in the repository and tens of
  thousands of mutations of them. Another schema document is still compiled at run time, and ajv is loaded only then.
  Each validator keeps its own `errors`. The browser bundle grows from 189.5 KB to 265.6 KB minified.
- Served profiles (spec §8.1, D-048): `readServedProfile(bytes, { canisterId })` checks the bytes a canister serves
  as `icp:public candid:profile` (`E_SERVED` for anything but UTF-8 JSON of an `author` canister profile, at most
  1 MiB, bound to that canister or to none); `SERVED_SECTION`, `SERVED_METADATA` and `SERVED_MAX_BYTES` name the
  section, its metadata path and its limit. In both entries.
- An `outcome` may give `default` alone (spec §5.3, D-049): the class of every reply of a method whose result has no
  variant to select. The schema needs `classes` or `default`; on a result that reaches a variant, `default` alone
  leaves every case to the default (`W_OUTCOME_UNCLASSIFIED`, info).
