//! Issue #230: a record field whose id is `u32::MAX` is refused before the
//! upstream grammar sees it.
//!
//! The pinned `candid_parser` 0.4.0 record rule computes the next positional
//! id as `id + 1` at every record field. At `u32::MAX` that addition panics in
//! a debug build and wraps to 0 in a release build, where the next unnamed
//! field silently gets id 0. candid-core refuses every record field whose id
//! is `u32::MAX` — written as a number, as a name whose Candid hash is
//! `u32::MAX`, or reached by an unnamed field — with `did_parse_error` and the
//! field's exact span, in every build and on every entry point. Variants and
//! service methods compute no next id and compile exactly as before. The
//! owner's decision, its rejected alternatives and the triage are recorded on
//! the issue.

use meant::{
    compile_did, compile_did_with_context, compile_did_with_options, compile_with_resolver,
    CompileError, CompileOptions, DiagnosticPhase, MemoryResolver, RawSourceInfo, RuntimeContext,
    SourceInfo, SourceSpan,
};
use sha2::{Digest, Sha256};

const INLINE: &str = "memory:/inline.did";

/// `idl_hash("hlrnuwa") == u32::MAX`: an ordinary-looking field name reaches
/// the overflow as surely as the number does.
const MAX_NAME: &str = "hlrnuwa";

/// Every shape the preflight refuses, with the byte range of the field it
/// names: the first field, in source order, whose id is `u32::MAX`.
const REFUSED: &[(&str, usize, usize)] = &[
    ("type T = record { 4294967295 : nat };", 18, 28),
    ("type T = record { 0xFFFF_FFFF : nat };", 18, 29),
    ("type T = record { 0xffffffff : nat };", 18, 28),
    ("type T = record { hlrnuwa : nat };", 18, 25),
    // A string-literal name: the span covers the literal, quotes included.
    ("type T = record { \"hlrnuwa\" : nat };", 18, 27),
    // An unnamed field after `u32::MAX - 1` lands on `u32::MAX`.
    ("type T = record { 4294967294 : nat; text };", 36, 40),
    // The case release builds got wrong: `text` wrapped to id 0.
    ("type T = record { 4294967295 : nat; text };", 18, 28),
    ("type T = record { hlrnuwa : nat; nat };", 18, 25),
    // Not only the last field: the addition happens at every field.
    ("type T = record { 4294967295 : nat; a : text };", 18, 28),
    // A documented field: doc comments are trivia, not tokens.
    (
        "type T = record {\n  // doc\n  4294967295 : nat\n};",
        29,
        39,
    ),
    // Nested, inline in a method argument, and in a func type.
    (
        "type T = record { a : record { 4294967295 : nat }; b : nat };",
        31,
        41,
    ),
    (
        "service : { m : (record { 4294967295 : nat }) -> () };",
        26,
        36,
    ),
    ("type F = func (record { hlrnuwa : nat }) -> ();", 24, 31),
    // The first offending field is named when there are several.
    (
        "type T = record { a : record { hlrnuwa : nat }; b : record { 4294967295 : nat } };",
        31,
        38,
    ),
];

/// Shapes the preflight accepts, with the field ids the Contract records, in
/// the order its types list them.
const ACCEPTED: &[(&str, &[u32])] = &[
    ("type T = record { 4294967294 : nat };", &[4294967294]),
    (
        "type T = record { 4294967294 : nat; 5 : text };",
        &[5, 4294967294],
    ),
    ("type T = variant { 4294967295 : nat };", &[4294967295]),
    ("type T = variant { hlrnuwa };", &[4294967295]),
    // A variant field at `u32::MAX` does not number the record around it.
    (
        "type T = record { a : variant { 4294967295 }; nat; text };",
        &[97, 98, 99, 4294967295],
    ),
    ("type T = record { nat; nat; nat };", &[0, 1, 2]),
];

fn refusal_message(start: usize, end: usize) -> String {
    format!(
        "Candid parser error: record field id 4294967295 is not supported at bytes \
         {start}..{end}; the pinned candid_parser cannot number a record field after it"
    )
}

fn assert_refusal(
    error: &CompileError,
    source_name: Option<&str>,
    start: usize,
    end: usize,
    case: &str,
) {
    assert_eq!(error.diagnostics.len(), 1, "{case}: {error:#?}");
    let diagnostic = &error.diagnostics[0];
    assert_eq!(diagnostic.code, "did_parse_error", "{case}");
    assert_eq!(diagnostic.phase, Some(DiagnosticPhase::Parse), "{case}");
    assert_eq!(diagnostic.message, refusal_message(start, end), "{case}");
    assert_eq!(
        diagnostic.span,
        Some(SourceSpan::exact(
            source_name.map(str::to_string),
            start as u64,
            end as u64
        )),
        "{case}"
    );
    // The label is located, never rendered (see `parse_error_message`).
    assert!(!diagnostic.message.contains(MAX_NAME), "{case}");
    assert_eq!(diagnostic.path, None, "{case}");
    assert!(diagnostic.resource_limit.is_none(), "{case}");
}

fn field_ids(source: &str) -> Vec<u32> {
    let compilation = compile_did(source).unwrap_or_else(|error| panic!("{source}: {error:#?}"));
    let contract = serde_json::to_value(compilation.contract()).unwrap();
    contract["types"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|ty| ty["fields"].as_array().cloned().unwrap_or_default())
        .map(|field| u32::try_from(field["id"].as_u64().unwrap()).unwrap())
        .collect()
}

#[test]
fn the_name_reaches_the_maximum_id() {
    assert_eq!(candid_parser::candid::idl_hash(MAX_NAME), u32::MAX);
}

#[test]
fn every_record_field_at_the_maximum_id_is_refused_with_its_span() {
    for (source, start, end) in REFUSED {
        let error = compile_did(source).expect_err(source);
        assert_refusal(&error, Some(INLINE), *start, *end, source);
    }
}

/// Why the preflight exists: in a build with overflow checks, the pinned
/// upstream grammar panics on every refused source. When an upstream fix
/// lands and the pin moves, this fails, and the preflight can be revisited.
#[cfg(debug_assertions)]
#[test]
fn the_pinned_upstream_grammar_panics_on_every_refused_source() {
    for (source, _, _) in REFUSED {
        let outcome = std::panic::catch_unwind(|| {
            let _ = source.parse::<candid_parser::syntax::IDLProg>();
        });
        assert!(outcome.is_err(), "{source}: upstream no longer panics");
    }
}

#[test]
fn variants_methods_and_lower_ids_compile_exactly_as_before() {
    for (source, ids) in ACCEPTED {
        assert_eq!(field_ids(source), *ids, "{source}");
    }
    compile_did("service : { hlrnuwa : () -> () };").expect("a method name at u32::MAX");
}

#[test]
fn upstream_diagnostics_keep_their_precedence() {
    // An id past `u32` is upstream's own refusal, not this one.
    let error = compile_did("type T = record { 4294967296 : nat };").unwrap_err();
    assert_eq!(
        error.diagnostics[0].message,
        "Candid parser error: field id out of u32 range at bytes 18..28"
    );
    // A lexical error inside the record keeps the parser's diagnostic: the
    // refusal waits for the record's closing brace, as upstream's reduction
    // does.
    let error = compile_did("type T = record { 4294967295 : nat; @ };").unwrap_err();
    assert_eq!(
        error.diagnostics[0].message,
        "Candid parser error: Unknown token @ at bytes 36..37"
    );
}

#[test]
fn a_leading_byte_order_mark_shifts_the_span_onto_the_stored_bytes() {
    let error = compile_did("\u{FEFF}type T = record { 4294967295 : nat };").unwrap_err();
    assert_refusal(&error, Some(INLINE), 21, 31, "marked");
}

#[test]
fn the_refusal_does_not_depend_on_provenance_or_the_context() {
    for (source, start, end) in REFUSED {
        for include_source_info in [false, true] {
            let options = CompileOptions {
                include_source_info,
            };
            let error = compile_did_with_options(source, options).expect_err(source);
            assert_refusal(&error, Some(INLINE), *start, *end, source);
            let error = compile_did_with_context(source, options, &RuntimeContext::default())
                .expect_err(source);
            assert_refusal(&error, Some(INLINE), *start, *end, source);
        }
    }
}

#[test]
fn the_resolver_path_refuses_and_names_the_declaring_source() {
    let resolver = MemoryResolver::new()
        .with_source(
            "memory:/entry.did",
            "import \"types.did\";\nservice : { m : (T) -> () };",
        )
        .unwrap()
        .with_source("memory:/types.did", "type T = record { hlrnuwa : nat };")
        .unwrap();
    for include_source_info in [false, true] {
        let error = compile_with_resolver(
            "memory:/entry.did",
            &resolver,
            CompileOptions {
                include_source_info,
            },
            &RuntimeContext::default(),
        )
        .expect_err("an imported record field at u32::MAX");
        assert_refusal(&error, Some("memory:/types.did"), 18, 25, "imported");
    }
}

#[cfg(feature = "filesystem-compiler")]
#[test]
fn native_file_compilation_refuses_too() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "candid-core-field-id-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join("types.did"),
        "type T = record { 4294967295 : nat; text };",
    )
    .unwrap();
    let entry = directory.join("service.did");
    std::fs::write(
        &entry,
        "import \"types.did\";\nservice : { m : (T) -> () };",
    )
    .unwrap();
    let outcome = meant::compile_did_file(&entry);
    let _ = std::fs::remove_dir_all(&directory);
    let error = outcome.expect_err("an imported record field at u32::MAX");
    let span = error.diagnostics[0].span.clone().expect("a source span");
    assert_refusal(&error, span.source_name.as_deref(), 18, 28, "native");
    assert!(
        span.source_name.as_deref().unwrap().ends_with("types.did"),
        "{span:?}"
    );
}

/// The source-bundle identity, computed independently of the crate, as in
/// `tests/opt_only_cycle.rs`.
fn bundle_id(sources: &serde_json::Value, imports: &serde_json::Value) -> String {
    const DOMAIN: &str = "candid-core:source-bundle:v1";
    let payload = serde_json::json!({ "imports": imports, "sources": sources });
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_string(&payload).unwrap().as_bytes());
    format!("{DOMAIN}:sha256:{}", hex::encode(hasher.finalize()))
}

#[test]
fn source_info_rederivation_refuses_an_embedded_overflowing_field() {
    // A genuine sidecar, then its one source replaced and its bundle identity
    // recomputed, so authentication reaches the rederivation, which recompiles
    // the bundle. Before this change a debug build panicked here.
    let compilation = compile_did("type T = record { a : nat };\n").unwrap();
    let contract = compilation.contract().clone();
    let mut raw = serde_json::to_value(compilation.source_info().unwrap()).unwrap();
    assert_eq!(
        bundle_id(&raw["sources"], &raw["imports"]),
        raw["source_bundle_id"],
        "the independent identity must reproduce the crate's"
    );
    raw["sources"][0]["source"] = serde_json::json!("type T = record { hlrnuwa : nat };\n");
    raw["source_bundle_id"] = serde_json::json!(bundle_id(&raw["sources"], &raw["imports"]));
    let raw: RawSourceInfo = serde_json::from_value(raw).unwrap();
    let error = SourceInfo::try_from_raw_with_context(raw, &contract, &RuntimeContext::default())
        .expect_err("rederivation must refuse the embedded field");
    assert_eq!(error.violations.len(), 1, "{error:#?}");
    let violation = &error.violations[0];
    assert_eq!(violation.code, "did_parse_error");
    assert!(
        violation.message.ends_with(&refusal_message(18, 25)),
        "{}",
        violation.message
    );
}
