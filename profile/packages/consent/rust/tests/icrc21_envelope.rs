//! The ICRC-21 envelope vectors (`../test/icrc21-envelope/vectors.json`, written by the JavaScript package): every
//! request, as Candid bytes, through `handle_consent_request`. The reply must decode to what JavaScript answered: an
//! `Ok` equal in full (message and metadata) and the same bytes as JavaScript's reply, an `Err` with the same variant and code (the two decoders word their
//! errors differently) and, for `GenericError`, the same `error_code`. Where a vector says the crate answers with
//! another code on purpose (`rust`: `E_FORM`), it must answer with exactly that.

use std::fs;
use std::path::{Path, PathBuf};

use candid::Nat;
use candid_profile_consent::icrc21::{ConsentInfo, ConsentMessage, ConsentMessageMetadata, ConsentMessageResponse, ErrorInfo, Icrc21Error};
use candid_profile_consent::{handle_consent_request, parse_resolved, ConsentContext, LanguagePolicy};
use serde_json::{Map, Value};

fn here(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read_json(path: &Path) -> Value {
    parse_resolved(&fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The JavaScript response (its JSON shape: variants as `{ Tag: payload }`, nat as a decimal string).
fn expected(v: &Value) -> ConsentMessageResponse {
    if let Some(ok) = v.get("Ok") {
        let message = &ok["consent_message"];
        let consent_message = match (message.get("GenericDisplayMessage"), message.get("FieldsDisplayMessage")) {
            (Some(Value::String(t)), _) => ConsentMessage::GenericDisplayMessage(t.clone()),
            _ => panic!("only generic messages are compared in full: {message}"),
        };
        let metadata = ConsentMessageMetadata {
            language: ok["metadata"]["language"].as_str().unwrap().to_string(),
            utc_offset_minutes: ok["metadata"]["utc_offset_minutes"].as_i64().map(|m| m as i16),
        };
        return Ok(ConsentInfo { consent_message, metadata });
    }
    let (tag, body) = v["Err"].as_object().unwrap().iter().next().unwrap();
    let description = body["description"].as_str().unwrap().to_string();
    Err(match tag.as_str() {
        "UnsupportedCanisterCall" => Icrc21Error::UnsupportedCanisterCall(ErrorInfo { description }),
        "ConsentMessageUnavailable" => Icrc21Error::ConsentMessageUnavailable(ErrorInfo { description }),
        "InsufficientPayment" => Icrc21Error::InsufficientPayment(ErrorInfo { description }),
        "GenericError" => {
            Icrc21Error::GenericError { error_code: body["error_code"].as_str().unwrap().parse::<Nat>().unwrap(), description }
        }
        other => panic!("unknown error {other}"),
    })
}

fn code(e: &Icrc21Error) -> (&'static str, String) {
    let (tag, d) = match e {
        Icrc21Error::UnsupportedCanisterCall(i) => ("UnsupportedCanisterCall", &i.description),
        Icrc21Error::ConsentMessageUnavailable(i) => ("ConsentMessageUnavailable", &i.description),
        Icrc21Error::InsufficientPayment(i) => ("InsufficientPayment", &i.description),
        Icrc21Error::GenericError { error_code, description } => {
            return ("GenericError", format!("{error_code} {}", description.split(':').next().unwrap()));
        }
    };
    (tag, d.split(':').next().unwrap().to_string())
}

#[test]
fn icrc21_envelope_vectors() {
    let doc = read_json(&here("../test/icrc21-envelope/vectors.json"));
    let vectors = doc["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 67, "the 67 envelope vectors");
    let icrc1 = read_json(&here("../../../fixtures/icrc1.resolved.json"));
    let icrc2 = read_json(&here("../../../fixtures/icrc2.resolved.json"));
    let (mut failures, mut same_bytes, mut compared_ok) = (Vec::new(), 0, 0);
    for v in vectors {
        let id = v["id"].as_str().unwrap();
        let resolved = if v["pack"] == "icrc1" { &icrc1 } else { &icrc2 };
        let mut refs = Map::new();
        refs.insert("query:icrc1_decimals".into(), v["ledger"]["decimals"].clone());
        refs.insert("query:icrc1_symbol".into(), v["ledger"]["symbol"].clone());
        let mut ctx = ConsentContext::new(resolved, &refs);
        if v["policy"] == "error" {
            ctx.language_policy = LanguagePolicy::Error;
        }
        let reply = handle_consent_request(&from_hex(v["request_hex"].as_str().unwrap()), &ctx);
        let got: ConsentMessageResponse = match candid::decode_one(&reply) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{id}: the reply does not decode: {e}"));
                continue;
            }
        };
        let identical = hex(&reply) == v["response_hex"].as_str().unwrap();
        if identical {
            same_bytes += 1;
        }
        match v["rust"].as_str().unwrap() {
            "same" => match (&got, expected(&v["response"])) {
                (Ok(g), Ok(w)) if *g == w && identical => compared_ok += 1,
                (Ok(g), Ok(w)) if *g == w => failures.push(format!("{id}: the same reply, but not the same bytes as JavaScript's")),
                (Err(g), Err(w)) if code(g) == code(&w) => {}
                (g, w) => failures.push(format!("{id}:\n  rust {g:?}\n  js   {w:?}")),
            },
            want => match &got {
                Err(Icrc21Error::ConsentMessageUnavailable(i)) if i.description.starts_with(&format!("{want}: ")) => {}
                g => failures.push(format!("{id}: want ConsentMessageUnavailable {want}, got {g:?}")),
            },
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared_ok, 50, "the Ok replies compared in full");
    // Every Ok, and the errors whose descriptions both decoders word alike (observed: 56 of 67).
    assert!(same_bytes >= compared_ok, "{same_bytes}");
    println!("{same_bytes} of {} replies are the same bytes as JavaScript's", vectors.len());
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
