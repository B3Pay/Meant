//! Step 1: Candid argument bytes to a value tree aligned with the resolved form's positions, the port of
//! `src/decode.mjs`.
//!
//! The expected types are built from the method's resolved-form tree, so the decoder never trusts the types the bytes
//! claim: an argument is read as the signature says (with Candid's subtyping and `opt` rules) or the call is refused.
//! The codec is the `candid` crate; the JavaScript version uses `@candid-core/schema`. Both follow the Candid
//! specification; the golden tests check that they agree.

use std::rc::Rc;

use candid::de::IDLDeserialize;
use candid::types::{Field, Label, Type, TypeInner};
use candid::{DecoderConfig, IDLValue, TypeEnv};
use serde_json::Value;

use crate::error::{codes, Error, Result};
use crate::resolved::{args_of, candid_of, entries_of, is_optional, is_true, key_id, prop, raw_id};

/// A consent message is for one ingress message at most (IC limit: 2 MiB).
pub const DEFAULT_MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_NODE_DEPTH: usize = 64;

/// Decoder limits.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The largest argument accepted, in bytes.
    pub max_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_bytes: DEFAULT_MAX_BYTES }
    }
}

/// One decoded value, in the shape of `src/decode.mjs`: integers as decimal text (never a float), `opt` as the value
/// or `Null`, records keyed exactly like the resolved form's `fields`, variants by the key of the resolved form's
/// `cases`.
#[derive(Debug, Clone, PartialEq)]
pub enum Tree {
    Null,
    Bool(bool),
    /// Any integer type, as canonical decimal text.
    Int(String),
    /// `float32` (widened) and `float64`.
    Float(f64),
    Text(String),
    /// The principal's bytes.
    Principal(Vec<u8>),
    Blob(Vec<u8>),
    Vec(Vec<Tree>),
    Record(Vec<(String, Tree)>),
    Variant(String, Box<Tree>),
}

impl Tree {
    /// `value[key]` of a record.
    pub(crate) fn get(&self, key: &str) -> Option<&Tree> {
        match self {
            Tree::Record(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

const INTEGERS: [&str; 10] = ["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"];

fn primitive(kind: &str) -> Option<TypeInner> {
    Some(match kind {
        "null" => TypeInner::Null,
        "bool" => TypeInner::Bool,
        "text" => TypeInner::Text,
        "principal" => TypeInner::Principal,
        "reserved" => TypeInner::Reserved,
        "empty" => TypeInner::Empty,
        "nat" => TypeInner::Nat,
        "int" => TypeInner::Int,
        "nat8" => TypeInner::Nat8,
        "nat16" => TypeInner::Nat16,
        "nat32" => TypeInner::Nat32,
        "nat64" => TypeInner::Nat64,
        "int8" => TypeInner::Int8,
        "int16" => TypeInner::Int16,
        "int32" => TypeInner::Int32,
        "int64" => TypeInner::Int64,
        "float32" => TypeInner::Float32,
        "float64" => TypeInner::Float64,
        _ => return None,
    })
}

/// The Candid type of one position of the resolved form.
pub(crate) fn type_for(node: &Value, at: &str, depth: usize) -> Result<Type> {
    if !matches!(prop(Some(node), "candid"), Some(Value::String(_))) {
        return Err(Error::new(codes::RESOLVED_FORM, format!("{at}: not a resolved-form position")));
    }
    if depth > MAX_NODE_DEPTH {
        return Err(Error::new(codes::UNSUPPORTED_TYPE, format!("{at}: nested deeper than {MAX_NODE_DEPTH}")));
    }
    let kind = candid_of(node);
    // A cut position (the type below it is unknown) is read as `reserved`, which every type is a subtype of: its bytes
    // are skipped, and `to_tree` refuses a call whose value reaches it (spec section 12, rule 12; D-042).
    let inner: Type = if is_true(prop(Some(node), "recursive")) {
        TypeInner::Reserved.into()
    } else if let Some(p) = primitive(kind) {
        p.into()
    } else {
        match kind {
            "blob" => TypeInner::Vec(TypeInner::Nat8.into()).into(),
            "vec" => match prop(Some(node), "element") {
                None => return Err(Error::new(codes::UNSUPPORTED_TYPE, format!("{at}: vec without an element type"))),
                Some(e) => TypeInner::Vec(type_for(e, &format!("{at}[]"), depth + 1)?).into(),
            },
            "record" => TypeInner::Record(fields_for(prop(Some(node), "fields"), at, depth)?).into(),
            "variant" => TypeInner::Variant(fields_for(prop(Some(node), "cases"), at, depth)?).into(),
            _ => {
                return Err(Error::new(
                    codes::UNSUPPORTED_TYPE,
                    format!("{at}: {kind} positions cannot be decoded (the resolved form carries no signature for them)"),
                ))
            }
        }
    };
    Ok(if is_optional(node) { TypeInner::Opt(inner).into() } else { inner })
}

fn fields_for(bucket: Option<&Value>, at: &str, depth: usize) -> Result<Vec<Field>> {
    let mut fields = Vec::new();
    for (key, child) in entries_of(bucket) {
        let label = if key.starts_with('#') && raw_id(key).is_some() {
            let id = raw_id(key).unwrap_or_default();
            Label::Id(u32::try_from(id).map_err(|_| Error::new(codes::RESOLVED_FORM, format!("{at}.{key}: the id is above 2^32 - 1")))?)
        } else {
            Label::Named(key.to_string())
        };
        fields.push(Field { id: Rc::new(label), ty: type_for(child, &format!("{at}.{key}"), depth + 1)? });
    }
    fields.sort_by_key(|f| f.id.get_id());
    if fields.windows(2).any(|w| w[0].id.get_id() == w[1].id.get_id()) {
        return Err(Error::new(codes::RESOLVED_FORM, format!("{at}: two fields or cases share one Candid id")));
    }
    Ok(fields)
}

/// Decode the Candid-encoded argument tuple of a call against a resolved-form method.
pub fn decode_arguments(method: &Value, bytes: &[u8], limits: Limits) -> Result<Vec<Tree>> {
    if bytes.len() > limits.max_bytes {
        return Err(Error::new(
            codes::TOO_LARGE,
            format!("the argument is {} bytes; the limit for a consent message is {}", bytes.len(), limits.max_bytes),
        ));
    }
    let args = args_of(method);
    let types = args.iter().enumerate().map(|(i, node)| type_for(node, &format!("argument {i}"), 0)).collect::<Result<Vec<_>>>()?;

    let mut config = DecoderConfig::new();
    // Bounded work for a canister: the skipping quota also counts every value decoded to an IDLValue, in proportion
    // to the largest accepted argument. No decoding quota: it charges skipped data 50 times, so it would refuse a
    // payload with a large ignored field that the JavaScript version renders. The JavaScript codec bounds the count of
    // values instead (100,000, skipped ones included): the two bounds differ (README, "Rust version").
    let quota = limits.max_bytes.saturating_mul(16).max(1 << 16);
    config.set_skipping_quota(quota).set_full_error_message(false);
    let env = TypeEnv::new();
    let mut de = IDLDeserialize::new_with_config(bytes, &config).map_err(decode_error)?;
    let mut values = Vec::with_capacity(types.len());
    for ty in &types {
        values.push(de.get_value_with_type(&env, ty).map_err(decode_error)?);
    }
    de.done().map_err(decode_error)?;
    args.iter().zip(values).enumerate().map(|(i, (node, v))| to_tree(node, v, &format!("argument {i}"))).collect()
}

fn decode_error(e: candid::Error) -> Error {
    let text = e.to_string();
    let code = if text.contains("cost exceeds the limit") { codes::TOO_LARGE } else { codes::DECODE };
    Error::new(code, format!("the argument bytes do not decode as the method's signature: {text}"))
}

fn mismatch(at: &str, kind: &str) -> Error {
    Error::new(codes::DECODE, format!("{at}: the decoder returned a value that is not a {kind}"))
}

/// Decoded value to value tree. `node` is the resolved-form position the type was built from.
fn to_tree(node: &Value, v: IDLValue, at: &str) -> Result<Tree> {
    if is_true(prop(Some(node), "recursive")) {
        if is_optional(node) && matches!(v, IDLValue::None | IDLValue::Null | IDLValue::Reserved) {
            return Ok(Tree::Null);
        }
        let kind = candid_of(node);
        return Err(Error::new(
            codes::UNSUPPORTED_TYPE,
            format!("{at}: the resolved form cuts this {kind} at a cycle (recursive: true), so its type below is unknown"),
        ));
    }
    let v = if is_optional(node) {
        match v {
            IDLValue::None | IDLValue::Null | IDLValue::Reserved => return Ok(Tree::Null),
            IDLValue::Opt(inner) => *inner,
            _ => return Err(mismatch(at, "opt")),
        }
    } else {
        v
    };
    let kind = candid_of(node);
    if INTEGERS.contains(&kind) {
        return Ok(Tree::Int(match v {
            IDLValue::Nat(n) => n.0.to_str_radix(10),
            IDLValue::Int(n) => n.0.to_str_radix(10),
            IDLValue::Nat8(n) => n.to_string(),
            IDLValue::Nat16(n) => n.to_string(),
            IDLValue::Nat32(n) => n.to_string(),
            IDLValue::Nat64(n) => n.to_string(),
            IDLValue::Int8(n) => n.to_string(),
            IDLValue::Int16(n) => n.to_string(),
            IDLValue::Int32(n) => n.to_string(),
            IDLValue::Int64(n) => n.to_string(),
            _ => return Err(mismatch(at, kind)),
        }));
    }
    Ok(match (kind, v) {
        ("float32", IDLValue::Float32(f)) => Tree::Float(f as f64),
        ("float64", IDLValue::Float64(f)) => Tree::Float(f),
        ("bool", IDLValue::Bool(b)) => Tree::Bool(b),
        ("text", IDLValue::Text(s)) => Tree::Text(s),
        ("principal", IDLValue::Principal(p)) => Tree::Principal(p.as_slice().to_vec()),
        ("blob", IDLValue::Blob(b)) => Tree::Blob(b),
        ("blob", IDLValue::Vec(items)) => Tree::Blob(
            items.into_iter().map(|e| if let IDLValue::Nat8(b) = e { Ok(b) } else { Err(mismatch(at, "blob")) }).collect::<Result<_>>()?,
        ),
        ("null" | "reserved", _) => Tree::Null,
        ("vec", v) => {
            let element = prop(Some(node), "element").ok_or_else(|| mismatch(at, "vec"))?;
            let items = match v {
                IDLValue::Vec(items) => items,
                // `vec nat8` written as vec in the resolved form: the decoder reads it as a blob
                IDLValue::Blob(bytes) => bytes.into_iter().map(IDLValue::Nat8).collect(),
                _ => return Err(mismatch(at, "vec")),
            };
            Tree::Vec(items.into_iter().enumerate().map(|(i, e)| to_tree(element, e, &format!("{at}[{i}]"))).collect::<Result<_>>()?)
        }
        ("record", IDLValue::Record(mut fields)) => {
            let mut out = Vec::new();
            for (key, child) in entries_of(prop(Some(node), "fields")) {
                let id = key_id(key);
                let pos = fields
                    .iter()
                    .position(|f| f.id.get_id() as u64 == id)
                    .ok_or_else(|| Error::new(codes::DECODE, format!("{at}: the decoder returned no field {key}")))?;
                let f = fields.swap_remove(pos);
                out.push((key.to_string(), to_tree(child, f.val, &format!("{at}.{key}"))?));
            }
            Tree::Record(out)
        }
        ("variant", IDLValue::Variant(candid::types::value::VariantValue(field, _))) => {
            let id = field.id.get_id() as u64;
            let (key, child) = entries_of(prop(Some(node), "cases")).into_iter().find(|(k, _)| key_id(k) == id).ok_or_else(|| {
                Error::new(codes::DECODE, format!("{at}: the decoder returned the case {id}, which the resolved form lacks"))
            })?;
            Tree::Variant(key.to_string(), Box::new(to_tree(child, field.val, &format!("{at}.{key}"))?))
        }
        ("float32" | "float64" | "bool" | "text" | "principal" | "blob" | "record" | "variant", _) => return Err(mismatch(at, kind)),
        _ => return Err(Error::new(codes::UNSUPPORTED_TYPE, format!("{at}: cannot convert {kind}"))),
    })
}
