//! Turning values into text (`src/display.mjs`) and a model into the generic Markdown message (`src/render.mjs`).
//!
//! Every tagged position is shown with the formatter of its tag; an untagged position is Candid text. A formatter that
//! refuses one value leaves it as raw Candid text and records a diagnostic; a formatter that cannot be built stops
//! the message.

use std::collections::HashMap;
use std::fmt::Write;

use serde_json::{Map, Value};

use crate::decode::Tree;
use crate::error::{codes, Error, Result};
use crate::format::{formatter_for, principal_to_text, Formatter};
use crate::model::{Diagnostic, Model, SentencePart};
use crate::resolved::{candid_of, entries_of, is_optional, js_number, prop};
use crate::text::{code_block, code_span, escape_line_start, escape_markdown, js_trim, one_line, utf16_len, visible};

/// Budget for the text of one message, in UTF-16 code units (a consent message is read by a person).
pub const MAX_MESSAGE_CHARS: usize = 32 * 1024;

pub(crate) struct Renderer<'r> {
    refs: &'r Map<String, Value>,
    /// Timestamps are shown in this zone (minutes east of UTC).
    utc_offset_minutes: i32,
    chars: usize,
    /// Set while `plain_tuple_text` runs: no formatter applies.
    plain: bool,
    formatters: HashMap<usize, Option<Formatter>>,
    pub diagnostics: Vec<Diagnostic>,
    /// Set when a timestamp was shown in the requested zone, so a response can say the text is zone-sensitive.
    pub used_zone: bool,
}

impl<'r> Renderer<'r> {
    pub(crate) fn new(refs: &'r Map<String, Value>, utc_offset_minutes: i32) -> Self {
        Renderer { refs, utc_offset_minutes, chars: 0, plain: false, formatters: HashMap::new(), diagnostics: Vec::new(), used_zone: false }
    }

    fn formatter(&mut self, node: &Value) -> Result<Option<Formatter>> {
        let key = node as *const Value as usize;
        if let Some(f) = self.formatters.get(&key) {
            return Ok(f.clone());
        }
        let f = formatter_for(node, self.refs)?;
        self.formatters.insert(key, f.clone());
        Ok(f)
    }

    fn charge(&mut self, text: String) -> Result<String> {
        self.chars += utf16_len(&text);
        if self.chars > MAX_MESSAGE_CHARS {
            return Err(Error::new(
                codes::TOO_LARGE,
                format!("the message would exceed {MAX_MESSAGE_CHARS} characters; it is never truncated"),
            ));
        }
        Ok(text)
    }

    /// Plain display text of one value, not yet escaped for any format.
    pub(crate) fn text(&mut self, node: &Value, value: &Tree, at: &str) -> Result<String> {
        if let Some(shown) = self.formatted(node, value, at)? {
            return self.charge(shown);
        }
        // An untagged principal is its canonical text; inside a composite it stays `principal "..."`.
        if let ("principal", Tree::Principal(p)) = (candid_of(node), value) {
            return self.charge(principal_to_text(p));
        }
        let raw = self.raw(node, value, at)?;
        self.charge(raw)
    }

    /// Candid text of a whole argument tuple, tagged children formatted (the raw arguments of spec section 11 item 1).
    pub(crate) fn tuple_text(&mut self, nodes: &[Value], values: &[Tree]) -> Result<String> {
        let parts = nodes
            .iter()
            .zip(values)
            .enumerate()
            .map(|(i, (n, v))| self.child(n, v, &format!("argument {i}")))
            .collect::<Result<Vec<_>>>()?;
        self.charge(format!("({})", parts.join(", ")))
    }

    /// Candid text of a whole argument tuple with no formatter applied: base units, nanoseconds, blobs as bytes.
    pub(crate) fn plain_tuple_text(&mut self, nodes: &[Value], values: &[Tree]) -> Result<String> {
        self.plain = true;
        let text = self.tuple_text(nodes, values);
        self.plain = false;
        text
    }

    /// The formatter's text, or `None` when the position has no value tag or the formatter refuses the value.
    fn formatted(&mut self, node: &Value, value: &Tree, at: &str) -> Result<Option<String>> {
        if self.plain {
            return Ok(None);
        }
        let Some(f) = self.formatter(node)? else { return Ok(None) };
        match f.display(value, self.utc_offset_minutes) {
            Ok(s) => {
                self.used_zone |= matches!(f, Formatter::Timestamp { .. });
                Ok(Some(s))
            }
            Err(e) => {
                self.diagnostics.push(Diagnostic {
                    code: "W_FORMAT_FALLBACK",
                    at: at.to_string(),
                    message: format!(
                        "the {} formatter refused the value ({}: {}); it is shown as raw Candid text",
                        f.tag(),
                        e.code,
                        e.message
                    ),
                });
                Ok(None)
            }
        }
    }

    /// A child of a composite: absent is `null`, a tagged child uses its formatter, any other is raw.
    fn child(&mut self, node: &Value, value: &Tree, at: &str) -> Result<String> {
        if is_optional(node) && *value == Tree::Null {
            return Ok("null".into());
        }
        if let Some(shown) = self.formatted(node, value, at)? {
            return Ok(shown);
        }
        let raw = self.raw(node, value, at)?;
        Ok(if is_optional(node) { format!("opt {raw}") } else { raw })
    }

    fn raw(&mut self, node: &Value, value: &Tree, at: &str) -> Result<String> {
        let kind = candid_of(node);
        Ok(match (kind, value) {
            ("null" | "reserved", _) => "null".into(),
            ("bool", Tree::Bool(b)) => b.to_string(),
            ("text", Tree::Text(s)) => candid_string(s),
            ("principal", Tree::Principal(p)) => format!("principal \"{}\"", principal_to_text(p)),
            ("blob", Tree::Blob(b)) => {
                let mut s = String::from("blob \"");
                for byte in b {
                    let _ = write!(s, "\\{byte:02x}");
                }
                s.push('"');
                s
            }
            ("float32" | "float64", Tree::Float(f)) => {
                if f.is_nan() {
                    "nan".into()
                } else if f.is_infinite() {
                    if *f > 0.0 {
                        "inf".into()
                    } else {
                        "-inf".into()
                    }
                } else {
                    js_number(*f)
                }
            }
            ("vec", Tree::Vec(items)) => {
                let element =
                    prop(Some(node), "element").ok_or_else(|| Error::new(codes::INTERNAL, format!("{at}: vec without element")))?;
                if items.is_empty() {
                    "vec {}".into()
                } else {
                    let parts =
                        items.iter().enumerate().map(|(i, e)| self.child(element, e, &format!("{at}[{i}]"))).collect::<Result<Vec<_>>>()?;
                    format!("vec {{ {} }}", parts.join("; "))
                }
            }
            ("record", Tree::Record(_)) => {
                let mut parts = Vec::new();
                for (key, child) in entries_of(prop(Some(node), "fields")) {
                    let v = value.get(key).ok_or_else(|| Error::new(codes::INTERNAL, format!("{at}: no field {key}")))?;
                    parts.push(format!("{} = {}", candid_label(key), self.child(child, v, &format!("{at}.{key}"))?));
                }
                if parts.is_empty() {
                    "record {}".into()
                } else {
                    format!("record {{ {} }}", parts.join("; "))
                }
            }
            ("variant", Tree::Variant(tag, v)) => {
                let cases = entries_of(prop(Some(node), "cases"));
                let arm = cases.into_iter().find(|(k, _)| k == tag);
                match arm {
                    Some((key, child)) if !(candid_of(child) == "null" && !is_optional(child)) => {
                        format!("variant {{ {} = {} }}", candid_label(key), self.child(child, v, &format!("{at}.{key}"))?)
                    }
                    _ => format!("variant {{ {} }}", candid_label(tag)),
                }
            }
            (_, Tree::Int(s)) => s.clone(),
            _ => return Err(Error::new(codes::INTERNAL, format!("{at}: a {kind} position holds another kind of value"))),
        })
    }
}

/// A Candid text literal: quotes, backslashes and invisible characters escaped.
fn candid_string(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(c),
        }
    }
    format!("\"{}\"", visible(&escaped))
}

/// A record field or variant case label as Candid writes it: an identifier, a number for `#id`, else quoted.
fn candid_label(key: &str) -> String {
    let b = key.as_bytes();
    let ident =
        b.first().is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_');
    if ident {
        return key.to_string();
    }
    if let Some(d) = key.strip_prefix('#') {
        if !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit()) && (d == "0" || !d.starts_with('0')) {
            return d.to_string();
        }
    }
    candid_string(key)
}

// ------------------------------------------------------------------------------------------------ the generic form

const NONE_MARKDOWN: &str = "*(none)*";

/// Label and title: one line, trimmed, never empty.
fn plain_label(raw: &str, fallback: &str) -> String {
    let s = one_line(raw);
    let s = js_trim(&s);
    if s.is_empty() {
        fallback.to_string()
    } else {
        s.to_string()
    }
}

fn field_markdown(model: &Model<'_>, index: usize, renderer: &mut Renderer<'_>) -> Result<String> {
    let field = &model.fields[index];
    if field.values.is_empty() {
        return Ok(NONE_MARKDOWN.into());
    }
    let many = field.values.len() > 1;
    let mut parts = Vec::with_capacity(field.values.len());
    for (i, v) in field.values.iter().enumerate() {
        let at = if many { format!("{}[{i}]", field.path) } else { field.path.clone() };
        parts.push(code_span(&renderer.text(field.node, v, &at)?));
    }
    Ok(parts.join(", "))
}

/// The GenericDisplayMessage of spec section 12: a title at `heading_level`, the sentence, then `**label:**` lines,
/// and with `raw_arguments` the Candid text of the arguments.
pub(crate) fn render_generic(model: &Model<'_>, renderer: &mut Renderer<'_>, heading_level: usize, raw_arguments: bool) -> Result<String> {
    let mut blocks = vec![format!("{} {}", "#".repeat(heading_level), escape_markdown(&plain_label(&model.title, model.method)))];
    if let Some(sentence) = &model.sentence {
        let mut paragraph = String::new();
        for part in sentence {
            match part {
                SentencePart::Lit(t) => paragraph.push_str(&escape_markdown(&one_line(t))),
                SentencePart::Field(i) => paragraph.push_str(&field_markdown(model, *i, renderer)?),
            }
        }
        let mut paragraph = js_trim(&paragraph).to_string();
        if matches!(sentence.first(), Some(SentencePart::Lit(_))) {
            paragraph = escape_line_start(&paragraph);
        }
        if !paragraph.is_empty() {
            blocks.push(paragraph);
        }
    }
    if !model.fields.is_empty() {
        let mut lines = Vec::with_capacity(model.fields.len());
        for (i, f) in model.fields.iter().enumerate() {
            lines.push(format!("- **{}:** {}", escape_markdown(&plain_label(&f.label, &f.path)), field_markdown(model, i, renderer)?));
        }
        blocks.push(lines.join("\n"));
    } else if model.sentence.is_none() {
        blocks.push("This call has no arguments.".into());
    }
    if raw_arguments {
        blocks.push(format!("**Raw arguments:**\n\n{}", code_block(&renderer.tuple_text(model.arg_nodes, model.arg_values)?)));
    }
    Ok(blocks.join("\n\n"))
}

/// The SNS arguments block: the Candid text of the tuple, no formatter applied, in a fenced block.
pub(crate) fn plain_arguments_block(model: &Model<'_>, renderer: &mut Renderer<'_>) -> Result<String> {
    Ok(code_block(&renderer.plain_tuple_text(model.arg_nodes, model.arg_values)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_strings() {
        assert_eq!(candid_label("amount"), "amount");
        assert_eq!(candid_label("#12"), "12");
        assert_eq!(candid_label("#012"), "\"#012\"");
        assert_eq!(candid_label("a-b"), "\"a-b\"");
        assert_eq!(candid_string("a\"b\\c\nd\u{202e}"), "\"a\\\"b\\\\c\\nd\\u{202e}\"");
    }
}
