//! Every failure is an [`Error`] with a stable `code`: the codes of the JavaScript package (`src/errors.mjs`).

use std::fmt;

/// A failure to describe a call. `code` is one of [`codes`]; `message` is written for a developer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error { code, message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// The error codes, as in `src/errors.mjs`.
pub mod codes {
    /// The resolved form has no such method.
    pub const METHOD_UNKNOWN: &str = "E_METHOD_UNKNOWN";
    /// The argument bytes do not decode against the method's signature.
    pub const DECODE: &str = "E_DECODE";
    /// The arguments exceed the bounds of a message (never truncated).
    pub const TOO_LARGE: &str = "E_TOO_LARGE";
    /// A position the resolved form cannot type (recursive cut, func, service).
    pub const UNSUPPORTED_TYPE: &str = "E_UNSUPPORTED_TYPE";
    /// The resolved form is malformed.
    pub const RESOLVED_FORM: &str = "E_RESOLVED_FORM";
    /// The intent template does not parse.
    pub const TEMPLATE: &str = "E_TEMPLATE";
    /// A placeholder names a position the method does not have.
    pub const TEMPLATE_PATH: &str = "E_TEMPLATE_PATH";
    /// A dynamic ref the caller did not supply.
    pub const REF_UNRESOLVED: &str = "E_REF_UNRESOLVED";
    /// A tag argument is missing or invalid.
    pub const ARG: &str = "E_ARG";
    /// The tag does not apply to the Candid type of its position.
    pub const TAG_TYPE: &str = "E_TAG_TYPE";
    /// Two value tags at one position.
    pub const TAG_CONFLICT: &str = "E_TAG_CONFLICT";
    /// A position is not what the format library can read.
    pub const TYPE: &str = "E_TYPE";
    /// Where the JavaScript version fails with an exception that is not a ConsentError.
    pub const INTERNAL: &str = "E_INTERNAL";
}
