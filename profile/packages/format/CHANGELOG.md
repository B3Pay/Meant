# Changelog: @meantjs/format

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.2.0 — 2026-10-28

- EVM integer types (spec §15, D-054): `amount` on `uint8`…`uint256` and `int8`…`int256`, `timestamp` and `duration`
  on `uint32`…`uint256` and `int64`…`int256`, with the bounds of their bits; `bytes` on `bytes` and `bytes1`…`bytes32`
  (a `bytesN` takes exactly N bytes). A resolved-form node with `abi` is read like one with `candid`.
- `amount` takes `threshold` and `message`: `displayAmount` shows a value at or above the threshold as the message
  (default "Unlimited") and the symbol. Parsing is unchanged.

## 0.1.0 — 2026-10-28

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile-format`.

- Names (spec §5.3, D-045): `normalizeName`, `resolveName`, `nameOf` and `ownerOf`, the one rule every consumer
  reads a name by, checked against the shared vectors in `spec/names-vectors.json`. `ownerOf` and `nameOf` compare
  Candid values structurally, so two different accounts never share a name.
- Exact parse and display for the six value tags of Candid Profile v0: `amount`, `timestamp`, `duration`, `account`,
  `subaccount`, `bytes`. Excess precision is refused, never rounded; integers never pass through a JavaScript number.
- `formatterFor(node, { refs, now })` for a position of a resolved form, with `describe()` for form hints and tool
  descriptions; `FormatError` with stable codes.
- No dependency, no Node built-in: runs in Node 22+ and in browsers.
- Bytes from another realm (an iframe, a `node:vm` context) are accepted wherever a `Uint8Array` is; the check is
  exported as `asUint8Array`.
- TypeScript declarations.
