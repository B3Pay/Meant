//! The ICRC-21 envelope: the Candid-encoded argument of `icrc21_canister_call_consent_message` in, the Candid-encoded
//! `icrc21_consent_message_response` out. The Rust version of `src/icrc21.mjs` and `src/icrc21-codec.mjs`, for the
//! generic form (D-061).
//!
//! What it does as the JavaScript version does, rule for rule:
//!   - a language other than English gets the English message, and `metadata.language` says `en` (ICRC-21 prefers a
//!     message to an error); with [`LanguagePolicy::Error`] it is refused instead (`E_LANGUAGE`);
//!   - a missing `device_spec` is `GenericDisplay`;
//!   - a `utc_offset_minutes` beyond +-1440 is ignored (UTC is used), and the reply carries the applied offset exactly
//!     when a time is shown;
//!   - errors map to the ICRC-21 variants by code, with the description `<code>: <message>`, clipped at 1000 UTF-16
//!     units with `...`.
//!
//! What it does not: the `FieldsDisplayMessage` form is not ported, so a `FieldsDisplay` request is answered with
//! `ConsentMessageUnavailable` (code `E_FORM`), where JavaScript answers with the fields. Diagnostics are not returned.

use candid::{CandidType, Deserialize, Nat};
use serde_json::{Map, Value};

use crate::decode::Limits;
use crate::error::{codes, Error};
use crate::generic_consent_message;
use crate::text::utf16_len;

/// The only language v0 writes.
pub const SUPPORTED_LANGUAGE: &str = "en";
const MAX_OFFSET_MINUTES: i16 = 24 * 60;
const MAX_DESCRIPTION: usize = 1000;
/// The largest request read: the 2 MiB argument limit of a call, plus room for the envelope (as in JavaScript).
pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 4096;

// ------------------------------------------------------------------------------------------- the ICRC-21 types
// topics/ICRC-21/ICRC-21.did of dfinity/wg-identity-authentication (commit in ../test/upstream/icrc21/SOURCE.json).

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConsentMessageMetadata {
    pub language: String,
    pub utc_offset_minutes: Option<i16>,
}

#[derive(CandidType, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayMessageType {
    GenericDisplay,
    FieldsDisplay,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConsentMessageSpec {
    pub metadata: ConsentMessageMetadata,
    pub device_spec: Option<DisplayMessageType>,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConsentMessageRequest {
    pub method: String,
    pub arg: Vec<u8>,
    pub user_preferences: ConsentMessageSpec,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Icrc21Value {
    TokenAmount { decimals: u8, amount: u64, symbol: String },
    TimestampSeconds { amount: u64 },
    DurationSeconds { amount: u64 },
    Text { content: String },
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FieldsDisplay {
    pub intent: String,
    pub fields: Vec<(String, Icrc21Value)>,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ConsentMessage {
    GenericDisplayMessage(String),
    FieldsDisplayMessage(FieldsDisplay),
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConsentInfo {
    pub consent_message: ConsentMessage,
    pub metadata: ConsentMessageMetadata,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ErrorInfo {
    pub description: String,
}

#[derive(CandidType, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Icrc21Error {
    UnsupportedCanisterCall(ErrorInfo),
    ConsentMessageUnavailable(ErrorInfo),
    InsufficientPayment(ErrorInfo),
    GenericError { error_code: Nat, description: String },
}

/// `icrc21_consent_message_response`: `variant { Ok : consent_info; Err : icrc21_error }`.
pub type ConsentMessageResponse = std::result::Result<ConsentInfo, Icrc21Error>;

// ------------------------------------------------------------------------------------------------ the context

/// What to do with a language other than English.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LanguagePolicy {
    /// Answer in English and say so in the metadata (the default, as ICRC-21 prefers).
    #[default]
    Fallback,
    /// Refuse with `UnsupportedCanisterCall` (`E_LANGUAGE`).
    Error,
}

/// What the canister answers with: its resolved form and the values of its dynamic refs.
#[derive(Debug, Clone)]
pub struct ConsentContext<'a> {
    pub resolved: &'a Value,
    pub refs: &'a Map<String, Value>,
    pub language_policy: LanguagePolicy,
    pub raw_arguments: bool,
    pub limits: Limits,
}

impl<'a> ConsentContext<'a> {
    pub fn new(resolved: &'a Value, refs: &'a Map<String, Value>) -> Self {
        ConsentContext { resolved, refs, language_policy: LanguagePolicy::Fallback, raw_arguments: false, limits: Limits::default() }
    }
}

// ----------------------------------------------------------------------------------------------- the entries

/// `icrc21_canister_call_consent_message` as a function, on the decoded request.
pub fn icrc21_consent_message(request: &ConsentMessageRequest, ctx: &ConsentContext) -> ConsentMessageResponse {
    build(request, ctx).map_err(|e| to_icrc21_error(&e))
}

/// The canister-side wrapper: request bytes in, response bytes out. A request that does not decode gets
/// `UnsupportedCanisterCall` (`E_REQUEST`), as the ICRC-21 interface prescribes for a malformed call.
pub fn handle_consent_request(request: &[u8], ctx: &ConsentContext) -> Vec<u8> {
    let response = match decode_consent_request(request) {
        Ok(r) => icrc21_consent_message(&r, ctx),
        Err(e) => Err(to_icrc21_error(&e)),
    };
    encode_consent_response(&response)
}

/// Decode the argument of `icrc21_canister_call_consent_message`.
pub fn decode_consent_request(bytes: &[u8]) -> crate::Result<ConsentMessageRequest> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(Error::new(
            codes::REQUEST,
            format!("not an icrc21_consent_message_request: {} bytes, over the {MAX_REQUEST_BYTES} read", bytes.len()),
        ));
    }
    let mut config = candid::de::DecoderConfig::new();
    config.set_skipping_quota(16 * MAX_REQUEST_BYTES);
    config.set_decoding_quota(16 * MAX_REQUEST_BYTES);
    candid::utils::decode_one_with_config(bytes, &config)
        .map_err(|e| Error::new(codes::REQUEST, format!("not an icrc21_consent_message_request: {e}")))
}

/// Candid-encode a response.
pub fn encode_consent_response(response: &ConsentMessageResponse) -> Vec<u8> {
    candid::encode_one(response).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------- the behavior

/// `^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$`, the shape JavaScript accepts as a language tag.
fn is_bcp47(s: &str) -> bool {
    let mut parts = s.split(['-', '_']);
    let first = parts.next().unwrap_or("");
    (2..=3).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn build(request: &ConsentMessageRequest, ctx: &ConsentContext) -> crate::Result<ConsentInfo> {
    let language = &request.user_preferences.metadata.language;
    let primary = if is_bcp47(language) { language.split(['-', '_']).next().map(str::to_ascii_lowercase) } else { None };
    let english = primary.as_deref() == Some(SUPPORTED_LANGUAGE);
    if !english && ctx.language_policy == LanguagePolicy::Error {
        let shown: String = language.chars().take(40).collect();
        return Err(Error::new(
            codes::LANGUAGE,
            format!("language {} is not supported; this generator writes \"{SUPPORTED_LANGUAGE}\"", json_string(&shown)),
        ));
    }
    // JavaScript's String.prototype.replace with a string pattern replaces the first match only.
    let answered = if english { language.replacen('_', "-", 1) } else { SUPPORTED_LANGUAGE.to_string() };

    if request.user_preferences.device_spec == Some(DisplayMessageType::FieldsDisplay) {
        return Err(Error::new(
            codes::FORM,
            "this canister answers with a GenericDisplayMessage only; ask with device_spec GenericDisplay",
        ));
    }

    // A range check, not `abs()`: `i16::MIN.abs()` overflows (and wraps to itself in a release build).
    let offset = request.user_preferences.metadata.utc_offset_minutes.filter(|m| (-MAX_OFFSET_MINUTES..=MAX_OFFSET_MINUTES).contains(m));
    let m = generic_consent_message(
        ctx.resolved,
        &request.method,
        &request.arg,
        ctx.refs,
        offset.map(i32::from),
        ctx.raw_arguments,
        ctx.limits,
    )?;
    Ok(ConsentInfo {
        consent_message: ConsentMessage::GenericDisplayMessage(m.text),
        metadata: ConsentMessageMetadata {
            language: answered,
            utc_offset_minutes: if m.zone_sensitive { Some(offset.unwrap_or(0)) } else { None },
        },
    })
}

fn json_string(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// At most 1000 UTF-16 units, then `...` (JavaScript's `s.slice(0, 1000)`, without splitting a surrogate pair).
fn clip(s: String) -> String {
    if utf16_len(&s) <= MAX_DESCRIPTION {
        return s;
    }
    let mut units = 0;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > MAX_DESCRIPTION {
            break;
        }
        units += c.len_utf16();
        end = i + c.len_utf8();
    }
    format!("{}...", &s[..end])
}

/// The generic error codes of `src/errors.mjs`.
fn generic_error_code(code: &str) -> u32 {
    match code {
        codes::RESOLVED_FORM => 1000,
        codes::TEMPLATE => 1001,
        codes::TEMPLATE_PATH => 1002,
        codes::REF_UNRESOLVED => 1100,
        codes::ARG => 1101,
        codes::TAG_TYPE => 1102,
        codes::TAG_CONFLICT => 1103,
        _ => 1999,
    }
}

/// An [`Error`] as the ICRC-21 `icrc21_error` variant (`toIcrc21Error` in JavaScript).
pub fn to_icrc21_error(e: &Error) -> Icrc21Error {
    if e.code == codes::INTERNAL {
        return Icrc21Error::GenericError { error_code: Nat::from(1999u32), description: clip(format!("internal error: {}", e.message)) };
    }
    let description = clip(format!("{}: {}", e.code, e.message));
    match e.code {
        codes::METHOD_UNKNOWN | codes::DECODE | codes::TOO_LARGE | codes::LANGUAGE | codes::REQUEST => {
            Icrc21Error::UnsupportedCanisterCall(ErrorInfo { description })
        }
        codes::UNSUPPORTED_TYPE | codes::FORM => Icrc21Error::ConsentMessageUnavailable(ErrorInfo { description }),
        other => Icrc21Error::GenericError { error_code: Nat::from(generic_error_code(other)), description },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tags_are_read_as_javascript_reads_them() {
        for ok in ["en", "EN", "en-US", "en_GB", "deu", "zh-Hant-TW", "en-a1b2c3d4"] {
            assert!(is_bcp47(ok), "{ok}");
        }
        for bad in ["", "e", "engl", "en-", "en--US", "en-abcdefghi", "1n", "en US", "é"] {
            assert!(!is_bcp47(bad), "{bad}");
        }
    }

    #[test]
    fn descriptions_clip_at_1000_utf16_units() {
        assert_eq!(clip("a".repeat(1000)), "a".repeat(1000));
        assert_eq!(clip("a".repeat(1001)), format!("{}...", "a".repeat(1000)));
        // a pair that would straddle the limit is left out whole
        let s = format!("{}😀", "a".repeat(999));
        assert_eq!(clip(s), format!("{}...", "a".repeat(999)));
    }

    #[test]
    fn codes_map_to_the_variants_javascript_uses() {
        let v = |code| to_icrc21_error(&Error::new(code, "m"));
        assert!(matches!(v(codes::METHOD_UNKNOWN), Icrc21Error::UnsupportedCanisterCall(_)));
        assert!(matches!(v(codes::REQUEST), Icrc21Error::UnsupportedCanisterCall(_)));
        assert!(matches!(v(codes::UNSUPPORTED_TYPE), Icrc21Error::ConsentMessageUnavailable(_)));
        assert!(matches!(v(codes::FORM), Icrc21Error::ConsentMessageUnavailable(_)));
        assert_eq!(
            v(codes::REF_UNRESOLVED),
            Icrc21Error::GenericError { error_code: Nat::from(1100u32), description: "E_REF_UNRESOLVED: m".into() }
        );
        assert_eq!(v(codes::TYPE), Icrc21Error::GenericError { error_code: Nat::from(1999u32), description: "E_TYPE: m".into() });
        assert_eq!(
            v(codes::INTERNAL),
            Icrc21Error::GenericError { error_code: Nat::from(1999u32), description: "internal error: m".into() }
        );
    }
}
