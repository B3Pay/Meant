import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODES,
  FormatError,
  alignNow,
  convertUnit,
  displayDuration,
  displayTimestamp,
  parseDuration,
  parseTimestamp,
} from "../src/index.mjs";
import { SEED, makeRng } from "./helpers/prng.mjs";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};
const NS = { unit: "ns" };
const S = { unit: "s" };

test("timestamp: absolute RFC 3339 to each unit", () => {
  const t = "2026-10-09T12:00:00Z";
  assert.equal(parseTimestamp(t, { unit: "s" }), "1791547200");
  assert.equal(parseTimestamp(t, { unit: "ms" }), "1791547200000");
  assert.equal(parseTimestamp(t, { unit: "us" }), "1791547200000000");
  assert.equal(parseTimestamp(t, NS), "1791547200000000000");
  assert.equal(parseTimestamp("1970-01-01T00:00:00Z", NS), "0");
  assert.equal(parseTimestamp("2026-10-09T12:00:00.123456789Z", NS), "1791547200123456789");
  assert.equal(parseTimestamp("2026-10-09T12:00:00.5Z", { unit: "ms" }), "1791547200500");
});

test("timestamp: zones, lower-case letters, and the epoch of the clock", () => {
  assert.equal(parseTimestamp("2026-10-09T14:00:00+02:00", S), "1791547200");
  assert.equal(parseTimestamp("2026-10-09T05:30:00-06:30", S), "1791547200");
  assert.equal(parseTimestamp("2026-10-09T12:00:00-00:00", S), "1791547200");
  assert.equal(parseTimestamp("2026-10-09t12:00:00z", S), "1791547200");
  assert.equal(parseTimestamp(" 2026-10-09T12:00:00Z ", S), "1791547200");
  // a zone can move the instant across the epoch
  assert.equal(parseTimestamp("1970-01-01T00:00:00+00:01", { unit: "s", candid: "int" }), "-60");
});

test("timestamp: calendar edge cases", () => {
  assert.equal(parseTimestamp("2024-02-29T00:00:00Z", S), "1709164800");
  assert.equal(parseTimestamp("2000-02-29T00:00:00Z", S), "951782400");
  assert.equal(parseTimestamp("9999-12-31T23:59:59Z", { unit: "s", candid: "nat" }), "253402300799");
  assert.equal(parseTimestamp("0000-01-01T00:00:00Z", { unit: "s", candid: "int" }), "-62167219200");
  assert.equal(displayTimestamp("-62167219200", { unit: "s", candid: "int" }), "0000-01-01T00:00:00Z");
  assert.equal(displayTimestamp("253402300799", { unit: "s", candid: "nat" }), "9999-12-31T23:59:59Z");
  assert.equal(displayTimestamp("-1", { unit: "s", candid: "int" }), "1969-12-31T23:59:59Z");
  assert.equal(displayTimestamp("-1", { unit: "ns", candid: "int" }), "1969-12-31T23:59:59.999999999Z");
});

test("timestamp: display is canonical RFC 3339 UTC with a trimmed fraction", () => {
  assert.equal(displayTimestamp("1791547200", S), "2026-10-09T12:00:00Z");
  assert.equal(displayTimestamp("1791547200000000000", NS), "2026-10-09T12:00:00Z");
  assert.equal(displayTimestamp("1791547200500", { unit: "ms" }), "2026-10-09T12:00:00.5Z");
  assert.equal(displayTimestamp("1791547200000001", { unit: "us" }), "2026-10-09T12:00:00.000001Z");
  assert.equal(displayTimestamp(1791547200123456789n, NS), "2026-10-09T12:00:00.123456789Z");
  assert.equal(displayTimestamp("0", NS), "1970-01-01T00:00:00Z");
});

test("timestamp: relative input is resolved against the supplied now", () => {
  const now = 1791547200000000000n; // 2026-10-09T12:00:00Z
  assert.equal(parseTimestamp("+PT24H", { unit: "ns", now }), "1791633600000000000");
  assert.equal(parseTimestamp("+P1D", { unit: "ns", now }), "1791633600000000000");
  assert.equal(parseTimestamp("+P7D", { unit: "s", now }), "1792152000");
  assert.equal(parseTimestamp("+P1W", { unit: "s", now }), "1792152000");
  assert.equal(parseTimestamp("+PT0S", { unit: "s", now }), "1791547200");
  assert.equal(parseTimestamp("+P1DT2H3M4S", { unit: "s", now }), String(1791547200 + 86400 + 7200 + 180 + 4));
  assert.equal(parseTimestamp("+PT0.5S", { unit: "ms", now }), "1791547200500");
  assert.equal(displayTimestamp(parseTimestamp("+PT24H", { unit: "ns", now }), NS), "2026-10-10T12:00:00Z");
});

test("timestamp: a relative time is resolved against now floored to the tagged unit (D-024)", () => {
  const now = 1791547200123456789n; // 2026-10-09T12:00:00.123456789Z
  assert.equal(parseTimestamp("+PT24H", { unit: "ns", now }), "1791633600123456789", "ns keeps every digit of the clock");
  assert.equal(parseTimestamp("+PT24H", { unit: "us", now }), "1791633600123456");
  assert.equal(parseTimestamp("+PT24H", { unit: "ms", now }), "1791633600123");
  assert.equal(parseTimestamp("+PT24H", { unit: "s", now }), "1791633600", "no E_INEXACT: now is floored to whole seconds");
  assert.equal(parseTimestamp("+PT0S", { unit: "s", now }), "1791547200", "the floor, not the ceiling");
  assert.equal(parseTimestamp("+PT24H", { unit: "s", now: now + 876543211n }), "1791633601", "a clock just short of the next second still floors");
  assert.equal(parseTimestamp("+PT24H", { unit: "s", now }), parseTimestamp("+PT24H", { unit: "s", now: alignNow(now, "s") }), "same as aligning the clock first");
  assert.equal(parseTimestamp("+PT24H", { unit: "s", now: -1n, candid: "int" }), "86399", "floors before the epoch too: -1 ns is second -1");
});

test("alignNow stays exported and floors a clock reading to a unit", () => {
  const now = 1791547200123456789n;
  assert.equal(alignNow(now, "s"), 1791547200000000000n);
  assert.equal(alignNow(now, "ms"), 1791547200123000000n);
  assert.equal(alignNow(now, "us"), 1791547200123456000n);
  assert.equal(alignNow(now, "ns"), now);
  assert.equal(alignNow(-1n, "s"), -1_000_000_000n, "floors before the epoch too");
  assert.equal(code(() => alignNow(5, "s")), CODES.TYPE);
  assert.equal(code(() => alignNow(5n, "min")), CODES.ARG);
});

test("timestamp: flooring now does not hide a duration or an absolute time that is inexact in the unit", () => {
  const now = 1791547200123456789n;
  assert.equal(code(() => parseTimestamp("+PT0.5S", { unit: "s", now })), CODES.INEXACT, "the duration has half a second");
  assert.equal(code(() => parseTimestamp("+PT0.0005S", { unit: "ms", now })), CODES.INEXACT);
  assert.equal(parseTimestamp("+PT0.5S", { unit: "ms", now }), "1791547200623", "exact in ms: floor(now) + 500 ms");
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00.5Z", { unit: "s", now })), CODES.INEXACT, "absolute times are never floored");
});

test("timestamp: relative input needs now", () => {
  assert.equal(code(() => parseTimestamp("+PT24H", NS)), CODES.NEEDS_NOW);
  assert.equal(code(() => parseTimestamp("+PT24H", { unit: "ns", now: 5 })), CODES.NEEDS_NOW, "a number is not a clock reading");
});

test("timestamp: input that is not RFC 3339 or a +duration is rejected", () => {
  for (const bad of [
    "", "now", "tomorrow", "2026-10-09", "2026-10-09T12:00:00", "2026-10-09 12:00:00Z", "2026-10-09T12:00Z",
    "2026-10-09T12:00:00+0200", "2026-10-09T12:00:00 +02:00", "2026-10-9T12:00:00Z", "26-10-09T12:00:00Z", "1791547200", "PT24H", "-PT24H", "+-PT24H", "++PT24H", "+24H", "+",
    "2026-10-09T12:00:00.Z", "2026-10-09T١٢:00:00Z",
  ]) {
    assert.equal(code(() => parseTimestamp(bad, { unit: "s", now: 0n })), CODES.SYNTAX, JSON.stringify(bad));
  }
  assert.equal(code(() => parseTimestamp(1791547200, S)), CODES.TYPE);
});

test("timestamp: impossible dates and times are rejected", () => {
  for (const bad of [
    "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z", "2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-00T00:00:00Z",
    "2026-10-09T24:00:00Z", "2026-10-09T12:60:00Z", "2026-10-09T23:59:60Z", "2026-10-09T12:00:00+24:00", "2026-10-09T12:00:00+01:60",
  ]) {
    assert.equal(code(() => parseTimestamp(bad, { unit: "s", candid: "int" })), CODES.RANGE, bad);
  }
});

test("timestamp: a conversion that loses precision is rejected, never rounded", () => {
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00.5Z", S)), CODES.INEXACT);
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00.0005Z", { unit: "ms" })), CODES.INEXACT);
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00.0000000001Z", NS)), CODES.INEXACT);
  assert.equal(parseTimestamp("2026-10-09T12:00:00.000Z", S), "1791547200", "zeros are exact");
  assert.equal(parseTimestamp("2026-10-09T12:00:00.0000000000Z", NS), "1791547200000000000", "zeros past a nanosecond are exact");
});

test("timestamp: Candid type bounds", () => {
  assert.equal(parseTimestamp("1970-01-01T00:00:00Z", { unit: "s", candid: "nat32" }), "0");
  assert.equal(parseTimestamp("2106-02-07T06:28:15Z", { unit: "s", candid: "nat32" }), "4294967295");
  assert.equal(code(() => parseTimestamp("2106-02-07T06:28:16Z", { unit: "s", candid: "nat32" })), CODES.RANGE);
  assert.equal(code(() => parseTimestamp("1969-12-31T23:59:59Z", S)), CODES.RANGE);
  assert.equal(code(() => parseTimestamp("2554-07-21T23:34:33.709551616Z", NS)), CODES.RANGE, "2^64 ns is out of nat64");
  assert.equal(parseTimestamp("2554-07-21T23:34:33.709551615Z", NS), "18446744073709551615");
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00Z", { unit: "s", candid: "text" })), CODES.TAG_TYPE);
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00Z", { unit: "s", candid: "nat8" })), CODES.TAG_TYPE);
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00Z", { unit: "weeks" })), CODES.ARG);
  assert.equal(code(() => parseTimestamp("2026-10-09T12:00:00Z", {})), CODES.ARG);
});

test("timestamp: display rejects what it cannot show", () => {
  assert.equal(code(() => displayTimestamp("253402300800", S)), CODES.RANGE, "year 10000");
  assert.equal(code(() => displayTimestamp("-62167219201", { unit: "s", candid: "int" })), CODES.RANGE, "year -1");
  assert.equal(code(() => displayTimestamp(1791547200, S)), CODES.TYPE);
  assert.equal(code(() => displayTimestamp("1.5", S)), CODES.SYNTAX);
  assert.equal(code(() => displayTimestamp("-1", S)), CODES.RANGE);
});

test("convertUnit: exact conversions only", () => {
  assert.equal(convertUnit("1791547200000000000", "ns", "s"), "1791547200");
  assert.equal(convertUnit("1791547200", "s", "ns"), "1791547200000000000");
  assert.equal(convertUnit("1500", "ms", "us"), "1500000");
  assert.equal(convertUnit("1500", "ms", "ms"), "1500");
  assert.equal(convertUnit("-3000", "ms", "s"), "-3");
  assert.equal(convertUnit(5n, "s", "ms"), "5000");
  assert.equal(code(() => convertUnit("1791547200000000001", "ns", "s")), CODES.INEXACT);
  assert.equal(code(() => convertUnit("1500", "ms", "s")), CODES.INEXACT);
  assert.equal(code(() => convertUnit("-1500", "ms", "s")), CODES.INEXACT);
  assert.equal(code(() => convertUnit("1001", "us", "ms")), CODES.INEXACT);
  assert.equal(code(() => convertUnit(1500, "ms", "s")), CODES.TYPE);
  assert.equal(code(() => convertUnit("1", "ms", "min")), CODES.ARG);
});

test("duration: units and the 86,400 s day", () => {
  assert.equal(parseDuration("PT24H", S), "86400");
  assert.equal(parseDuration("P1D", S), "86400");
  assert.equal(parseDuration("P1W", S), "604800");
  assert.equal(parseDuration("P7D", S), "604800");
  assert.equal(parseDuration("PT1M", S), "60");
  assert.equal(parseDuration("PT90S", S), "90");
  assert.equal(parseDuration("P1DT2H3M4S", S), "93784");
  assert.equal(parseDuration("P1W2D", S), String(9 * 86400));
  assert.equal(parseDuration("PT0S", S), "0");
  assert.equal(parseDuration("P0D", S), "0");
  assert.equal(parseDuration("PT1.5S", { unit: "ms" }), "1500");
  assert.equal(parseDuration("PT0,5S", { unit: "ms" }), "500");
  assert.equal(parseDuration("PT0.000000001S", NS), "1");
  assert.equal(parseDuration("P1D", NS), "86400000000000");
  assert.equal(parseDuration(" PT24H ", S), "86400");
});

test("duration: display is canonical ISO 8601", () => {
  const cases = { 0: "PT0S", 1: "PT1S", 59: "PT59S", 60: "PT1M", 3599: "PT59M59S", 3600: "PT1H", 5400: "PT1H30M", 86399: "PT23H59M59S", 86400: "P1D", 90061: "P1DT1H1M1S", 604800: "P7D", 1209600: "P14D" };
  for (const [v, text] of Object.entries(cases)) assert.equal(displayDuration(v, S) ?? "", text, `${v} s`);
  assert.equal(displayDuration("1500", { unit: "ms" }), "PT1.5S");
  assert.equal(displayDuration("1", NS), "PT0.000000001S");
  assert.equal(displayDuration("86400000000001", NS), "P1DT0.000000001S");
  assert.equal(displayDuration(86400n, S), "P1D");
  assert.equal(displayDuration("-5400", { unit: "s", candid: "int" }), "-PT1H30M");
});

test("duration: calendar years and months are rejected", () => {
  for (const bad of ["P1Y", "P1M", "P1Y2M", "P1Y1D", "P1M1D", "P6M", "P1Y2M3DT4H", "-P1M", "P0Y", "P0M"]) {
    assert.equal(code(() => parseDuration(bad, { unit: "s", candid: "int" })), CODES.CALENDAR_UNIT, bad);
  }
  assert.equal(code(() => parseTimestamp("+P1Y", { unit: "s", now: 0n })), CODES.CALENDAR_UNIT);
  assert.equal(code(() => parseTimestamp("+P1M", { unit: "s", now: 0n })), CODES.CALENDAR_UNIT);
  assert.equal(code(() => parseTimestamp("+P1Y2M10DT2H30M", { unit: "s", now: 0n })), CODES.CALENDAR_UNIT);
  assert.equal(parseDuration("PT1M", S), "60", "M after T is minutes, not months");
});

test("duration: anything outside W, D, H, M, S in the right order is a syntax error", () => {
  for (const bad of ["", "P", "PT", "P1DT", "24H", "PT24", "PT24h", "pt24h", "P1H", "PT1D", "PT1W", "P1D1W", "PT1S1M", "PT1.5H", "P1.5D", "PT1.S", "PT.5S", "+PT24H", "PT-1H", "P 1D", "T1H", "PT1X", "P1Q", "1D"]) {
    assert.equal(code(() => parseDuration(bad, S)), CODES.SYNTAX, JSON.stringify(bad));
  }
});

test("duration: sub-unit precision and sign", () => {
  assert.equal(code(() => parseDuration("PT0.5S", S)), CODES.INEXACT);
  assert.equal(code(() => parseDuration("PT0.0005S", { unit: "ms" })), CODES.INEXACT);
  assert.equal(code(() => parseDuration("PT0.0000000001S", NS)), CODES.INEXACT);
  assert.equal(parseDuration("PT1.000S", S), "1", "zeros are exact");
  assert.equal(parseDuration("-PT5S", { unit: "s", candid: "int" }), "-5");
  assert.equal(code(() => parseDuration("-PT5S", S)), CODES.NEGATIVE);
  assert.equal(parseDuration("-PT0S", S), "0");
});

test("duration: Candid type bounds", () => {
  assert.equal(parseDuration("PT4294967295S", { unit: "s", candid: "nat32" }), "4294967295");
  assert.equal(code(() => parseDuration("PT4294967296S", { unit: "s", candid: "nat32" })), CODES.RANGE);
  assert.equal(code(() => parseDuration("P214748364800D", { unit: "ns", candid: "nat64" })), CODES.RANGE);
  assert.equal(code(() => parseDuration("PT1S", { unit: "s", candid: "nat8" })), CODES.TAG_TYPE);
  assert.equal(code(() => displayDuration(86400, S)), CODES.TYPE);
});

// ---------------------------------------------------------------- properties

const MS_MIN = Date.UTC(1970, 0, 1);
const MS_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

test(`property: timestamp display then parse is the identity in every unit (seed ${SEED})`, () => {
  const rng = makeRng();
  for (let i = 0; i < 4000; i++) {
    const unit = rng.pick(["ns", "us", "ms", "s"]);
    const candid = rng.pick(["nat64", "nat", "int", "int64"]);
    const signed = candid.startsWith("int");
    // a random magnitude whose ns value stays inside year 0..9999 and inside the Candid type
    const f = { ns: 1n, us: 1000n, ms: 1_000_000n, s: 1_000_000_000n }[unit];
    const maxPos = unit === "ns" ? 2n ** 63n - 1n : 253402300799n * 1_000_000_000n;
    const maxNeg = unit === "ns" ? 2n ** 63n : 62167219200n * 1_000_000_000n;
    let ns = rng.bits(rng.int(64) + 1) % (maxPos + 1n);
    if (signed && rng.bool()) ns = -(ns % (maxNeg + 1n));
    const v = ns / f;
    const text = displayTimestamp(v, { unit, candid });
    assert.equal(parseTimestamp(text, { unit, candid }), v.toString(), `seed ${SEED}: ${v} ${unit} ${candid} -> ${text}`);
    assert.match(text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d*[1-9])?Z$/, `canonical form, seed ${SEED}: ${text}`);
  }
});

test(`property: absolute parsing and display agree with Date for millisecond instants (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 1);
  for (let i = 0; i < 4000; i++) {
    const ms = rng.pick([MS_MIN, 0]) + Math.floor((rng.next32() / 4294967296) * Math.min(MS_MAX - MS_MIN, 2 ** 52));
    const clamped = Math.min(ms, MS_MAX);
    const iso = new Date(clamped).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
    assert.equal(parseTimestamp(iso, { unit: "ms", candid: "nat" }), String(clamped), `seed ${SEED + 1}: ${iso}`);
    const shown = displayTimestamp(String(clamped), { unit: "ms", candid: "nat" });
    assert.equal(Date.parse(shown), clamped, `seed ${SEED + 1}: ${shown}`);
    // the same instant through a random zone
    const offMin = rng.int(24 * 60 * 2) - 24 * 60 + 1; // -1439..1440 minutes, never beyond 23:59
    if (Math.abs(offMin) <= 23 * 60 + 59) {
      const local = new Date(clamped + offMin * 60000);
      if (local.getUTCFullYear() >= 0 && local.getUTCFullYear() <= 9999) {
        const sign = offMin < 0 ? "-" : "+";
        const a = Math.abs(offMin);
        const zone = `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
        const text = local.toISOString().replace("Z", zone);
        assert.equal(Date.parse(text), clamped, "oracle sanity");
        assert.equal(parseTimestamp(text, { unit: "ms", candid: "int" }), String(clamped), `seed ${SEED + 1}: ${text}`);
      }
    }
  }
});

test(`property: unit conversion round-trips when exact and rejects when not (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 2);
  const f = { ns: 1n, us: 1000n, ms: 1_000_000n, s: 1_000_000_000n };
  const order = ["ns", "us", "ms", "s"];
  for (let i = 0; i < 4000; i++) {
    const from = rng.pick(order);
    const to = rng.pick(order);
    const v = rng.bigint(80) * (rng.bool() ? 1n : -1n);
    const ns = v * f[from];
    const exact = ns % f[to] === 0n;
    if (exact) {
      const out = convertUnit(v, from, to);
      assert.equal(BigInt(out) * f[to], ns, `seed ${SEED + 2}: ${v} ${from} -> ${to}`);
      assert.equal(convertUnit(out, to, from), v.toString(), `seed ${SEED + 2}: back`);
    } else {
      assert.equal(code(() => convertUnit(v, from, to)), CODES.INEXACT, `seed ${SEED + 2}: ${v} ${from} -> ${to}`);
    }
  }
});

test(`property: duration display then parse is the identity, and parse matches component arithmetic (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 3);
  const f = { ns: 1n, us: 1000n, ms: 1_000_000n, s: 1_000_000_000n };
  for (let i = 0; i < 4000; i++) {
    const unit = rng.pick(["ns", "us", "ms", "s"]);
    const candid = rng.pick(["nat64", "int", "int64"]);
    const mag = rng.bits(rng.int(63) + 1);
    const v = candid === "nat64" || !rng.bool() ? mag : -mag;
    const text = displayDuration(v, { unit, candid });
    assert.equal(parseDuration(text, { unit, candid }), v.toString(), `seed ${SEED + 3}: ${v} ${unit} -> ${text}`);
    assert.match(text, /^-?P(?:[0-9]+D)?(?:T(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]*[1-9])?S)?)?$/, `canonical form, seed ${SEED + 3}: ${text}`);

    const w = rng.int(5), d = rng.int(400), h = rng.int(100), mi = rng.int(1000), s = rng.int(100000);
    const parts = `${w ? `${w}W` : ""}${d ? `${d}D` : ""}`;
    const tparts = `${h ? `${h}H` : ""}${mi ? `${mi}M` : ""}${s ? `${s}S` : ""}`;
    if (!parts && !tparts) continue;
    const iso = `P${parts}${tparts ? `T${tparts}` : ""}`;
    const secs = BigInt(w * 7 * 86400 + d * 86400 + h * 3600 + mi * 60 + s);
    assert.equal(parseDuration(iso, { unit: "s" }), secs.toString(), `seed ${SEED + 3}: ${iso}`);
    assert.equal(parseDuration(iso, NS), (secs * f.s).toString(), `seed ${SEED + 3}: ${iso} ns`);
    assert.equal(parseDuration(displayDuration(secs, S), S), secs.toString());
  }
});

test(`property: relative timestamp equals now plus the duration, exactly (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 4);
  for (let i = 0; i < 2000; i++) {
    const now = rng.bits(61);
    const secs = rng.bits(30);
    const iso = displayDuration(secs, { unit: "s" });
    assert.equal(parseTimestamp(`+${iso}`, { unit: "ns", now }), (now + secs * 1_000_000_000n).toString(), `seed ${SEED + 4}: ${now} ${iso}`);
  }
});

test(`property: a timestamp with a sub-unit fraction is rejected for the coarser unit (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 5);
  for (let i = 0; i < 2000; i++) {
    const secs = rng.bits(31);
    const unit = rng.pick(["s", "ms", "us"]);
    const digits = { s: 0, ms: 3, us: 6 }[unit];
    const frac = String(rng.int(1e9)).padStart(9, "0");
    if (frac.slice(digits) === "0".repeat(9 - digits)) continue;
    const text = `${displayTimestamp(secs, { unit: "s", candid: "nat" }).replace("Z", "")}.${frac}Z`;
    assert.equal(code(() => parseTimestamp(text, { unit, candid: "nat64" })), CODES.INEXACT, `seed ${SEED + 5}: ${text} ${unit}`);
    assert.doesNotThrow(() => parseTimestamp(text, NS));
  }
});

test(`property: a relative timestamp is floor(now to the unit) plus the duration, exactly (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 6);
  const f = { ns: 1n, us: 1000n, ms: 1_000_000n, s: 1_000_000_000n };
  for (let i = 0; i < 3000; i++) {
    const unit = rng.pick(["ns", "us", "ms", "s"]);
    const now = rng.bits(rng.int(62) + 1);
    const secs = rng.bits(rng.int(32) + 1);
    const iso = displayDuration(secs, { unit: "s" });
    const expected = (now / f[unit]) * f[unit] + secs * 1_000_000_000n;
    assert.equal(parseTimestamp(`+${iso}`, { unit, now }), (expected / f[unit]).toString(), `seed ${SEED + 6}: now ${now} ${unit} ${iso}`);
  }
});
