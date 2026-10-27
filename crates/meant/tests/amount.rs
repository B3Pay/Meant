//! The `amount` rules of Candid Profile v0 §5.3, ported from the JavaScript
//! package's `test/amount.test.mjs`, plus the cases where Rust and JavaScript
//! could part ways (whitespace sets, UTF-16 length, `u128` and `i128`).

use meant::{AmountFormat, Code, FormatError, IntType, MAX_INPUT_UTF16_LEN};

fn icp() -> AmountFormat {
    AmountFormat::new(8).with_symbol("ICP").unwrap()
}

fn code<T: std::fmt::Debug>(result: Result<T, FormatError>) -> Code {
    result.expect_err("expected an error").code()
}

#[test]
fn the_spec_examples() {
    let icp = icp();
    assert_eq!(icp.display("150000000").unwrap(), "1.5 ICP");
    assert_eq!(icp.display("100000000").unwrap(), "1 ICP");
    assert_eq!(icp.parse("1.5").unwrap(), "150000000");
    assert_eq!(icp.parse("1.5 ICP").unwrap(), "150000000");
    assert_eq!(icp.parse("1 icp").unwrap(), "100000000");
    assert_eq!(icp.display("0").unwrap(), "0 ICP");
    assert_eq!(icp.display("1").unwrap(), "0.00000001 ICP");
    assert_eq!(icp.display("12345678").unwrap(), "0.12345678 ICP");
    assert_eq!(AmountFormat::new(8).display("150000000").unwrap(), "1.5");
    let x = AmountFormat::new(0).with_symbol("X").unwrap();
    assert_eq!(x.display("7").unwrap(), "7 X");
}

#[test]
fn parsing_is_exact_for_typical_inputs() {
    let icp = icp();
    assert_eq!(icp.parse("0.5").unwrap(), "50000000");
    assert_eq!(icp.parse("0.00000001").unwrap(), "1");
    assert_eq!(icp.parse("007.5").unwrap(), "750000000");
    assert_eq!(icp.parse("  2  ").unwrap(), "200000000");
    assert_eq!(icp.parse("1.5\tICP").unwrap(), "150000000");
    assert_eq!(icp.parse("0").unwrap(), "0");
    assert_eq!(icp.parse("0.12345678").unwrap(), "12345678");
    assert_eq!(AmountFormat::new(0).parse("12").unwrap(), "12");
}

#[test]
fn eighteen_decimal_amounts_past_2_pow_64_round_trip() {
    let eth = AmountFormat::new(18).with_symbol("ckETH").unwrap();
    for v in [
        "9007199254740993",
        "18446744073709551615",
        "18446744073709551616",
        "123456789012345678901234567890123456789",
    ] {
        let text = eth.display(v).unwrap();
        assert_eq!(eth.parse(&text).unwrap(), v, "{v} -> {text}");
    }
    assert_eq!(
        eth.display("1000000000000000001").unwrap(),
        "1.000000000000000001 ckETH"
    );
    assert_eq!(
        eth.parse("18.446744073709551615").unwrap(),
        "18446744073709551615"
    );
}

#[test]
fn decimals_255_works() {
    let z = AmountFormat::new(255).with_symbol("Z").unwrap();
    let v = format!("1{}1", "0".repeat(253));
    let text = z.display(&v).unwrap();
    assert_eq!(z.parse(&text).unwrap(), v);
}

#[test]
fn never_rounds() {
    let icp = icp();
    for input in [
        "0.123456789",
        "0.123456780",
        "1.000000000",
        "0.000000005",
        "0.999999999",
    ] {
        assert_eq!(code(icp.parse(input)), Code::ExcessPrecision, "{input}");
    }
    assert_eq!(
        code(AmountFormat::new(0).parse("1.0")),
        Code::ExcessPrecision
    );
}

#[test]
fn signed_types_accept_negatives_and_unsigned_types_do_not() {
    let s = AmountFormat::new(2)
        .with_symbol("S")
        .unwrap()
        .with_candid(IntType::Int);
    assert_eq!(s.parse("-1.25").unwrap(), "-125");
    assert_eq!(s.display("-125").unwrap(), "-1.25 S");
    assert_eq!(s.display("-5").unwrap(), "-0.05 S");
    assert_eq!(s.parse("-0").unwrap(), "0");
    let unsigned = s.clone().with_candid(IntType::Nat);
    assert_eq!(code(unsigned.parse("-1.25")), Code::Negative);
    assert_eq!(code(unsigned.parse("-0")), Code::Negative);
    assert_eq!(code(unsigned.display("-1")), Code::Range);
}

#[test]
fn candid_bounds_are_enforced_not_wrapped() {
    let n8 = AmountFormat::new(0).with_candid(IntType::Nat8);
    assert_eq!(n8.parse("255").unwrap(), "255");
    assert_eq!(code(n8.parse("256")), Code::Range);
    assert_eq!(code(n8.display("256")), Code::Range);
    let n64 = AmountFormat::new(8).with_candid(IntType::Nat64);
    assert_eq!(
        n64.parse("184467440737.09551615").unwrap(),
        "18446744073709551615"
    );
    assert_eq!(code(n64.parse("184467440737.09551616")), Code::Range);
    let i64 = AmountFormat::new(0).with_candid(IntType::Int64);
    assert_eq!(
        i64.parse("-9223372036854775808").unwrap(),
        "-9223372036854775808"
    );
    assert_eq!(code(i64.parse("-9223372036854775809")), Code::Range);
    assert_eq!(code(i64.parse("9223372036854775808")), Code::Range);
    // Every bounded type, exactly at each bound and one step past it.
    for (ty, min, max, below, above) in [
        (IntType::Nat8, "0", "255", "-1", "256"),
        (IntType::Nat16, "0", "65535", "-1", "65536"),
        (IntType::Nat32, "0", "4294967295", "-1", "4294967296"),
        (
            IntType::Nat64,
            "0",
            "18446744073709551615",
            "-1",
            "18446744073709551616",
        ),
        (IntType::Int8, "-128", "127", "-129", "128"),
        (IntType::Int16, "-32768", "32767", "-32769", "32768"),
        (
            IntType::Int32,
            "-2147483648",
            "2147483647",
            "-2147483649",
            "2147483648",
        ),
        (
            IntType::Int64,
            "-9223372036854775808",
            "9223372036854775807",
            "-9223372036854775809",
            "9223372036854775808",
        ),
    ] {
        let f = AmountFormat::new(0).with_candid(ty);
        assert_eq!(f.display(min).unwrap(), min, "{ty:?}");
        assert_eq!(f.display(max).unwrap(), max, "{ty:?}");
        assert_eq!(code(f.display(below)), Code::Range, "{ty:?} {below}");
        assert_eq!(code(f.display(above)), Code::Range, "{ty:?} {above}");
    }
}

#[test]
fn only_integer_candid_types_are_accepted() {
    for name in ["text", "float64", "Nat", "nat128", ""] {
        assert_eq!(
            code(AmountFormat::new(0).with_candid_name(name)),
            Code::TagType,
            "{name}"
        );
    }
    for ty in IntType::ALL {
        assert_eq!(IntType::from_candid_name(ty.candid_name()), Some(ty));
    }
}

#[test]
fn inputs_that_are_not_plain_decimals_are_refused() {
    let icp = icp();
    for bad in [
        "", " ", "abc", "1,5", "1,000.5", "1_000", "1.", ".5", "1e3", "+1", "--1", "1.2.3", "1 .5",
        "０１", "1٫5", "0x10", "ICP 1", "1ICP", "NaN", "Infinity", "-", "-.5",
    ] {
        let c = code(icp.parse(bad));
        assert!(
            c == Code::Syntax || c == Code::SymbolMismatch,
            "{bad:?} -> {c:?}"
        );
    }
}

#[test]
fn display_refuses_malformed_integers() {
    let icp = icp();
    for bad in ["1.5", "01", "", "+1", " 1", "1 ", "1_000", "１", "-"] {
        assert_eq!(code(icp.display(bad)), Code::Syntax, "{bad:?}");
    }
    let signed = icp.clone().with_candid(IntType::Int);
    assert_eq!(code(signed.display("-0")), Code::Syntax);
    assert_eq!(code(icp.display("-1")), Code::Range);
}

#[test]
fn a_symbol_must_be_a_plain_label() {
    let new = || AmountFormat::new(0);
    for bad in [
        "",
        "I\nCP",
        "ICP\u{202E}",
        " ICP",
        "ICP\u{3000}",
        "IC\u{200B}P",
        "\u{AD}ICP",
    ] {
        assert_eq!(code(new().with_symbol(bad)), Code::Arg, "{bad:?}");
    }
    assert_eq!(code(new().with_symbol(&"x".repeat(33))), Code::Arg);
    // 32 characters is the limit in characters, not bytes.
    new().with_symbol(&"\u{1F600}".repeat(32)).unwrap();
    let inch = new().with_symbol("1INCH").unwrap();
    assert_eq!(inch.display("1").unwrap(), "1 1INCH");
    assert_eq!(inch.parse("15 1INCH").unwrap(), "15");
}

#[test]
fn symbol_matching_ignores_ascii_case_only() {
    let ckbtc = AmountFormat::new(0).with_symbol("ckBTC").unwrap();
    assert_eq!(ckbtc.parse("1 ckbtc").unwrap(), "1");
    assert_eq!(ckbtc.parse("1 CKBTC").unwrap(), "1");
    // U+212A KELVIN SIGN lowercases to "k" under Unicode rules; it must not match.
    assert_eq!(code(ckbtc.parse("1 c\u{212A}BTC")), Code::SymbolMismatch);
    // CYRILLIC CAPITAL LETTER ES looks like a Latin C.
    let upper = AmountFormat::new(0).with_symbol("CKBTC").unwrap();
    assert_eq!(code(upper.parse("1 \u{421}KBTC")), Code::SymbolMismatch);
    // A token with no symbol refuses any symbol.
    assert_eq!(
        code(AmountFormat::new(0).parse("1 ICP")),
        Code::SymbolMismatch
    );
}

#[test]
fn whitespace_is_javascripts_set_not_rusts() {
    let icp = icp();
    // In JavaScript's set: trimmed, and accepted between number and symbol.
    for ws in [
        "\u{FEFF}", "\u{A0}", "\u{3000}", "\u{2028}", "\u{B}", "\u{202F}",
    ] {
        assert_eq!(
            icp.parse(&format!("{ws}1.5{ws}ICP{ws}")).unwrap(),
            "150000000",
            "{ws:?}"
        );
    }
    // Rust's char::is_whitespace includes U+0085; JavaScript's trim does not.
    assert_eq!(code(icp.parse("\u{85}1.5")), Code::Syntax);
    assert_eq!(code(icp.parse("1.5\u{85}ICP")), Code::Syntax);
    // Invisible but not whitespace anywhere.
    assert_eq!(code(icp.parse("1.5\u{200B}ICP")), Code::Syntax);
}

#[test]
fn the_length_bound_counts_utf16_units() {
    let nat = AmountFormat::new(0);
    let at = "1".repeat(MAX_INPUT_UTF16_LEN);
    assert_eq!(nat.parse(&at).unwrap(), at);
    assert_eq!(nat.display(&at).unwrap(), at);
    let over = "1".repeat(MAX_INPUT_UTF16_LEN + 1);
    assert_eq!(code(nat.parse(&over)), Code::TooLong);
    assert_eq!(code(nat.display(&over)), Code::TooLong);
    // An emoji is 4 UTF-8 bytes but 2 UTF-16 units: 512 of them are at the
    // bound (2048 bytes), so the text is read, and refused only as syntax.
    let emoji = "\u{1F600}".repeat(MAX_INPUT_UTF16_LEN / 2);
    assert_eq!(code(nat.parse(&emoji)), Code::Syntax);
    assert_eq!(code(nat.parse(&format!("{emoji} "))), Code::TooLong);
    // Whitespace counts before it is trimmed.
    let padded = format!("{}1.5", " ".repeat(MAX_INPUT_UTF16_LEN - 3));
    assert_eq!(AmountFormat::new(1).parse(&padded).unwrap(), "15");
    assert_eq!(
        code(AmountFormat::new(1).parse(&format!(" {padded}"))),
        Code::TooLong
    );
}

#[test]
fn integer_helpers_agree_with_display() {
    let icp = icp();
    assert_eq!(icp.display_u128(150_000_000).unwrap(), "1.5 ICP");
    assert_eq!(
        AmountFormat::new(0).display_u128(u128::MAX).unwrap(),
        u128::MAX.to_string()
    );
    let int = AmountFormat::new(2).with_candid(IntType::Int);
    assert_eq!(int.display_i128(-125).unwrap(), "-1.25");
    assert_eq!(
        AmountFormat::new(0)
            .with_candid(IntType::Int)
            .display_i128(i128::MIN)
            .unwrap(),
        i128::MIN.to_string()
    );
    assert_eq!(code(icp.display_i128(-1)), Code::Range);
    assert_eq!(
        code(
            AmountFormat::new(0)
                .with_candid(IntType::Nat64)
                .display_u128(u128::from(u64::MAX) + 1)
        ),
        Code::Range
    );
}

#[test]
fn errors_carry_stable_codes_and_readable_messages() {
    let err = icp().parse("0.123456789").unwrap_err();
    assert_eq!(err.code().as_str(), "E_EXCESS_PRECISION");
    assert_eq!(
        err.to_string(),
        "E_EXCESS_PRECISION: \"0.123456789\" has 9 fractional digits but this token has 8; amounts are never rounded, so give at most 8"
    );
}

#[cfg(feature = "std")]
#[test]
fn the_std_feature_makes_errors_std_errors() {
    let err = icp().parse("1e3").unwrap_err();
    let as_std: &dyn std::error::Error = &err;
    assert!(as_std.source().is_none());
}

// ---------------------------------------------------------------- properties

/// splitmix64: a fixed seed, so a failure names a case that can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn digits(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| char::from(b'0' + self.below(10) as u8))
            .collect()
    }
    /// A canonical magnitude with up to `max_len` digits.
    fn magnitude(&mut self, max_len: u64) -> String {
        let len = 1 + self.below(max_len) as usize;
        let s = self.digits(len);
        let t = s.trim_start_matches('0');
        if t.is_empty() {
            "0".into()
        } else {
            t.into()
        }
    }
}

const SEED: u64 = 20_261_027;

#[test]
fn property_display_then_parse_is_the_identity() {
    let mut rng = Rng(SEED);
    let symbols = [None, Some("ICP"), Some("ckBTC"), Some("TKA"), Some("1INCH")];
    for _ in 0..4000 {
        let decimals = if rng.below(4) == 0 {
            rng.below(256)
        } else {
            rng.below(31)
        } as u8;
        let mut f = AmountFormat::new(decimals);
        if let Some(s) = symbols[rng.below(5) as usize] {
            f = f.with_symbol(s).unwrap();
        }
        let signed = rng.below(2) == 0;
        f = f.with_candid(if signed { IntType::Int } else { IntType::Nat });
        let mag = rng.magnitude(80);
        let v = if signed && mag != "0" && rng.below(2) == 0 {
            format!("-{mag}")
        } else {
            mag
        };
        let text = f.display(&v).unwrap();
        assert_eq!(f.parse(&text).unwrap(), v, "seed {SEED}: {v} d={decimals}");
        let number = text.split(' ').next().unwrap();
        assert!(
            !number.ends_with('.') && !(number.contains('.') && number.ends_with('0')),
            "seed {SEED}: {text}"
        );
    }
}

#[test]
fn property_parse_agrees_with_a_string_padding_oracle() {
    let mut rng = Rng(SEED + 1);
    for _ in 0..4000 {
        let decimals = rng.below(31) as usize;
        let frac_len = rng.below(decimals as u64 + 1) as usize;
        let whole_len = 1 + rng.below(40) as usize;
        let whole_raw = rng.digits(whole_len);
        let whole = match whole_raw.trim_start_matches('0') {
            "" => "0",
            w => w,
        };
        let frac = rng.digits(frac_len);
        let text = if frac.is_empty() {
            whole.to_string()
        } else {
            format!("{whole}.{frac}")
        };
        let padded = format!("{whole}{frac}{}", "0".repeat(decimals - frac_len));
        let expected = match padded.trim_start_matches('0') {
            "" => "0",
            e => e,
        };
        let f = AmountFormat::new(decimals as u8);
        assert_eq!(
            f.parse(&text).unwrap(),
            expected,
            "seed {}: {text} d={decimals}",
            SEED + 1
        );
    }
}

#[test]
fn property_more_fractional_digits_than_decimals_is_always_refused() {
    let mut rng = Rng(SEED + 2);
    for _ in 0..4000 {
        let decimals = rng.below(31) as usize;
        let extra = 1 + rng.below(6) as usize;
        // a 5 that would round up, 9s that would carry, plain zeros, anything
        let tail = match rng.below(4) {
            0 => "5".to_string(),
            1 => "9".repeat(extra),
            2 => "0".repeat(extra),
            _ => rng.digits(extra),
        };
        let whole_len = 1 + rng.below(20) as usize;
        let text = format!("{}.{}{tail}", rng.digits(whole_len), rng.digits(decimals));
        let f = AmountFormat::new(decimals as u8);
        assert_eq!(
            code(f.parse(&text)),
            Code::ExcessPrecision,
            "seed {}: {text} d={decimals}",
            SEED + 2
        );
    }
}

#[test]
fn property_display_is_injective_and_ordered() {
    let mut rng = Rng(SEED + 3);
    for _ in 0..1000 {
        let decimals = rng.below(21) as u8;
        let f = AmountFormat::new(decimals);
        let v = u128::from(rng.next()) * u128::from(rng.next());
        let a = f.display_u128(v).unwrap();
        let b = f.display_u128(v + 1).unwrap();
        assert_ne!(a, b, "seed {}: {v} d={decimals}", SEED + 3);
        let pa: u128 = f.parse(&a).unwrap().parse().unwrap();
        let pb: u128 = f.parse(&b).unwrap().parse().unwrap();
        assert!(pa < pb, "seed {}: {v} d={decimals}", SEED + 3);
    }
}
