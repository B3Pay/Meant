# Changelog: @meantjs/consent

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.4.0 — 2026-10-30

- What a request grants (spec §5.3, D-056). `evmConsent`, `eip712Consent` and `generateConsent` also return `values`,
  the decoded arguments or message, and `grant`: who may take tokens because of the request, which token, how many
  and until when, read from the effect's `grant` (`{ kind, spender | to, token, amount: { units, unlimited }, ends }`),
  or null. Addresses are EIP-55, accounts their ICRC-1 text, units a decimal string and ends exact seconds, never
  rounded. A grant that cannot be read is null with a `W_GRANT` diagnostic, and the text is the same.
  `generateConsent` takes `canisterId`, the ledger called, and reads the grant only then, so an ICRC-21 message is
  unchanged.
- `@meantjs/consent/terms`, new: terms the user confirms for one task, and the check of a request's grant against them
  (spec §5.3, "Confirmed terms"; §11 item 10). `readTerms` reads an agent's terms in the wallet's values (a token by
  its symbol, an app by its name, an amount never rounded, an end as a date, a length, hours or "never") or throws a
  `TermsError` with a message for the agent; `termsText` writes them out exactly for the wallet's own screen;
  `confirmTerms` freezes them with an id; `checkGrant` says whether a grant fits, and why not; `termsGate` keeps the
  order (confirmed before the request is read, fixed after, one request, named by the id the wallet gives it). It runs
  in browsers.

## 0.3.0 — 2026-10-29

- `@meantjs/consent/evm`: `eip712Consent`, the consent text of an EIP-712 signing request (spec §15.9, D-055),
  matched to a message of the resolved form by its type hash and refused before anything is shown when its domain,
  contract, type hash or values do not match (new codes `E_DOMAIN` and `E_TYPE_HASH`). The text ends with the
  verifying contract, the EIP-712 digest and the note that a signature is not a transaction. `evmConsent` and
  `eip712Consent` take `tokens`, the decimals and symbol of each token an amount's `token` field names; the token's
  address is shown beside its symbol.
- `@meantjs/consent/erc7730`: `erc7730Descriptor(resolved, { context: "eip712" })` writes the ERC-7730 file of the
  messages (formats keyed by `encode_type`, field groups for arrays of tokens). It returns `notes`: a timestamp's
  words and a template ERC-7730 cannot interpolate are left out with a note instead of refusing the file, for
  functions as well. Every file 0.2.0 writes is written the same.
- ICRC-21 fields: an amount at or above its threshold, and a timestamp shown as words, are `Text`, never a
  `TokenAmount` or `TimestampSeconds` of the raw number.

## 0.2.0 — 2026-10-28

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
