# @meantjs/format

Exact value conversion for the six value tags of Candid Profile v0 (`docs/profile-v0.md` §5.3): `amount`, `timestamp`, `duration`, `account`, `subaccount` and `bytes`. It turns the text a person or an agent writes (`"1.5 ICP"`, `"+PT24H"`, `"#7"`) into the value a call carries, and back into canonical text for display. The agent tools (`@meantjs/tools`) and the ICRC-21 consent generator (`@meantjs/consent`) both use it, so they cannot disagree about what a value means.

```sh
npm install @meantjs/format
```

- **Runs on:** Node 22 or later and browsers: no dependency, no I/O, no Node built-in.
- **Module format:** ES modules only, with hand-written TypeScript declarations for every entry.
- **Spec:** [Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md). **Licence:** Apache-2.0.
- **Versions:** the five Candid Profile packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`,
  `/reconcile`) release together under one version and pin each other exactly; in 0.x a minor is breaking,
  and so is any change to generated text ([releasing](https://github.com/B3Pay/Meant/blob/main/profile/docs/releasing.md)).

- **No rounding, ever** (ground rule 8, D-006): input with excess precision is rejected, a conversion that would lose precision throws, integers never pass through a JavaScript number.
- **No dependencies** at run time or for tests. Node >= 22.
- **No I/O.** Dynamic tag arguments (`{ "from": "query:icrc1_decimals" }`) are resolved by the caller and passed in.
- The choices it made where §5.3 was open were accepted as D-024 and are now in spec §5.3.
- **EVM types** (spec §15, experimental): a position of an EVM contract's resolved form (`{ abi: "uint256", tags }`)
  works like a Candid one. `amount` takes `uint8`…`uint256` and `int8`…`int256`, `timestamp` and `duration`
  `uint32`…`uint256` and `int64`…`int256`, each with the bounds of its bits; `bytes` takes `bytes` and `bytesN`
  (exactly N bytes). `amount`'s `threshold` and `message` show a value at or above the threshold as `Unlimited USDC`.

```sh
npm test -w packages/format          # or: npm test at the repo root
npm run vectors -w packages/format   # re-fetch the ICRC-1 examples (needs network; see below)
```

## API

The entry point for consumers:

```js
import { formatterFor } from "@meantjs/format";

// node = a position of the resolved form (fixtures/*.resolved.json): { candid, tags, ... }
const f = formatterFor(node, {
  refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }, // dynamic args, keyed by their `from`
  now: 1791547200000000000n,                                        // optional default clock, bigint ns
});
// f === null when the position has no value tag (render it as Candid text, spec §6)

f.tag;                       // "amount" | "timestamp" | "duration" | "account" | "subaccount" | "bytes"
f.args;                      // the tag's arguments with refs resolved, e.g. { decimals: 8, symbol: "ICP" }
f.parse("1.5 ICP");          // -> "150000000"   (throws FormatError)
f.display("150000000");      // -> "1.5 ICP"     (throws FormatError)
f.safeParse(input, { now }); // -> { ok: true, value } | { ok: false, error: { code, message } }
f.safeDisplay(value);        // same shape
f.describe();                // -> { summary, examples, pattern? }: the text this position reads, in words
```

`describe()` gives a form hint or a tool input's description from the parser itself, so they cannot drift from it (#16). The summary is the grammar in words with the tag's resolved arguments filled in ("at most 8 digits after the point", the symbol), then "For example" and exactly the examples kept. Every kept example parses at this position: one a range or `max_len` refuses is left out (and the summary then quotes none), and a relative time is checked against the formatter's `now` when it was given one, else against a fixed instant, since describing reads no clock. `pattern` (amount and subaccount only, whose grammar is regular) is an ECMAScript regular expression for a JSON Schema `pattern`, valid under the `u` flag. It is a necessary condition only: everything `parse` accepts matches it, and a match can still be refused for its range. `describeInput(tag, args, candid, { accepts })` is the same without a formatter: it refuses the arguments and Candid types `formatterFor` refuses, with the same codes, and keeps the examples `accepts` returns true for (all, by default).

`formatterFor` throws a `FormatError` (never returns a half-working formatter) when a ref is missing (`E_REF_UNRESOLVED`), a tag argument is invalid (`E_ARG`), the tag does not apply to the node's Candid type (`E_TAG_TYPE`) or the position carries two value tags (`E_TAG_CONFLICT`). `opt` is the node's `optional` flag: handle absence before calling the formatter.

The same functions are exported directly: `parseAmount`, `displayAmount`, `parseTimestamp`, `displayTimestamp`, `parseDuration`, `displayDuration`, `convertUnit`, `alignNow`, `parseAccount`, `displayAccount`, `principalFromText`, `principalToText`, `parseSubaccount`, `displaySubaccount`, `parseBytes`, `displayBytes`, `VALUE_TAGS`, `describeInput`, `CODES`, `FormatError`.

### Values

| Tag | `parse` returns / `display` takes | Options |
|---|---|---|
| `amount` | base-unit integer as a decimal string (a bigint is accepted by `display`; a number is rejected) | `decimals`, `symbol`, `candid` (sign and range) |
| `timestamp` | integer count of `unit` since the Unix epoch, decimal string | `unit` (`ns` `us` `ms` `s`), `candid`, `now` (bigint ns, relative input only) |
| `duration` | integer count of `unit`, decimal string | `unit`, `candid` |
| `account` | `{ owner: <principal text>, subaccount: Uint8Array(32) \| null }`, `null` = the default subaccount | |
| `subaccount` | `Uint8Array(32)` | |
| `bytes` | `Uint8Array` | `encoding` (`utf8` `hex` `base64`), `maxLen` (the tag's `max_len`, bytes) |

Wherever a `Uint8Array` is taken, one made in another realm (an iframe, a `node:vm` context, a test environment's
`TextEncoder`) is accepted too, read through its typed-array slot; other typed arrays, `DataView`s and look-alike
objects are refused with `E_TYPE`, and so are a `Proxy` around a `Uint8Array` (it passed `instanceof` before) and
a view of a detached buffer. A foreign view's memory is read through the intrinsic typed-array getters, so its own
properties cannot make it show other bytes. The library imports no Node built-in (`test/browser-bundle.test.mjs`). The check is exported as `asUint8Array(value)`: the value as a `Uint8Array` of this realm viewing the same memory, or `null`. `@meantjs/consent` and `@meantjs/tools` use it, so the three packages agree on what bytes are.

Other helpers: `convertUnit(value, from, to)` converts an integer between units and throws `E_INEXACT` when it would lose precision (W4: a ns timestamp with sub-second digits does not fit ICRC-21's `TimestampSeconds`; catch it and fall back to `Text`). `alignNow(nowNs, unit)` floors a clock reading to a unit. `parseTimestamp` already does this to `now` before adding a relative duration (spec §5.3, D-024), so `+PT24H` on a `unit: s` field is exact; `alignNow` is exported for callers that want the aligned value themselves.

### Errors

Every rejection is a `FormatError` with a stable `code` and a message that says how to fix the input. Codes: `E_TYPE` `E_SYNTAX` `E_RANGE` `E_TOO_LONG` `E_ARG` `E_TAG_TYPE` `E_TAG_CONFLICT` `E_REF_UNRESOLVED` `E_EXCESS_PRECISION` `E_NEGATIVE` `E_SYMBOL_MISMATCH` `E_INEXACT` `E_CALENDAR_UNIT` `E_NEEDS_NOW` `E_CHECKSUM` `E_CHECKSUM_MISSING` `E_NOT_CANONICAL` `E_PRINCIPAL` `E_HEX` `E_BASE64` `E_UTF8` `E_LENGTH` `E_MAX_LEN` (`CODES` lists them with their meaning).

## Rules and where they are tested

| Spec §5.3 rule | Behavior | Test (`test/rejections.test.mjs` unless noted) |
|---|---|---|
| amount: more than `d` fractional digits is rejected, never rounded | `E_EXCESS_PRECISION` (also for trailing zeros, proposal F1) | "amount: input with more than d fractional digits…"; property in `amount.test.mjs` |
| amount: negative rejected unless signed | `E_NEGATIVE` | "amount: negative input…" |
| amount: symbol must match, case-insensitive | `E_SYMBOL_MISMATCH` | "amount: a symbol that does not match…" |
| timestamp: conversion to the unit is exact (an absolute time or a duration finer than the unit) | `E_INEXACT` | "timestamp: a conversion… is not exact"; properties in `time.test.mjs` |
| timestamp: relative input is resolved against `now` floored to the unit | | "timestamp: a relative time is resolved against now floored…" |
| timestamp: relative input follows the duration rules | `E_CALENDAR_UNIT`, `E_NEEDS_NOW` | "timestamp: relative input…" (two tests) |
| duration: only W, D, H, M (after T), S | `E_SYNTAX` | "duration: only W, D, H, M…" |
| duration: `P1Y`, `P1M` rejected | `E_CALENDAR_UNIT` | "duration: calendar years and months…" |
| duration: `P1D` is exactly 86,400 s | | "duration: P1D is exactly 86,400 s" |
| account: checksum verified on input | `E_CHECKSUM`, `E_CHECKSUM_MISSING` | "account: the checksum is verified on input"; the ICRC-1 vectors in `account.test.mjs` |
| subaccount: `0 <= n < 2^64` | `E_RANGE` | "subaccount: a decimal n outside…" |
| subaccount: hex is exactly 64 characters | `E_LENGTH` | "subaccount: a hex form with other than exactly 64…" |
| subaccount: `parse(display(x)) = x` for every 32-byte value | | edge values in `rejections.test.mjs`; property over 20,000 random values in `subaccount.test.mjs` |
| subaccount: display is `#n` iff the first 24 bytes are zero | | "subaccount: display is #n if and only if…" and the same property |
| bytes: `max_len` counts bytes after encoding | `E_MAX_LEN` | "bytes: max_len counts bytes after encoding…" |
| bytes: utf8 input starting with `0x` is hex | `E_HEX` for malformed hex | "bytes: utf8 input starting with 0x is hex…" |
| §4 / D-006: integers are never JavaScript numbers | `E_TYPE` | "an integer is never a JavaScript number…" |

## Why no principal library

`principalFromText` and the ICRC-1 checksum need base32 and CRC-32. Options considered:

- `@dfinity/principal` 3.4.3: tiny (one dependency, `@noble/hashes`), but **deprecated** on npm in favour of `@icp-sdk/core`, which would put a deprecation warning on every `npm ci`.
- `@icp-sdk/core` 6.1.0: the supported package, but 2.2 MB unpacked with six direct dependencies (asn1js, two `@scure` BIP packages, `@dfinity/cbor`, `@noble/curves`, `@noble/hashes`) for a feature that is ~60 lines. It also pulls key-handling code into a package whose point is to be small enough to review.
- **Chosen: implement it** in `src/principal.mjs` (base32 lowercase without padding, CRC-32 with the zlib polynomial, the canonical-dashes rule), with zero dependencies, and check it three ways:
  1. the 7 official ICRC-1 parse examples and 3 `toText` examples, well-known canister ids (`aaaaa-aa`, `2vxsx-fae`, the ICP ledger, NNS governance and registry);
  2. independent oracles in the tests: CRC-32 from `node:zlib`, and a base32 encoder built on big-integer division (a different algorithm from the bit shifter in `src`), compared on thousands of random principals and accounts; plus a property that **every single-character change** to a canonical account text is rejected;
  3. a one-off differential run against `@dfinity/principal` 3.4.3 (installed temporarily, removed again): 60,000 random principals of 0 to 29 bytes, text and bytes in both directions, 0 mismatches. This is **not** in the suite, so it is not reproducible from the repo; the suite's oracles are.

## ICRC-1 test vectors

`test/vectors/icrc1-textual-encoding.json` holds the examples of the ICRC-1 textual encoding standard, extracted by `scripts/fetch-icrc1-vectors.mjs` from `standards/ICRC-1/TextualEncoding.md` of github.com/dfinity/ICRC-1 at commit `5d670e54d9a58fbf472bf0a25f33743d60cfd0e6` (head of `main` on 2026-10-09; Apache-2.0). The download itself, with its LICENSE, `SOURCE.json` (commit, URLs, sha256) lives alone in `upstream/icrc1/`.

The download is **untrusted data**: the script only reads it as text and extracts fields with fixed regular expressions (and aborts if the shape changes), nothing from `upstream/` is ever imported or executed, and the tests read the committed JSON, never the network. A test checks that the recorded sha256 matches the committed bytes and that every vector appears in the document. To move to another commit: `node scripts/fetch-icrc1-vectors.mjs --commit <40-hex sha>`, review the diff of `upstream/` and the vectors, update `PINNED` in the script.

## Design notes

- **Integers are decimal strings or bigints** (D-006). Nanosecond timestamps (~1.8e18) and 18-decimal amounts exceed 2^53; a JavaScript number is rejected on input and on display.
- **Calendar math is in BigInt nanoseconds** with the proleptic Gregorian calendar (days-from-civil), not `Date` (millisecond precision). Tests compare against `Date` for millisecond instants and zones.
- **Display is canonical and total**: it throws on a value that does not fit the Candid type or the calendar instead of producing something misleading.
- **Untrusted text**: lengths are bounded (1024 characters; 4 MiB for `bytes`), regular expressions are anchored and linear, symbols from a canister's `icrc1_symbol` are checked for control and invisible characters before use.
- **Escaping is not done here.** `display` returns plain text; a memo can contain Markdown. The template renderer escapes values for its target format (spec §6).
- **Property tests** use a seeded PRNG (`test/helpers/prng.mjs`, default seed 20261009, override with `FORMAT_TEST_SEED`); every failure message carries the seed.
