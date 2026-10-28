# Changelog: @meantjs/consent

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.1.0 (unreleased)

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
