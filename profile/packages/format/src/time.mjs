// `timestamp` and `duration` (spec §5.3).
//
// A timestamp is an integer count of `unit` since the Unix epoch; a duration is an integer count
// of `unit`. Both travel as decimal strings. All arithmetic is in BigInt nanoseconds, so a
// nanosecond timestamp round-trips exactly, and a conversion that would drop precision throws
// (E_INEXACT) instead of rounding.
//
// Calendar arithmetic follows the proleptic Gregorian calendar with no leap seconds
// (Howard Hinnant's days_from_civil / civil_from_days), not JavaScript's Date, which has only
// millisecond precision.

import { CODES, fail } from "./errors.mjs";
import { checkMessage, checkThreshold } from "./amount.mjs";
import { ABI_INT_TYPES, checkRange, intType, requireString, toBigInt, typeWord } from "./util.mjs";

export const TIME_TYPES = ["nat", "int", "nat32", "nat64", "int64", ...ABI_INT_TYPES.filter((t) => (t.startsWith("u") ? Number(t.slice(4)) >= 32 : Number(t.slice(3)) > 64))];

const NS_PER = Object.freeze({ ns: 1n, us: 1_000n, ms: 1_000_000n, s: 1_000_000_000n });
const NS_PER_S = 1_000_000_000n;
const S_PER_DAY = 86_400n;

export function unitFactor(unit) {
  const f = typeof unit === "string" && Object.hasOwn(NS_PER, unit) ? NS_PER[unit] : undefined;
  if (f === undefined) fail(CODES.ARG, `unit must be one of ns, us, ms, s, got ${JSON.stringify(unit)}`);
  return f;
}

/**
 * Convert an integer between units. Going to a finer unit multiplies; going to a coarser unit
 * requires the value to be an exact multiple, otherwise it throws E_INEXACT. Never rounds.
 *
 * @param {string | bigint} value
 * @param {"ns"|"us"|"ms"|"s"} from
 * @param {"ns"|"us"|"ms"|"s"} to
 * @returns {string} decimal string
 */
export function convertUnit(value, from, to) {
  return nsToUnit(toBigInt(value, "value") * unitFactor(from), to).toString();
}

/**
 * Floor a clock reading (ns) to a unit. `parseTimestamp` applies this to `now` before it adds a
 * relative duration (spec §5.3, D-024), so a caller does not need it for parsing; it is exported
 * for callers that want the aligned clock reading themselves.
 *
 * @param {bigint} nowNs
 * @param {"ns"|"us"|"ms"|"s"} unit
 * @returns {bigint}
 */
export function alignNow(nowNs, unit) {
  if (typeof nowNs !== "bigint") fail(CODES.TYPE, "now must be a bigint in nanoseconds");
  const f = unitFactor(unit);
  let q = nowNs / f;
  if (nowNs % f < 0n) q -= 1n; // floor, also for pre-1970 clocks
  return q * f;
}

function nsToUnit(ns, unit) {
  const f = unitFactor(unit);
  if (ns % f !== 0n) {
    fail(CODES.INEXACT, `${ns} ns is not a whole number of ${unit}; the conversion would lose precision and is not rounded`);
  }
  return ns / f;
}

const floorDiv = (a, b) => {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
};

// ---------------------------------------------------------------- calendar

const daysFromCivil = (y0, m, d) => {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const civilFromDays = (z0) => {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
};

const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y, m) => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

const MIN_S = BigInt(daysFromCivil(0, 1, 1)) * S_PER_DAY; // 0000-01-01T00:00:00Z
const MAX_S = (BigInt(daysFromCivil(9999, 12, 31)) + 1n) * S_PER_DAY - 1n; // 9999-12-31T23:59:59Z

const pad = (n, w) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- RFC 3339

const RFC3339 = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;

/** An absolute RFC 3339 time as nanoseconds since the Unix epoch. */
function parseRfc3339Ns(text) {
  const m = RFC3339.exec(text);
  if (!m) {
    fail(
      CODES.SYNTAX,
      `cannot read ${JSON.stringify(text)} as a time: use RFC 3339 with an explicit zone, for example "2026-10-09T12:00:00Z" or "2026-10-09T14:00:00+02:00", or a relative time such as "+PT24H"`,
    );
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const frac = m[7] ?? "";
  if (mo < 1 || mo > 12) fail(CODES.RANGE, `month ${pad(mo, 2)} is not between 01 and 12`);
  if (d < 1 || d > daysInMonth(y, mo)) fail(CODES.RANGE, `${pad(y, 4)}-${pad(mo, 2)} has no day ${pad(d, 2)}`);
  if (h > 23) fail(CODES.RANGE, `hour ${pad(h, 2)} is not between 00 and 23`);
  if (mi > 59) fail(CODES.RANGE, `minute ${pad(mi, 2)} is not between 00 and 59`);
  if (s > 59) fail(CODES.RANGE, `second ${pad(s, 2)} is not between 00 and 59 (leap seconds have no Unix time and are rejected)`);
  let offset = 0;
  if (!/^[Zz]$/.test(m[8])) {
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) fail(CODES.RANGE, `zone offset ${m[8]} is out of range`);
    offset = (m[8][0] === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const fracNs = BigInt(frac.slice(0, 9).padEnd(9, "0"));
  if (/[1-9]/.test(frac.slice(9))) fail(CODES.INEXACT, `${JSON.stringify(text)} is finer than a nanosecond and is not rounded`);
  const secs = (BigInt(daysFromCivil(y, mo, d)) * 86_400n) + BigInt(h * 3600 + mi * 60 + s - offset);
  return secs * NS_PER_S + fracNs;
}

/** Canonical RFC 3339 UTC: `YYYY-MM-DDTHH:MM:SS[.f]Z`, the fraction with trailing zeros removed. */
function rfc3339FromNs(ns) {
  const secs = floorDiv(ns, NS_PER_S);
  const fracNs = ns - secs * NS_PER_S;
  if (secs < MIN_S || secs > MAX_S) fail(CODES.RANGE, "the time is outside 0000-01-01T00:00:00Z to 9999-12-31T23:59:59Z");
  const days = floorDiv(secs, S_PER_DAY);
  const sod = Number(secs - days * S_PER_DAY);
  const [y, mo, d] = civilFromDays(Number(days));
  const frac = pad(fracNs, 9).replace(/0+$/, "");
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(Math.floor(sod / 3600), 2)}:${pad(Math.floor((sod % 3600) / 60), 2)}:${pad(sod % 60, 2)}${frac ? `.${frac}` : ""}Z`;
}

// ---------------------------------------------------------------- ISO 8601 durations

const DURATION =
  /^(-)?P(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?=[0-9])(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)(?:[.,]([0-9]+))?S)?)?$/;

/** Nanoseconds in an ISO 8601 duration; only W, D, H, M (after T) and S. Returns { negative, ns }. */
function parseDurationNs(text, what) {
  if (/^-?P[^T]*[YM]/.test(text)) {
    fail(
      CODES.CALENDAR_UNIT,
      `${JSON.stringify(text)} uses years or months, which have no fixed length; use W, D, H, M or S, for example "P30D" or "PT24H"`,
    );
  }
  const m = DURATION.exec(text);
  if (!m || m.slice(2, 7).every((g) => g === undefined)) {
    fail(
      CODES.SYNTAX,
      `cannot read ${JSON.stringify(text)} as ${what}: use ISO 8601 with W, D, H, M and S only, for example "PT24H", "P7D" or "PT1M30S"`,
    );
  }
  const n = (g) => (g === undefined ? 0n : BigInt(g));
  const frac = m[7] ?? "";
  if (/[1-9]/.test(frac.slice(9))) fail(CODES.INEXACT, `${JSON.stringify(text)} is finer than a nanosecond and is not rounded`);
  const ns =
    ((n(m[2]) * 7n + n(m[3])) * S_PER_DAY + n(m[4]) * 3600n + n(m[5]) * 60n + n(m[6])) * NS_PER_S + BigInt(frac.slice(0, 9).padEnd(9, "0"));
  return { negative: m[1] === "-", ns };
}

// ---------------------------------------------------------------- public: timestamp

/**
 * Parse a timestamp: an absolute RFC 3339 time, or a relative ISO 8601 duration prefixed with "+"
 * resolved against `now` floored to `unit` (spec §5.3, D-024). The floor applies to the clock
 * reading only: it is a rule about the reference time, not a rounding of the user's value, so
 * "+PT24H" on a `unit: s` field is exact. The duration itself and an absolute time must still
 * convert exactly (E_INEXACT). Returns the integer count of `unit` as a decimal string.
 *
 * @param {string} input
 * @param {{ unit: "ns"|"us"|"ms"|"s", candid?: string, now?: bigint }} opts  `now` is nanoseconds
 *   since the Unix epoch from the canister's clock (spec §4), required only for relative input.
 */
export function parseTimestamp(input, { unit, candid = "nat64", now } = {}) {
  unitFactor(unit);
  const type = intType(candid, TIME_TYPES, "timestamp");
  const text = requireString(input, "timestamp").trim();
  let ns;
  if (text.startsWith("+")) {
    if (typeof now !== "bigint") fail(CODES.NEEDS_NOW, `"${text}" is relative to the current time, but no \`now\` (a bigint in nanoseconds) was supplied`);
    const { negative, ns: dur } = parseDurationNs(text.slice(1), "a relative time");
    if (negative) fail(CODES.SYNTAX, `a relative time is "+" followed by a duration, not ${JSON.stringify(text)}`);
    ns = alignNow(now, unit) + dur;
  } else {
    ns = parseRfc3339Ns(text);
  }
  const v = nsToUnit(ns, unit);
  checkRange(v, type, "timestamp");
  return v.toString();
}

/**
 * A timestamp's `labels` (spec section 15.9): words for exact values, keyed by the value in the tagged unit as a
 * canonical decimal string. At most 16, each 1 to 32 characters with nothing invisible.
 *
 * @returns {Map<bigint, string> | undefined}
 */
export function checkTimeLabels(labels) {
  if (labels === undefined || labels === null) return undefined;
  if (typeof labels !== "object" || Array.isArray(labels)) fail(CODES.ARG, "timestamp labels must be an object of value to words");
  const entries = Object.entries(labels);
  if (entries.length < 1 || entries.length > 16) fail(CODES.ARG, `timestamp labels must have 1 to 16 entries, got ${entries.length}`);
  const out = new Map();
  for (const [k, v] of entries) {
    if (!/^(?:0|[1-9][0-9]{0,77})$/.test(k)) fail(CODES.ARG, `a timestamp label's value must be a decimal string of the tagged unit (0 or more, at most 78 digits), got ${JSON.stringify(k)}`);
    out.set(BigInt(k), checkMessage(v, `timestamp label of ${k}`));
  }
  return out;
}

/**
 * Display a timestamp as canonical RFC 3339 UTC, for example "2026-10-09T12:00:00.5Z". Display only (spec section
 * 15.9): a value that `labels` names shows its words, and a value at or above `threshold` shows `message` ("Never"
 * for a deadline of uint256 max), so that such a value is never read as a date.
 *
 * @param {string | bigint} value integer count of `unit` since the Unix epoch
 * @param {{ unit: string, candid?: string, threshold?: string | bigint, message?: string, labels?: Record<string, string> }} opts
 */
export function displayTimestamp(value, { unit, candid = "nat64", threshold, message, labels } = {}) {
  const f = unitFactor(unit);
  const type = intType(candid, TIME_TYPES, "timestamp");
  const limit = checkThreshold(threshold, "timestamp");
  const text = checkMessage(message, "timestamp message");
  if ((limit === undefined) !== (text === undefined)) fail(CODES.ARG, "a timestamp threshold and its message go together: give both or neither");
  const words = checkTimeLabels(labels);
  const v = toBigInt(value, "timestamp");
  checkRange(v, type, "timestamp");
  if (words?.has(v)) return words.get(v);
  if (limit !== undefined && v >= limit) return text;
  return rfc3339FromNs(v * f);
}

// ---------------------------------------------------------------- public: duration

/**
 * Parse an ISO 8601 duration made only of W, D, H, M (after T) and S, for example "PT24H".
 * A fraction is allowed on the seconds only ("PT0.5S"). A leading "-" is allowed for signed types.
 * Returns the integer count of `unit` as a decimal string.
 */
export function parseDuration(input, { unit, candid = "nat64" } = {}) {
  unitFactor(unit);
  const type = intType(candid, TIME_TYPES, "duration");
  const text = requireString(input, "duration").trim();
  const { negative, ns } = parseDurationNs(text, "a duration");
  if (negative && ns !== 0n && !type.signed) fail(CODES.NEGATIVE, `negative durations are not allowed here (the ${typeWord(candid)} ${candid} is unsigned)`);
  const v = nsToUnit(negative ? -ns : ns, unit);
  checkRange(v, type, "duration");
  return v.toString();
}

/**
 * Display a duration as canonical ISO 8601: days, hours, minutes and seconds, each only when
 * non-zero; never weeks, years or months. 86,400 s is "P1D", 5,400 s is "PT1H30M", zero is "PT0S".
 * The seconds carry a fraction when the unit is finer than a second ("PT0.5S").
 */
export function displayDuration(value, { unit, candid = "nat64" } = {}) {
  const f = unitFactor(unit);
  const type = intType(candid, TIME_TYPES, "duration");
  const v = toBigInt(value, "duration");
  checkRange(v, type, "duration");
  const total = (v < 0n ? -v : v) * f;
  const secs = total / NS_PER_S;
  const frac = pad(total % NS_PER_S, 9).replace(/0+$/, "");
  const days = secs / S_PER_DAY;
  const h = (secs % S_PER_DAY) / 3600n;
  const mi = (secs % 3600n) / 60n;
  const s = secs % 60n;
  let out = days ? `${days}D` : "";
  let t = `${h ? `${h}H` : ""}${mi ? `${mi}M` : ""}${s || frac ? `${s}${frac ? `.${frac}` : ""}S` : ""}`;
  if (!out && !t) t = "0S";
  if (t) out += `T${t}`;
  return `${v < 0n ? "-" : ""}P${out}`;
}
