use alloc::format;
use alloc::string::String;
use core::cmp::Ordering;

use crate::{Code, FormatError};

/// Defines [`IntType`] from one row per type: its variant and docs, its name
/// as a resolved profile spells it, its sign, its family and its inclusive
/// bounds as decimal strings (`None` is unbounded).
macro_rules! int_types {
    ($(
        $(#[doc = $doc:literal])*
        $variant:ident = $name:literal, $sign:ident, $family:ident, $min:expr, $max:expr;
    )*) => {
        /// The integer types the `amount` tag applies to: Candid's, then the
        /// EVM ABI's `uint8` to `uint256` and `int8` to `int256` (Candid
        /// Profile v0 §15).
        ///
        /// `int8`, `int16`, `int32` and `int64` are both Candid and ABI types,
        /// with the same bounds, so each appears once, as the Candid type.
        /// More types may come, so the enum is `#[non_exhaustive]`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum IntType {
            $($(#[doc = $doc])* $variant,)*
        }

        impl IntType {
            /// Every type, in the reference's order: the ten Candid types,
            /// then the ABI's by width, `uint` before `int`.
            pub const ALL: &'static [IntType] = &[$(IntType::$variant),*];

            /// The name as a resolved profile spells it: the Candid name, such
            /// as `"nat64"`, or the ABI name, such as `"uint256"`.
            pub const fn candid_name(self) -> &'static str {
                match self {
                    $(IntType::$variant => $name,)*
                }
            }

            /// Whether the type admits negative values.
            pub const fn is_signed(self) -> bool {
                match self {
                    $(IntType::$variant => int_types!(@signed $sign),)*
                }
            }

            /// Whether the type is the EVM ABI's alone, which messages name
            /// "the ABI type" rather than "the Candid type".
            pub(crate) const fn is_abi(self) -> bool {
                match self {
                    $(IntType::$variant => int_types!(@abi $family),)*
                }
            }

            /// The inclusive bounds as decimal strings; `None` is unbounded.
            const fn bounds(self) -> (Option<&'static str>, Option<&'static str>) {
                match self {
                    $(IntType::$variant => ($min, $max),)*
                }
            }
        }
    };
    (@signed signed) => { true };
    (@signed unsigned) => { false };
    (@abi abi) => { true };
    (@abi candid) => { false };
}

int_types! {
    /// `nat`: unbounded, non-negative.
    Nat = "nat", unsigned, candid, Some("0"), None;
    /// `int`: unbounded, signed.
    Int = "int", signed, candid, None, None;
    /// `nat8`: 0 to 255.
    Nat8 = "nat8", unsigned, candid, Some("0"), Some("255");
    /// `nat16`: 0 to 65535.
    Nat16 = "nat16", unsigned, candid, Some("0"), Some("65535");
    /// `nat32`: 0 to 2^32 − 1.
    Nat32 = "nat32", unsigned, candid, Some("0"), Some("4294967295");
    /// `nat64`: 0 to 2^64 − 1.
    Nat64 = "nat64", unsigned, candid, Some("0"), Some("18446744073709551615");
    /// `int8`: −128 to 127.
    Int8 = "int8", signed, candid, Some("-128"), Some("127");
    /// `int16`: −2^15 to 2^15 − 1.
    Int16 = "int16", signed, candid, Some("-32768"), Some("32767");
    /// `int32`: −2^31 to 2^31 − 1.
    Int32 = "int32", signed, candid, Some("-2147483648"), Some("2147483647");
    /// `int64`: −2^63 to 2^63 − 1.
    Int64 = "int64", signed, candid, Some("-9223372036854775808"), Some("9223372036854775807");
    /// `uint8`: 0 to 2^8 − 1 (EVM ABI).
    Uint8 = "uint8", unsigned, abi, Some("0"), Some("255");
    /// `uint16`: 0 to 2^16 − 1 (EVM ABI).
    Uint16 = "uint16", unsigned, abi, Some("0"), Some("65535");
    /// `uint24`: 0 to 2^24 − 1 (EVM ABI).
    Uint24 = "uint24", unsigned, abi, Some("0"), Some("16777215");
    /// `int24`: −2^23 to 2^23 − 1 (EVM ABI).
    Int24 = "int24", signed, abi, Some("-8388608"), Some("8388607");
    /// `uint32`: 0 to 2^32 − 1 (EVM ABI).
    Uint32 = "uint32", unsigned, abi, Some("0"), Some("4294967295");
    /// `uint40`: 0 to 2^40 − 1 (EVM ABI).
    Uint40 = "uint40", unsigned, abi, Some("0"), Some("1099511627775");
    /// `int40`: −2^39 to 2^39 − 1 (EVM ABI).
    Int40 = "int40", signed, abi, Some("-549755813888"), Some("549755813887");
    /// `uint48`: 0 to 2^48 − 1 (EVM ABI).
    Uint48 = "uint48", unsigned, abi, Some("0"), Some("281474976710655");
    /// `int48`: −2^47 to 2^47 − 1 (EVM ABI).
    Int48 = "int48", signed, abi, Some("-140737488355328"), Some("140737488355327");
    /// `uint56`: 0 to 2^56 − 1 (EVM ABI).
    Uint56 = "uint56", unsigned, abi, Some("0"), Some("72057594037927935");
    /// `int56`: −2^55 to 2^55 − 1 (EVM ABI).
    Int56 = "int56", signed, abi, Some("-36028797018963968"), Some("36028797018963967");
    /// `uint64`: 0 to 2^64 − 1 (EVM ABI).
    Uint64 = "uint64", unsigned, abi, Some("0"), Some("18446744073709551615");
    /// `uint72`: 0 to 2^72 − 1 (EVM ABI).
    Uint72 = "uint72", unsigned, abi, Some("0"), Some("4722366482869645213695");
    /// `int72`: −2^71 to 2^71 − 1 (EVM ABI).
    Int72 = "int72", signed, abi, Some("-2361183241434822606848"), Some("2361183241434822606847");
    /// `uint80`: 0 to 2^80 − 1 (EVM ABI).
    Uint80 = "uint80", unsigned, abi, Some("0"), Some("1208925819614629174706175");
    /// `int80`: −2^79 to 2^79 − 1 (EVM ABI).
    Int80 = "int80", signed, abi, Some("-604462909807314587353088"), Some("604462909807314587353087");
    /// `uint88`: 0 to 2^88 − 1 (EVM ABI).
    Uint88 = "uint88", unsigned, abi, Some("0"), Some("309485009821345068724781055");
    /// `int88`: −2^87 to 2^87 − 1 (EVM ABI).
    Int88 = "int88", signed, abi, Some("-154742504910672534362390528"), Some("154742504910672534362390527");
    /// `uint96`: 0 to 2^96 − 1 (EVM ABI).
    Uint96 = "uint96", unsigned, abi, Some("0"), Some("79228162514264337593543950335");
    /// `int96`: −2^95 to 2^95 − 1 (EVM ABI).
    Int96 = "int96", signed, abi, Some("-39614081257132168796771975168"), Some("39614081257132168796771975167");
    /// `uint104`: 0 to 2^104 − 1 (EVM ABI).
    Uint104 = "uint104", unsigned, abi, Some("0"), Some("20282409603651670423947251286015");
    /// `int104`: −2^103 to 2^103 − 1 (EVM ABI).
    Int104 = "int104", signed, abi, Some("-10141204801825835211973625643008"), Some("10141204801825835211973625643007");
    /// `uint112`: 0 to 2^112 − 1 (EVM ABI).
    Uint112 = "uint112", unsigned, abi, Some("0"), Some("5192296858534827628530496329220095");
    /// `int112`: −2^111 to 2^111 − 1 (EVM ABI).
    Int112 = "int112", signed, abi, Some("-2596148429267413814265248164610048"), Some("2596148429267413814265248164610047");
    /// `uint120`: 0 to 2^120 − 1 (EVM ABI).
    Uint120 = "uint120", unsigned, abi, Some("0"), Some("1329227995784915872903807060280344575");
    /// `int120`: −2^119 to 2^119 − 1 (EVM ABI).
    Int120 = "int120", signed, abi, Some("-664613997892457936451903530140172288"), Some("664613997892457936451903530140172287");
    /// `uint128`: 0 to 2^128 − 1 (EVM ABI).
    Uint128 = "uint128", unsigned, abi, Some("0"), Some("340282366920938463463374607431768211455");
    /// `int128`: −2^127 to 2^127 − 1 (EVM ABI).
    Int128 = "int128", signed, abi, Some("-170141183460469231731687303715884105728"), Some("170141183460469231731687303715884105727");
    /// `uint136`: 0 to 2^136 − 1 (EVM ABI).
    Uint136 = "uint136", unsigned, abi, Some("0"), Some("87112285931760246646623899502532662132735");
    /// `int136`: −2^135 to 2^135 − 1 (EVM ABI).
    Int136 = "int136", signed, abi, Some("-43556142965880123323311949751266331066368"), Some("43556142965880123323311949751266331066367");
    /// `uint144`: 0 to 2^144 − 1 (EVM ABI).
    Uint144 = "uint144", unsigned, abi, Some("0"), Some("22300745198530623141535718272648361505980415");
    /// `int144`: −2^143 to 2^143 − 1 (EVM ABI).
    Int144 = "int144", signed, abi, Some("-11150372599265311570767859136324180752990208"), Some("11150372599265311570767859136324180752990207");
    /// `uint152`: 0 to 2^152 − 1 (EVM ABI).
    Uint152 = "uint152", unsigned, abi, Some("0"), Some("5708990770823839524233143877797980545530986495");
    /// `int152`: −2^151 to 2^151 − 1 (EVM ABI).
    Int152 = "int152", signed, abi, Some("-2854495385411919762116571938898990272765493248"), Some("2854495385411919762116571938898990272765493247");
    /// `uint160`: 0 to 2^160 − 1 (EVM ABI).
    Uint160 = "uint160", unsigned, abi, Some("0"), Some("1461501637330902918203684832716283019655932542975");
    /// `int160`: −2^159 to 2^159 − 1 (EVM ABI).
    Int160 = "int160", signed, abi, Some("-730750818665451459101842416358141509827966271488"), Some("730750818665451459101842416358141509827966271487");
    /// `uint168`: 0 to 2^168 − 1 (EVM ABI).
    Uint168 = "uint168", unsigned, abi, Some("0"), Some("374144419156711147060143317175368453031918731001855");
    /// `int168`: −2^167 to 2^167 − 1 (EVM ABI).
    Int168 = "int168", signed, abi, Some("-187072209578355573530071658587684226515959365500928"), Some("187072209578355573530071658587684226515959365500927");
    /// `uint176`: 0 to 2^176 − 1 (EVM ABI).
    Uint176 = "uint176", unsigned, abi, Some("0"), Some("95780971304118053647396689196894323976171195136475135");
    /// `int176`: −2^175 to 2^175 − 1 (EVM ABI).
    Int176 = "int176", signed, abi, Some("-47890485652059026823698344598447161988085597568237568"), Some("47890485652059026823698344598447161988085597568237567");
    /// `uint184`: 0 to 2^184 − 1 (EVM ABI).
    Uint184 = "uint184", unsigned, abi, Some("0"), Some("24519928653854221733733552434404946937899825954937634815");
    /// `int184`: −2^183 to 2^183 − 1 (EVM ABI).
    Int184 = "int184", signed, abi, Some("-12259964326927110866866776217202473468949912977468817408"), Some("12259964326927110866866776217202473468949912977468817407");
    /// `uint192`: 0 to 2^192 − 1 (EVM ABI).
    Uint192 = "uint192", unsigned, abi, Some("0"), Some("6277101735386680763835789423207666416102355444464034512895");
    /// `int192`: −2^191 to 2^191 − 1 (EVM ABI).
    Int192 = "int192", signed, abi, Some("-3138550867693340381917894711603833208051177722232017256448"), Some("3138550867693340381917894711603833208051177722232017256447");
    /// `uint200`: 0 to 2^200 − 1 (EVM ABI).
    Uint200 = "uint200", unsigned, abi, Some("0"), Some("1606938044258990275541962092341162602522202993782792835301375");
    /// `int200`: −2^199 to 2^199 − 1 (EVM ABI).
    Int200 = "int200", signed, abi, Some("-803469022129495137770981046170581301261101496891396417650688"), Some("803469022129495137770981046170581301261101496891396417650687");
    /// `uint208`: 0 to 2^208 − 1 (EVM ABI).
    Uint208 = "uint208", unsigned, abi, Some("0"), Some("411376139330301510538742295639337626245683966408394965837152255");
    /// `int208`: −2^207 to 2^207 − 1 (EVM ABI).
    Int208 = "int208", signed, abi, Some("-205688069665150755269371147819668813122841983204197482918576128"), Some("205688069665150755269371147819668813122841983204197482918576127");
    /// `uint216`: 0 to 2^216 − 1 (EVM ABI).
    Uint216 = "uint216", unsigned, abi, Some("0"), Some("105312291668557186697918027683670432318895095400549111254310977535");
    /// `int216`: −2^215 to 2^215 − 1 (EVM ABI).
    Int216 = "int216", signed, abi, Some("-52656145834278593348959013841835216159447547700274555627155488768"), Some("52656145834278593348959013841835216159447547700274555627155488767");
    /// `uint224`: 0 to 2^224 − 1 (EVM ABI).
    Uint224 = "uint224", unsigned, abi, Some("0"), Some("26959946667150639794667015087019630673637144422540572481103610249215");
    /// `int224`: −2^223 to 2^223 − 1 (EVM ABI).
    Int224 = "int224", signed, abi, Some("-13479973333575319897333507543509815336818572211270286240551805124608"), Some("13479973333575319897333507543509815336818572211270286240551805124607");
    /// `uint232`: 0 to 2^232 − 1 (EVM ABI).
    Uint232 = "uint232", unsigned, abi, Some("0"), Some("6901746346790563787434755862277025452451108972170386555162524223799295");
    /// `int232`: −2^231 to 2^231 − 1 (EVM ABI).
    Int232 = "int232", signed, abi, Some("-3450873173395281893717377931138512726225554486085193277581262111899648"), Some("3450873173395281893717377931138512726225554486085193277581262111899647");
    /// `uint240`: 0 to 2^240 − 1 (EVM ABI).
    Uint240 = "uint240", unsigned, abi, Some("0"), Some("1766847064778384329583297500742918515827483896875618958121606201292619775");
    /// `int240`: −2^239 to 2^239 − 1 (EVM ABI).
    Int240 = "int240", signed, abi, Some("-883423532389192164791648750371459257913741948437809479060803100646309888"), Some("883423532389192164791648750371459257913741948437809479060803100646309887");
    /// `uint248`: 0 to 2^248 − 1 (EVM ABI).
    Uint248 = "uint248", unsigned, abi, Some("0"), Some("452312848583266388373324160190187140051835877600158453279131187530910662655");
    /// `int248`: −2^247 to 2^247 − 1 (EVM ABI).
    Int248 = "int248", signed, abi, Some("-226156424291633194186662080095093570025917938800079226639565593765455331328"), Some("226156424291633194186662080095093570025917938800079226639565593765455331327");
    /// `uint256`: 0 to 2^256 − 1 (EVM ABI).
    Uint256 = "uint256", unsigned, abi, Some("0"), Some("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    /// `int256`: −2^255 to 2^255 − 1 (EVM ABI).
    Int256 = "int256", signed, abi, Some("-57896044618658097711785492504343953926634992332820282019728792003956564819968"), Some("57896044618658097711785492504343953926634992332820282019728792003956564819967");
}

impl IntType {
    /// The type with this exact name, Candid's or the ABI's, or `None`.
    /// Names are case-sensitive, as in Candid and Solidity.
    pub fn from_candid_name(name: &str) -> Option<Self> {
        IntType::ALL
            .iter()
            .copied()
            .find(|t| t.candid_name() == name)
    }

    /// How messages name the type: "ABI type" for the EVM ABI's own types,
    /// "Candid type" for the rest.
    pub(crate) const fn type_word(self) -> &'static str {
        if self.is_abi() {
            "ABI type"
        } else {
            "Candid type"
        }
    }
}

/// An integer held as a sign and canonical decimal digits: no leading zeros,
/// `"0"` for zero, and never a negative zero.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Decimal<'a> {
    pub(crate) negative: bool,
    pub(crate) magnitude: &'a str,
}

impl<'a> Decimal<'a> {
    /// Reads a canonical decimal integer (`-?(0|[1-9][0-9]*)`), refusing
    /// `"-0"`. Returns `None` for anything else.
    pub(crate) fn canonical(text: &'a str) -> Option<Self> {
        let (negative, digits) = match text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let bytes = digits.as_bytes();
        let canonical = !bytes.is_empty()
            && bytes.iter().all(u8::is_ascii_digit)
            && (bytes[0] != b'0' || bytes.len() == 1);
        if !canonical || (negative && digits == "0") {
            return None;
        }
        Some(Self {
            negative,
            magnitude: digits,
        })
    }

    pub(crate) fn to_text(self) -> String {
        if self.negative {
            format!("-{}", self.magnitude)
        } else {
            String::from(self.magnitude)
        }
    }

    pub(crate) fn cmp(self, other: Decimal<'_>) -> Ordering {
        let by_magnitude = self
            .magnitude
            .len()
            .cmp(&other.magnitude.len())
            .then_with(|| self.magnitude.cmp(other.magnitude));
        match (self.negative, other.negative) {
            (false, false) => by_magnitude,
            (true, true) => by_magnitude.reverse(),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
        }
    }
}

/// Refuses a value outside the type's range, in the reference's order: sign
/// first, then the minimum, then the maximum.
pub(crate) fn check_range(value: Decimal<'_>, ty: IntType, what: &str) -> Result<(), FormatError> {
    let word = ty.type_word();
    if !ty.is_signed() && value.negative {
        return Err(FormatError::new(
            Code::Range,
            format!(
                "{what} {} is negative but the {word} is unsigned",
                value.to_text()
            ),
        ));
    }
    let (min, max) = ty.bounds();
    if let Some(min) = min.and_then(Decimal::canonical) {
        if value.cmp(min) == Ordering::Less {
            return Err(FormatError::new(
                Code::Range,
                format!(
                    "{what} {} is below the minimum {} of the {word}",
                    value.to_text(),
                    min.to_text()
                ),
            ));
        }
    }
    if let Some(max) = max.and_then(Decimal::canonical) {
        if value.cmp(max) == Ordering::Greater {
            return Err(FormatError::new(
                Code::Range,
                format!(
                    "{what} {} is above the maximum {} of the {word}",
                    value.to_text(),
                    max.to_text()
                ),
            ));
        }
    }
    Ok(())
}
