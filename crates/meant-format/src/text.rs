use alloc::string::String;
use core::fmt::Write as _;

/// The longest text this crate reads, in UTF-16 code units (what JavaScript's
/// `length` counts), so that work is bounded and a value refused by the
/// reference for its length is refused here too.
pub const MAX_INPUT_UTF16_LEN: usize = 1024;

/// Whether `text` is longer than [`MAX_INPUT_UTF16_LEN`] UTF-16 code units.
/// Stops counting once the bound is passed.
pub(crate) fn too_long(text: &str) -> bool {
    // Every UTF-8 byte is at most one UTF-16 unit, so short text is decided
    // without decoding.
    if text.len() <= MAX_INPUT_UTF16_LEN {
        return false;
    }
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > MAX_INPUT_UTF16_LEN {
            return true;
        }
    }
    false
}

/// ECMAScript's WhiteSpace and LineTerminator: what `String.prototype.trim`
/// removes and what `\s` matches. Unlike Rust's `char::is_whitespace` it
/// includes U+FEFF and excludes U+0085.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{D}'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// A character that must never be shown inline in consent or tool text:
/// general categories Cc (controls), Cf (format characters such as
/// bidirectional overrides and zero-width joiners), Zl and Zp. The table is
/// Unicode 16.0, taken from Node 22's `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u`.
pub(crate) fn is_unsafe_display(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1F}'
            | '\u{7F}'..='\u{9F}'
            | '\u{AD}'
            | '\u{600}'..='\u{605}'
            | '\u{61C}'
            | '\u{6DD}'
            | '\u{70F}'
            | '\u{890}'..='\u{891}'
            | '\u{8E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// `JSON.stringify` of a string, so messages quote input the way the
/// reference does.
pub(crate) fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
