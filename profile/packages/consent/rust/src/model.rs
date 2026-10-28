//! The neutral model of one message (a title, an optional sentence and the fields), the port of `src/model.mjs`,
//! `src/template.mjs` and `src/paths.mjs`.
//!
//! Which fields appear:
//!   - a call with an intent template, its case's (spec section 5.2, D-053) or else its method's: its placeholders
//!     that are present, in template order, once per path;
//!   - a call without one: one field per leaf of the decoded arguments (records flattened, tagged positions are
//!     leaves, absent optionals left out). More than [`MAX_FIELDS`] fields or [`MAX_ELEMENTS`] list elements is
//!     refused (`E_TOO_LARGE`), never truncated.

use std::collections::HashMap;

use serde_json::Value;

use crate::decode::Tree;
use crate::error::{codes, Error, Result};
use crate::format::VALUE_TAGS;
use crate::resolved::{args_of, candid_of, entries_of, idl_hash, is_optional, is_true, json_string, key_id, label_of, path, prop};
use crate::text::js_trim;

pub const MAX_FIELDS: usize = 64;
pub const MAX_ELEMENTS: usize = 256;

/// A note about the message that does not stop it (a template that fell back, a value shown raw).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub at: String,
    pub message: String,
}

pub(crate) struct Field<'a> {
    /// The placeholder path, or the dotted path of a flattened leaf.
    pub path: String,
    /// `describe.label` of the position, else its field name (raw, not yet escaped).
    pub label: String,
    pub node: &'a Value,
    /// The present values: none (absent), one, or one per list element.
    pub values: Vec<&'a Tree>,
}

pub(crate) enum SentencePart {
    Lit(String),
    /// An index into `Model::fields`.
    Field(usize),
}

pub(crate) struct Model<'a> {
    pub method: &'a str,
    pub title: String,
    /// `None` for a call without an intent template.
    pub sentence: Option<Vec<SentencePart>>,
    pub fields: Vec<Field<'a>>,
    pub arg_nodes: &'a [Value],
    pub arg_values: &'a [Tree],
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn build_model<'a>(method: &'a Value, name: &'a str, values: &'a [Tree]) -> Result<Model<'a>> {
    let args = args_of(method);
    // the call's intent: its case's, else its method's (D-053)
    let intent = prop(call_tag(method, values, "intent"), "args");
    let title = match prop(intent, "title") {
        Some(Value::String(t)) if !js_trim(t).is_empty() => t.clone(),
        _ => label_of(method).map_or_else(|| format!("Call {name}"), str::to_string),
    };
    let mut model =
        Model { method: name, title, sentence: None, fields: Vec::new(), arg_nodes: args, arg_values: values, diagnostics: Vec::new() };
    if let Some(Value::String(template)) = prop(intent, "template") {
        match parse_template(template).and_then(|parts| apply_template(args, values, parts)) {
            Ok((sentence, fields)) => {
                model.sentence = Some(sentence);
                model.fields = fields;
                return Ok(model);
            }
            // A template the profile got wrong must not leave the reader without a message: fall back to the
            // generic intent, which lists every argument, and say so.
            Err(e) if e.code == codes::TEMPLATE || e.code == codes::TEMPLATE_PATH => model.diagnostics.push(Diagnostic {
                code: "W_TEMPLATE_FALLBACK",
                at: name.to_string(),
                message: format!("{e}; the generic intent is used instead"),
            }),
            Err(e) => return Err(e),
        }
    }
    model.fields = flatten(args, values)?;
    Ok(model)
}

/// The `intent` or `effect` entry (`{ args, origin, profile }`) a call takes: that of the deepest tagged variant case
/// its decoded arguments hold (spec section 5.2, D-053), else the method's. The port of `callTag` in
/// `src/resolved.mjs`: the cases one call holds are a chain in any resolved form a resolver writes, and a form with
/// tagged cases that one call holds side by side gets the method's entry.
pub(crate) fn call_tag<'a>(method: &'a Value, values: &[Tree], tag: &str) -> Option<&'a Value> {
    struct Walk<'a, 't> {
        tag: &'t str,
        /// The hit with the most hits above and at it, and that count.
        best: Option<(&'a Value, usize)>,
        hits: usize,
    }
    fn visit<'a>(w: &mut Walk<'a, '_>, node: &'a Value, value: &Tree, chain: usize) {
        if !node.is_object() || is_true(prop(Some(node), "recursive")) {
            return;
        }
        match (candid_of(node), value) {
            ("record", Tree::Record(_)) => {
                for (key, child) in entries_of(prop(Some(node), "fields")) {
                    if let Some(v) = value.get(key) {
                        visit(w, child, v, chain);
                    }
                }
            }
            ("variant", Tree::Variant(key, inner)) => {
                let Some((_, child)) = entries_of(prop(Some(node), "cases")).into_iter().find(|(k, _)| k == key) else {
                    return;
                };
                let mut chain = chain;
                if let Some(entry @ Value::Object(_)) = prop(prop(Some(child), "tags"), w.tag) {
                    chain += 1;
                    w.hits += 1;
                    if w.best.is_none_or(|(_, c)| chain > c) {
                        w.best = Some((entry, chain));
                    }
                }
                visit(w, child, inner, chain);
            }
            _ => {}
        }
    }
    let mut w = Walk { tag, best: None, hits: 0 };
    for (node, value) in args_of(method).iter().zip(values) {
        visit(&mut w, node, value, 0);
    }
    match w.best {
        Some((entry, chain)) if chain == w.hits => Some(entry),
        _ => prop(prop(Some(method), "tags"), tag),
    }
}

// ------------------------------------------------------------------------------------------------ template

pub(crate) enum Part {
    Lit(String),
    Ph(String),
}

pub(crate) enum TemplatePart {
    One(Part),
    Opt(Vec<Part>),
}

fn template_error(message: &str) -> Error {
    Error::new(codes::TEMPLATE, message)
}

/// `Send {amount} to {to}[ with memo {memo}]`: placeholders, optional segments (no nesting in v0), escapes `{{ }} [[ ]]`.
/// The same scan as `parseTemplate` in `src/template.mjs`; the special characters are ASCII, so scanning bytes
/// splits the text where the UTF-16 scan does.
pub(crate) fn parse_template(template: &str) -> Result<Vec<TemplatePart>> {
    let t = template.as_bytes();
    let mut top: Vec<TemplatePart> = Vec::new();
    let mut segment: Option<Vec<Part>> = None;
    let mut lit: Vec<u8> = Vec::new();
    fn flush(lit: &mut Vec<u8>, top: &mut Vec<TemplatePart>, segment: &mut Option<Vec<Part>>) {
        if !lit.is_empty() {
            let text = String::from_utf8(std::mem::take(lit)).unwrap_or_default();
            match segment {
                Some(s) => s.push(Part::Lit(text)),
                None => top.push(TemplatePart::One(Part::Lit(text))),
            }
        }
    }
    let mut i = 0;
    while i < t.len() {
        let ch = t[i];
        if matches!(ch, b'{' | b'}' | b'[' | b']') && t.get(i + 1) == Some(&ch) {
            lit.push(ch);
            i += 2;
            continue;
        }
        match ch {
            b'[' => {
                if segment.is_some() {
                    return Err(template_error("nested [ ] segments are not allowed in v0"));
                }
                flush(&mut lit, &mut top, &mut segment);
                segment = Some(Vec::new());
            }
            b']' => {
                if segment.is_none() {
                    return Err(template_error("unbalanced ]"));
                }
                flush(&mut lit, &mut top, &mut segment);
                top.push(TemplatePart::Opt(segment.take().unwrap_or_default()));
            }
            b'{' => {
                let end = t[i..].iter().position(|&b| b == b'}').map(|p| p + i).ok_or_else(|| template_error("unclosed {"))?;
                flush(&mut lit, &mut top, &mut segment);
                let path = template[i + 1..end].to_string();
                match &mut segment {
                    Some(s) => s.push(Part::Ph(path)),
                    None => top.push(TemplatePart::One(Part::Ph(path))),
                }
                i = end;
            }
            b'}' => return Err(template_error("unbalanced }")),
            _ => lit.push(ch),
        }
        i += 1;
    }
    if segment.is_some() {
        return Err(template_error("unclosed ["));
    }
    flush(&mut lit, &mut top, &mut segment);
    Ok(top)
}

// ------------------------------------------------------------------------------------------------ paths

enum Seg {
    Field { label: String, id: u64 },
    Elem,
}

enum Step {
    Field(String),
    Case(String),
    Elem,
}

struct ResolvedPath<'a> {
    index: usize,
    steps: Vec<Step>,
    node: &'a Value,
    nodes: Vec<&'a Value>,
}

/// `.amount`, `.#5`, `[]`, in sequence (`parsePath` of the resolver). `None` when the text is not a path.
fn parse_path(s: &str) -> Option<Vec<Seg>> {
    let b = s.as_bytes();
    let mut segs = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i..].starts_with(b"[]") {
            segs.push(Seg::Elem);
            i += 2;
            continue;
        }
        if b[i] != b'.' {
            return None;
        }
        let start = i + 1;
        let mut j = start;
        if b.get(j).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
            while b.get(j).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_') {
                j += 1;
            }
            let label = &s[start..j];
            segs.push(Seg::Field { label: label.to_string(), id: idl_hash(label) as u64 });
        } else if b.get(j) == Some(&b'#') {
            j += 1;
            match b.get(j) {
                Some(b'0') => j += 1,
                Some(c) if c.is_ascii_digit() => {
                    j += 1;
                    while j - start < 11 && b.get(j).is_some_and(u8::is_ascii_digit) {
                        j += 1;
                    }
                }
                _ => return None,
            }
            let label = &s[start..j];
            let id: u64 = label[1..].parse().ok()?;
            if id > u32::MAX as u64 {
                return None;
            }
            segs.push(Seg::Field { label: label.to_string(), id });
        } else {
            return None;
        }
        i = j;
    }
    Some(segs)
}

/// The placeholder's argument index (`(1)`) and its segments. A path with a line break is an exception in the
/// JavaScript version (its pattern does not match), so it is `E_INTERNAL` here too.
fn parse_rel_path(rel: &str) -> Result<Option<(Option<usize>, Vec<Seg>)>> {
    if rel.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return Err(Error::new(codes::INTERNAL, format!("cannot read the placeholder path {}", json_string(rel))));
    }
    let mut index = None;
    let mut rest = rel;
    if let Some(after) = rel.strip_prefix('(') {
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after.as_bytes().get(digits) == Some(&b')') {
            index = Some(after[..digits].parse::<usize>().unwrap_or(usize::MAX));
            rest = &after[digits + 1..];
        }
    }
    let rest = if !rest.is_empty() && !rest.starts_with('.') && !rest.starts_with('[') { format!(".{rest}") } else { rest.to_string() };
    Ok(parse_path(&rest).map(|segs| (index, segs)))
}

/// A placeholder path against the method's arguments, or why it does not resolve (`Ok(Err(..))`).
fn resolve_path<'a>(args: &'a [Value], rel: &str) -> Result<std::result::Result<ResolvedPath<'a>, String>> {
    let (index, segs) = match parse_rel_path(rel)? {
        Some(p) => p,
        None => return Ok(Err(format!("bad relative path {}", json_string(rel)))),
    };
    let index = match index {
        Some(i) => i,
        None if args.len() != 1 => {
            return Ok(Err(format!("path {} must start with (i): the method has {} arguments", json_string(rel), args.len())))
        }
        None => 0,
    };
    if index >= args.len() {
        return Ok(Err(format!("argument index {index} is out of range")));
    }
    let mut node = &args[index];
    let mut nodes = vec![node];
    let mut steps = Vec::new();
    for seg in segs {
        if is_true(prop(Some(node), "recursive")) {
            return Ok(Err(format!("{} enters a position the resolved form cuts at a cycle", json_string(rel))));
        }
        match seg {
            Seg::Elem => match prop(Some(node), "element") {
                Some(e) if candid_of(node) == "vec" => {
                    steps.push(Step::Elem);
                    node = e;
                }
                _ => return Ok(Err(format!("\"[]\" applied to {}", candid_of(node)))),
            },
            Seg::Field { label, id } => {
                let field = entries_of(prop(Some(node), "fields")).into_iter().find(|(k, _)| key_id(k) == id);
                if let Some((key, child)) = field {
                    steps.push(Step::Field(key.to_string()));
                    node = child;
                } else if let Some((key, child)) = entries_of(prop(Some(node), "cases")).into_iter().find(|(k, _)| key_id(k) == id) {
                    steps.push(Step::Case(key.to_string()));
                    node = child;
                } else {
                    return Ok(Err(format!("no field or case {} in {}", json_string(&label), candid_of(node))));
                }
            }
        }
        nodes.push(node);
    }
    Ok(Ok(ResolvedPath { index, steps, node, nodes }))
}

/// The present values at a resolved path. An absent optional on the way, a variant with another case, or an empty
/// vector gives no values.
fn values_at<'a>(p: &ResolvedPath<'_>, values: &'a [Tree]) -> Vec<&'a Tree> {
    let mut current: Vec<&Tree> = vec![&values[p.index]];
    for (depth, step) in p.steps.iter().enumerate() {
        let parent_optional = is_optional(p.nodes[depth]);
        let mut next = Vec::new();
        for v in current {
            if parent_optional && *v == Tree::Null {
                continue;
            }
            match (step, v) {
                (Step::Elem, Tree::Vec(items)) => next.extend(items.iter()),
                (Step::Field(key), v) => next.extend(v.get(key)),
                (Step::Case(key), Tree::Variant(tag, value)) if tag == key => next.push(value.as_ref()),
                _ => {}
            }
        }
        current = next;
    }
    let leaf_optional = is_optional(p.node);
    current.into_iter().filter(|v| !(leaf_optional && **v == Tree::Null)).collect()
}

enum Lookup<'a> {
    Known(usize),
    Fresh(Field<'a>),
    Unresolved(String),
}

fn name_of(p: &ResolvedPath<'_>) -> String {
    for s in p.steps.iter().rev() {
        match s {
            Step::Field(k) | Step::Case(k) => return k.clone(),
            Step::Elem => {}
        }
    }
    format!("Argument {}", p.index + 1)
}

fn apply_template<'a>(args: &'a [Value], values: &'a [Tree], parts: Vec<TemplatePart>) -> Result<(Vec<SentencePart>, Vec<Field<'a>>)> {
    let mut known: HashMap<String, usize> = HashMap::new();
    let mut sentence = Vec::new();
    let mut fields: Vec<Field<'a>> = Vec::new();

    let lookup = |known: &HashMap<String, usize>, path: &str| -> Result<Lookup<'a>> {
        if let Some(&i) = known.get(path) {
            return Ok(Lookup::Known(i));
        }
        let rp = match resolve_path(args, path)? {
            Ok(rp) => rp,
            Err(e) => return Ok(Lookup::Unresolved(e)),
        };
        let found = values_at(&rp, values);
        if found.len() > MAX_ELEMENTS {
            return Err(Error::new(codes::TOO_LARGE, format!("{{{path}}} has {} values; the limit is {MAX_ELEMENTS}", found.len())));
        }
        let label = label_of(rp.node).map_or_else(|| name_of(&rp), str::to_string);
        Ok(Lookup::Fresh(Field { path: path.to_string(), label, node: rp.node, values: found }))
    };
    let register = |known: &mut HashMap<String, usize>, fields: &mut Vec<Field<'a>>, l: Lookup<'a>| -> Result<usize> {
        match l {
            Lookup::Known(i) => Ok(i),
            Lookup::Fresh(f) => {
                known.insert(f.path.clone(), fields.len());
                fields.push(f);
                if fields.len() > MAX_FIELDS {
                    return Err(Error::new(codes::TOO_LARGE, format!("the template has more than {MAX_FIELDS} distinct placeholders")));
                }
                Ok(fields.len() - 1)
            }
            Lookup::Unresolved(e) => Err(Error::new(codes::INTERNAL, e)),
        }
    };

    for part in parts {
        match part {
            TemplatePart::One(Part::Lit(text)) => sentence.push(SentencePart::Lit(text)),
            TemplatePart::One(Part::Ph(path)) => match lookup(&known, &path)? {
                Lookup::Unresolved(e) => return Err(Error::new(codes::TEMPLATE_PATH, format!("{{{path}}}: {e}"))),
                found => sentence.push(SentencePart::Field(register(&mut known, &mut fields, found)?)),
            },
            TemplatePart::Opt(inner) => {
                // [ ... ]: dropped when any placeholder inside is absent or names a position this method lacks.
                let mut looked = Vec::with_capacity(inner.len());
                for p in &inner {
                    looked.push(match p {
                        Part::Ph(path) => Some(lookup(&known, path)?),
                        Part::Lit(_) => None,
                    });
                }
                let drop = looked.iter().any(|l| match l {
                    Some(Lookup::Unresolved(_)) => true,
                    Some(Lookup::Known(i)) => fields[*i].values.is_empty(),
                    Some(Lookup::Fresh(f)) => f.values.is_empty(),
                    None => false,
                });
                if drop {
                    continue;
                }
                for (p, l) in inner.into_iter().zip(looked) {
                    match (p, l) {
                        (Part::Lit(text), _) => sentence.push(SentencePart::Lit(text)),
                        (Part::Ph(_), Some(l)) => sentence.push(SentencePart::Field(register(&mut known, &mut fields, l)?)),
                        (Part::Ph(_), None) => {}
                    }
                }
            }
        }
    }
    Ok((sentence, fields))
}

// ------------------------------------------------------------------------------------------------ generic intent

fn has_value_tag(node: &Value) -> bool {
    matches!(prop(Some(node), "tags"), Some(Value::Object(t)) if VALUE_TAGS.iter().any(|k| t.contains_key(*k)))
}

/// `ui.order` puts the fields that have one first, ascending; the rest keep id order.
fn presentation_order<'v>(mut entries: Vec<(&'v str, &'v Value)>) -> Vec<(&'v str, &'v Value)> {
    let order = |child: &Value| match path(child, &["tags", "ui", "args", "order"]) {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).unwrap_or(f64::INFINITY),
        _ => f64::INFINITY,
    };
    // `sort_by` is stable, as Array.prototype.sort is: equal orders keep id order.
    entries.sort_by(|a, b| order(a.1).partial_cmp(&order(b.1)).unwrap_or(std::cmp::Ordering::Equal));
    entries
}

fn flatten<'a>(args: &'a [Value], values: &'a [Tree]) -> Result<Vec<Field<'a>>> {
    let mut fields = Vec::new();
    let multi = args.len() > 1;
    for (index, (node, value)) in args.iter().zip(values).enumerate() {
        walk(node, value, &mut Vec::new(), index, multi, &mut fields)?;
    }
    Ok(fields)
}

fn walk<'a>(
    node: &'a Value,
    value: &'a Tree,
    keys: &mut Vec<&'a str>,
    index: usize,
    multi: bool,
    fields: &mut Vec<Field<'a>>,
) -> Result<()> {
    if is_optional(node) && *value == Tree::Null {
        return Ok(());
    }
    let children = if candid_of(node) == "record" && !is_true(prop(Some(node), "recursive")) && !has_value_tag(node) {
        presentation_order(entries_of(prop(Some(node), "fields")))
    } else {
        Vec::new()
    };
    if !children.is_empty() {
        for (key, child) in children {
            let v = value.get(key).ok_or_else(|| Error::new(codes::INTERNAL, format!("the value has no field {key}")))?;
            keys.push(key);
            walk(child, v, keys, index, multi, fields)?;
            keys.pop();
        }
        return Ok(());
    }
    let dotted = keys.join(".");
    let label = match label_of(node) {
        Some(l) => l.to_string(),
        None if multi => format!("Argument {}{}", index + 1, if dotted.is_empty() { String::new() } else { format!(" {dotted}") }),
        None if dotted.is_empty() => format!("Argument {}", index + 1),
        None => dotted.clone(),
    };
    if let (true, Tree::Vec(items)) = (candid_of(node) == "vec", value) {
        if items.len() > MAX_ELEMENTS {
            return Err(Error::new(codes::TOO_LARGE, format!("{label} has {} elements; the limit is {MAX_ELEMENTS}", items.len())));
        }
    }
    let path = format!("({index}){}", keys.iter().map(|k| format!(".{k}")).collect::<String>());
    fields.push(Field { path, label, node, values: vec![value] });
    if fields.len() > MAX_FIELDS {
        return Err(Error::new(codes::TOO_LARGE, format!("the arguments have more than {MAX_FIELDS} fields")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(parts: &[TemplatePart]) -> String {
        let one = |p: &Part| match p {
            Part::Lit(t) => format!("'{t}'"),
            Part::Ph(p) => format!("{{{p}}}"),
        };
        parts
            .iter()
            .map(|p| match p {
                TemplatePart::One(p) => one(p),
                TemplatePart::Opt(ps) => format!("[{}]", ps.iter().map(one).collect::<Vec<_>>().join("")),
            })
            .collect::<Vec<_>>()
            .join("")
    }

    #[test]
    fn templates() {
        assert_eq!(
            shape(&parse_template("Send {amount} to {to}[ with memo {memo}]").unwrap()),
            "'Send '{amount}' to '{to}[' with memo '{memo}]"
        );
        assert_eq!(shape(&parse_template("a {{b}} [[c]] é").unwrap()), "'a {b} [c] é'");
        assert_eq!(parse_template("[a[b]]").err().unwrap().code, codes::TEMPLATE);
        assert_eq!(parse_template("{a").err().unwrap().code, codes::TEMPLATE);
        assert_eq!(parse_template("a}").err().unwrap().code, codes::TEMPLATE);
        assert_eq!(parse_template("{a}}").err().unwrap().code, codes::TEMPLATE);
        assert_eq!(parse_template("[a").err().unwrap().code, codes::TEMPLATE);
    }

    #[test]
    fn paths() {
        let segs = |s: &str| parse_rel_path(s).unwrap().map(|(i, segs)| (i, segs.len()));
        assert_eq!(segs("amount"), Some((None, 1)));
        assert_eq!(segs("(1).to.owner"), Some((Some(1), 2)));
        assert_eq!(segs("(0)"), Some((Some(0), 0)));
        assert_eq!(segs("items[].#5"), Some((None, 3)));
        assert_eq!(segs("a.#05"), None);
        assert_eq!(segs("a.#4294967296"), None);
        assert_eq!(segs("a b"), None);
        assert_eq!(parse_rel_path("a\nb").err().unwrap().code, codes::INTERNAL);
    }
}
