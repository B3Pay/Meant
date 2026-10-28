//! The value tags of spec section 5.1 (amount, timestamp, duration, account, subaccount, bytes), display side only:
//! the port of `formatterFor(node).display` in packages/format (`@meantjs/format`).
//!
//! A formatter that cannot be built (a dynamic ref the caller did not supply, a bad tag argument) is a configuration
//! error and stops the message. A formatter that refuses one value returns a [`FormatError`]; the renderer then shows
//! the value as raw Candid text, as the JavaScript version does. Nothing here rounds (spec section 5.3, D-006).

use std::fmt::Write;

use num_bigint::{BigInt, BigUint, Sign};
use serde_json::{Map, Value};

use crate::decode::Tree;
use crate::error::{codes, Error};
use crate::resolved::{candid_of, js_string, js_typeof, json_string, prop};
use crate::text::{is_unsafe, js_trim};

/// The tags that give a position a text form (spec section 5.1).
pub(crate) const VALUE_TAGS: [&str; 6] = ["amount", "timestamp", "duration", "account", "subaccount", "bytes"];

const AMOUNT_TYPES: [&str; 10] = ["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"];
const TIME_TYPES: [&str; 5] = ["nat", "int", "nat32", "nat64", "int64"];
/// Bound on the length of any integer text this library reads (bounded work, spec section 11.6).
const MAX_INPUT_CHARS: usize = 1024;

/// A formatter's refusal of one value. The renderer shows the value as raw Candid text instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError {
    pub code: &'static str,
    pub message: String,
}

type FResult<T> = std::result::Result<T, FormatError>;

fn ferr<T>(code: &'static str, message: impl Into<String>) -> FResult<T> {
    Err(FormatError { code, message: message.into() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unit {
    Ns,
    Us,
    Ms,
    S,
}

impl Unit {
    fn ns_per(self) -> u64 {
        match self {
            Unit::Ns => 1,
            Unit::Us => 1_000,
            Unit::Ms => 1_000_000,
            Unit::S => 1_000_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encoding {
    Utf8,
    Hex,
    Base64,
}

/// A formatter bound to its tag's arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Formatter {
    Amount { decimals: usize, symbol: Option<String> },
    Timestamp { unit: Unit },
    Duration { unit: Unit },
    Account,
    Subaccount,
    Bytes { encoding: Encoding },
}

/// The formatter of a position, or `None` when it has no value tag (it is then shown as Candid text, spec section 6).
pub(crate) fn formatter_for(node: &Value, refs: &Map<String, Value>) -> Result<Option<Formatter>, Error> {
    if !matches!(prop(Some(node), "candid"), Some(Value::String(_))) {
        return Err(Error::new(codes::TYPE, "node must be a resolved-form position with a `candid` type"));
    }
    let tags = match prop(Some(node), "tags") {
        Some(Value::Object(t)) => Some(t),
        _ => None,
    };
    let present: Vec<&str> = VALUE_TAGS.iter().copied().filter(|t| tags.is_some_and(|m| m.contains_key(*t))).collect();
    let tag = match present.as_slice() {
        [] => return Ok(None),
        [one] => *one,
        many => {
            return Err(Error::new(
                codes::TAG_CONFLICT,
                format!("a position cannot carry more than one value tag, found {}", many.join(", ")),
            ))
        }
    };
    let raw = prop(tags.and_then(|m| m.get(tag)), "args");
    let raw_arg = |name: &str| prop(raw, name);
    let arg = |name: &str| resolve_arg(raw_arg(name), refs, &format!("{tag}.{name}"));
    let candid = candid_of(node);
    let require_candid = |allowed: &[&str]| {
        if allowed.contains(&candid) {
            Ok(())
        } else {
            Err(Error::new(codes::TAG_TYPE, format!("the {tag} tag applies to {}, not {candid}", allowed.join(", "))))
        }
    };
    Ok(Some(match tag {
        "amount" => {
            require_candid(&AMOUNT_TYPES)?;
            if raw_arg("decimals").is_none() {
                return Err(Error::new(codes::ARG, "the amount tag needs decimals"));
            }
            let decimals = check_decimals(arg("decimals")?)?;
            let symbol = check_symbol(arg("symbol")?)?;
            Formatter::Amount { decimals, symbol }
        }
        "timestamp" => {
            require_candid(&TIME_TYPES)?;
            if let Some(epoch) = raw_arg("epoch") {
                if epoch.as_str() != Some("unix") {
                    return Err(Error::new(codes::ARG, format!("timestamp epoch must be \"unix\", got {epoch}")));
                }
            }
            Formatter::Timestamp { unit: require_unit(arg("unit")?, tag)? }
        }
        "duration" => {
            require_candid(&TIME_TYPES)?;
            Formatter::Duration { unit: require_unit(arg("unit")?, tag)? }
        }
        "account" => {
            require_candid(&["record"])?;
            if let Some(enc) = raw_arg("encoding") {
                if enc.as_str() != Some("icrc1") {
                    return Err(Error::new(codes::ARG, format!("account encoding must be \"icrc1\", got {enc}")));
                }
            }
            Formatter::Account
        }
        "subaccount" => {
            require_candid(&["blob"])?;
            Formatter::Subaccount
        }
        _ => {
            require_candid(&["blob"])?;
            let encoding = match arg("encoding")?.as_ref().and_then(Value::as_str) {
                Some("utf8") => Encoding::Utf8,
                Some("hex") => Encoding::Hex,
                Some("base64") => Encoding::Base64,
                _ => {
                    let got = arg("encoding")?.map_or("undefined".to_string(), |v| v.to_string());
                    return Err(Error::new(codes::ARG, format!("the bytes tag needs encoding utf8, hex or base64, got {got}")));
                }
            };
            Formatter::Bytes { encoding }
        }
    }))
}

/// A dynamic value (`{ "from": ... }`) replaced by the caller-supplied one; literals pass through.
fn resolve_arg(arg: Option<&Value>, refs: &Map<String, Value>, at: &str) -> Result<Option<Value>, Error> {
    let obj = match arg {
        Some(Value::Object(o)) => o,
        other => return Ok(other.cloned()),
    };
    let from = match obj.get("from") {
        Some(Value::String(f)) => f,
        _ => return Err(Error::new(codes::ARG, format!("{at} is an object without a \"from\" string"))),
    };
    if from == "now" || from == "caller" {
        return Err(Error::new(codes::ARG, format!("{at}: {{ \"from\": \"{from}\" }} is not valid here (only default.value may use it)")));
    }
    match refs.get(from) {
        Some(v) => Ok(Some(v.clone())),
        None => Err(Error::new(
            codes::REF_UNRESOLVED,
            format!(
                "{at} needs the value of \"{from}\", which the caller did not supply (call it once per canister and pass it in `refs`)"
            ),
        )),
    }
}

fn check_decimals(d: Option<Value>) -> Result<usize, Error> {
    let n = match &d {
        Some(Value::String(s))
            if s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0')) && !s.is_empty() =>
        {
            s.parse::<f64>().ok()
        }
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    match n {
        Some(n) if n.fract() == 0.0 && (0.0..=255.0).contains(&n) => Ok(n as usize),
        _ => Err(Error::new(
            codes::ARG,
            format!("amount decimals must be an integer from 0 to 255, got {}", d.as_ref().map_or("undefined".into(), js_string)),
        )),
    }
}

fn check_symbol(symbol: Option<Value>) -> Result<Option<String>, Error> {
    let s = match symbol {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s,
        Some(other) => return Err(Error::new(codes::ARG, format!("amount symbol must be a string, got {}", js_typeof(&other)))),
    };
    let n = s.chars().count();
    if !(1..=32).contains(&n) {
        return Err(Error::new(codes::ARG, format!("amount symbol must be 1 to 32 characters, got {n}")));
    }
    if js_trim(&s) != s || s.chars().any(is_unsafe) {
        return Err(Error::new(
            codes::ARG,
            format!("amount symbol {} has surrounding whitespace, control or invisible characters", json_string(&s)),
        ));
    }
    Ok(Some(s))
}

fn require_unit(unit: Option<Value>, tag: &str) -> Result<Unit, Error> {
    match unit.as_ref().and_then(Value::as_str) {
        Some("ns") => Ok(Unit::Ns),
        Some("us") => Ok(Unit::Us),
        Some("ms") => Ok(Unit::Ms),
        Some("s") => Ok(Unit::S),
        _ if unit.is_none() => Err(Error::new(codes::ARG, format!("the {tag} tag needs a unit"))),
        _ => Err(Error::new(codes::ARG, format!("unit must be one of ns, us, ms, s, got {}", unit.unwrap_or(Value::Null)))),
    }
}

impl Formatter {
    pub(crate) fn tag(&self) -> &'static str {
        match self {
            Formatter::Amount { .. } => "amount",
            Formatter::Timestamp { .. } => "timestamp",
            Formatter::Duration { .. } => "duration",
            Formatter::Account => "account",
            Formatter::Subaccount => "subaccount",
            Formatter::Bytes { .. } => "bytes",
        }
    }

    /// The display text of one value. A timestamp is shown in the zone `utc_offset_minutes` east of UTC as
    /// `YYYY-MM-DD HH:MM:SS UTC` or `... UTC+02:00` (the generic form of `src/display.mjs`).
    pub(crate) fn display(&self, value: &Tree, utc_offset_minutes: i32) -> FResult<String> {
        match self {
            Formatter::Amount { decimals, symbol } => display_amount(value, *decimals, symbol.as_deref()),
            Formatter::Timestamp { unit } => display_zoned(value, *unit, utc_offset_minutes),
            Formatter::Duration { unit } => display_duration(value, *unit),
            Formatter::Account => display_account(value),
            Formatter::Subaccount => display_subaccount(bytes_of(value, "subaccount")?),
            Formatter::Bytes { encoding } => Ok(display_bytes(bytes_of(value, "bytes")?, *encoding)),
        }
    }
}

// ------------------------------------------------------------------------------------------------ integers

/// A decoded integer (decimal text), as `toBigInt` of packages/format reads it.
fn int_text<'a>(value: &'a Tree, what: &str) -> FResult<&'a str> {
    match value {
        Tree::Int(s) if s.len() > MAX_INPUT_CHARS => ferr("E_TOO_LONG", format!("{what} is too long")),
        Tree::Int(s) => Ok(s),
        _ => ferr(codes::TYPE, format!("{what} must be a decimal string or a bigint")),
    }
}

fn big(s: &str) -> BigInt {
    s.parse().unwrap_or_default()
}

// The decoder reads every integer within its Candid type, so the range checks of packages/format always pass here.

fn display_amount(value: &Tree, decimals: usize, symbol: Option<&str>) -> FResult<String> {
    let s = int_text(value, "amount")?;
    let (negative, magnitude) = match s.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, s),
    };
    let digits = format!("{:0>width$}", magnitude, width = decimals + 1);
    let (whole, frac) = digits.split_at(digits.len() - decimals);
    let frac = frac.trim_end_matches('0');
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(whole);
    if !frac.is_empty() {
        let _ = write!(out, ".{frac}");
    }
    if let Some(sym) = symbol {
        let _ = write!(out, " {sym}");
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------------------ time

const NS_PER_S: i128 = 1_000_000_000;
const S_PER_DAY: i128 = 86_400;

fn days_from_civil(y0: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y0 - 1 } else { y0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2).div_euclid(5) + d - 1;
    let doe = yoe * 365 + yoe.div_euclid(4) - yoe.div_euclid(100) + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z0: i64) -> (i64, i64, i64) {
    let z = z0 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Canonical RFC 3339 UTC, `YYYY-MM-DDTHH:MM:SS[.f]Z`, for 0000-01-01 to 9999-12-31.
fn rfc3339_from_ns(ns: i128) -> FResult<String> {
    let min_s = days_from_civil(0, 1, 1) as i128 * S_PER_DAY;
    let max_s = (days_from_civil(9999, 12, 31) as i128 + 1) * S_PER_DAY - 1;
    let secs = ns.div_euclid(NS_PER_S);
    let frac_ns = ns - secs * NS_PER_S;
    if secs < min_s || secs > max_s {
        return ferr("E_RANGE", "the time is outside 0000-01-01T00:00:00Z to 9999-12-31T23:59:59Z");
    }
    let days = secs.div_euclid(S_PER_DAY);
    let sod = secs - days * S_PER_DAY;
    let (y, mo, d) = civil_from_days(days as i64);
    let frac = format!("{frac_ns:09}");
    let frac = frac.trim_end_matches('0');
    let frac = if frac.is_empty() { String::new() } else { format!(".{frac}") };
    Ok(format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}{frac}Z", sod / 3600, (sod % 3600) / 60, sod % 60))
}

/// `UTC`, `UTC+02:00`, `UTC-05:30`.
pub(crate) fn zone_name(offset_minutes: i32) -> String {
    if offset_minutes == 0 {
        return "UTC".into();
    }
    let abs = offset_minutes.unsigned_abs();
    format!("UTC{}{:02}:{:02}", if offset_minutes < 0 { "-" } else { "+" }, abs / 60, abs % 60)
}

/// A timestamp in the requested zone: the instant shifted by whole minutes, shown with the calendar code.
fn display_zoned(value: &Tree, unit: Unit, offset_minutes: i32) -> FResult<String> {
    let ns =
        big(int_text(value, "value")?) * BigInt::from(unit.ns_per()) + BigInt::from(offset_minutes) * BigInt::from(60 * NS_PER_S as i64);
    let ns = i128::try_from(ns).or_else(|_| ferr("E_RANGE", "the time is outside 0000-01-01T00:00:00Z to 9999-12-31T23:59:59Z"))?;
    let utc = rfc3339_from_ns(ns)?;
    Ok(format!("{} {}", utc[..utc.len() - 1].replacen('T', " ", 1), zone_name(offset_minutes)))
}

/// Canonical ISO 8601: days, hours, minutes and seconds, each only when non-zero; zero is `PT0S`.
fn display_duration(value: &Tree, unit: Unit) -> FResult<String> {
    let v = big(int_text(value, "duration")?);
    let negative = v.sign() == Sign::Minus;
    let total: BigUint = v.magnitude() * BigUint::from(unit.ns_per());
    let ns_per_s = BigUint::from(NS_PER_S as u64);
    let secs = &total / &ns_per_s;
    let frac = format!("{:0>9}", (&total % &ns_per_s).to_string());
    let frac = frac.trim_end_matches('0');
    let day = BigUint::from(S_PER_DAY as u64);
    let zero = BigUint::from(0u8);
    let days = &secs / &day;
    let h = (&secs % &day) / BigUint::from(3600u32);
    let mi = (&secs % BigUint::from(3600u32)) / BigUint::from(60u32);
    let s = &secs % BigUint::from(60u32);
    let mut out = if days != zero { format!("{days}D") } else { String::new() };
    let mut t = String::new();
    if h != zero {
        let _ = write!(t, "{h}H");
    }
    if mi != zero {
        let _ = write!(t, "{mi}M");
    }
    if s != zero || !frac.is_empty() {
        let _ = write!(t, "{s}{}S", if frac.is_empty() { String::new() } else { format!(".{frac}") });
    }
    if out.is_empty() && t.is_empty() {
        t = "0S".into();
    }
    if !t.is_empty() {
        let _ = write!(out, "T{t}");
    }
    Ok(format!("{}P{out}", if negative { "-" } else { "" }))
}

// ------------------------------------------------------------------------------------------------ principals, accounts

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const MAX_PRINCIPAL_BYTES: usize = 29;

fn crc32(bytes: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for &b in bytes {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xffff_ffff
}

fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(BASE32[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(BASE32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in text.chars() {
        let v = BASE32.iter().position(|&c| c as char == ch)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
        acc &= (1 << bits) - 1;
    }
    if bits >= 5 || acc != 0 {
        return None;
    }
    Some(out)
}

/// Canonical principal text for up to 29 bytes.
pub fn principal_to_text(bytes: &[u8]) -> String {
    let mut all = crc32(bytes).to_be_bytes().to_vec();
    all.extend_from_slice(bytes);
    let b32 = base32_encode(&all);
    b32.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join("-")
}

fn principal_from_text(text: &str) -> FResult<Vec<u8>> {
    if text.chars().map(char::len_utf16).sum::<usize>() > MAX_INPUT_CHARS {
        return ferr("E_TOO_LONG", "principal text is too long");
    }
    let lower = text.to_lowercase();
    let not = |why: &str| ferr(codes_principal(), format!("{} is not a principal: {why}", json_string(text)));
    let decoded = match base32_decode(&lower.replace('-', "")) {
        Some(d) => d,
        None => return not("it must be base32 (a to z, 2 to 7) in groups of five separated by dashes"),
    };
    if decoded.len() < 4 {
        return not("too short");
    }
    let data = &decoded[4..];
    if data.len() > MAX_PRINCIPAL_BYTES {
        return not("more than 29 bytes");
    }
    if decoded[..4] != crc32(data).to_be_bytes() {
        return not("the checksum does not match (a character was probably mistyped)");
    }
    let canonical = principal_to_text(data);
    if lower != canonical {
        return ferr(codes_principal(), format!("{} is not a canonical principal: dashes must separate groups of five", json_string(text)));
    }
    Ok(data.to_vec())
}

fn codes_principal() -> &'static str {
    "E_PRINCIPAL"
}

fn owner_bytes(owner: Option<&Tree>) -> FResult<Vec<u8>> {
    match owner {
        Some(Tree::Principal(b)) | Some(Tree::Blob(b)) if b.len() <= MAX_PRINCIPAL_BYTES => Ok(b.clone()),
        Some(Tree::Principal(b)) | Some(Tree::Blob(b)) => {
            ferr(codes_principal(), format!("a principal is at most 29 bytes, got {}", b.len()))
        }
        Some(Tree::Text(s)) => principal_from_text(s),
        _ => ferr(codes::TYPE, "owner must be a Uint8Array or an array of byte values"),
    }
}

fn display_account(value: &Tree) -> FResult<String> {
    if !matches!(value, Tree::Record(_)) {
        return ferr(codes::TYPE, "account must be { owner, subaccount }");
    }
    let owner = owner_bytes(value.get("owner"))?;
    let owner_text = principal_to_text(&owner);
    let sub = match value.get("subaccount") {
        None | Some(Tree::Null) => return Ok(owner_text),
        Some(t) => bytes_of(t, "subaccount")?,
    };
    if sub.len() != 32 {
        return ferr("E_LENGTH", format!("a subaccount is 32 bytes, got {}", sub.len()));
    }
    if sub.iter().all(|&b| b == 0) {
        return Ok(owner_text);
    }
    let mut all = owner.clone();
    all.extend_from_slice(sub);
    let checksum = base32_encode(&crc32(&all).to_be_bytes());
    Ok(format!("{owner_text}-{checksum}.{}", hex(sub).trim_start_matches('0')))
}

/// A blob value (`toBytes`). An empty `vec` passes too, as an empty array does in JavaScript.
fn bytes_of<'a>(value: &'a Tree, what: &str) -> FResult<&'a [u8]> {
    match value {
        Tree::Blob(b) => Ok(b),
        Tree::Vec(v) if v.is_empty() => Ok(&[]),
        _ => ferr(codes::TYPE, format!("{what} must be a Uint8Array or an array of byte values")),
    }
}

fn display_subaccount(b: &[u8]) -> FResult<String> {
    if b.len() != 32 {
        return ferr("E_LENGTH", format!("a subaccount is 32 bytes, got {}", b.len()));
    }
    if b[..24].iter().all(|&x| x == 0) {
        let mut n = [0u8; 8];
        n.copy_from_slice(&b[24..]);
        return Ok(format!("#{}", u64::from_be_bytes(n)));
    }
    Ok(hex(b))
}

// ------------------------------------------------------------------------------------------------ bytes

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18 & 63) as usize] as char);
        out.push(B64[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// utf8: the text when the bytes are valid UTF-8 with no control or invisible character and no 0x/0X prefix,
/// else 0x and hex. hex: 0x and hex. base64: padded, standard alphabet.
fn display_bytes(bytes: &[u8], encoding: Encoding) -> String {
    match encoding {
        Encoding::Hex => format!("0x{}", hex(bytes)),
        Encoding::Base64 => base64(bytes),
        Encoding::Utf8 => match std::str::from_utf8(bytes) {
            Ok(text) if !text.chars().any(is_unsafe) && !text.starts_with("0x") && !text.starts_with("0X") => text.to_string(),
            _ => format!("0x{}", hex(bytes)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(s: &str) -> Tree {
        Tree::Int(s.into())
    }

    #[test]
    fn amounts() {
        assert_eq!(display_amount(&int("150000000"), 8, Some("TKA")).unwrap(), "1.5 TKA");
        assert_eq!(display_amount(&int("5"), 18, None).unwrap(), "0.000000000000000005");
        assert_eq!(display_amount(&int("-1200"), 2, Some("X")).unwrap(), "-12 X");
        assert_eq!(display_amount(&int("7"), 0, None).unwrap(), "7");
        assert_eq!(display_amount(&int(&"9".repeat(1025)), 0, None).unwrap_err().code, "E_TOO_LONG");
    }

    #[test]
    fn times() {
        assert_eq!(display_zoned(&int("1791547200"), Unit::S, 0).unwrap(), "2026-10-09 12:00:00 UTC");
        assert_eq!(display_zoned(&int("1791547200000000000"), Unit::Ns, -330).unwrap(), "2026-10-09 06:30:00 UTC-05:30");
        assert_eq!(display_zoned(&int("1500"), Unit::Ms, 0).unwrap(), "1970-01-01 00:00:01.5 UTC");
        assert_eq!(display_zoned(&int("-62167219200"), Unit::S, 0).unwrap(), "0000-01-01 00:00:00 UTC");
        assert_eq!(display_zoned(&int("-62167219201"), Unit::S, 0).unwrap_err().code, "E_RANGE");
        assert_eq!(display_zoned(&int("253402300799"), Unit::S, 0).unwrap(), "9999-12-31 23:59:59 UTC");
        assert_eq!(display_zoned(&int("253402300800"), Unit::S, 0).unwrap_err().code, "E_RANGE");
        assert_eq!(display_zoned(&int("951782400"), Unit::S, 0).unwrap(), "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn durations() {
        assert_eq!(display_duration(&int("86400"), Unit::S).unwrap(), "P1D");
        assert_eq!(display_duration(&int("5400"), Unit::S).unwrap(), "PT1H30M");
        assert_eq!(display_duration(&int("0"), Unit::Ns).unwrap(), "PT0S");
        assert_eq!(display_duration(&int("500"), Unit::Ms).unwrap(), "PT0.5S");
        assert_eq!(display_duration(&int("-90061"), Unit::S).unwrap(), "-P1DT1H1M1S");
        assert_eq!(display_duration(&int("86400000000001"), Unit::Ns).unwrap(), "P1DT0.000000001S");
    }

    #[test]
    fn principals_and_accounts() {
        // the vectors of packages/format/test/account.test.mjs (dfxgiyy is the worked example of ICRC-1 TextualEncoding.md)
        let owner = principal_from_text("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae").unwrap();
        assert_eq!(principal_to_text(&owner), "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
        let mut sub = vec![0u8; 32];
        sub[31] = 1;
        let acct = Tree::Record(vec![("owner".into(), Tree::Principal(owner.clone())), ("subaccount".into(), Tree::Blob(sub))]);
        assert_eq!(display_account(&acct).unwrap(), "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-6cc627i.1");
        let sub: Vec<u8> = (1..=32).collect();
        let acct = Tree::Record(vec![("owner".into(), Tree::Principal(owner)), ("subaccount".into(), Tree::Blob(sub))]);
        assert_eq!(
            display_account(&acct).unwrap(),
            "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
        );
        assert_eq!(principal_to_text(&[]), "aaaaa-aa");
        assert!(principal_from_text("aaaaa-ab").is_err());
    }

    #[test]
    fn subaccounts_and_bytes() {
        let mut b = [0u8; 32];
        b[31] = 7;
        assert_eq!(display_subaccount(&b).unwrap(), "#7");
        b[0] = 1;
        assert_eq!(display_subaccount(&b).unwrap(), format!("01{}07", "0".repeat(60)));
        assert_eq!(display_subaccount(&b[..5]).unwrap_err().code, "E_LENGTH");
        assert_eq!(display_bytes(b"grant #42", Encoding::Utf8), "grant #42");
        assert_eq!(display_bytes(b"0xab", Encoding::Utf8), "0x30786162");
        assert_eq!(display_bytes(b"a\nb", Encoding::Utf8), "0x610a62");
        assert_eq!(display_bytes(&[0xff], Encoding::Utf8), "0xff");
        assert_eq!(display_bytes("\u{feff}x".as_bytes(), Encoding::Utf8), "0xefbbbf78");
        assert_eq!(display_bytes(b"ab", Encoding::Base64), "YWI=");
        assert_eq!(display_bytes(b"abc", Encoding::Base64), "YWJj");
        assert_eq!(display_bytes(b"a", Encoding::Base64), "YQ==");
        assert_eq!(display_bytes(&[1, 2], Encoding::Hex), "0x0102");
    }
}
