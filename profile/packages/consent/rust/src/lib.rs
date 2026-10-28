//! Consent and SNS validator texts from a Candid Profile resolved form: the Rust version of `packages/consent`, for
//! canisters.
//!
//! Given a resolved form (docs/profile-v0.md section 10, the JSON the resolver writes), a method name and the
//! Candid-encoded arguments of a call, this crate writes the same text as the JavaScript package, byte for byte:
//!   - [`sns_validator_rendering`]: the reply of an SNS generic nervous system function's validator method
//!     (rules `candid-profile-sns/v0`), and [`handle_sns_validator_call`] with the reply Candid-encoded;
//!   - [`generic_consent_message`]: the ICRC-21 `GenericDisplayMessage` text (spec section 12).
//!
//! The tests run the JavaScript goldens (`../test/sns-golden/`, `../test/golden/`) through this crate.
//!
//! Dynamic refs (for example `{ "from": "query:icrc1_decimals" }`) are not fetched here: the caller resolves them
//! once and passes them in `refs`, keyed by the `from` string, as in JavaScript.

mod decode;
pub mod error;
mod format;
mod model;
mod render;
mod resolved;
mod sns;
mod text;

use serde_json::{Map, Value};

pub use decode::{Limits, DEFAULT_MAX_BYTES};
pub use error::{codes, Error, Result};
pub use model::{Diagnostic, MAX_ELEMENTS, MAX_FIELDS};
pub use render::MAX_MESSAGE_CHARS;
pub use sns::{
    encode_validator_result, handle_sns_validator_call, render_sns_payload, sns_validator_rendering, SnsRendering, SNS_RENDERING_RULES,
};

/// A generic consent message and the notes about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenericMessage {
    /// The Markdown text (`GenericDisplayMessage`).
    pub text: String,
    /// True when a timestamp was shown in the requested zone (ICRC-21 then answers with the offset).
    pub zone_sensitive: bool,
    pub diagnostics: Vec<Diagnostic>,
}

/// The ICRC-21 generic display message of one call (`generateConsent` with `form: "generic"` in JavaScript).
///
/// `utc_offset_minutes`: timestamps are shown in that zone; `None` is UTC. `raw_arguments`: append the Candid text of
/// the arguments (spec section 11 item 1).
pub fn generic_consent_message(
    resolved: &Value,
    method: &str,
    arg: &[u8],
    refs: &Map<String, Value>,
    utc_offset_minutes: Option<i32>,
    raw_arguments: bool,
    limits: Limits,
) -> Result<GenericMessage> {
    let m = resolved::method_of(resolved, method)?;
    let values = decode::decode_arguments(m, arg, limits)?;
    let model = model::build_model(m, method, &values)?;
    let mut renderer = render::Renderer::new(refs, utc_offset_minutes.unwrap_or(0));
    let text = render::render_generic(&model, &mut renderer, 1, raw_arguments)?;
    let mut diagnostics = model.diagnostics;
    diagnostics.extend(renderer.diagnostics);
    Ok(GenericMessage { text, zone_sensitive: renderer.used_zone, diagnostics })
}

/// Parse a resolved form from its JSON text. Field order matters (it is the order of the Candid text), so the crate
/// is built with `serde_json`'s `preserve_order`.
pub fn parse_resolved(json: &str) -> Result<Value> {
    serde_json::from_str(json).map_err(|e| Error::new(codes::RESOLVED_FORM, format!("not JSON: {e}")))
}
