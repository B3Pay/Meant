//! Text safety, the port of `src/text.mjs` (spec section 6, "Escaping values"; section 11 item 4).
//!
//! JavaScript strings are UTF-16. Where that shows (the length of a text, the neighbours of an underscore, what
//! `trim` and `\s` remove), these functions count and look the way the JavaScript version does.

use std::fmt::Write;

use unicode_general_category::{get_general_category, GeneralCategory as G};

/// Control (Cc), format (Cf, including bidi overrides), line separator (Zl) and paragraph separator (Zp) characters.
pub(crate) fn is_unsafe(c: char) -> bool {
    matches!(get_general_category(c), G::Control | G::Format | G::LineSeparator | G::ParagraphSeparator)
}

fn is_line_break(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// JavaScript's WhiteSpace and LineTerminator (what `trim` removes and `\s` matches). Rust's `is_whitespace` has
/// U+0085 too and lacks U+FEFF.
pub(crate) fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The length of a text in UTF-16 code units (JavaScript's `length`).
pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Show invisible characters instead of passing them through: U+202E becomes the six characters `\u{202e}`.
pub fn visible(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if is_unsafe(c) {
            let _ = write!(out, "\\u{{{:x}}}", c as u32);
        } else {
            out.push(c);
        }
    }
    out
}

/// Template text and labels come from the profile: one line, so each run of line breaks becomes one space.
pub fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_break = false;
    for c in s.chars() {
        if is_line_break(c) {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    visible(&out)
}

/// A letter or digit as `[\p{L}\p{N}]` sees one UTF-16 code unit: a character outside the BMP is a surrogate there,
/// which is neither.
fn is_word_unit(c: Option<char>) -> bool {
    match c {
        Some(c) if (c as u32) <= 0xffff => matches!(
            get_general_category(c),
            G::UppercaseLetter
                | G::LowercaseLetter
                | G::TitlecaseLetter
                | G::ModifierLetter
                | G::OtherLetter
                | G::DecimalNumber
                | G::LetterNumber
                | G::OtherNumber
        ),
        _ => false,
    }
}

/// Backslash-escape the characters that start inline Markdown constructs. An underscore between two letters or
/// digits cannot open emphasis in CommonMark, so `snake_case` stays readable; every other underscore is escaped.
pub fn escape_markdown(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '\\' | '`' | '*' | '[' | ']' | '<' | '>' | '&' | '~' | '|' | '#' => {
                out.push('\\');
                out.push(c);
            }
            '_' => {
                let prev = if i == 0 { None } else { Some(chars[i - 1]) };
                if !(is_word_unit(prev) && is_word_unit(chars.get(i + 1).copied())) {
                    out.push('\\');
                }
                out.push('_');
            }
            _ => out.push(c),
        }
    }
    out
}

fn leading_space_end(s: &str) -> usize {
    s.char_indices().find(|&(_, c)| !is_js_space(c)).map_or(s.len(), |(i, _)| i)
}

/// A list marker or ordered-list number at the start of a line would open a block; escape it.
/// (`^(\s*)(\d+)([.)])` then `^(\s*)([-+=])`, as in the JavaScript version.)
pub fn escape_line_start(s: &str) -> String {
    let mut s = s.to_string();
    let start = leading_space_end(&s);
    let digits = s[start..].bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && matches!(s.as_bytes().get(start + digits), Some(b'.') | Some(b')')) {
        s.insert(start + digits, '\\');
    }
    let start = leading_space_end(&s);
    if matches!(s.as_bytes().get(start), Some(b'-') | Some(b'+') | Some(b'=')) {
        s.insert(start, '\\');
    }
    s
}

fn longest_backtick_run(s: &str) -> usize {
    let (mut longest, mut run) = (0, 0);
    for b in s.bytes() {
        run = if b == b'`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    longest
}

/// An empty string, distinguishable from a code span that contains the same words.
pub fn empty_markdown() -> String {
    "*(empty)*".to_string()
}

/// One string as a Markdown code span: verbatim, whatever it contains. The fence is one backtick longer than the
/// longest backtick run inside; a space pads content that starts or ends with a backtick or a space.
pub fn code_span(s: &str) -> String {
    let text = visible(s);
    if text.is_empty() {
        return empty_markdown();
    }
    let fence = "`".repeat(longest_backtick_run(&text) + 1);
    let all_spaces = text.bytes().all(|b| b == b' ');
    let edge = |b: Option<u8>| matches!(b, Some(b' ') | Some(b'`'));
    let pad = if !all_spaces && (edge(text.bytes().next()) || edge(text.bytes().last())) { " " } else { "" };
    format!("{fence}{pad}{text}{pad}{fence}")
}

/// A fenced block for one line of technical text; the fence outgrows any backtick run inside.
pub fn code_block(s: &str) -> String {
    let text = visible(s);
    let fence = "`".repeat(longest_backtick_run(&text).max(2) + 1);
    format!("{fence}\n{text}\n{fence}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_shows_controls_and_bidi() {
        assert_eq!(visible("a\u{202e}b\u{0}c\u{2028}"), "a\\u{202e}b\\u{0}c\\u{2028}");
        assert_eq!(visible("\u{feff}"), "\\u{feff}");
    }

    #[test]
    fn one_line_joins_runs_of_breaks() {
        assert_eq!(one_line("a\r\n\nb\u{85}c\td"), "a b c\\u{9}d");
    }

    #[test]
    fn trim_is_javascript_trim() {
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn underscores_between_letters_stay() {
        assert_eq!(
            escape_markdown("snake_case _x x_ a_1 *b* [c](d) <e> #f |g| ~h &i"),
            "snake_case \\_x x\\_ a_1 \\*b\\* \\[c\\](d) \\<e\\> \\#f \\|g\\| \\~h \\&i"
        );
        // a neighbour outside the BMP is a surrogate in UTF-16, so the underscore is escaped, as in JavaScript
        assert_eq!(escape_markdown("\u{1d400}_a"), "\u{1d400}\\_a");
        assert_eq!(escape_markdown("é_ü"), "é_ü");
    }

    #[test]
    fn line_start() {
        assert_eq!(escape_line_start("12. x"), "12\\. x");
        assert_eq!(escape_line_start("  3) x"), "  3\\) x");
        assert_eq!(escape_line_start("- x"), "\\- x");
        assert_eq!(escape_line_start("12 x"), "12 x");
        assert_eq!(escape_line_start("+1"), "\\+1");
    }

    #[test]
    fn code_spans() {
        assert_eq!(code_span(""), "*(empty)*");
        assert_eq!(code_span("a`b"), "``a`b``");
        assert_eq!(code_span("`a"), "`` `a ``");
        assert_eq!(code_span("  "), "`  `");
        assert_eq!(code_span(" a"), "`  a `");
        assert_eq!(code_block("a```b"), "````\na```b\n````");
        assert_eq!(code_block("x"), "```\nx\n```");
    }

    #[test]
    fn utf16_lengths() {
        assert_eq!(utf16_len("a\u{1d400}é"), 4);
    }
}
