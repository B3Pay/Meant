//! The JavaScript goldens, run through the Rust crate: every SNS validator rendering of `../test/sns-golden/` and
//! every ICRC-21 generic message of `../test/golden/` must come out byte for byte. An `Err` must carry the same code
//! (the decoder's own words differ between the two codecs).

use std::fs;
use std::path::{Path, PathBuf};

use candid_profile_consent::{
    encode_validator_result, generic_consent_message, handle_sns_validator_call, parse_resolved, sns_validator_rendering, Limits,
};
use serde_json::{Map, Value};

fn here(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_resolved(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn resolved_for(source: &str) -> Value {
    match source {
        "icrc1" | "icrc2" => read_json(&here(&format!("../../../fixtures/{source}.resolved.json"))),
        "dapp" | "bare" => read_json(&here(&format!("../test/sns-golden/resolved/{source}.resolved.json"))),
        other => panic!("unknown source {other}"),
    }
}

fn cases(dir: &str) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = fs::read_dir(here(dir))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), read_json(&p)))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn code_of(err: &str) -> &str {
    err.split(':').next().unwrap()
}

#[test]
fn sns_goldens() {
    let all = cases("../test/sns-golden");
    assert_eq!(all.len(), 13, "the 13 SNS golden cases");
    let mut failures = Vec::new();
    for (id, g) in &all {
        let resolved = resolved_for(g["source"].as_str().unwrap());
        let method = g["method"].as_str().unwrap();
        let refs: Map<String, Value> = g["refs"].as_object().cloned().unwrap_or_default();
        let payload = from_hex(g["payload_hex"].as_str().unwrap());
        let got = sns_validator_rendering(&resolved, method, &payload, &refs);
        let reply = handle_sns_validator_call(&resolved, method, &payload, &refs);
        assert_eq!(reply, encode_validator_result(&got), "{id}: the wrapper encodes the rendering");
        match (&got, g["reply"].get("Ok"), g["reply"].get("Err")) {
            (Ok(text), Some(Value::String(want)), _) => {
                if text != want {
                    failures.push(format!("{id}: Ok differs\n--- js\n{want}\n--- rust\n{text}"));
                } else if hex(&reply) != g["reply_hex"].as_str().unwrap() {
                    failures.push(format!("{id}: the Candid reply bytes differ"));
                }
            }
            (Err(e), _, Some(Value::String(want))) if code_of(e) == code_of(want) => {}
            _ => failures.push(format!("{id}: got {got:?}, want {}", g["reply"])),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn icrc21_generic_goldens() {
    let all = cases("../test/golden");
    assert_eq!(all.len(), 20, "the 20 ICRC-21 golden cases");
    let mut failures = Vec::new();
    for (id, g) in &all {
        let resolved = resolved_for(g["pack"].as_str().unwrap());
        let ledger = &g["ledger"];
        let mut refs = Map::new();
        refs.insert("query:icrc1_decimals".into(), ledger["decimals"].clone());
        refs.insert("query:icrc1_symbol".into(), ledger["symbol"].clone());
        let arg = from_hex(g["arg_hex"].as_str().unwrap());
        let offset = g["generic"]["request"]["user_preferences"]["metadata"]["utc_offset_minutes"].as_i64().map(|m| m as i32);
        let ok = &g["generic"]["response"]["Ok"];
        let want = ok["consent_message"]["GenericDisplayMessage"].as_str().expect("every ICRC-21 golden is Ok");
        let want_zone = !ok["metadata"]["utc_offset_minutes"].is_null();
        match generic_consent_message(&resolved, g["method"].as_str().unwrap(), &arg, &refs, offset, false, Limits::default()) {
            Ok(m) if m.text == want && m.zone_sensitive == want_zone => {}
            Ok(m) => failures
                .push(format!("{id}: differs (zone sensitive {} vs {want_zone})\n--- js\n{want}\n--- rust\n{}", m.zone_sensitive, m.text)),
            Err(e) => failures.push(format!("{id}: {e}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
