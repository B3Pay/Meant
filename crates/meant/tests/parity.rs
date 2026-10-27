//! The crate gives the JavaScript reference's answer for every case in
//! `vectors/amount.json`: the same value, or the same error code and message.
//! The vectors are generated from `@candid-core/profile-format` by
//! `vectors/generate-amount.mjs`, which records the commit it ran against.

use std::collections::BTreeSet;

use meant::{AmountFormat, FormatError};
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/amount.json");

/// README.md states this count. Regenerating the vectors with another count
/// fails here until the README says the new number.
const DOCUMENTED_CASES: usize = 2155;

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors/amount.json is JSON")
}

fn format_for(case: &Value) -> AmountFormat {
    let decimals = u8::try_from(case["d"].as_u64().expect("d")).expect("d fits u8");
    let mut format = AmountFormat::new(decimals);
    if let Some(symbol) = case["sym"].as_str() {
        format = format
            .with_symbol(symbol)
            .expect("symbols in parse and display cases are valid");
    }
    format
        .with_candid_name(case["candid"].as_str().expect("candid"))
        .expect("types in parse and display cases are valid")
}

/// `None` when `got` is the answer the case records, else what differs.
fn mismatch(case: &Value, got: &Result<String, FormatError>) -> Option<String> {
    let expected_ok = case.get("ok").and_then(Value::as_str);
    match (got, expected_ok) {
        (Ok(value), Some(want)) if value == want => None,
        (Err(e), None)
            if Some(e.code().as_str()) == case["err"].as_str()
                && Some(e.message()) == case["msg"].as_str() =>
        {
            None
        }
        _ => Some(format!("case {case}\n     got {got:?}")),
    }
}

fn assert_all(kind: &str, failures: &[String], total: usize) {
    assert!(
        failures.is_empty(),
        "{} of {total} {kind} cases differ from the reference; first ones:\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// The codes the cases expect, so a regenerated file that lost a whole class
/// of answer fails here instead of passing vacuously.
fn expected_codes(cases: &[Value]) -> BTreeSet<String> {
    cases
        .iter()
        .map(|c| c["err"].as_str().unwrap_or("ok").to_owned())
        .collect()
}

#[test]
fn records_where_it_came_from() {
    let v = vectors();
    let source = &v["source"];
    for key in ["repository", "commit", "package", "node", "unicode", "seed"] {
        assert!(!source[key].is_null(), "source.{key} is missing");
    }
    // The unsafe-character table in src/text.rs is Unicode 16.0; vectors from
    // an engine on another version could disagree for reasons that are not a
    // bug in either implementation.
    assert_eq!(source["unicode"], "16.0");
    let total: usize = ["parse", "display", "symbol", "candid"]
        .iter()
        .map(|k| v[*k].as_array().expect(k).len())
        .sum();
    assert_eq!(
        total, DOCUMENTED_CASES,
        "update README.md and DOCUMENTED_CASES"
    );
}

#[test]
fn parse_matches_the_reference() {
    let v = vectors();
    let cases = v["parse"].as_array().expect("parse cases");
    assert!(cases.len() >= 1000, "only {} parse cases", cases.len());
    let codes = expected_codes(cases);
    for code in [
        "ok",
        "E_SYNTAX",
        "E_RANGE",
        "E_TOO_LONG",
        "E_EXCESS_PRECISION",
        "E_NEGATIVE",
        "E_SYMBOL_MISMATCH",
    ] {
        assert!(codes.contains(code), "no parse case expects {code}");
    }
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let input = case["in"].as_str().expect("in");
            mismatch(case, &format_for(case).parse(input))
        })
        .collect();
    assert_all("parse", &failures, cases.len());
}

#[test]
fn display_matches_the_reference() {
    let v = vectors();
    let cases = v["display"].as_array().expect("display cases");
    assert!(cases.len() >= 500, "only {} display cases", cases.len());
    let codes = expected_codes(cases);
    for code in ["ok", "E_SYNTAX", "E_RANGE", "E_TOO_LONG"] {
        assert!(codes.contains(code), "no display case expects {code}");
    }
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let value = case["in"].as_str().expect("in");
            mismatch(case, &format_for(case).display(value))
        })
        .collect();
    assert_all("display", &failures, cases.len());
}

#[test]
fn symbol_rules_match_the_reference() {
    let v = vectors();
    let cases = v["symbol"].as_array().expect("symbol cases");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let symbol = case["sym"].as_str().expect("sym");
            let got = AmountFormat::new(0).with_symbol(symbol);
            let same = match (&got, case["ok"].as_bool()) {
                (Ok(_), Some(true)) => true,
                (Err(e), None) => {
                    Some(e.code().as_str()) == case["err"].as_str()
                        && Some(e.message()) == case["msg"].as_str()
                }
                _ => false,
            };
            (!same).then(|| format!("case {case}\n     got {got:?}"))
        })
        .collect();
    assert_all("symbol", &failures, cases.len());
}

#[test]
fn candid_names_match_the_reference() {
    let v = vectors();
    let cases = v["candid"].as_array().expect("candid cases");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let name = case["name"].as_str().expect("name");
            let got = AmountFormat::new(0)
                .with_candid_name(name)
                .and_then(|f| f.parse("1"));
            mismatch(case, &got)
        })
        .collect();
    assert_all("candid", &failures, cases.len());
}
