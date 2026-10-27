//! Doc attributes v1 (`docs/doc-attributes.md`): `@name(key = value, …)` lines
//! in `.did` doc comments, parsed from the docs a [`SourceInfo`] already
//! records and handed out with the item they were written on.
//!
//! The syntax carries no meaning of its own; which names exist is the reading
//! tool's business. Parsing fails closed: one error per attribute line that
//! does not parse, and no partial result. The parser walks each line once with
//! an explicit frame stack bounded by `max_source_nesting`, never by
//! recursion (ADR 0005): comments are not tokens, so the compiler's own
//! nesting preflight never saw the brackets inside them.

use super::diagnostics::budget_error;
use crate::diagnostics::{
    CompileError, Diagnostic, DiagnosticPhase, ResourceLimitInfo, SourceSpan,
};
use crate::limits::RuntimeContext;
use crate::model::{SourceInfo, SourceLabel, SourceOrigin};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const DOC_ATTRIBUTES_VERSION: u32 = 1;

/// Every item of a [`SourceInfo`] that has at least one doc line, its prose
/// and its parsed attributes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocAttributes {
    doc_attributes_version: u32,
    items: Vec<DocItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocItem {
    pub kind: DocItemKind,
    pub origin: SourceOrigin,
    /// `actor`, `type:<Name>`, or the occurrence path `SourceInfo` records.
    pub path: String,
    /// The declaration or method name, or a field's named label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The doc lines that are not attributes, normalized, in order.
    pub prose: Vec<String>,
    pub attributes: Vec<DocAttribute>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocItemKind {
    Actor,
    Declaration,
    Field,
    Method,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocAttribute {
    pub name: String,
    /// Index of the attribute's first line in the item's docs, from 0.
    pub doc_line: u32,
    pub args: Vec<DocArgument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocArgument {
    pub key: String,
    pub value: DocValue,
}

/// An argument value. A number keeps the text written, never a binary float.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocValue {
    Text { value: String },
    Number { value: String },
    Bool { value: bool },
    Ident { value: String },
    Call { name: String, args: Vec<DocValue> },
    List { items: Vec<DocValue> },
    Record { fields: Vec<DocArgument> },
}

impl DocAttributes {
    /// Parse the doc attributes of every documented item, under the default
    /// limits.
    pub fn from_source_info(source_info: &SourceInfo) -> Result<Self, CompileError> {
        Self::from_source_info_with_context(source_info, &RuntimeContext::default())
    }

    /// [`DocAttributes::from_source_info`] under the caller's limits and
    /// cancellation: nesting is bounded by `max_source_nesting` and the
    /// errors kept by `max_diagnostics`.
    pub fn from_source_info_with_context(
        source_info: &SourceInfo,
        context: &RuntimeContext,
    ) -> Result<Self, CompileError> {
        let budget = context.budget();
        let limits = budget.limits();
        let mut errors = ErrorCollector::new(limits.max_diagnostics());
        let mut items = Vec::new();
        let max_nesting = limits.max_source_nesting();

        let mut visit = |kind: DocItemKind,
                         origin: SourceOrigin,
                         path: String,
                         name: Option<String>,
                         docs: &[String],
                         errors: &mut ErrorCollector|
         -> Result<(), CompileError> {
            budget.checkpoint().map_err(|error| {
                budget_error(error, DiagnosticPhase::Parse, "doc attribute parsing")
            })?;
            if docs.is_empty() {
                return Ok(());
            }
            let source = match &origin {
                SourceOrigin::Declaration { source, .. } | SourceOrigin::Actor { source } => {
                    source.clone()
                }
            };
            let place = Place {
                path: &path,
                source: &source,
            };
            let (prose, attributes) = parse_docs(docs, max_nesting, &place, errors)?;
            items.push(DocItem {
                kind,
                origin,
                path,
                name,
                prose,
                attributes,
            });
            Ok(())
        };

        for actor in source_info.actors() {
            visit(
                DocItemKind::Actor,
                SourceOrigin::Actor {
                    source: actor.source.clone(),
                },
                "actor".to_string(),
                None,
                &actor.docs,
                &mut errors,
            )?;
        }
        for declaration in source_info.declarations() {
            visit(
                DocItemKind::Declaration,
                SourceOrigin::Declaration {
                    source: declaration.source.clone(),
                    name: declaration.name.clone(),
                },
                format!("type:{}", declaration.name),
                Some(declaration.name.clone()),
                &declaration.docs,
                &mut errors,
            )?;
        }
        for method in source_info.methods() {
            visit(
                DocItemKind::Method,
                method.origin.clone(),
                method.path.clone(),
                Some(method.name.clone()),
                &method.docs,
                &mut errors,
            )?;
        }
        for field in source_info.field_labels() {
            let name = match &field.label {
                SourceLabel::Named { name } => Some(name.clone()),
                SourceLabel::Numeric | SourceLabel::Positional => None,
            };
            visit(
                DocItemKind::Field,
                field.origin.clone(),
                field.path.clone(),
                name,
                &field.docs,
                &mut errors,
            )?;
        }

        errors.into_result()?;
        Ok(Self {
            doc_attributes_version: DOC_ATTRIBUTES_VERSION,
            items,
        })
    }

    pub fn doc_attributes_version(&self) -> u32 {
        self.doc_attributes_version
    }

    pub fn items(&self) -> &[DocItem] {
        &self.items
    }
}

/// Where an item's docs were written, for error reports.
struct Place<'a> {
    path: &'a str,
    source: &'a str,
}

/// Keeps at most `limit` errors; past it the last kept one becomes the
/// `resource_limit_exceeded` sentinel, as Contract validation does.
struct ErrorCollector {
    diagnostics: Vec<Diagnostic>,
    limit: usize,
    observed: usize,
}

impl ErrorCollector {
    fn new(limit: usize) -> Self {
        Self {
            diagnostics: Vec::new(),
            limit,
            observed: 0,
        }
    }

    fn push(&mut self, diagnostic: Diagnostic) {
        self.observed = self.observed.saturating_add(1);
        if self.diagnostics.len() < self.limit {
            self.diagnostics.push(diagnostic);
            return;
        }
        let sentinel = Diagnostic::compiler(
            "resource_limit_exceeded",
            DiagnosticPhase::Parse,
            format!(
                "resource diagnostics exceeded limit {}; observed at least {}",
                self.limit, self.observed
            ),
        )
        .with_resource_limit(ResourceLimitInfo {
            resource: "diagnostics".to_string(),
            limit: crate::limits::portable_count(self.limit),
            observed: crate::limits::portable_count(self.observed),
        });
        match self.diagnostics.last_mut() {
            Some(last) => *last = sentinel,
            None => self.diagnostics.push(sentinel),
        }
    }

    fn into_result(self) -> Result<(), CompileError> {
        if self.observed == 0 {
            Ok(())
        } else {
            Err(CompileError {
                diagnostics: self.diagnostics,
            })
        }
    }
}

/// One recorded doc string as the standard reads it: one leading `/` removed
/// (what the upstream lexer leaves of `///`), then surrounding whitespace.
fn normalize(raw: &str) -> &str {
    raw.strip_prefix('/').unwrap_or(raw).trim()
}

fn is_lower(c: char) -> bool {
    c.is_ascii_lowercase()
}

fn is_segment_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// When `line` is an attribute line (`@`, a name, then `(` or the end): the
/// name, and the byte offset just past the `(` when there is one.
fn attribute_head(line: &str) -> Option<(&str, Option<usize>)> {
    let rest = line.strip_prefix('@')?;
    let bytes = rest.as_bytes();
    if !bytes.first().is_some_and(|&b| is_lower(b as char)) {
        return None;
    }
    let mut end = 0;
    loop {
        // one segment
        end += 1;
        while end < bytes.len() && is_segment_char(bytes[end] as char) {
            end += 1;
        }
        if end + 1 < bytes.len() && bytes[end] == b'.' && is_lower(bytes[end + 1] as char) {
            end += 1;
            continue;
        }
        break;
    }
    match bytes.get(end) {
        None => Some((&rest[..end], None)),
        // `@` + name + `(`
        Some(b'(') => Some((&rest[..end], Some(end + 2))),
        Some(_) => None,
    }
}

/// Splits an item's docs into prose and attributes. A syntax error is pushed
/// to `errors` and parsing goes on with the next line after the attribute; a
/// nesting overrun ends everything at once.
fn parse_docs(
    docs: &[String],
    max_nesting: usize,
    place: &Place<'_>,
    errors: &mut ErrorCollector,
) -> Result<(Vec<String>, Vec<DocAttribute>), CompileError> {
    let mut prose = Vec::new();
    let mut attributes = Vec::new();
    let mut index = 0;
    while index < docs.len() {
        let line = normalize(&docs[index]);
        let Some((name, after)) = attribute_head(line) else {
            prose.push(line.to_string());
            index += 1;
            continue;
        };
        let first = index;
        let Some(after) = after else {
            // `@name` alone on its line
            attributes.push(DocAttribute {
                name: name.to_string(),
                doc_line: line_number(first),
                args: Vec::new(),
            });
            index += 1;
            continue;
        };
        // Gather continuation lines while a bracket is still open outside a
        // text value.
        let mut text = line[after..].to_string();
        index += 1;
        let gathered = loop {
            match open_brackets(&text) {
                Scan::Closed => break Ok(()),
                Scan::OpenText => break Err("a text value is not closed on its line".to_string()),
                Scan::Open if index < docs.len() => {
                    text.push('\n');
                    text.push_str(normalize(&docs[index]));
                    index += 1;
                }
                // out of lines: the parser names what is missing
                Scan::Open => break Ok(()),
            }
        };
        let parsed = gathered
            .map_err(|message| (DocErrorKind::Malformed, message))
            .and_then(|()| parse_arguments(&text, max_nesting));
        match parsed {
            Ok(args) => attributes.push(DocAttribute {
                name: name.to_string(),
                doc_line: line_number(first),
                args,
            }),
            Err((DocErrorKind::Nesting { observed }, message)) => {
                return Err(CompileError {
                    diagnostics: vec![Diagnostic::compiler(
                        "resource_limit_exceeded",
                        DiagnosticPhase::Parse,
                        format!("doc line {} of {}: {message}", first + 1, place.path),
                    )
                    .with_path(place.path)
                    .with_span(SourceSpan::source_only(place.source))
                    .with_resource_limit(ResourceLimitInfo {
                        resource: "source_nesting".to_string(),
                        limit: crate::limits::portable_count(max_nesting),
                        observed: crate::limits::portable_count(observed),
                    })],
                });
            }
            Err((kind, message)) => {
                let code = match kind {
                    DocErrorKind::DuplicateKey => "doc_attribute_duplicate_key",
                    DocErrorKind::Malformed | DocErrorKind::Nesting { .. } => {
                        "doc_attribute_malformed"
                    }
                };
                errors.push(
                    Diagnostic::compiler(
                        code,
                        DiagnosticPhase::Parse,
                        format!(
                            "doc line {} of {}: @{name}: {message}",
                            first + 1,
                            place.path
                        ),
                    )
                    .with_path(place.path)
                    .with_span(SourceSpan::source_only(place.source)),
                );
            }
        }
    }
    Ok((prose, attributes))
}

fn line_number(index: usize) -> u32 {
    // docs come from one source of at most `max_source_bytes`, far below u32::MAX lines
    u32::try_from(index).unwrap_or(u32::MAX)
}

enum Scan {
    Closed,
    Open,
    OpenText,
}

/// Whether the attribute that `text` continues (its `(` already consumed) has
/// closed every bracket, outside text values. Malformed bracket order is the
/// parser's to report.
fn open_brackets(text: &str) -> Scan {
    let mut depth: usize = 1;
    let mut in_text = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_text {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_text = false;
            } else if c == '\n' {
                return Scan::OpenText;
            }
            continue;
        }
        match c {
            '"' => in_text = true,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return Scan::Closed;
                }
            }
            _ => {}
        }
    }
    if in_text {
        Scan::OpenText
    } else {
        Scan::Open
    }
}

enum DocErrorKind {
    Malformed,
    DuplicateKey,
    Nesting { observed: usize },
}

type ParseResult<T> = Result<T, (DocErrorKind, String)>;

fn malformed<T>(message: impl Into<String>) -> ParseResult<T> {
    Err((DocErrorKind::Malformed, message.into()))
}

/// An open bracket and what it has collected so far.
enum Frame {
    /// The attribute's own argument list, closed by `)`.
    Arguments {
        args: Vec<DocArgument>,
        keys: BTreeSet<String>,
        key: Option<String>,
    },
    Record {
        fields: Vec<DocArgument>,
        keys: BTreeSet<String>,
        key: Option<String>,
    },
    Call {
        name: String,
        args: Vec<DocValue>,
    },
    List {
        items: Vec<DocValue>,
    },
}

impl Frame {
    fn closer(&self) -> char {
        match self {
            Frame::Arguments { .. } | Frame::Call { .. } => ')',
            Frame::Record { .. } => '}',
            Frame::List { .. } => ']',
        }
    }

    fn keyed(&self) -> bool {
        matches!(self, Frame::Arguments { .. } | Frame::Record { .. })
    }
}

struct Cursor<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<char> {
        self.text[self.pos..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn skip_space(&mut self) {
        while let Some(c) = self.peek() {
            if c == ' ' || c == '\t' || c == '\n' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn take_while(&mut self, keep: impl Fn(char) -> bool) -> &'a str {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if !keep(c) {
                break;
            }
            self.pos += c.len_utf8();
        }
        &self.text[start..self.pos]
    }

    fn describe_next(&self) -> String {
        match self.peek() {
            None => "the end of the attribute".to_string(),
            Some('\n') => "the end of the line".to_string(),
            Some(c) => format!("`{c}`"),
        }
    }
}

enum State {
    /// After an opening bracket or a comma: an item, or the closing bracket.
    ItemOrClose,
    /// After an item: a comma or the closing bracket.
    AfterItem,
}

/// Parses the text after an attribute's `(` to its matching `)` and checks
/// nothing but space follows.
fn parse_arguments(text: &str, max_nesting: usize) -> ParseResult<Vec<DocArgument>> {
    let mut cursor = Cursor { text, pos: 0 };
    let mut frames = vec![Frame::Arguments {
        args: Vec::new(),
        keys: BTreeSet::new(),
        key: None,
    }];
    check_nesting(frames.len(), max_nesting)?;
    let mut state = State::ItemOrClose;
    loop {
        cursor.skip_space();
        let top = frames
            .last_mut()
            .expect("the argument frame is never popped here");
        let next = cursor.peek();
        if next == Some(top.closer()) {
            cursor.bump();
            let closed = frames.pop().expect("a frame was on the stack");
            let value = match closed {
                Frame::Arguments {
                    args, key: None, ..
                } => {
                    cursor.skip_space();
                    if cursor.peek().is_some() {
                        return malformed(format!(
                            "unexpected {} after the closing `)`",
                            cursor.describe_next()
                        ));
                    }
                    return Ok(args);
                }
                Frame::Record {
                    fields, key: None, ..
                } => DocValue::Record { fields },
                Frame::Call { name, args } => DocValue::Call { name, args },
                Frame::List { items } => DocValue::List { items },
                Frame::Arguments { key: Some(key), .. } | Frame::Record { key: Some(key), .. } => {
                    return malformed(format!("expected a value for `{key}`"));
                }
            };
            attach(&mut frames, value);
            state = State::AfterItem;
            continue;
        }
        match state {
            State::AfterItem => {
                if next == Some(',') {
                    cursor.bump();
                    state = State::ItemOrClose;
                    continue;
                }
                let closer = frames.last().expect("a frame is open").closer();
                return malformed(format!(
                    "expected `,` or `{closer}`, found {}",
                    cursor.describe_next()
                ));
            }
            State::ItemOrClose => {}
        }
        // An item: in a keyed frame, `key =` first.
        if frames.last().expect("a frame is open").keyed() {
            let key = parse_key(&mut cursor)?;
            cursor.skip_space();
            if cursor.peek() != Some('=') {
                return malformed(format!(
                    "expected `=` after `{key}`, found {}",
                    cursor.describe_next()
                ));
            }
            cursor.bump();
            cursor.skip_space();
            match frames.last_mut().expect("a frame is open") {
                Frame::Arguments {
                    keys, key: slot, ..
                }
                | Frame::Record {
                    keys, key: slot, ..
                } => {
                    if !keys.insert(key.clone()) {
                        return Err((
                            DocErrorKind::DuplicateKey,
                            format!("the key `{key}` repeats"),
                        ));
                    }
                    *slot = Some(key);
                }
                Frame::Call { .. } | Frame::List { .. } => unreachable!("checked keyed above"),
            }
        }
        // A value, or the opening of a nested one.
        match cursor.peek() {
            Some('"') => {
                let value = parse_text(&mut cursor)?;
                attach(&mut frames, DocValue::Text { value });
                state = State::AfterItem;
            }
            Some(c) if c == '-' || c.is_ascii_digit() => {
                let value = parse_number(&mut cursor)?;
                attach(&mut frames, DocValue::Number { value });
                state = State::AfterItem;
            }
            Some('[') => {
                cursor.bump();
                frames.push(Frame::List { items: Vec::new() });
                check_nesting(frames.len(), max_nesting)?;
                state = State::ItemOrClose;
            }
            Some('{') => {
                cursor.bump();
                frames.push(Frame::Record {
                    fields: Vec::new(),
                    keys: BTreeSet::new(),
                    key: None,
                });
                check_nesting(frames.len(), max_nesting)?;
                state = State::ItemOrClose;
            }
            Some(c) if is_ident_start(c) => {
                let ident = cursor.take_while(is_ident_char).to_string();
                cursor.skip_space();
                if cursor.peek() == Some('(') {
                    cursor.bump();
                    frames.push(Frame::Call {
                        name: ident,
                        args: Vec::new(),
                    });
                    check_nesting(frames.len(), max_nesting)?;
                    state = State::ItemOrClose;
                } else {
                    let value = match ident.as_str() {
                        "true" => DocValue::Bool { value: true },
                        "false" => DocValue::Bool { value: false },
                        _ => DocValue::Ident { value: ident },
                    };
                    attach(&mut frames, value);
                    state = State::AfterItem;
                }
            }
            _ => {
                return malformed(format!(
                    "expected a value, found {}",
                    cursor.describe_next()
                ));
            }
        }
    }
}

fn check_nesting(depth: usize, max_nesting: usize) -> ParseResult<()> {
    if depth > max_nesting {
        return Err((
            DocErrorKind::Nesting { observed: depth },
            format!("nesting {depth} exceeds the limit {max_nesting}"),
        ));
    }
    Ok(())
}

/// Adds a finished value to the innermost open frame.
fn attach(frames: &mut [Frame], value: DocValue) {
    match frames.last_mut().expect("a frame is open") {
        Frame::Arguments {
            args: list, key, ..
        }
        | Frame::Record {
            fields: list, key, ..
        } => {
            let key = key
                .take()
                .expect("a keyed frame reads its key before the value");
            list.push(DocArgument { key, value });
        }
        Frame::Call { args, .. } => args.push(value),
        Frame::List { items } => items.push(value),
    }
}

fn parse_key(cursor: &mut Cursor<'_>) -> ParseResult<String> {
    match cursor.peek() {
        Some('"') => parse_text(cursor),
        Some(c) if is_ident_start(c) => Ok(cursor.take_while(is_ident_char).to_string()),
        _ => malformed(format!("expected a key, found {}", cursor.describe_next())),
    }
}

fn parse_text(cursor: &mut Cursor<'_>) -> ParseResult<String> {
    cursor.bump(); // the opening quote
    let mut out = String::new();
    loop {
        match cursor.bump() {
            None | Some('\n') => return malformed("a text value is not closed on its line"),
            Some('"') => return Ok(out),
            Some('\\') => match cursor.bump() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('u') => out.push(parse_unicode_escape(cursor)?),
                Some(other) => return malformed(format!("unknown escape `\\{other}`")),
                None => return malformed("a text value is not closed on its line"),
            },
            Some(c) => out.push(c),
        }
    }
}

fn parse_unicode_escape(cursor: &mut Cursor<'_>) -> ParseResult<char> {
    if cursor.bump() != Some('{') {
        return malformed("expected `{` after `\\u`");
    }
    let digits = cursor.take_while(|c| c.is_ascii_hexdigit());
    if digits.is_empty() || digits.len() > 6 || cursor.bump() != Some('}') {
        return malformed("a `\\u{…}` escape takes 1 to 6 hex digits");
    }
    let code = u32::from_str_radix(digits, 16).expect("at most 6 hex digits fit in u32");
    char::from_u32(code).ok_or_else(|| {
        (
            DocErrorKind::Malformed,
            format!("`\\u{{{digits}}}` is not a Unicode scalar value"),
        )
    })
}

fn parse_number(cursor: &mut Cursor<'_>) -> ParseResult<String> {
    let start = cursor.pos;
    if cursor.peek() == Some('-') {
        cursor.bump();
    }
    let whole = cursor.take_while(|c| c.is_ascii_digit());
    if whole.is_empty() {
        return malformed("expected digits after `-`");
    }
    if whole.len() > 1 && whole.starts_with('0') {
        return malformed(format!("`{whole}` has a leading zero"));
    }
    if cursor.peek() == Some('.') {
        cursor.bump();
        if cursor.take_while(|c| c.is_ascii_digit()).is_empty() {
            return malformed("expected digits after `.`");
        }
    }
    if cursor.peek().is_some_and(|c| is_ident_char(c) || c == '.') {
        return malformed(format!(
            "`{}` is not a number",
            &cursor.text[start..cursor.pos + cursor.peek().map_or(0, char::len_utf8)]
        ));
    }
    Ok(cursor.text[start..cursor.pos].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> Result<(Vec<String>, Vec<DocAttribute>), Vec<Diagnostic>> {
        parse_with(lines, 256, 100)
    }

    fn parse_with(
        lines: &[&str],
        max_nesting: usize,
        max_diagnostics: usize,
    ) -> Result<(Vec<String>, Vec<DocAttribute>), Vec<Diagnostic>> {
        let docs: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        let mut errors = ErrorCollector::new(max_diagnostics);
        let place = Place {
            path: "actor.methods[0]",
            source: "memory:/t.did",
        };
        let parsed =
            parse_docs(&docs, max_nesting, &place, &mut errors).map_err(|e| e.diagnostics)?;
        errors.into_result().map_err(|e| e.diagnostics)?;
        Ok(parsed)
    }

    fn text(value: &str) -> DocValue {
        DocValue::Text {
            value: value.to_string(),
        }
    }

    fn number(value: &str) -> DocValue {
        DocValue::Number {
            value: value.to_string(),
        }
    }

    fn arg(key: &str, value: DocValue) -> DocArgument {
        DocArgument {
            key: key.to_string(),
            value,
        }
    }

    fn only_error(lines: &[&str]) -> Diagnostic {
        let errors = parse(lines).expect_err("must fail");
        assert_eq!(errors.len(), 1, "{errors:?}");
        errors.into_iter().next().unwrap()
    }

    #[test]
    fn lines_are_normalized_like_the_lexer_leaves_them() {
        assert_eq!(normalize("/ @a"), "@a");
        assert_eq!(normalize("@a"), "@a");
        assert_eq!(normalize("/@a  "), "@a");
        assert_eq!(normalize("//x"), "/x");
        assert_eq!(normalize("/"), "");
    }

    #[test]
    fn only_the_exact_head_makes_an_attribute_line() {
        for line in [
            "@deprecated",
            "@amount(decimals = 8)",
            "@ui.hidden()",
            "@a_1.b2(x = 1)",
        ] {
            assert!(attribute_head(line).is_some(), "{line}");
        }
        for line in [
            "@param amount the value",
            "@amount (decimals = 8)",
            "see @amount(decimals = 8)",
            "@Amount(decimals = 8)",
            "@",
            "@1x",
            "@a.",
            "@a.B()",
            "@a-b()",
            "email@example.com",
        ] {
            assert!(attribute_head(line).is_none(), "{line}");
        }
        assert_eq!(
            attribute_head("@ui.hidden(x)"),
            Some(("ui.hidden", Some(11)))
        );
        assert_eq!(&"@ui.hidden(x)"[11..], "x)");
        assert_eq!(attribute_head("@deprecated"), Some(("deprecated", None)));
    }

    #[test]
    fn the_spec_example_parses() {
        let (prose, attributes) = parse(&[
            "/ Send tokens to another principal.",
            "/ @intent(title = \"Send\", template = \"Send {amount} to {to}[ with memo {memo}]\")",
            "/ @effect(kind = \"transfer\", irreversible = true)",
            "/ @amount(at = \"amount\", decimals = query(decimals), symbol = \"TOK\")",
            "/ @deprecated",
        ])
        .unwrap();
        assert_eq!(prose, ["Send tokens to another principal."]);
        assert_eq!(
            attributes,
            [
                DocAttribute {
                    name: "intent".into(),
                    doc_line: 1,
                    args: vec![
                        arg("title", text("Send")),
                        arg("template", text("Send {amount} to {to}[ with memo {memo}]")),
                    ],
                },
                DocAttribute {
                    name: "effect".into(),
                    doc_line: 2,
                    args: vec![
                        arg("kind", text("transfer")),
                        arg("irreversible", DocValue::Bool { value: true }),
                    ],
                },
                DocAttribute {
                    name: "amount".into(),
                    doc_line: 3,
                    args: vec![
                        arg("at", text("amount")),
                        arg(
                            "decimals",
                            DocValue::Call {
                                name: "query".into(),
                                args: vec![DocValue::Ident {
                                    value: "decimals".into()
                                }],
                            }
                        ),
                        arg("symbol", text("TOK")),
                    ],
                },
                DocAttribute {
                    name: "deprecated".into(),
                    doc_line: 4,
                    args: vec![],
                },
            ]
        );
    }

    #[test]
    fn every_value_kind_and_nesting() {
        let (_, attributes) = parse(&[
            "@x(a = -1, b = 0.25, c = 0, d = [1, \"two\", now()], e = { Ok = \"success\", \"Err.TooOld\" = \"fail\", }, f = false, g = _x9,)",
        ])
        .unwrap();
        assert_eq!(
            attributes[0].args,
            vec![
                arg("a", number("-1")),
                arg("b", number("0.25")),
                arg("c", number("0")),
                arg(
                    "d",
                    DocValue::List {
                        items: vec![
                            number("1"),
                            text("two"),
                            DocValue::Call {
                                name: "now".into(),
                                args: vec![]
                            },
                        ]
                    }
                ),
                arg(
                    "e",
                    DocValue::Record {
                        fields: vec![arg("Ok", text("success")), arg("Err.TooOld", text("fail"))]
                    }
                ),
                arg("f", DocValue::Bool { value: false }),
                arg(
                    "g",
                    DocValue::Ident {
                        value: "_x9".into()
                    }
                ),
            ]
        );
    }

    #[test]
    fn escapes_decode_and_brackets_inside_text_do_not_count() {
        let (_, attributes) =
            parse(&[r#"@t(a = "q\"b\\s\n\r\t\u{1F600}\u{41}", b = "(]{")"#]).unwrap();
        assert_eq!(
            attributes[0].args,
            vec![
                arg("a", text("q\"b\\s\n\r\t\u{1F600}A")),
                arg("b", text("(]{"))
            ]
        );
    }

    #[test]
    fn an_attribute_continues_while_a_bracket_is_open() {
        let (prose, attributes) = parse(&[
            "/ @intent(",
            "/   title = \"Send\",",
            "/   template = \"Send {amount}\"",
            "/ )",
            "/ after",
        ])
        .unwrap();
        assert_eq!(prose, ["after"]);
        assert_eq!(attributes.len(), 1);
        assert_eq!(attributes[0].doc_line, 0);
        assert_eq!(attributes[0].args.len(), 2);
    }

    #[test]
    fn empty_and_flag_forms() {
        let (prose, attributes) = parse(&["@a()", "@b( )", "@c", "", "plain"]).unwrap();
        assert_eq!(prose, ["", "plain"]);
        assert!(attributes.iter().all(|a| a.args.is_empty()));
        assert_eq!(attributes.len(), 3);
    }

    #[test]
    fn malformed_lines_are_errors_not_prose() {
        let cases = [
            ("@a(x)", "expected `=` after `x`"),
            ("@a(x = )", "expected a value"),
            ("@a(x = 1 y = 2)", "expected `,` or `)`"),
            ("@a(x = 1))", "unexpected `)` after the closing"),
            ("@a(x = 1) trailing", "unexpected `t` after the closing"),
            ("@a(x = \"open)", "not closed on its line"),
            ("@a(x = \"\\q\")", "unknown escape"),
            ("@a(x = \"\\u{110000}\")", "not a Unicode scalar value"),
            ("@a(x = \"\\u{}\")", "1 to 6 hex digits"),
            ("@a(x = \"\\u{1234567}\")", "1 to 6 hex digits"),
            ("@a(x = 08)", "leading zero"),
            ("@a(x = 1.)", "expected digits after `.`"),
            ("@a(x = .5)", "expected a value"),
            ("@a(x = 1e5)", "is not a number"),
            ("@a(x = +1)", "expected a value"),
            ("@a(x = -)", "expected digits after `-`"),
            ("@a(x = [1,,2])", "expected a value"),
            ("@a(,)", "expected a key"),
            ("@a(x = [1)", "expected `,` or `]`"),
            ("@a(x = {1 = 2})", "expected a key"),
            ("@a(x = {y})", "expected `=` after `y`"),
            (
                "@a(x = 1",
                "expected `,` or `)`, found the end of the attribute",
            ),
            (
                "@a(x = [1, 2",
                "expected `,` or `]`, found the end of the attribute",
            ),
        ];
        for (line, expected) in cases {
            let error = only_error(&[line]);
            assert_eq!(error.code, "doc_attribute_malformed", "{line}");
            assert!(
                error.message.contains(expected),
                "{line}: {}",
                error.message
            );
            assert!(
                error
                    .message
                    .starts_with("doc line 1 of actor.methods[0]: @a: "),
                "{}",
                error.message
            );
            assert_eq!(error.path.as_deref(), Some("actor.methods[0]"));
            assert_eq!(error.phase, Some(DiagnosticPhase::Parse));
            assert_eq!(error.span, Some(SourceSpan::source_only("memory:/t.did")));
        }
    }

    #[test]
    fn repeated_keys_are_refused_at_every_level() {
        for line in [
            "@a(x = 1, x = 2)",
            "@a(x = 1, \"x\" = 2)",
            "@a(y = {k = 1, k = 2})",
        ] {
            assert_eq!(
                only_error(&[line]).code,
                "doc_attribute_duplicate_key",
                "{line}"
            );
        }
        // the same key in sibling records is fine, and so is a repeated name
        let (_, attributes) = parse(&["@a(y = [{k = 1}, {k = 2}])", "@a(y = 1)"]).unwrap();
        assert_eq!(attributes.len(), 2);
    }

    #[test]
    fn every_bad_attribute_is_reported_and_the_cap_holds() {
        let errors = parse(&["@a(x)", "fine", "@b(y = )", "@c(z = 1)"]).unwrap_err();
        assert_eq!(errors.len(), 2);
        assert!(errors[0].message.starts_with("doc line 1 "));
        assert!(errors[1].message.starts_with("doc line 3 "));

        let errors = parse_with(&["@a(x)", "@b(x)", "@c(x)"], 256, 2).unwrap_err();
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[1].code, "resource_limit_exceeded");
        let info = errors[1].resource_limit.as_ref().unwrap();
        assert_eq!(
            (info.resource.as_str(), info.limit, info.observed),
            ("diagnostics", 2, 3)
        );

        let errors = parse_with(&["@a(x)"], 256, 0).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "resource_limit_exceeded");
    }

    #[test]
    fn nesting_is_bounded_exactly_without_recursion() {
        // the attribute's own `(` is level 1
        assert!(parse_with(&["@a(x = [[1]])"], 3, 100).is_ok());
        let errors = parse_with(&["@a(x = [[[1]]])"], 3, 100).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "resource_limit_exceeded");
        let info = errors[0].resource_limit.as_ref().unwrap();
        assert_eq!(
            (info.resource.as_str(), info.limit, info.observed),
            ("source_nesting", 3, 4)
        );
        assert!(parse_with(&["@a()"], 0, 100).is_err());

        // far past any call stack, refused by count rather than by a crash
        let deep = format!("@a(x = {}1{})", "[".repeat(200_000), "]".repeat(200_000));
        let errors = parse_with(&[&deep], 256, 100).unwrap_err();
        assert_eq!(errors[0].code, "resource_limit_exceeded");
        let deep_calls = format!("@a(x = {}{})", "f(".repeat(100_000), ")".repeat(100_000));
        assert_eq!(
            parse_with(&[&deep_calls], 256, 100).unwrap_err()[0].code,
            "resource_limit_exceeded"
        );
    }
}
