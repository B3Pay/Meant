//! `didToDocAttributes` at the function level: the same code the wasm artifact
//! wraps, compared with the crate's own `DocAttributes` and with the envelope
//! path for the same sources.

use meant::{compile_did, DocAttributes};
use candid_core_wasm::{did_to_contract, did_to_doc_attributes};
use serde_json::{json, Value};

const SOURCE: &str = r#"
type Tokens = record {
  /// @amount(decimals = 8, symbol = "ICP")
  e8s : nat64;
};
service : {
  /// Send tokens.
  /// @intent(title = "Send", template = "Send {amount}")
  send : (record { amount : Tokens }) -> ();
}
"#;

fn single(source: &str) -> String {
    serde_json::to_string(&json!({ "source": source })).unwrap()
}

fn call(request: &str) -> Value {
    serde_json::from_str(&did_to_doc_attributes(request)).unwrap()
}

#[test]
fn success_carries_the_contract_the_source_info_and_the_attributes() {
    let response = call(&single(SOURCE));
    assert_eq!(response["ok"], Value::Bool(true), "{response}");
    let keys: Vec<_> = response.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["contract", "doc_attributes", "ok", "source_info"]);

    // the same Contract the envelope path hands out
    let envelope: Value = serde_json::from_str(&did_to_contract(&single(SOURCE))).unwrap();
    assert_eq!(response["contract"], envelope["contract"]);

    // the same attributes the crate parses from its own compilation
    let compilation = compile_did(SOURCE).unwrap();
    let native = DocAttributes::from_source_info(compilation.source_info().unwrap()).unwrap();
    let mut expected = serde_json::to_value(&native).unwrap();
    let mut actual = response["doc_attributes"].clone();
    // the only difference is the source's name: `compile_did` calls its one
    // source memory:/inline.did, a sources request names its own
    for value in [&mut expected, &mut actual] {
        for item in value["items"].as_array_mut().unwrap() {
            item["origin"]["source"] = Value::Null;
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(
        response["doc_attributes"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        response["doc_attributes"]["items"][0]["attributes"][0]["name"],
        json!("intent")
    );
    assert_eq!(
        response["source_info"]["contract_id"],
        response["contract"]["identities"]["contract"]
    );
}

#[test]
fn an_imported_file_keeps_its_own_source_name() {
    let request = serde_json::to_string(&json!({
        "entry": "main.did",
        "files": {
            "main.did": "import \"types.did\";\nservice : { m : (T) -> () }",
            "types.did": "type T = record {\n  /// @describe(label = \"Count\")\n  n : nat;\n};",
        }
    }))
    .unwrap();
    let response = call(&request);
    assert_eq!(response["ok"], Value::Bool(true), "{response}");
    let item = &response["doc_attributes"]["items"][0];
    assert_eq!(item["path"], json!("type:T.fields[0]"));
    assert_eq!(item["origin"]["source"], json!("memory:/types.did"));
}

#[test]
fn a_malformed_attribute_fails_the_call() {
    let response = call(&single(
        "service : {\n  /// @intent(title = \"Send\", title = \"Again\")\n  m : () -> ();\n}",
    ));
    assert_eq!(response["ok"], Value::Bool(false));
    let diagnostics = response["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], json!("doc_attribute_duplicate_key"));
    assert_eq!(diagnostics[0]["path"], json!("actor.methods[0]"));
    assert_eq!(diagnostics[0]["phase"], json!("parse"));
}

#[test]
fn compile_failures_and_bad_requests_pass_through() {
    let response = call(&single("service : { m : (missing) -> () }"));
    assert_eq!(response["ok"], Value::Bool(false));
    assert_ne!(
        response["diagnostics"][0]["code"],
        json!("doc_attribute_malformed")
    );

    let response = call("{\"nope\": 1}");
    assert_eq!(response["diagnostics"][0]["code"], json!("invalid_request"));
}

#[test]
fn responses_are_deterministic_and_comments_never_move_identity() {
    let first = did_to_doc_attributes(&single(SOURCE));
    assert_eq!(first, did_to_doc_attributes(&single(SOURCE)));
    assert!(first.ends_with("}\n"));

    let bare: String = SOURCE
        .lines()
        .filter(|line| !line.trim_start().starts_with("///"))
        .map(|line| format!("{line}\n"))
        .collect();
    let with = call(&single(SOURCE));
    let without = call(&single(&bare));
    assert_eq!(with["contract"], without["contract"]);
    assert_eq!(without["doc_attributes"]["items"], json!([]));
}

fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/goldens")
        .join(name)
}

/// The whole response for the reviewed fixture, byte for byte. The npm suite
/// compares the wasm build's response with the same file, so the same code
/// compiled twice must agree.
#[test]
fn the_fixture_response_matches_its_golden() {
    let source = std::fs::read_to_string(golden_path("attributes.did")).unwrap();
    let response = did_to_doc_attributes(&single(&source));
    let parsed: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(parsed["ok"], Value::Bool(true), "{response}");
    let golden = golden_path("attributes.doc-attributes.json");
    if std::env::var_os("UPDATE_GOLDENS").is_some() {
        std::fs::write(&golden, &response).unwrap();
    }
    assert_eq!(
        response,
        std::fs::read_to_string(&golden).unwrap(),
        "regenerate with UPDATE_GOLDENS=1 and review the diff"
    );
}

/// The generator's doc-comment fixture, written before this syntax existed,
/// reads cleanly: its `@param …` and `@deprecated also …` lines stay prose.
#[test]
fn the_generator_docs_fixture_reads_as_prose() {
    let source = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../candid-core-ts/tests/fixtures/docs.did"),
    )
    .unwrap();
    let response = call(&single(&source));
    assert_eq!(response["ok"], Value::Bool(true), "{response}");
    let items = response["doc_attributes"]["items"].as_array().unwrap();
    assert!(!items.is_empty());
    for item in items {
        assert_eq!(item["attributes"], json!([]), "{item}");
    }
}
