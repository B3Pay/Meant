//! Exact conversion between the amounts people write and the base units a
//! contract call carries.
//!
//! A token ledger's `transfer` takes `amount : nat` in base units. A person
//! (or an agent acting for one) writes `"1.5 ICP"`. With 8 decimals that is
//! `150000000`; with 6 it is `1500000`. Getting this wrong by a factor of ten
//! sends ten times the money, so this crate never guesses:
//!
//! - **No rounding.** Input with more fractional digits than the token has is
//!   rejected with [`Code::ExcessPrecision`], even when the extra digits are
//!   zeros.
//! - **No wrapping or clamping.** A value outside its integer type, Candid's
//!   or the EVM ABI's (`uint256`), is rejected with [`Code::Range`].
//! - **No floats.** Base units are canonical decimal strings, so `nat` amounts
//!   of any size (18-decimal tokens, `decimals` up to 255) are exact.
//! - **The symbol must match.** `"1.5 ICP"` on a ckBTC ledger is
//!   [`Code::SymbolMismatch`]. Matching ignores ASCII case only, so a
//!   look-alike letter from another script never matches.
//!
//! ```
//! use meant_format::{AmountFormat, Code};
//!
//! let icp = AmountFormat::new(8).with_symbol("ICP")?;
//! assert_eq!(icp.parse("1.5 ICP")?, "150000000");
//! assert_eq!(icp.parse("1.5")?, "150000000");
//! assert_eq!(icp.display("150000000")?, "1.5 ICP");
//!
//! let err = icp.parse("0.123456789").unwrap_err();
//! assert_eq!(err.code(), Code::ExcessPrecision);
//! assert_eq!(err.code().as_str(), "E_EXCESS_PRECISION");
//! # Ok::<(), meant_format::FormatError>(())
//! ```
//!
//! # Where the rules come from
//!
//! The rules are the `amount` tag of Candid Profile v0 (§5.3, and §15 for EVM
//! positions). The JavaScript package `@meantjs/format` is the reference
//! implementation, and this crate gives the same answer for the same input:
//! the same value, or the same error code and message. `tests/parity.rs`
//! checks that against vectors generated from the reference. Two details
//! follow it exactly because they decide what is accepted:
//!
//! - Surrounding whitespace, and the whitespace between a number and its
//!   symbol, is ECMAScript's set (the characters `String.prototype.trim`
//!   removes), which includes U+FEFF and excludes U+0085.
//! - The length bound, [`MAX_INPUT_UTF16_LEN`], counts UTF-16 code units, as
//!   JavaScript's `length` does.
//!
//! Error codes are the stable surface. Message text is written for a person or
//! a model and may change between releases.
//!
//! # Features
//!
//! `std` (default) implements `std::error::Error` for [`FormatError`].
//! Without it the crate is `no_std` and uses only `alloc`.

#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

extern crate alloc;
#[cfg(feature = "std")]
extern crate std;

mod amount;
mod error;
mod int_type;
mod text;

pub use amount::AmountFormat;
pub use error::{Code, FormatError};
pub use int_type::IntType;
pub use text::MAX_INPUT_UTF16_LEN;

/// The README's example, compiled and run as a doctest so the page crates.io
/// shows cannot drift from the code.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;
