# Changelog: @meantjs/consent

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.2.0 (unreleased)

- A call takes the `intent` and `effect` of the deepest tagged variant case its arguments hold, else the method's
  (spec §5.2, D-053): the title, template and provenance of the message, the model's `effect` and the effect line
  of the SNS rendering. A resolved form without case tags renders as before. The Rust version does the same.
- EVM contracts, experimental (spec §15, D-054), in two new subpaths; the main entry is unchanged and refuses an EVM
  resolved form (`E_RESOLVED_FORM`).
  - `@meantjs/consent/evm`: `decodeCalldata` (strict) and `evmConsent`, the consent text of a call in the generic or
    fields form, ending with the contract's address and chain. A call to a contract its profiles do not list is
    `E_DEPLOYMENT`; a payable function is refused until its native value has a position.
  - `@meantjs/consent/erc7730`: `erc7730Descriptor`, the ERC-7730 clear-signing file of a contract (schema 2.1.0,
    deterministic) with its ERC-8176 `descriptorHash`; `descriptorHash`; `erc8176Attestation`, the unsigned EAS
    offchain attestation a reviewer signs, with its EIP-712 digest. What a file cannot say is refused (`E_EXPORT`).
  - New codes `E_DEPLOYMENT` and `E_EXPORT`. The Rust version does not cover EVM.

## 0.1.0 — 2026-10-28

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile-consent`.

- ICRC-21 consent messages for any method of a resolved form, as `GenericDisplayMessage` (Markdown) and
  `FieldsDisplayMessage`, values formatted by `@meantjs/format` and escaped, nothing rounded
  (`icrc21ConsentMessage`, `handleConsentRequest`, `generateConsent`).
- The ICRC-21 Candid codec (`encodeConsentRequest`, `decodeConsentResponse`, ...), built on `@candid-core/schema` 0.5.0.
- `./sns` (Node only): SNS generic-function validator renderings and the reviewer's check of a stored rendering.
- The main entry imports no Node built-in and runs in browsers.
- The argument bytes may be a `Uint8Array` or an `ArrayBuffer` from any realm (an iframe, an extension's content script),
  or an array of integers 0 to 255. An array with any other element is refused (`E_REQUEST`; `E_DECODE` from
  `decodeArguments` and the SNS rendering), where it used to be wrapped modulo 256 and described as other bytes.
- TypeScript declarations for both entries.
