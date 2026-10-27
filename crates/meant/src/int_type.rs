use alloc::format;
use alloc::string::String;
use core::cmp::Ordering;

use crate::{Code, FormatError};

/// The Candid integer types the `amount` tag applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntType {
    /// `nat`: unbounded, non-negative.
    Nat,
    /// `int`: unbounded, signed.
    Int,
    /// `nat8`: 0 to 255.
    Nat8,
    /// `nat16`: 0 to 65535.
    Nat16,
    /// `nat32`: 0 to 2^32 − 1.
    Nat32,
    /// `nat64`: 0 to 2^64 − 1.
    Nat64,
    /// `int8`: −128 to 127.
    Int8,
    /// `int16`: −2^15 to 2^15 − 1.
    Int16,
    /// `int32`: −2^31 to 2^31 − 1.
    Int32,
    /// `int64`: −2^63 to 2^63 − 1.
    Int64,
}

impl IntType {
    /// Every type, in the order the reference names them in messages.
    pub const ALL: [IntType; 10] = [
        IntType::Nat,
        IntType::Int,
        IntType::Nat8,
        IntType::Nat16,
        IntType::Nat32,
        IntType::Nat64,
        IntType::Int8,
        IntType::Int16,
        IntType::Int32,
        IntType::Int64,
    ];

    /// The Candid name, such as `"nat64"`.
    pub const fn candid_name(self) -> &'static str {
        match self {
            IntType::Nat => "nat",
            IntType::Int => "int",
            IntType::Nat8 => "nat8",
            IntType::Nat16 => "nat16",
            IntType::Nat32 => "nat32",
            IntType::Nat64 => "nat64",
            IntType::Int8 => "int8",
            IntType::Int16 => "int16",
            IntType::Int32 => "int32",
            IntType::Int64 => "int64",
        }
    }

    /// The type with this exact Candid name, or `None`. Names are
    /// case-sensitive, as in Candid.
    pub fn from_candid_name(name: &str) -> Option<Self> {
        IntType::ALL.into_iter().find(|t| t.candid_name() == name)
    }

    /// Whether the type admits negative values.
    pub const fn is_signed(self) -> bool {
        matches!(
            self,
            IntType::Int | IntType::Int8 | IntType::Int16 | IntType::Int32 | IntType::Int64
        )
    }

    /// The inclusive bounds as decimal strings; `None` is unbounded.
    const fn bounds(self) -> (Option<&'static str>, Option<&'static str>) {
        match self {
            IntType::Nat => (Some("0"), None),
            IntType::Int => (None, None),
            IntType::Nat8 => (Some("0"), Some("255")),
            IntType::Nat16 => (Some("0"), Some("65535")),
            IntType::Nat32 => (Some("0"), Some("4294967295")),
            IntType::Nat64 => (Some("0"), Some("18446744073709551615")),
            IntType::Int8 => (Some("-128"), Some("127")),
            IntType::Int16 => (Some("-32768"), Some("32767")),
            IntType::Int32 => (Some("-2147483648"), Some("2147483647")),
            IntType::Int64 => (Some("-9223372036854775808"), Some("9223372036854775807")),
        }
    }
}

/// An integer held as a sign and canonical decimal digits: no leading zeros,
/// `"0"` for zero, and never a negative zero.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Decimal<'a> {
    pub(crate) negative: bool,
    pub(crate) magnitude: &'a str,
}

impl<'a> Decimal<'a> {
    /// Reads a canonical decimal integer (`-?(0|[1-9][0-9]*)`), refusing
    /// `"-0"`. Returns `None` for anything else.
    pub(crate) fn canonical(text: &'a str) -> Option<Self> {
        let (negative, digits) = match text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let bytes = digits.as_bytes();
        let canonical = !bytes.is_empty()
            && bytes.iter().all(u8::is_ascii_digit)
            && (bytes[0] != b'0' || bytes.len() == 1);
        if !canonical || (negative && digits == "0") {
            return None;
        }
        Some(Self {
            negative,
            magnitude: digits,
        })
    }

    pub(crate) fn to_text(self) -> String {
        if self.negative {
            format!("-{}", self.magnitude)
        } else {
            String::from(self.magnitude)
        }
    }

    fn cmp(self, other: Decimal<'_>) -> Ordering {
        let by_magnitude = self
            .magnitude
            .len()
            .cmp(&other.magnitude.len())
            .then_with(|| self.magnitude.cmp(other.magnitude));
        match (self.negative, other.negative) {
            (false, false) => by_magnitude,
            (true, true) => by_magnitude.reverse(),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
        }
    }
}

/// Refuses a value outside the type's range, in the reference's order: sign
/// first, then the minimum, then the maximum.
pub(crate) fn check_range(value: Decimal<'_>, ty: IntType, what: &str) -> Result<(), FormatError> {
    if !ty.is_signed() && value.negative {
        return Err(FormatError::new(
            Code::Range,
            format!(
                "{what} {} is negative but the Candid type is unsigned",
                value.to_text()
            ),
        ));
    }
    let (min, max) = ty.bounds();
    if let Some(min) = min.and_then(Decimal::canonical) {
        if value.cmp(min) == Ordering::Less {
            return Err(FormatError::new(
                Code::Range,
                format!(
                    "{what} {} is below the minimum {} of the Candid type",
                    value.to_text(),
                    min.to_text()
                ),
            ));
        }
    }
    if let Some(max) = max.and_then(Decimal::canonical) {
        if value.cmp(max) == Ordering::Greater {
            return Err(FormatError::new(
                Code::Range,
                format!(
                    "{what} {} is above the maximum {} of the Candid type",
                    value.to_text(),
                    max.to_text()
                ),
            ));
        }
    }
    Ok(())
}
