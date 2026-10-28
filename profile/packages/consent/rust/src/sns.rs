//! SNS proposals that execute a generic nervous system function: the validator method as a function, the port of
//! `snsValidatorRendering` in `src/sns.mjs` (rules `candid-profile-sns/v0`, docs/proposals/w4-sns-validator-rendering.md).
//!
//! Governance calls the validator with the proposal's payload bytes and decodes the reply as
//! `variant { Ok : text; Err : text }`. `Err` rejects the proposal; `Ok` is what voters read, under governance's own
//! `## Payload:` heading. The text is:
//!   1. the generic message of spec section 12, title at heading level 3, times in UTC;
//!   2. the method and the call's effect, its case's or else its method's (a default effect is said to be one);
//!   3. the arguments as Candid text with no formatter applied;
//!   4. the profiles, the interface id and these rules.
//!
//! Anything the generator cannot describe is `Err`, so a proposal never reaches voters undescribed.

use serde_json::{Map, Value};

use crate::decode::{decode_arguments, Limits};
use crate::error::{codes, Error, Result};
use crate::model::{build_model, call_tag, Diagnostic};
use crate::render::{plain_arguments_block, render_generic, Renderer, MAX_MESSAGE_CHARS};
use crate::resolved::{js_string, js_truthy, method_of, prop};
use crate::text::{code_span, escape_markdown, one_line, utf16_len};

/// The name and version of the rules this module renders by. Part of every rendering.
pub const SNS_RENDERING_RULES: &str = "candid-profile-sns/v0";

/// The longest `Err` text, in UTF-16 code units, before `...`.
const MAX_ERROR: usize = 1000;

/// A rendering and the notes about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnsRendering {
    pub text: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// The validator's text for one payload, or the error that makes it `Err`.
pub fn render_sns_payload(
    resolved: &Value,
    method: &str,
    payload: &[u8],
    refs: &Map<String, Value>,
    limits: Limits,
) -> Result<SnsRendering> {
    let m = method_of(resolved, method)?;
    let values = decode_arguments(m, payload, limits)?;
    let model = build_model(m, method, &values)?;
    let mut renderer = Renderer::new(refs, 0);
    let blocks = [
        render_generic(&model, &mut renderer, 3, false)?,
        format!("**Method:** {}. **Effect:** {}.", code_span(method), effect_text(m, call_tag(m, &values, "effect"))?),
        format!("**Arguments (Candid, as sent, no units applied):**\n\n{}", plain_arguments_block(&model, &mut renderer)?),
        source_text(resolved),
    ];
    let text = blocks.join("\n\n");
    if utf16_len(&text) > MAX_MESSAGE_CHARS {
        return Err(Error::new(
            codes::TOO_LARGE,
            format!("the rendering would exceed {MAX_MESSAGE_CHARS} characters; it is never truncated"),
        ));
    }
    let mut diagnostics = model.diagnostics;
    diagnostics.extend(renderer.diagnostics);
    Ok(SnsRendering { text, diagnostics })
}

/// The validator method as a function: payload bytes in, `Ok(text)` or `Err(text)` out, exactly as the JavaScript
/// `snsValidatorRendering` returns them.
pub fn sns_validator_rendering(
    resolved: &Value,
    method: &str,
    payload: &[u8],
    refs: &Map<String, Value>,
) -> std::result::Result<String, String> {
    render_sns_payload(resolved, method, payload, refs, Limits::default()).map(|r| r.text).map_err(|e| error_text(&e))
}

/// The Candid encoding of a validator reply, `variant { Ok : text; Err : text }`: what a validator method returns.
pub fn encode_validator_result(result: &std::result::Result<String, String>) -> Vec<u8> {
    // Encoding a String result cannot fail.
    candid::encode_one(result).unwrap_or_default()
}

/// The canister-side wrapper: payload bytes in, the Candid-encoded reply out.
pub fn handle_sns_validator_call(resolved: &Value, method: &str, payload: &[u8], refs: &Map<String, Value>) -> Vec<u8> {
    encode_validator_result(&sns_validator_rendering(resolved, method, payload, refs))
}

fn is_query(method: &Value) -> bool {
    matches!(prop(Some(method), "mode").and_then(Value::as_str), Some("query" | "composite_query"))
}

/// The effect kind and reversibility of the call (spec section 5.3; `tag` is its effect entry, [`call_tag`]), and
/// whether a profile stated them.
fn effect_text(method: &Value, tag: Option<&Value>) -> Result<String> {
    let query = is_query(method);
    let args = prop(tag, "args");
    let kind = match prop(args, "kind") {
        Some(Value::String(k)) => k.clone(),
        _ => if query { "read" } else { "write" }.to_string(),
    };
    let irreversible = match prop(args, "irreversible") {
        Some(Value::Bool(b)) => Some(*b),
        _ if tag.is_some_and(js_truthy) => None,
        _ => Some(!query),
    };
    let reversibility = match irreversible {
        _ if kind == "read" => "",
        None => "",
        Some(true) => ", irreversible",
        Some(false) => ", reversible",
    };
    let stated = match tag {
        None => false,
        // `tag.origin` of a JSON null throws in JavaScript
        Some(Value::Null) => return Err(Error::new(codes::INTERNAL, "Cannot read properties of null (reading 'origin')")),
        Some(t) => prop(Some(t), "origin").and_then(Value::as_str) != Some("default"),
    };
    let note = if stated {
        String::new()
    } else {
        format!(" (the default for {}; no profile states an effect)", if query { "a query" } else { "an update" })
    };
    Ok(format!("{}{reversibility}{note}", escape_markdown(&one_line(&kind))))
}

fn source_text(resolved: &Value) -> String {
    let mut lines = Vec::new();
    let profiles: &[Value] = match prop(Some(resolved), "profiles") {
        Some(Value::Array(p)) => p,
        _ => &[],
    };
    for p in profiles {
        let id = match prop(Some(p), "profile_id") {
            Some(Value::String(id)) => format!(": {}", code_span(id)),
            _ => String::new(),
        };
        let or = |key: &str, fallback: &str| match prop(Some(p), key) {
            None | Some(Value::Null) => fallback.to_string(),
            Some(v) => js_string(v),
        };
        lines.push(format!(
            "- Profile {} ({}){id}",
            code_span(&or("name", "(unnamed)")),
            escape_markdown(&one_line(&or("origin", "unknown origin")))
        ));
    }
    if profiles.is_empty() {
        lines.push("- No profile: every argument is listed as Candid".into());
    }
    if let Some(Value::String(id)) = prop(Some(resolved), "interface_id") {
        lines.push(format!("- Interface: {}", code_span(id)));
    }
    lines.push(format!("- Rules: {}", code_span(SNS_RENDERING_RULES)));
    format!("**Rendered from:**\n\n{}", lines.join("\n"))
}

/// `CODE: message`, clipped to [`MAX_ERROR`] UTF-16 code units.
fn error_text(e: &Error) -> String {
    let s = e.to_string();
    if utf16_len(&s) <= MAX_ERROR {
        return s;
    }
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > MAX_ERROR {
            break;
        }
        out.push(c);
    }
    out.push_str("...");
    out
}
