# Changelog

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
