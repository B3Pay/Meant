//! Doc attributes v1 end to end (`docs/doc-attributes.md`): compiled from real
//! `.did` text, read back from the SourceInfo the compiler records, and pinned
//! in the serialized shape `@candid-core/cli` hands out.
#![cfg(feature = "compiler")]

use candid_core::{
    compile_did, compile_did_with_context, CompileOptions, DocAttributes, DocItemKind, Limits,
    RuntimeContext,
};
use serde_json::json;

const SPEC_EXAMPLE: &str = r#"
type Tokens = record {
  /// @amount(decimals = 8, symbol = "ICP")
  e8s : nat64;
};
service : {
  decimals : () -> (nat8) query;
  /// Send tokens to another principal.
  /// @intent(title = "Send", template = "Send {amount} to {to}")
  /// @amount(at = "amount", decimals = query(decimals))
  send : (record { to : principal; amount : nat }) -> (variant { Ok : nat; Err : text });
  inline : (record {
    /// @describe(label = "Who")
    who : principal;
    n : nat;
  }) -> ();
}
"#;

fn attributes_of(source: &str) -> Result<DocAttributes, candid_core::CompileError> {
    let compilation = compile_did(source).expect("the source compiles");
    DocAttributes::from_source_info(
        compilation
            .source_info()
            .expect("source info is on by default"),
    )
}

#[test]
fn the_spec_example_serializes_to_the_documented_shape() {
    let attributes = attributes_of(SPEC_EXAMPLE).unwrap();
    assert_eq!(
        serde_json::to_value(&attributes).unwrap(),
        json!({
            "doc_attributes_version": 1,
            "items": [
                {
                    "kind": "method",
                    "origin": { "kind": "actor", "source": "memory:/inline.did" },
                    "path": "actor.methods[2]",
                    "name": "send",
                    "prose": ["Send tokens to another principal."],
                    "attributes": [
                        {
                            "name": "intent",
                            "doc_line": 1,
                            "args": [
                                { "key": "title", "value": { "kind": "text", "value": "Send" } },
                                { "key": "template", "value": { "kind": "text", "value": "Send {amount} to {to}" } }
                            ]
                        },
                        {
                            "name": "amount",
                            "doc_line": 2,
                            "args": [
                                { "key": "at", "value": { "kind": "text", "value": "amount" } },
                                { "key": "decimals", "value": {
                                    "kind": "call", "name": "query",
                                    "args": [{ "kind": "ident", "value": "decimals" }]
                                } }
                            ]
                        }
                    ]
                },
                {
                    "kind": "field",
                    "origin": { "kind": "declaration", "source": "memory:/inline.did", "name": "Tokens" },
                    "path": "type:Tokens.fields[0]",
                    "name": "e8s",
                    "prose": [],
                    "attributes": [
                        { "name": "amount", "doc_line": 0, "args": [
                            { "key": "decimals", "value": { "kind": "number", "value": "8" } },
                            { "key": "symbol", "value": { "kind": "text", "value": "ICP" } }
                        ] }
                    ]
                },
                {
                    "kind": "field",
                    "origin": { "kind": "actor", "source": "memory:/inline.did" },
                    "path": "actor.methods[1].function.args[0].type.fields[1]",
                    "name": "who",
                    "prose": [],
                    "attributes": [
                        { "name": "describe", "doc_line": 0, "args": [
                            { "key": "label", "value": { "kind": "text", "value": "Who" } }
                        ] }
                    ]
                }
            ]
        })
    );
}

/// The item paths are the SourceInfo's own, so a reader finds the Contract
/// coordinates of a field on the `field_labels` entry with the same path.
#[test]
fn item_paths_are_the_source_info_paths() {
    let compilation = compile_did(SPEC_EXAMPLE).unwrap();
    let source_info = compilation.source_info().unwrap();
    let attributes = DocAttributes::from_source_info(source_info).unwrap();
    for item in attributes.items() {
        match item.kind {
            DocItemKind::Field => assert!(source_info
                .field_labels()
                .iter()
                .any(|field| field.path == item.path && field.origin == item.origin)),
            DocItemKind::Method => {
                assert!(source_info
                    .methods()
                    .iter()
                    .any(|method| method.path == item.path
                        && Some(&method.name) == item.name.as_ref()))
            }
            DocItemKind::Actor | DocItemKind::Declaration => {}
        }
    }
}

#[test]
fn actor_and_declaration_docs_are_items_too() {
    let attributes = attributes_of(
        "// @ui.group(name = \"Ledger\")\ntype T = nat;\n/// The service.\n/// @deprecated\nservice : { get : () -> (T) query }",
    )
    .unwrap();
    let items: Vec<_> = attributes
        .items()
        .iter()
        .map(|item| {
            (
                item.kind,
                item.path.as_str(),
                item.prose.clone(),
                item.attributes
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    assert_eq!(
        items,
        [
            (
                DocItemKind::Actor,
                "actor",
                vec!["The service.".to_string()],
                vec!["deprecated"]
            ),
            (DocItemKind::Declaration, "type:T", vec![], vec!["ui.group"]),
        ]
    );
}

/// Comments are provenance: adding attributes moves `source_bundle_id` and
/// never the Contract or interface identities.
#[test]
fn attributes_never_move_contract_or_interface_identity() {
    let bare = SPEC_EXAMPLE
        .lines()
        .filter(|line| !line.trim_start().starts_with("///"))
        .collect::<Vec<_>>()
        .join("\n");
    let with = compile_did(SPEC_EXAMPLE).unwrap();
    let without = compile_did(&bare).unwrap();
    assert_eq!(
        with.contract().identities(),
        without.contract().identities()
    );
    assert_ne!(
        with.source_info().unwrap().source_bundle_id(),
        without.source_info().unwrap().source_bundle_id()
    );
    assert!(attributes_of(&bare).unwrap().items().is_empty());
}

/// What the upstream lexer does not keep as docs is not read: a comment after
/// code on its line, a block comment, one separated by a blank line.
#[test]
fn only_doc_lines_carry_attributes() {
    let attributes = attributes_of(
        "type T = record { /// @a(x = 1)\n  f : nat;\n  /* @b(x = 1) */\n  g : nat;\n  /// @c(x = 1)\n\n  h : nat;\n};\nservice : { m : (T) -> () }",
    )
    .unwrap();
    assert!(attributes.items().is_empty(), "{:?}", attributes.items());
}

/// A comment above a quoted name is dropped by the pinned lexer (a quoted
/// name is a text token, and only other tokens take the buffered comments),
/// so it documents nothing. Pinned so a parser upgrade that changes it shows.
#[test]
fn a_comment_above_a_quoted_name_documents_nothing() {
    let attributes = attributes_of(
        "type T = record {\n  /// @a(x = 1)\n  \"quoted-field\" : nat;\n};\nservice : {\n  /// @b(x = 1)\n  \"quoted-method\" : (T) -> ();\n  /// @c(x = 1)\n  plain : () -> ();\n}",
    )
    .unwrap();
    let paths: Vec<_> = attributes
        .items()
        .iter()
        .map(|item| {
            (
                item.path.as_str(),
                item.name.as_deref(),
                item.attributes
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    // nor does the dropped comment reach the next item
    assert_eq!(paths, [("actor.methods[0]", Some("plain"), vec!["c"])]);
}

#[test]
fn a_malformed_attribute_fails_closed_with_its_place() {
    let error = attributes_of(
        "service : {\n  /// fine prose\n  /// @amount(decimals = )\n  send : (nat) -> ();\n}",
    )
    .unwrap_err();
    assert_eq!(error.diagnostics.len(), 1);
    let diagnostic = &error.diagnostics[0];
    assert_eq!(diagnostic.code, "doc_attribute_malformed");
    assert_eq!(diagnostic.path.as_deref(), Some("actor.methods[0]"));
    assert_eq!(
        diagnostic.message,
        "doc line 2 of actor.methods[0]: @amount: expected a value, found `)`"
    );
    assert_eq!(
        serde_json::to_value(diagnostic).unwrap(),
        json!({
            "code": "doc_attribute_malformed",
            "phase": "parse",
            "severity": "error",
            "path": "actor.methods[0]",
            "message": "doc line 2 of actor.methods[0]: @amount: expected a value, found `)`",
            "span": { "source_name": "memory:/inline.did" }
        })
    );
}

/// Every malformed attribute across the interface is reported, in item order.
#[test]
fn every_malformed_attribute_is_reported() {
    let error = attributes_of(
        "type T = record {\n  /// @x(a = 1, a = 2)\n  f : nat;\n};\nservice : {\n  /// @y(\n  m : (T) -> ();\n}",
    )
    .unwrap_err();
    let found: Vec<_> = error
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.path.as_deref().unwrap()))
        .collect();
    assert_eq!(
        found,
        [
            ("doc_attribute_malformed", "actor.methods[0]"),
            ("doc_attribute_duplicate_key", "type:T.fields[0]"),
        ]
    );
}

#[test]
fn the_callers_limits_bound_nesting_and_errors() {
    let source = "service : {\n  /// @a(x = [[1]])\n  m : () -> ();\n}";
    let tight = RuntimeContext::new(Limits::default().with_max_source_nesting(2));
    // the .did itself nests less than that, so only the attribute is refused
    let compilation = compile_did_with_context(source, CompileOptions::default(), &tight).unwrap();
    let error =
        DocAttributes::from_source_info_with_context(compilation.source_info().unwrap(), &tight)
            .unwrap_err();
    assert_eq!(error.diagnostics[0].code, "resource_limit_exceeded");
    let info = error.diagnostics[0].resource_limit.as_ref().unwrap();
    assert_eq!(
        (info.resource.as_str(), info.limit, info.observed),
        ("source_nesting", 2, 3)
    );
    let roomy = RuntimeContext::new(Limits::default().with_max_source_nesting(3));
    assert!(DocAttributes::from_source_info_with_context(
        compilation.source_info().unwrap(),
        &roomy
    )
    .is_ok());

    let cancelled = RuntimeContext::default();
    cancelled.cancellation_token().cancel();
    let error = DocAttributes::from_source_info_with_context(
        compilation.source_info().unwrap(),
        &cancelled,
    )
    .unwrap_err();
    assert_eq!(error.diagnostics[0].code, "operation_cancelled");
}
