//! The differential corpus (`../test/differential/corpus.json`, written by `npm run golden -w packages/consent`):
//! generated payloads over every Candid type and value tag, hostile payloads, and resolved forms with faults. For each,
//! the crate must answer what the JavaScript package answered: the same text, or an error with the same code.

use std::fs;
use std::path::Path;

use candid_profile_consent::{generic_consent_message, parse_resolved, sns_validator_rendering, Limits};
use serde_json::{Map, Value};

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn code_of(err: &str) -> &str {
    err.split(':').next().unwrap()
}

#[test]
fn differential_corpus() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/differential/corpus.json");
    let corpus = parse_resolved(&fs::read_to_string(&path).unwrap()).unwrap();
    let sources = corpus["sources"].as_object().unwrap();
    let vectors = corpus["vectors"].as_array().unwrap();
    assert!(vectors.len() > 150, "the corpus has {} vectors", vectors.len());

    let mut failures = Vec::new();
    for (i, v) in vectors.iter().enumerate() {
        let source = v["source"].as_str().unwrap();
        let resolved = &sources[source];
        let method = v["method"].as_str().unwrap();
        let refs: Map<String, Value> = v["refs"].as_object().cloned().unwrap_or_default();
        let payload = from_hex(v["payload_hex"].as_str().unwrap());
        let what = format!("vector {i} ({source} {method}, payload {})", v["payload_hex"].as_str().unwrap());

        let sns = sns_validator_rendering(resolved, method, &payload, &refs);
        match (&sns, v["sns"].get("Ok"), v["sns"].get("Err")) {
            (Ok(text), Some(Value::String(want)), _) if text == want => {}
            (Err(e), _, Some(Value::String(want))) if code_of(e) == code_of(want) => {}
            (Ok(text), Some(Value::String(want)), _) => failures.push(format!("{what}: sns Ok differs\n--- js\n{want}\n--- rust\n{text}")),
            _ => failures.push(format!("{what}: sns got {sns:?}, want {}", v["sns"])),
        }

        let offset = v["utc_offset_minutes"].as_i64().map(|m| m as i32);
        let raw = v["raw_arguments"].as_bool().unwrap();
        let generic = generic_consent_message(resolved, method, &payload, &refs, offset, raw, Limits::default());
        let want = &v["generic"];
        match (&generic, want.get("Ok"), want.get("Err")) {
            (Ok(m), Some(Value::String(text)), _) if &m.text == text && Some(m.zone_sensitive) == want["zone_sensitive"].as_bool() => {}
            (Err(e), _, Some(Value::String(code))) if e.code == code => {}
            (Ok(m), Some(Value::String(text)), _) => failures.push(format!(
                "{what}: generic differs (zone sensitive {} vs {})\n--- js\n{text}\n--- rust\n{}",
                m.zone_sensitive, want["zone_sensitive"], m.text
            )),
            _ => failures.push(format!("{what}: generic got {generic:?}, want {want}")),
        }
    }
    assert!(failures.is_empty(), "{} of {} vectors differ:\n\n{}", failures.len(), vectors.len(), failures.join("\n\n"));
}
