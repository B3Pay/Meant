# Changelog

## 0.2.0

Brings the crate level with the JavaScript reference `@meantjs/format` 0.2.0
(candid-profile decision D-054). Breaking, as 0.x releases may be: `IntType`
gains variants and `IntType::ALL` becomes a slice.

- EVM positions (Candid Profile v0 §15): `IntType` gains the EVM ABI's
  `uint8` to `uint256` and `int8` to `int256` (`int8` to `int64` are the
  Candid types already there), with their exact bounds, and is now
  `#[non_exhaustive]`. `with_candid_name("uint256")` accepts them, and
  messages name them "the ABI type".
- `with_threshold(threshold, message)`: `display` shows a value at or above
  the threshold as the message and the symbol, such as `"Unlimited USDC"`
  for an ERC-20 approval of 2^256 − 1. The default message is
  `AmountFormat::DEFAULT_THRESHOLD_MESSAGE`, `"Unlimited"`. Parsing is
  unchanged.
- `IntType::ALL` is a `&'static [IntType]` rather than an array, so a later
  type does not change its type.
- The parity vectors come from `@meantjs/format` 0.2.0 and cover the new types
  and the threshold: 3,412 cases.

## 0.1.0

The first release: the `amount` tag of Candid Profile v0 (§5.3).

- `AmountFormat`: `parse` turns `"1.5 ICP"` into the exact base-unit value, and
  `display` turns it back. Nothing is rounded, wrapped or clamped.
- `IntType`: the ten Candid integer types an amount can have, with their bounds.
- `FormatError` and `Code`: a stable code (`E_SYNTAX`, `E_RANGE`, `E_TOO_LONG`,
  `E_ARG`, `E_TAG_TYPE`, `E_EXCESS_PRECISION`, `E_NEGATIVE`,
  `E_SYMBOL_MISMATCH`) and a message, the same as the JavaScript reference
  `@candid-core/profile-format` 0.1.0 gives.
- `no_std` with `alloc`; the default `std` feature adds `std::error::Error`.
