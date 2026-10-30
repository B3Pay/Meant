// Terms the user allows for one task (docs/profile-v0.md section 5.3, "Confirmed terms", D-056): the token, who may
// take it, the most and the latest end. The agent drafts them from the user's words (readTerms). The wallet shows them
// exactly (termsText), and the user confirms them on the wallet's own screen, never through a tool the agent can call
// (section 11 item 10; confirmTerms). A request whose grant (grant.mjs) fits them then needs no second yes, and one
// that does not is refused with its reasons (checkGrant). termsGate keeps the order: the terms are confirmed before the
// request is read, and they cannot change after.
//
// Pure: no clock and no zone of their own. The wallet passes `now`, nanoseconds since the Unix epoch as a bigint (as
// @meantjs/format takes it), and its UTC offset. Nothing is rounded: an amount with more decimals than its token has is
// refused (spec section 5.3, D-006), and times are compared in nanoseconds.

import { displayAccount, displayAmount, normalizeName, parseAccount, parseAmount, principalFromText, principalToText } from "@meantjs/format";
import { jcs, readAddress } from "@meantjs/profile/evm";
import { zoneName } from "./display.mjs";
import { CODES, fail } from "./errors.mjs";
import { secondsText } from "./grant.mjs";
import { sha256Hex } from "./sha256.mjs";

/** A term the agent wrote that cannot be read, or a step out of order. `message` is written for the agent, which asks the user when it cannot fix the term itself. */
export class TermsError extends Error {
  /**
   * @param {string} code  one of TERMS_CODES
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TermsError";
    this.code = code;
  }
}

export const TERMS_CODES = Object.freeze({
  MISSING: "E_TERMS_MISSING", // a field is missing or empty, or both spender and to are given
  TOKEN: "E_TERMS_TOKEN", // a token the wallet does not know
  PARTY: "E_TERMS_PARTY", // an app the wallet does not know, or an address or account that is not one
  AMOUNT: "E_TERMS_AMOUNT", // an amount that cannot be read, or has more decimals than its token
  END: "E_TERMS_END", // an end that cannot be read, or a date before today
  ORDER: "E_TERMS_ORDER", // termsGate: a step out of order
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NS_PER_S = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_S;
const NS_PER_DAY = 86_400n * NS_PER_S;
/** As icrc21.mjs takes a zone: a fixed offset of at most a day. */
const MAX_OFFSET_MINUTES = 24 * 60;
const HOURS = /^(\d{1,3})\s*hours?$/i;
const LENGTH = /^(\d{1,4})\s*(day|week|month|year)s?$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SECONDS = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/;
const NATURAL = /^(0|[1-9][0-9]*)$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** How a token or an app is looked up by name: NFKC, lowercase, letters and digits only, so "Uni-swap" and "1 inch" find Uniswap and 1inch. */
const nameKey = (s) => normalizeName(s).replace(/[^\p{L}\p{N}]/gu, "");
/** "A", "A and B", "A, B and C". */
const listText = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const ADDRESS = /^0x/i;

// ------------------------------------------------------------------------------------------------ days, exactly

const floorDiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
/** Days since 1970-01-01 of a date in the proleptic Gregorian calendar (H. Hinnant's days_from_civil), any year. */
function daysFrom(y, m, d) {
  const yy = BigInt(y) - (m <= 2 ? 1n : 0n);
  const era = floorDiv(yy, 400n);
  const yoe = yy - era * 400n;
  const doy = (153n * BigInt(m > 2 ? m - 3 : m + 9) + 2n) / 5n + BigInt(d) - 1n;
  return era * 146097n + yoe * 365n + yoe / 4n - yoe / 100n + doy - 719468n;
}
/** The date of a day count (civil_from_days): { y, m, d } with y a bigint. */
function dateOf(days) {
  const z = days + 719468n;
  const era = floorDiv(z, 146097n);
  const doe = z - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = Number(doy - (153n * mp + 2n) / 5n + 1n);
  const m = Number(mp < 10n ? mp + 3n : mp - 9n);
  return { y: yoe + era * 400n + (m <= 2 ? 1n : 0n), m, d };
}
const daysIn = (y, m) => Number(daysFrom(m === 12 ? BigInt(y) + 1n : y, m === 12 ? 1 : m + 1, 1) - daysFrom(y, m, 1));
const isoDate = ({ y, m, d }) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** A YYYY-MM-DD that names a real day, as { y, m, d }; null otherwise ("2027-02-30"). */
function readDate(text) {
  const m = DATE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) ? { y: BigInt(y), m: mo, d } : null;
}
/** Local time in ns at an offset -> its day count. */
const localDays = (ns, offset) => floorDiv(ns + BigInt(offset) * NS_PER_MINUTE, NS_PER_DAY);
/** The last nanosecond of a local date: a date allows its whole day. */
const endOfDay = (date, offset) => (daysFrom(date.y, date.m, date.d) + 1n) * NS_PER_DAY - BigInt(offset) * NS_PER_MINUTE - 1n;

/**
 * A length of time from a date as the date it ends on. Days and weeks count days. Months and years count calendar
 * months, and a day the target month does not have becomes its last day (31 January and 1 month is 28 or 29 February).
 */
function addLength(n, unit, from) {
  if (unit === "day" || unit === "week") return dateOf(daysFrom(from.y, from.m, from.d) + BigInt(n * (unit === "week" ? 7 : 1)));
  const months = from.y * 12n + BigInt(from.m - 1) + BigInt(n * (unit === "year" ? 12 : 1));
  const y = floorDiv(months, 12n);
  const m = Number(months - y * 12n) + 1;
  return { y, m, d: Math.min(from.d, daysIn(y, m)) };
}

/** Exact seconds (a decimal string, as a grant writes them) -> ns. */
function nsOf(seconds) {
  const m = SECONDS.exec(seconds);
  const ns = BigInt(m[2]) * NS_PER_S + BigInt((m[3] ?? "").padEnd(9, "0"));
  return m[1] ? -ns : ns;
}
const dayText = ({ y, m, d }) => `${d} ${MONTHS[m - 1]} ${y}`;
/** A moment in the zone, exactly: "2 November 2026 at 14:00", with seconds and their fraction only when there are any. */
function timeText(ns, offset) {
  const local = ns + BigInt(offset) * NS_PER_MINUTE;
  const days = floorDiv(local, NS_PER_DAY);
  const rest = local - days * NS_PER_DAY;
  const s = rest / NS_PER_S;
  const frac = (rest % NS_PER_S).toString().padStart(9, "0").replace(/0+$/, "");
  const hm = `${String(s / 3600n).padStart(2, "0")}:${String((s / 60n) % 60n).padStart(2, "0")}`;
  const sec = s % 60n !== 0n || frac ? `:${String(s % 60n).padStart(2, "0")}${frac ? `.${frac}` : ""}` : "";
  return `${dayText(dateOf(days))} at ${hm}${sec}`;
}

// ------------------------------------------------------------------------------------------------ the wallet

/**
 * @typedef {object} Wallet
 * @property {Record<string, { address?: string, canister?: string, decimals: number }>} tokens  the tokens it knows, by
 *   symbol: an EVM token's address or an Internet Computer ledger's canister id, and its decimals
 * @property {Record<string, string>} [apps]  the apps and people it knows by name: an address, or an account in its
 *   ICRC-1 text. The agent names one and code looks it up: the agent never turns a name into an address itself
 * @property {bigint} now  nanoseconds since the Unix epoch, from the wallet's clock
 * @property {number} [utcOffsetMinutes]  the user's zone, default 0 (UTC): a date allows its whole day there
 */

const canister = (text) => principalToText(principalFromText(text));
/** An address in EIP-55 form, or an account in its ICRC-1 text, or null. */
function partyId(text) {
  if (typeof text !== "string") return null;
  try {
    return ADDRESS.test(text) ? { chain: "evm", id: readAddress(text) } : { chain: "icp", id: displayAccount(parseAccount(text)) };
  } catch {
    return null;
  }
}
function tokenId(text) {
  if (typeof text !== "string") return null;
  try {
    return ADDRESS.test(text) ? { chain: "evm", id: readAddress(text) } : { chain: "icp", id: canister(text) };
  } catch {
    return null;
  }
}

function walletOf(wallet) {
  const bad = (why) => fail(CODES.REQUEST, `wallet ${why}`);
  if (!isObject(wallet)) bad("must be { tokens, apps, now, utcOffsetMinutes }");
  const { tokens, apps = {}, now, utcOffsetMinutes = 0 } = wallet;
  if (typeof now !== "bigint" || now < 0n) bad(".now must be nanoseconds since the Unix epoch, a bigint");
  if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > MAX_OFFSET_MINUTES) bad(`.utcOffsetMinutes must be whole minutes within +-${MAX_OFFSET_MINUTES}`);
  if (!isObject(tokens) || Object.keys(tokens).length === 0) bad(".tokens must name its tokens by symbol: { USDC: { address, decimals }, ICP: { canister, decimals } }");
  if (!isObject(apps)) bad(".apps must be { name: address or account }");
  const byKey = new Map();
  const unique = (kind, name) => {
    const key = nameKey(name);
    if (!key) bad(`${kind} ${JSON.stringify(name)} has no letters or digits`);
    if (byKey.has(`${kind}:${key}`)) bad(`${kind}s ${JSON.stringify(byKey.get(`${kind}:${key}`))} and ${JSON.stringify(name)} are one name once case, spaces and punctuation are set aside`);
    byKey.set(`${kind}:${key}`, name);
    return key;
  };
  const ids = new Map();
  const tokenList = Object.entries(tokens).map(([symbol, t]) => {
    const key = unique("token", symbol);
    if (!isObject(t) || (t.address === undefined) === (t.canister === undefined)) bad(`.tokens.${symbol} must give its address or its canister, not both`);
    const id = t.address !== undefined ? tokenId(t.address) : tokenId(t.canister);
    if (id === null || (t.address !== undefined) !== (id.chain === "evm")) bad(`.tokens.${symbol}: ${JSON.stringify(t.address ?? t.canister)} is not ${t.address !== undefined ? "an address (0x and 40 hex digits)" : "a canister id"}`);
    if (ids.has(id.id)) bad(`.tokens ${ids.get(id.id)} and ${symbol} are the same token`);
    ids.set(id.id, symbol);
    try {
      displayAmount("0", { decimals: t.decimals, symbol });
    } catch (e) {
      bad(`.tokens.${symbol}: ${e.message}`);
    }
    return { symbol, key, ...id, decimals: Number(t.decimals) };
  });
  const appList = Object.entries(apps).map(([name, value]) => {
    const key = unique("app", name);
    const id = partyId(value);
    if (id === null) bad(`.apps.${name}: ${JSON.stringify(value)} is neither an address (0x and 40 hex digits) nor an ICRC-1 account`);
    return { name, key, ...id };
  });
  return { tokens: tokenList, apps: appList, now, offset: utcOffsetMinutes };
}

/** The one app with this address or account, by name; null for none. */
const appNamed = (w, id) => w.apps.find((a) => a.id === id)?.name ?? null;

// ------------------------------------------------------------------------------------------------ terms

/**
 * The agent's terms, read: what the user allows, in the wallet's own values. Throws TermsError with a message for the
 * agent when a term cannot be read; it never guesses a token, an app, a number of decimals or a date.
 *
 * @param {{ token: string, spender?: string, to?: string, max_amount: string, expires_by: string }} fields  as the agent
 *   wrote them: the token by symbol; `spender` (who may spend the tokens) or `to` (who is paid directly), by the name
 *   the wallet knows or an address or account the user gave; the most, in tokens ("100", "0.5"), or "unlimited"; the
 *   latest end, as YYYY-MM-DD (the whole day counts), a length from today ("30 days", "2 weeks", "1 month", "1 year"),
 *   a number of hours from now ("2 hours", an exact time), or "never"
 * @param {Wallet} wallet
 */
export function readTerms(fields, wallet) {
  const w = walletOf(wallet);
  const o = isObject(fields) ? fields : {};
  const given = (k) => typeof o[k] === "string" && o[k].trim() !== "";
  if (given("spender") && given("to")) throw new TermsError(TERMS_CODES.MISSING, "give spender or to, not both: spender for who may spend the tokens, to for who is paid directly");
  const role = given("to") ? "to" : "spender";
  const str = (k, what = k) => {
    if (!given(k)) throw new TermsError(TERMS_CODES.MISSING, `missing parameter: ${what}`);
    return o[k].trim();
  };
  const written = { token: str("token"), [role]: str(role, "spender or to"), max_amount: str("max_amount"), expires_by: str("expires_by") };

  const token = w.tokens.find((t) => t.key === nameKey(written.token));
  if (!token) {
    throw new TermsError(TERMS_CODES.TOKEN, `the wallet knows no token named ${JSON.stringify(written.token)}; it knows ${listText(w.tokens.map((t) => t.symbol))}. If the user named another token, or did not say which, ask the user`);
  }
  const party = readParty(role, written[role], token, w);

  let amount;
  if (written.max_amount.toLowerCase() === "unlimited") amount = { units: null, unlimited: true };
  else {
    try {
      amount = { units: parseAmount(written.max_amount, { decimals: token.decimals, symbol: token.symbol, candid: token.chain === "evm" ? "uint256" : "nat" }), unlimited: false };
    } catch (e) {
      if (typeof e?.code !== "string") throw e;
      throw new TermsError(TERMS_CODES.AMOUNT, `max_amount: ${e.message}`); // refuses, never rounds
    }
  }

  const exp = written.expires_by;
  const today = dateOf(localDays(w.now, w.offset));
  let ends;
  const hours = HOURS.exec(exp);
  const length = LENGTH.exec(exp);
  if (exp.toLowerCase() === "never") ends = { never: true };
  else if (hours) ends = { at: secondsText((w.now / NS_PER_S) * NS_PER_S + BigInt(hours[1]) * 3600n * NS_PER_S) }; // from now in whole seconds: an exact time
  else {
    const date = length ? addLength(Number(length[1]), length[2].toLowerCase(), today) : readDate(exp);
    if (!date) {
      throw new TermsError(TERMS_CODES.END, `expires_by must be a date as YYYY-MM-DD, a length of time from now as a number and a unit (hours, days, weeks, months or years), such as "2 hours", "30 days" or "1 month", or "never"; got ${JSON.stringify(exp)}`);
    }
    if (date.y > 9999n) throw new TermsError(TERMS_CODES.END, `expires_by ${JSON.stringify(exp)} ends after the year 9999; write "never" only if the user plainly accepts no end`);
    if (daysFrom(date.y, date.m, date.d) < daysFrom(today.y, today.m, today.d)) throw new TermsError(TERMS_CODES.END, `expires_by ${isoDate(date)} is before today, ${isoDate(today)}`);
    ends = { at: secondsText(endOfDay(date, w.offset)), day: isoDate(date) };
  }
  return { token: token.id, symbol: token.symbol, decimals: token.decimals, [role]: party.id, name: party.name, amount, ends, utcOffsetMinutes: w.offset, written };
}

function readParty(role, text, token, w) {
  const evm = token.chain === "evm";
  if (evm && ADDRESS.test(text)) {
    try {
      const id = readAddress(text);
      return { id, name: appNamed(w, id) };
    } catch (e) {
      if (e?.code === "E_ADDRESS_CHECKSUM") throw new TermsError(TERMS_CODES.PARTY, `${role} ${text} is in mixed case, but its EIP-55 checksum does not match: a character may be mistyped. Ask the user to check the address`);
      throw new TermsError(TERMS_CODES.PARTY, `${role} ${JSON.stringify(text)} is not a 0x address with 40 hex digits`);
    }
  }
  if (!evm) {
    const id = partyId(text);
    if (id?.chain === "icp") return { id: id.id, name: appNamed(w, id.id) };
  }
  const what = evm ? "a 0x address" : "an account: a principal, or its ICRC-1 text with a subaccount";
  const app = w.apps.find((a) => a.key === nameKey(text));
  const here = w.apps.filter((a) => a.chain === token.chain).map((a) => a.name);
  if (!app && here.length === 0) throw new TermsError(TERMS_CODES.PARTY, `${role} must be ${what}; got ${JSON.stringify(text)}`);
  if (!app) {
    throw new TermsError(TERMS_CODES.PARTY, `the wallet knows no app named ${JSON.stringify(text)}; it knows ${listText(here)}. If the user named another app, or none, ask the user which app they mean, or for its ${evm ? "address" : "account"}`);
  }
  if (app.chain !== token.chain) {
    throw new TermsError(TERMS_CODES.PARTY, `the wallet has ${app.chain === "evm" ? "an EVM address" : "an Internet Computer account"} for ${app.name}, and ${token.symbol} is a token ${evm ? "on an EVM chain" : "on the Internet Computer"}; ask the user for ${what}`);
  }
  return { id: app.id, name: app.name };
}

/** Terms as readTerms wrote them (with `id` when confirmed), checked so that their text cannot say less than they allow. */
function termsOf(terms, { confirmed = false } = {}) {
  const bad = (why) => fail(CODES.REQUEST, `terms ${why}: they come from readTerms${confirmed ? ", then confirmTerms" : ""}`);
  if (!isObject(terms)) bad("must be an object");
  const role = terms.spender !== undefined ? "spender" : "to";
  const want = ["token", "symbol", "decimals", role, "name", "amount", "ends", "utcOffsetMinutes", "written", ...(confirmed ? ["id"] : [])];
  const keys = Object.keys(terms).filter((k) => !(k === "id" && !confirmed));
  if (keys.length !== want.length || !want.every((k) => Object.hasOwn(terms, k))) bad(`must have exactly ${want.join(", ")}`);
  const token = tokenId(terms.token);
  const party = partyId(terms[role]);
  if (!token || token.id !== terms.token) bad("name their token by its address (EIP-55) or canister id");
  if (!party || party.id !== terms[role] || party.chain !== token.chain) bad(`name their ${role} by an address (EIP-55) or an account (ICRC-1 text) on the token's chain`);
  if (terms.name !== null && (typeof terms.name !== "string" || !terms.name)) bad("name the party's app by a non-empty string, or null");
  try {
    displayAmount("0", { decimals: terms.decimals, symbol: terms.symbol });
  } catch (e) {
    bad(`have a symbol and decimals: ${e.message}`);
  }
  const { amount, ends, utcOffsetMinutes: offset } = terms;
  if (!isObject(amount) || Object.keys(amount).length !== 2 || typeof amount.unlimited !== "boolean" || (amount.unlimited ? amount.units !== null : typeof amount.units !== "string" || !NATURAL.test(amount.units))) {
    bad("give their amount as { units, unlimited: false } or { units: null, unlimited: true }");
  }
  if (!Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET_MINUTES) bad("give their zone in whole minutes");
  const keysOf = isObject(ends) ? Object.keys(ends).sort().join() : "";
  const at = keysOf === "at" || keysOf === "at,day" ? SECONDS.test(ends.at) && !ends.at.startsWith("-") : keysOf === "never" && ends.never === true;
  if (!at) bad("give their end as { at }, { at, day } or { never: true }");
  if (keysOf === "at,day") {
    const date = typeof ends.day === "string" ? readDate(ends.day) : null;
    if (!date || nsOf(ends.at) !== endOfDay(date, offset)) bad("end with the last moment of their day");
  }
  if (!isObject(terms.written) || !Object.values(terms.written).every((v) => typeof v === "string")) bad("keep what the agent wrote, as strings");
  if (confirmed && terms.id !== termsId(terms)) bad("are not the ones the user confirmed: they changed after confirmTerms");
  return terms;
}

const termsId = ({ id, ...rest }) => sha256Hex(jcs(rest));
const partyText = (name, id) => (name ? `${name} (${id})` : id);
const zoneOf = (offset) => `(${zoneName(offset)})`;
const mostText = (t) => displayAmount(t.amount.units, { decimals: t.decimals, symbol: t.symbol });
function untilText(t) {
  if (t.ends.day !== undefined) return `until the end of ${dayText(readDate(t.ends.day))} ${zoneOf(t.utcOffsetMinutes)}`;
  return `until ${timeText(nsOf(t.ends.at), t.utcOffsetMinutes)} ${zoneOf(t.utcOffsetMinutes)}`;
}

/**
 * The terms in words, for the user to confirm on the wallet's own screen: the full address, the amount without
 * rounding, and "any amount (unlimited)" or "never ends" written out (spec section 11 item 10). For example: "Uniswap
 * (0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af) may spend at most 500 USDC, until the end of 30 November 2026 (UTC)."
 */
export function termsText(terms) {
  const t = termsOf(terms, { confirmed: terms?.id !== undefined });
  const role = t.spender !== undefined ? "spender" : "to";
  const verb = role === "spender" ? "may spend" : "may be sent";
  const amount = t.amount.unlimited ? `any amount of ${t.symbol} (unlimited)` : `at most ${mostText(t)}`;
  const end = t.ends.never ? "and this permission never ends" : untilText(t);
  return `${partyText(t.name, t[role])} ${verb} ${amount}, ${end}.`;
}

/**
 * The terms as the user confirmed them, with `id`: the SHA-256 of their canonical JSON (RFC 8785), lowercase hex. Call it
 * only once the user has confirmed exactly `termsText(terms)` on the wallet's own screen. The result is frozen, and
 * checkGrant refuses terms whose id no longer matches.
 */
export function confirmTerms(terms) {
  const { id, ...rest } = isObject(terms) ? terms : {};
  termsOf(rest);
  return deepFreeze(structuredClone({ ...rest, id: termsId(rest) }));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** A grant from the consent functions, checked; its token and party as the terms write theirs. */
function grantOf(grant) {
  const bad = (why) => fail(CODES.REQUEST, `grant ${why}: it comes from evmConsent, eip712Consent or generateConsent`);
  if (!isObject(grant)) bad("must be an object or null");
  if (grant.kind !== "transfer" && grant.kind !== "approve") bad("has kind transfer or approve");
  if ((grant.spender === undefined) === (grant.to === undefined)) bad("names spender or to");
  const role = grant.spender !== undefined ? "spender" : "to";
  const token = tokenId(grant.token);
  const party = partyId(grant[role]);
  if (!token || !party || token.chain !== party.chain) bad(`names its token and its ${role} on one chain`);
  const { amount, ends } = grant;
  if (!isObject(amount) || typeof amount.unlimited !== "boolean" || !(amount.units === null ? amount.unlimited : typeof amount.units === "string" && NATURAL.test(amount.units))) bad("gives its amount as { units, unlimited }");
  const end = isObject(ends) ? Object.keys(ends).join() : "";
  if (!(end === "at" ? typeof ends.at === "string" && SECONDS.test(ends.at) : (end === "never" && ends.never === true) || (end === "now" && ends.now === true))) bad("ends { at }, { never: true } or { now: true }");
  return { role, token: token.id, party: party.id, amount, ends };
}

/**
 * Whether a request's grant fits terms the user confirmed (spec section 5.3, "Confirmed terms"): its token and its
 * spender or recipient are the terms', its amount is at most the terms' most (unlimited only under unlimited terms; a
 * grant of nothing fits any), and it ends no later than the terms' end (one that never ends only under terms that never
 * end; a transfer while the terms have not ended). A request that fits may be signed or sent without a second yes. One
 * that does not is refused with the reasons, and the agent asks the user for new terms. A request without a grant
 * (`null`) is not covered by terms and needs its confirmation.
 *
 * @param {object} confirmed  confirmTerms' result, unchanged
 * @param {object | null} grant  the `grant` of evmConsent, eip712Consent or generateConsent
 * @param {Wallet} wallet  its clock, and the names it shows: its tokens and apps
 * @returns {{ fits: boolean, reasons: string[] }}
 */
export function checkGrant(confirmed, grant, wallet) {
  const t = termsOf(confirmed, { confirmed: true });
  const w = walletOf(wallet);
  if (grant === null || grant === undefined) {
    return { fits: false, reasons: ["the request has no grant a profile describes, so no terms cover it: it needs the user's confirmation"] };
  }
  const g = grantOf(grant);
  const role = t.spender !== undefined ? "spender" : "to";
  const tokenName = (id) => w.tokens.find((k) => k.id === id)?.symbol ?? id;
  const named = (id) => partyText(appNamed(w, id), id);
  const terms = partyText(t.name, t[role]);
  const reasons = [];
  const sameToken = g.token === t.token;
  if (!sameToken) reasons.push(`the request is for ${tokenName(g.token)}, the terms say ${t.symbol}`);
  if (g.role !== role) reasons.push(role === "spender" ? `the request pays ${named(g.party)} directly, the terms let ${terms} spend` : `the request lets ${named(g.party)} spend, the terms pay ${terms} directly`);
  else if (g.party !== t[role]) reasons.push(`the ${role === "spender" ? "spender" : "recipient"} is ${named(g.party)}, the terms say ${terms}`);
  if (sameToken && !t.amount.unlimited) {
    if (g.amount.unlimited) reasons.push(`the request is unlimited, the terms say at most ${mostText(t)}`);
    else if (BigInt(g.amount.units) > BigInt(t.amount.units)) reasons.push(`the request allows ${displayAmount(g.amount.units, { decimals: t.decimals, symbol: t.symbol })}, the terms say at most ${mostText(t)}`);
  }
  if (!t.ends.never) {
    const end = nsOf(t.ends.at);
    if (g.ends.never) reasons.push(`the permission never ends, the terms say ${untilText(t)}`);
    else if (g.ends.now) {
      if (w.now > end) reasons.push(`the terms have ended: they said ${untilText(t)}`);
    } else if (nsOf(g.ends.at) > end) reasons.push(`the permission lasts until ${timeText(nsOf(g.ends.at), t.utcOffsetMinutes)} ${zoneOf(t.utcOffsetMinutes)}, the terms say ${untilText(t)}`);
  }
  return { fits: reasons.length === 0, reasons };
}

/**
 * The order of one task, kept (spec section 5.3, "Confirmed terms"; the order surface D2 of the everyday-wording test
 * kept): the agent proposes terms, the user confirms exactly their text on the wallet's own screen, the agent reads the
 * request, and its grant is checked. Once the request is read the terms cannot change: new terms are a new task, with a
 * new gate. The terms cover one request, the first checked, named by the id the wallet gives it. Steps out of order
 * throw TermsError E_TERMS_ORDER, with a message for the agent.
 */
export function termsGate() {
  let proposed = null;
  let confirmed = null;
  let read = false;
  let request = null;
  const order = (why) => {
    throw new TermsError(TERMS_CODES.ORDER, why);
  };
  const fixed = () => read && order("the request was read under the confirmed terms, so they cannot be changed now; new terms start a new task");
  return {
    /** "open", "proposed", "confirmed" or "read". */
    get state() {
      return read ? "read" : confirmed ? "confirmed" : proposed ? "proposed" : "open";
    },
    /** The terms waiting for the user, or null. */
    get proposed() {
      return proposed;
    },
    /** The terms the user confirmed, or null. */
    get confirmed() {
      return confirmed;
    },
    /** The agent's draft, readTerms' terms. It replaces an earlier draft and its confirmation. Returns the text to show the user. */
    propose(terms) {
      fixed();
      const { id, ...draft } = isObject(terms) ? terms : {};
      proposed = deepFreeze(structuredClone(termsOf(draft)));
      confirmed = null;
      return termsText(proposed);
    },
    /** The wallet, when the user confirmed `shown` on its own screen: it must be exactly termsText of the draft. Returns the confirmed terms. */
    confirm(shown) {
      fixed();
      if (proposed === null) order("there are no terms to confirm: the agent proposes them first");
      if (shown !== termsText(proposed)) order("the text the user confirmed is not the text of the terms proposed; show termsText(gate.proposed) and ask again");
      confirmed = confirmTerms(proposed);
      return confirmed;
    },
    /** The user said no: the draft is dropped, and the agent may propose other terms or ask the user. */
    reject() {
      fixed();
      proposed = null;
      confirmed = null;
    },
    /** Before the agent reads the request: refused until the user has confirmed terms. */
    read() {
      if (confirmed === null) order(proposed ? "the user has not confirmed the terms yet; the request can be read once they do" : "there are no terms yet: propose the user's terms, and read the request once the user confirms them");
      read = true;
    },
    /**
     * The grant of the request read, against the confirmed terms: checkGrant's { fits, reasons }. `requestId` names the
     * request the wallet will sign or send: eip712Consent's `digest`, or for a call the wallet's own id of it (an EVM
     * transaction's hash, an Internet Computer request's id). The same request may be checked again; another is refused
     * even when it grants the same, since two Permit2 transfers that differ only in their nonce are two transfers.
     */
    check(grant, wallet, requestId) {
      if (!read) order("read the request first: its grant is checked against the terms it was read under");
      if (typeof requestId !== "string" || requestId === "") fail(CODES.REQUEST, "termsGate's check needs the request's id: eip712Consent's digest, or the wallet's own id of a call");
      const result = checkGrant(confirmed, grant, wallet);
      const key = jcs(grant ?? null);
      if (request !== null && (requestId !== request.id || key !== request.grant)) order("these terms cover one request, the one already checked; another request is a new task, with new terms");
      request = { id: requestId, grant: key };
      return result;
    },
  };
}
