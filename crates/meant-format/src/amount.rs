use alloc::format;
use alloc::string::{String, ToString};

use crate::int_type::{check_range, Decimal};
use crate::text::{is_js_whitespace, is_unsafe_display, js_trim, json_quote, too_long};
use crate::{Code, FormatError, IntType, MAX_INPUT_UTF16_LEN};

/// The `amount` tag at one position: how many decimals the token has, its
/// symbol if any, and the Candid integer type the position holds.
///
/// Base-unit values are canonical decimal strings (`"150000000"`, `"-125"`),
/// never floats, so an amount of any size converts exactly.
///
/// ```
/// use meant_format::{AmountFormat, IntType};
///
/// let usdc = AmountFormat::new(6).with_symbol("USDC")?.with_candid(IntType::Nat64);
/// assert_eq!(usdc.parse("1.5 usdc")?, "1500000");
/// assert_eq!(usdc.display_u128(1_500_000)?, "1.5 USDC");
/// # Ok::<(), meant_format::FormatError>(())
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AmountFormat {
    decimals: u8,
    symbol: Option<String>,
    candid: IntType,
}

/// The pieces of `-?[0-9]+(\.[0-9]+)?(\s+\S(.*\S)?)?`, matched against
/// trimmed text.
struct Parts<'a> {
    negative: bool,
    whole: &'a str,
    fraction: &'a str,
    symbol: Option<&'a str>,
}

fn digits_end(bytes: &[u8], from: usize) -> usize {
    from + bytes[from..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count()
}

fn split(text: &str) -> Option<Parts<'_>> {
    let bytes = text.as_bytes();
    let negative = bytes.first() == Some(&b'-');
    let whole_start = usize::from(negative);
    let mut end = digits_end(bytes, whole_start);
    if end == whole_start {
        return None;
    }
    let whole = &text[whole_start..end];
    let mut fraction = "";
    if bytes.get(end) == Some(&b'.') {
        let fraction_end = digits_end(bytes, end + 1);
        if fraction_end == end + 1 {
            return None;
        }
        fraction = &text[end + 1..fraction_end];
        end = fraction_end;
    }
    let rest = &text[end..];
    if rest.is_empty() {
        return Some(Parts {
            negative,
            whole,
            fraction,
            symbol: None,
        });
    }
    let symbol = rest.trim_start_matches(is_js_whitespace);
    if symbol.len() == rest.len() || symbol.is_empty() {
        return None;
    }
    Some(Parts {
        negative,
        whole,
        fraction,
        symbol: Some(symbol),
    })
}

impl AmountFormat {
    /// A token with `decimals` decimals, no symbol, at a `nat` position.
    pub fn new(decimals: u8) -> Self {
        Self {
            decimals,
            symbol: None,
            candid: IntType::Nat,
        }
    }

    /// Sets the token's symbol, which `display` appends and `parse` accepts.
    ///
    /// The symbol must be 1 to 32 characters, with no surrounding whitespace
    /// and no control or invisible characters (Unicode categories Cc, Cf, Zl
    /// and Zp), since it is shown to the person approving a call. Otherwise
    /// the error is [`Code::Arg`].
    pub fn with_symbol(mut self, symbol: &str) -> Result<Self, FormatError> {
        let count = symbol.chars().count();
        if !(1..=32).contains(&count) {
            return Err(FormatError::new(
                Code::Arg,
                format!("amount symbol must be 1 to 32 characters, got {count}"),
            ));
        }
        if js_trim(symbol) != symbol || symbol.chars().any(is_unsafe_display) {
            return Err(FormatError::new(
                Code::Arg,
                format!(
                    "amount symbol {} has surrounding whitespace, control or invisible characters",
                    json_quote(symbol)
                ),
            ));
        }
        self.symbol = Some(String::from(symbol));
        Ok(self)
    }

    /// Sets the Candid integer type of the position, which bounds the value
    /// and decides whether it may be negative.
    pub fn with_candid(mut self, candid: IntType) -> Self {
        self.candid = candid;
        self
    }

    /// [`with_candid`](Self::with_candid) by Candid name, as a resolved
    /// profile spells it. A name that is not an integer type is
    /// [`Code::TagType`].
    pub fn with_candid_name(self, name: &str) -> Result<Self, FormatError> {
        match IntType::from_candid_name(name) {
            Some(candid) => Ok(self.with_candid(candid)),
            None => Err(FormatError::new(
                Code::TagType,
                format!(
                    "the amount tag applies to nat, int, nat8, nat16, nat32, nat64, int8, int16, int32, int64, not {name}"
                ),
            )),
        }
    }

    /// The token's decimals.
    pub fn decimals(&self) -> u8 {
        self.decimals
    }

    /// The token's symbol, if it has one.
    pub fn symbol(&self) -> Option<&str> {
        self.symbol.as_deref()
    }

    /// The Candid integer type of the position.
    pub fn candid(&self) -> IntType {
        self.candid
    }

    /// Reads an amount a person wrote, such as `"1.5"` or `"1.5 ICP"`, and
    /// returns the exact base-unit value as a canonical decimal string.
    ///
    /// Accepted: an optional `-`, digits, optionally a `.` with digits after
    /// it, and optionally whitespace and the token's symbol (ASCII letters in
    /// any case). Surrounding whitespace is ignored. Refused, never rounded or
    /// guessed:
    ///
    /// - thousands separators, exponents, a leading `+`, `"1."` or `".5"`:
    ///   [`Code::Syntax`];
    /// - more fractional digits than `decimals`, even zeros:
    ///   [`Code::ExcessPrecision`];
    /// - a minus sign at an unsigned position: [`Code::Negative`];
    /// - a symbol that is not the token's, or any symbol when the token has
    ///   none: [`Code::SymbolMismatch`];
    /// - a value outside the Candid type: [`Code::Range`];
    /// - text longer than [`MAX_INPUT_UTF16_LEN`]: [`Code::TooLong`].
    ///
    /// ```
    /// use meant_format::{AmountFormat, Code, IntType};
    ///
    /// let eth = AmountFormat::new(18).with_symbol("ckETH")?;
    /// assert_eq!(eth.parse("1.000000000000000001")?, "1000000000000000001");
    ///
    /// let byte = AmountFormat::new(0).with_candid(IntType::Nat8);
    /// assert_eq!(byte.parse("256").unwrap_err().code(), Code::Range);
    /// # Ok::<(), meant_format::FormatError>(())
    /// ```
    pub fn parse(&self, input: &str) -> Result<String, FormatError> {
        if too_long(input) {
            return Err(FormatError::new(
                Code::TooLong,
                format!("amount is longer than {MAX_INPUT_UTF16_LEN} characters"),
            ));
        }
        let text = js_trim(input);
        let Some(parts) = split(text) else {
            let with_symbol = match &self.symbol {
                Some(symbol) => format!(" or \"1.5 {symbol}\""),
                None => String::new(),
            };
            return Err(FormatError::new(
                Code::Syntax,
                format!(
                    "cannot read {} as an amount: write digits with an optional decimal point, for example \"1.5\"{with_symbol}; no thousands separators, exponents or signs other than \"-\"",
                    json_quote(text)
                ),
            ));
        };
        if parts.negative && !self.candid.is_signed() {
            return Err(FormatError::new(
                Code::Negative,
                format!(
                    "negative amounts are not allowed here (the Candid type {} is unsigned)",
                    self.candid.candid_name()
                ),
            ));
        }
        if let Some(given) = parts.symbol {
            match &self.symbol {
                None => {
                    return Err(FormatError::new(
                        Code::SymbolMismatch,
                        format!(
                            "this amount has no symbol; remove \"{given}\" and give the number only"
                        ),
                    ))
                }
                Some(expected) if !given.eq_ignore_ascii_case(expected) => {
                    return Err(FormatError::new(
                        Code::SymbolMismatch,
                        format!("the symbol \"{given}\" is not this token's symbol \"{expected}\""),
                    ))
                }
                Some(_) => {}
            }
        }
        let decimals = usize::from(self.decimals);
        if parts.fraction.len() > decimals {
            return Err(FormatError::new(
                Code::ExcessPrecision,
                format!(
                    "{} has {} fractional digits but this token has {decimals}; amounts are never rounded, so give at most {decimals}",
                    json_quote(text),
                    parts.fraction.len()
                ),
            ));
        }

        // whole × 10^d + fraction padded to d digits, which on decimal digits
        // is concatenation: no multiplication, so no size limit and no float.
        let mut digits = String::with_capacity(parts.whole.len() + decimals);
        digits.push_str(parts.whole);
        digits.push_str(parts.fraction);
        for _ in parts.fraction.len()..decimals {
            digits.push('0');
        }
        let trimmed = digits.trim_start_matches('0');
        let magnitude = if trimmed.is_empty() { "0" } else { trimmed };
        let value = Decimal {
            negative: parts.negative && magnitude != "0",
            magnitude,
        };
        check_range(value, self.candid, "amount")?;
        Ok(value.to_text())
    }

    /// Shows a base-unit value as a person reads it: the decimal point placed
    /// by `decimals`, trailing fractional zeros removed, then a space and the
    /// symbol if the token has one. `"150000000"` with 8 decimals is
    /// `"1.5 ICP"`.
    ///
    /// `base_units` must be a canonical decimal integer (no leading zeros, no
    /// `+`, no `"-0"`, no separators) or the error is [`Code::Syntax`]; that
    /// rules out `candid::Nat`'s `Display`, which writes `1_500_000`. A value
    /// outside the Candid type is [`Code::Range`].
    pub fn display(&self, base_units: &str) -> Result<String, FormatError> {
        if too_long(base_units) {
            return Err(FormatError::new(
                Code::TooLong,
                String::from("amount is too long"),
            ));
        }
        let Some(value) = Decimal::canonical(base_units) else {
            let message = if base_units == "-0" {
                String::from("amount must not be \"-0\"")
            } else {
                format!(
                    "amount must be a canonical decimal integer string, got {}",
                    json_quote(base_units)
                )
            };
            return Err(FormatError::new(Code::Syntax, message));
        };
        check_range(value, self.candid, "amount")?;

        let decimals = usize::from(self.decimals);
        let magnitude = value.magnitude;
        let mut padded = String::with_capacity(decimals + 1);
        for _ in magnitude.len()..decimals + 1 {
            padded.push('0');
        }
        padded.push_str(magnitude);
        let (whole, fraction) = padded.split_at(padded.len() - decimals);
        let fraction = fraction.trim_end_matches('0');

        let mut out = String::with_capacity(padded.len() + 2);
        if value.negative {
            out.push('-');
        }
        out.push_str(whole);
        if !fraction.is_empty() {
            out.push('.');
            out.push_str(fraction);
        }
        if let Some(symbol) = &self.symbol {
            out.push(' ');
            out.push_str(symbol);
        }
        Ok(out)
    }

    /// [`display`](Self::display) for a value held as `u128`.
    pub fn display_u128(&self, base_units: u128) -> Result<String, FormatError> {
        self.display(&base_units.to_string())
    }

    /// [`display`](Self::display) for a value held as `i128`.
    pub fn display_i128(&self, base_units: i128) -> Result<String, FormatError> {
        self.display(&base_units.to_string())
    }
}
