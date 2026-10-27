use alloc::string::String;
use core::fmt;

/// Why a value was refused. The codes are the stable surface: callers switch
/// on them, and they are the same strings the JavaScript reference uses.
///
/// More codes will come with more value tags, so the enum is
/// `#[non_exhaustive]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Code {
    /// `E_SYNTAX`: the text does not match the grammar, for example `"1,5"`,
    /// `"1e3"`, `"+1"` or a base-unit value that is not a canonical decimal
    /// integer.
    Syntax,
    /// `E_RANGE`: the value is outside the range of its Candid integer type.
    Range,
    /// `E_TOO_LONG`: the text is longer than
    /// [`MAX_INPUT_UTF16_LEN`](crate::MAX_INPUT_UTF16_LEN).
    TooLong,
    /// `E_ARG`: a tag argument is invalid, for example an empty symbol.
    Arg,
    /// `E_TAG_TYPE`: the tag does not apply to this Candid type.
    TagType,
    /// `E_EXCESS_PRECISION`: more fractional digits than the token's decimals.
    /// Amounts are never rounded.
    ExcessPrecision,
    /// `E_NEGATIVE`: a negative amount for an unsigned Candid type.
    Negative,
    /// `E_SYMBOL_MISMATCH`: the symbol in the input is not the token's symbol,
    /// or the token has no symbol.
    SymbolMismatch,
}

impl Code {
    /// The code as the reference implementation spells it, such as
    /// `"E_SYNTAX"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Code::Syntax => "E_SYNTAX",
            Code::Range => "E_RANGE",
            Code::TooLong => "E_TOO_LONG",
            Code::Arg => "E_ARG",
            Code::TagType => "E_TAG_TYPE",
            Code::ExcessPrecision => "E_EXCESS_PRECISION",
            Code::Negative => "E_NEGATIVE",
            Code::SymbolMismatch => "E_SYMBOL_MISMATCH",
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A refused value: a stable [`Code`] and a message that says how to fix the
/// input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatError {
    code: Code,
    message: String,
}

impl FormatError {
    pub(crate) fn new(code: Code, message: String) -> Self {
        Self { code, message }
    }

    /// The stable code. Switch on this, not on the message.
    pub fn code(&self) -> Code {
        self.code
    }

    /// The message, written for a person or a model. Not stable.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(feature = "std")]
impl std::error::Error for FormatError {}
