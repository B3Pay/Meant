# meant-format

Exact conversion between the amounts people write and the base units a
contract call carries. It never rounds.

A token ledger's `transfer` takes `amount : nat` in base units, and an ERC-20
contract's takes `uint256`. A person, or an agent acting for one, writes
`"1.5 ICP"`. With 8 decimals that is `150000000`; with 6 it is `1500000`. A
wrong guess sends ten or a thousand times the money, so `meant-format` refuses
to guess:

```rust
use meant_format::{AmountFormat, Code, IntType};

let icp = AmountFormat::new(8).with_symbol("ICP").unwrap();
assert_eq!(icp.parse("1.5 ICP").unwrap(), "150000000");
assert_eq!(icp.display("150000000").unwrap(), "1.5 ICP");

// More digits than the token has: refused, never rounded.
assert_eq!(icp.parse("0.123456789").unwrap_err().code(), Code::ExcessPrecision);

// The wrong token's symbol: refused.
assert_eq!(icp.parse("1.5 ckBTC").unwrap_err().code(), Code::SymbolMismatch);

// Outside the integer type: refused, never wrapped or clamped.
let byte = AmountFormat::new(0).with_candid(IntType::Nat8);
assert_eq!(byte.parse("256").unwrap_err().code(), Code::Range);

// An ERC-20 approval of 2^256 - 1, shown as what it means.
let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
let usdc = AmountFormat::new(6)
    .with_symbol("USDC").unwrap()
    .with_candid(IntType::Uint256)
    .with_threshold(max, None).unwrap();
assert_eq!(usdc.display(max).unwrap(), "Unlimited USDC");
```

- **Exact.** Base units are canonical decimal strings, so amounts of any size
  convert exactly, including 18-decimal tokens past 2^64, every EVM integer
  type up to `uint256` and `int256`, and `decimals` up to 255. `display_u128`
  and `display_i128` take native integers.
- **Strict.** No thousands separators, exponents, leading `+`, `"1."` or `".5"`.
  A symbol matches ignoring ASCII case only, so a look-alike letter from
  another script (a Kelvin sign, a Cyrillic С) never matches.
- **Safe to show.** A symbol with control or invisible characters (such as a
  right-to-left override) is refused when the format is built, because it is
  shown to the person approving a call.
- **Bounded.** Input longer than 1024 UTF-16 code units is refused before it is
  read.
- **No dependencies, `no_std`.** The default `std` feature only implements
  `std::error::Error`. Without it the crate needs only `alloc`.

## Where the rules come from

`meant-format` is part of Meant, the meaning layer for contract calls. Its
sibling [`meant`](https://crates.io/crates/meant) compiles Candid interfaces
into a canonical, identity-addressed graph; this crate converts the values a
profile describes, and depends on nothing, `meant` included. Both are developed
in the [B3Pay/Meant](https://github.com/B3Pay/Meant) repository.
The rules are the `amount` tag of
[Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md)
(§5.3, and §15 for EVM positions). The JavaScript package `@meantjs/format` is
the reference implementation. For the same input this crate gives the same
answer: the same value, or the same error code and message. `tests/parity.rs`
checks that against 3,412 cases generated from the reference
(`tests/vectors/generate-amount.mjs`, which records the commit it ran on).

Error codes (`E_SYNTAX`, `E_EXCESS_PRECISION`, and so on) are the stable
surface. Message text is written for a person or a model and may change.

## Versions

Pre-1.0: any 0.x release may change the API or the text `display` produces.
Pin an exact version:

```toml
meant-format = "=0.2.0"
```

The minimum supported Rust version is 1.78.

## License

Apache-2.0.
