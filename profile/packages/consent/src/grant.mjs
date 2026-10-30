// What a call or a signature grants (docs/profile-v0.md section 5.3, D-056): who may take tokens because of it, which
// token, how many and until when, read from its effect's `grant` and its decoded values. A wallet compares it with the
// terms the user confirmed (`@meantjs/consent/terms`).
//
// A grant that cannot be read is no grant: `null`, with a W_GRANT diagnostic. The request then needs its confirmation,
// as any request without a grant does, and the consent text is the same either way.

import { displayAccount, principalFromText, principalToText } from "@meantjs/format";
import { CODES, fail } from "./errors.mjs";
import { callTag, tagArgs } from "./resolved.mjs";
import { resolvePath, valuesAt } from "./paths.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NATURAL = /^(0|[1-9][0-9]*)$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
/** Nanoseconds per unit of a `timestamp` tag (spec section 5.3); every grant end is compared in nanoseconds, exactly. */
const NS = { s: 1_000_000_000n, ms: 1_000_000n, us: 1_000n, ns: 1n };

/** Nanoseconds as exact seconds: a decimal string with a fraction only when there is one, never rounded. */
export function secondsText(ns) {
  const sign = ns < 0n ? "-" : "";
  const a = ns < 0n ? -ns : ns;
  const frac = (a % NS.s).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${a / NS.s}${frac ? `.${frac}` : ""}`;
}

/** The canonical text of a canister id; anything else is E_REQUEST. */
export function canisterText(id) {
  try {
    return principalToText(principalFromText(id));
  } catch {
    fail(CODES.REQUEST, `canisterId must be a principal's text, got ${JSON.stringify(String(id))}`);
  }
}

class Skip extends Error {}

/**
 * @param {object} input
 * @param {string} input.name  the method or message, for the diagnostic
 * @param {object} input.method  its resolved-form entry (an EVM one as abiView reads it)
 * @param {unknown[]} input.argValues  its decoded arguments, before any amount is boxed with its token
 * @param {string | undefined} input.called  the contract or canister the call is for: the token, unless the amount's
 *   tag names a field that holds it (spec section 15.9)
 * @param {object[]} input.diagnostics  where W_GRANT goes
 * @returns {null | { kind: "transfer" | "approve", spender?: string, to?: string, token: string,
 *   amount: { units: string | null, unlimited: boolean }, ends: { at: string } | { never: true } | { now: true } }}
 */
export function grantOf({ name, method, argValues, called, diagnostics }) {
  const effect = callTag(method, argValues, "effect");
  const grant = effect?.args?.grant;
  if (grant === undefined) return null;
  try {
    return read(method, argValues, effect, grant, called);
  } catch (e) {
    if (!(e instanceof Skip)) throw e;
    diagnostics.push({ code: "W_GRANT", at: name, message: `${e.message}; the request has no grant, so terms the user confirmed cannot cover it` });
    return null;
  }
}

function read(method, argValues, effect, grant, called) {
  const skip = (why) => {
    throw new Skip(why);
  };
  if (effect !== method.tags?.effect) skip("a grant on the effect of a case is not read in this version (D-056)");
  const { kind } = effect.args;
  if (kind !== "transfer" && kind !== "approve") skip(`a grant goes with effect kind transfer or approve, not ${String(kind)}`);
  if (!isObject(grant) || (grant.spender === undefined) === (grant.to === undefined)) skip("the grant names neither or both of spender and to");

  /** The one value at a grant position: no [] and no case of a variant on the way, so a call holds it once at most. */
  const at = (what, path, mayBeAbsent = false) => {
    if (typeof path !== "string") skip(`grant ${what} is not a path`);
    const rp = resolvePath(method, path);
    if (rp.error) skip(`grant ${what} ${JSON.stringify(path)}: ${rp.error}`);
    if (rp.steps.some((s) => s.kind !== "field")) skip(`grant ${what} ${JSON.stringify(path)} steps into [] or a case of a variant`);
    const values = valuesAt(rp, argValues);
    if (values.length === 0 && !mayBeAbsent) skip(`grant ${what} ${JSON.stringify(path)} is absent from this call`);
    return { node: rp.node, value: values[0] };
  };

  const who = grant.spender !== undefined ? "spender" : "to";
  const party = at(who, grant[who]);
  let address;
  if (party.node.abi === "address" && typeof party.value === "string") address = party.value; // EIP-55, as decoded
  else if (tagArgs(party.node, "account") !== undefined && isObject(party.value)) {
    try {
      address = displayAccount(party.value);
    } catch (e) {
      skip(`grant ${who}: ${e.message}`);
    }
  } else skip(`grant ${who} ${JSON.stringify(grant[who])} is neither an address nor an account`);

  const amt = at("amount", grant.amount);
  const tag = tagArgs(amt.node, "amount");
  let amount;
  if ((amt.node.abi ?? amt.node.candid) === "bool" && typeof amt.value === "boolean") {
    amount = amt.value ? { units: null, unlimited: true } : { units: "0", unlimited: false }; // DAI's allowed (spec 15.9)
  } else {
    if (tag === undefined || typeof amt.value !== "string" || !NATURAL.test(amt.value)) skip(`grant amount ${JSON.stringify(grant.amount)} is neither an amount nor a bool`);
    if (tag.threshold !== undefined && (typeof tag.threshold !== "string" || !NATURAL.test(tag.threshold))) skip("the amount tag's threshold is not a decimal string");
    amount = { units: amt.value, unlimited: tag.threshold !== undefined && BigInt(amt.value) >= BigInt(tag.threshold) };
  }

  let token;
  if (tag?.token !== undefined) {
    const t = at("amount token", tag.token);
    if (t.node.abi !== "address" || typeof t.value !== "string") skip(`the amount's token ${JSON.stringify(tag.token)} is not an address`);
    token = t.value;
  } else if (typeof called === "string") token = called;
  else skip("the canister the call is for was not given (canisterId), so its token is not known");

  let ends;
  if (grant.ends === undefined) ends = kind === "approve" ? { never: true } : { now: true };
  else {
    if (!Array.isArray(grant.ends) || grant.ends.length === 0) skip("grant ends is not a list of paths");
    let latest = null;
    let never = false;
    for (const path of grant.ends) {
      const end = at("ends", path, true);
      if (end.value === undefined) { // an optional end left out: the grant never ends (spec 5.3)
        never = true;
        continue;
      }
      const ts = tagArgs(end.node, "timestamp");
      if (ts === undefined || !Object.hasOwn(NS, ts.unit) || (ts.epoch ?? "unix") !== "unix" || typeof end.value !== "string" || !INTEGER.test(end.value)) {
        skip(`grant ends ${JSON.stringify(path)} is not a unix timestamp`);
      }
      if (ts.threshold !== undefined && (typeof ts.threshold !== "string" || !NATURAL.test(ts.threshold))) skip(`the timestamp tag of ${JSON.stringify(path)} has a threshold that is not a decimal string`);
      if (ts.threshold !== undefined && BigInt(end.value) >= BigInt(ts.threshold)) { // at its threshold: never (spec 5.3)
        never = true;
        continue;
      }
      const ns = BigInt(end.value) * NS[ts.unit]; // a label is how a value is shown; here it is the time it is
      if (latest === null || ns > latest) latest = ns;
    }
    ends = never ? { never: true } : { at: secondsText(latest) };
  }
  return { kind, [who]: address, token, amount, ends };
}
