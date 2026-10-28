//! Read-only accessors over the resolved form (docs/profile-v0.md section 10), the port of `src/resolved.mjs`. The
//! resolved form is data from a resolver, so nothing here trusts its shape beyond what the code reads.

use serde_json::Value;

use crate::error::{codes, Error, Result};
use crate::text::js_trim;

/// `v?.[key]` on a JSON value: a property of an object, nothing for any other value.
pub(crate) fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// `v?.a?.b?.c`.
pub(crate) fn path<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(v, |v, k| prop(Some(v), k))
}

pub(crate) fn is_true(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true)))
}

/// The method entry of a resolved form.
pub fn method_of<'a>(resolved: &'a Value, name: &str) -> Result<&'a Value> {
    let methods = match (prop(Some(resolved), "format"), prop(Some(resolved), "methods")) {
        (Some(Value::String(f)), Some(Value::Object(m))) if f == "candid-profile-resolved" => m,
        _ => return Err(Error::new(codes::RESOLVED_FORM, "not a candid-profile-resolved document (format, methods)")),
    };
    let m = methods
        .get(name)
        .ok_or_else(|| Error::new(codes::METHOD_UNKNOWN, format!("the resolved form has no method {}", json_string(name))))?;
    if !matches!(prop(Some(m), "args"), Some(Value::Array(_))) {
        return Err(Error::new(codes::RESOLVED_FORM, format!("method {name} has no args array")));
    }
    Ok(m)
}

/// The `args` array of a method returned by [`method_of`].
pub(crate) fn args_of(method: &Value) -> &[Value] {
    match prop(Some(method), "args") {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

/// The Candid field id of a label (the IDL hash).
pub(crate) fn idl_hash(label: &str) -> u32 {
    label.bytes().fold(0u32, |h, b| h.wrapping_mul(223).wrapping_add(b as u32))
}

/// `#123` with no leading zero and at most ten digits: the raw id. The value can exceed `u32` (then it matches
/// nothing, as in JavaScript).
pub(crate) fn raw_id(key: &str) -> Option<u64> {
    let digits = key.strip_prefix('#')?;
    let ok = !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if ok {
        digits.parse().ok()
    } else {
        None
    }
}

/// The Candid field or case id of a resolved-form key: `#123` is the raw id, any other key is a name.
pub(crate) fn key_id(key: &str) -> u64 {
    raw_id(key).unwrap_or_else(|| idl_hash(key) as u64)
}

/// Own entries of a `fields` or `cases` object, in document order.
pub(crate) fn entries_of(bucket: Option<&Value>) -> Vec<(&str, &Value)> {
    match bucket {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        _ => Vec::new(),
    }
}

/// `describe.label` of a position or method, when it is a non-empty string.
pub(crate) fn label_of(node: &Value) -> Option<&str> {
    match path(node, &["tags", "describe", "args", "label"]) {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(s),
        _ => None,
    }
}

/// The Candid type name of a position (`candid`).
pub(crate) fn candid_of(node: &Value) -> &str {
    match prop(Some(node), "candid") {
        Some(Value::String(s)) => s,
        _ => "",
    }
}

pub(crate) fn is_optional(node: &Value) -> bool {
    is_true(prop(Some(node), "optional"))
}

/// `JSON.stringify` of a string (for messages).
pub(crate) fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// `String(v)` for a JSON value, as JavaScript writes it.
pub(crate) fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|e| if e.is_null() { String::new() } else { js_string(e) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(n)` for a JavaScript number.
pub(crate) fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        ryu_js::Buffer::new().format_finite(n).to_string()
    }
}

/// `typeof v` for a JSON value.
pub(crate) fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(idl_hash("amount"), 3_573_748_184);
        assert_eq!(key_id("#5"), 5);
        assert_eq!(key_id("#05"), idl_hash("#05") as u64);
        assert_eq!(key_id("#9999999999"), 9_999_999_999);
    }

    #[test]
    fn js_strings() {
        assert_eq!(js_string(&serde_json::json!(8)), "8");
        assert_eq!(js_string(&serde_json::json!(1.5)), "1.5");
        assert_eq!(js_string(&serde_json::json!(1e21)), "1e+21");
        assert_eq!(js_string(&serde_json::json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&serde_json::json!({"a": 1})), "[object Object]");
    }
}
