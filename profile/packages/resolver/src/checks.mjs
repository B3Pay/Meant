/**
 * Per-annotation semantic checks (spec sections 3 to 6). Moved verbatim from scripts/validate.mjs.
 */
import { AbiError, readAddress } from "./abi.mjs";
import { parseRelPath } from "./address.mjs";

/** EVM integer types (spec section 15): uint8 to uint256 and int8 to int256. int8 to int64 are also Candid's, with the same bounds. */
const ABI_BITS = Array.from({ length: 32 }, (_, i) => 8 * (i + 1));
export const NUMERIC = new Set(["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64", ...ABI_BITS.flatMap((b) => [`uint${b}`, `int${b}`])]);
export const TIMEISH = new Set(["nat", "int", "nat32", "nat64", "int64", ...ABI_BITS.filter((b) => b >= 32).map((b) => `uint${b}`), ...ABI_BITS.filter((b) => b >= 64).map((b) => `int${b}`)]);
/** Text: Candid's `text`, the ABI's `string`. */
export const TEXT = new Set(["text", "string"]);
/** Tags an EVM contract profile cannot use yet: they need receipts, nonces or reads that phase 2 adds (spec section 15). */
export const EVM_LATER_TAGS = new Set(["idempotency", "outcome", "list", "names", "named"]);
export const METHOD_TAGS = new Set(["intent", "effect", "idempotency", "outcome", "list", "names"]);
/** Method tags that may also sit on a case of a variant in the arguments (spec 5.2, D-053). */
export const CASE_TAGS = new Set(["intent", "effect"]);
/** Effect kinds that need a person's confirmation (spec 5.3). */
export const CONFIRM_KINDS = new Set(["transfer", "approve", "admin", "destroy"]);
/** Tags that convert a value between its wire form and a human form; a stale profile must not supply them (spec section 7). */
export const VALUE_CONVERSION_TAGS = new Set(["amount", "timestamp", "duration", "account", "subaccount", "bytes", "named"]);
export const STALE_CODES = new Set(["E_ADDR_UNRESOLVED", "E_TYPE_NODE", "E_TAG_NOT_APPLICABLE", "E_REF_UNRESOLVED", "E_REF_NOT_QUERY", "E_REF_SHAPE", "E_REF_TYPE", "E_STAMP_UNTAGGED", "E_OUTCOME_NOT_CASE", "E_TEMPLATE_PATH", "E_TAG_TARGET", "E_NAMES_MODE", "E_NAMES_SHAPE", "E_NAMES_FIELD", "E_NAMED_SET", "E_NAMED_TYPE", "E_CASE_OVERLAP", "E_CASE_EFFECT", "E_TOKEN_PATH", "E_GRANT"]);

/**
 * Why a pin (`fixed`, spec 15.4, D-058) does not hold, as `{ code, message }`, or null. A pin sits on an `address` in the
 * arguments of an EVM function or message, where a consumer reads it from what is sent or signed before any text, and
 * its value is an address (§15.2: in mixed case, with its EIP-55 checksum).
 */
export function pinError(iface, addr, res, value) {
  if (res.method || addr.kind !== "arg") return { code: "E_TAG_TARGET", message: "fixed pins a value in the arguments of a function or a message, where a consumer reads it before it shows text" };
  const wrong = checkApplicability(iface, "fixed", res.ref);
  if (wrong) return { code: "E_TAG_NOT_APPLICABLE", message: wrong };
  try {
    readAddress(String(value));
  } catch (e) {
    if (!(e instanceof AbiError)) throw e;
    return { code: "E_ADDRESS_CHECKSUM", message: `fixed: ${e.message}` };
  }
  return null;
}

export function checkApplicability(iface, tag, ref) {
  const { ref: r } = iface.unwrapOpt(ref);
  const p = iface.prim(r);
  if (iface.chain === "evm" && (tag === "account" || tag === "subaccount")) return `${tag} is an ICRC type; an EVM address needs no tag (it is shown with its EIP-55 checksum, spec section 15)`;
  switch (tag) {
    case "amount": return NUMERIC.has(p) ? null : `amount needs a numeric type, found ${iface.describeType(ref)}`;
    case "timestamp":
    case "duration": return TIMEISH.has(p) ? null : `${tag} needs ${iface.chain === "evm" ? "uint32 to uint256 or int64 to int256" : "nat/int/nat32/nat64/int64"}, found ${iface.describeType(ref)}`;
    case "account": return iface.isAccount(r) ? null : `account needs record { owner : principal; subaccount : opt blob }, found ${iface.describeType(ref)}`;
    case "subaccount":
    case "bytes": return iface.isBlob(r) ? null : `${tag} needs ${iface.chain === "evm" ? "bytes or bytesN" : "blob"}, found ${iface.describeType(ref)}`;
    case "text": return TEXT.has(p) ? null : `text needs ${iface.chain === "evm" ? "string" : "text"}, found ${iface.describeType(ref)}`;
    case "range": return NUMERIC.has(p) || TEXT.has(p) || iface.node(r).kind === "vec" ? null : `range needs numeric, text or vec, found ${iface.describeType(ref)}`;
    case "fixed":
      if (iface.chain !== "evm") return "fixed pins an EVM address; a Candid position cannot carry it yet (spec section 15.4)";
      return p === "address" ? null : `fixed needs an address, found ${iface.describeType(ref)}`;
    default: return null;
  }
}

/**
 * An amount's `token` (spec section 15.9): a path from the arguments of the same function or message to the `address`
 * of the token the amount is in, through the same array elements as the amount. The reason it is wrong, or null.
 */
export function tokenPathError(iface, addr, token) {
  if (iface.chain !== "evm") return "token names the address of an EVM token; a Candid amount's ledger cannot be named by a field yet (OQ-6)";
  if (addr.kind !== "arg") return "an amount with a token sits in the arguments of a function or message, where the token's address is";
  const p = parseRelPath(token);
  const r = iface.resolveRel(addr.method, "args", token);
  if (!p || r.error) return `token ${JSON.stringify(token)}: ${r.error ?? "not a relative path"}`;
  if ((p.index ?? 0) !== addr.index) return `token ${JSON.stringify(token)} is in another argument than the amount`;
  if (iface.prim(r.ref) !== "address") return `token ${JSON.stringify(token)} is ${iface.describeType(r.ref)}, not an address`;
  const last = p.segs.findLastIndex((s) => s.kind === "elem");
  const same = (a, b) => a.kind === b.kind && (a.kind === "elem" || a.id === b.id);
  if (last >= 0 && (addr.segs.length <= last || !p.segs.slice(0, last + 1).every((s, i) => same(s, addr.segs[i])))) {
    return `token ${JSON.stringify(token)} must be in the same array element as the amount: its path up to its last [] must be the amount's`;
  }
  return null;
}

/**
 * An effect's grant (spec 5.3, D-056): who may take the tokens, how many and until when, as positions in the arguments
 * of the method the effect is on. `tags` is the merged view: the amount, timestamp and account tags a grant needs may
 * come from another profile. The reason it is wrong, or null.
 */
export function grantError(iface, tags, methodName, { kind, grant }) {
  if (kind !== "transfer" && kind !== "approve") return `a grant goes with effect kind transfer or approve, not ${kind}`;
  if ((grant.spender === undefined) === (grant.to === undefined)) return "a grant names exactly one of spender and to";
  if (kind === "approve" && grant.to !== undefined) return "an approve's grant names a spender: an allowance is taken by its spender, not paid to it";
  const at = (name, rel, mayBeAbsent) => {
    const p = parseRelPath(rel);
    const r = iface.resolveRel(methodName, "args", rel);
    const what = `grant ${name} ${JSON.stringify(rel)}`;
    if (!p || r.error) return { error: `${what}: ${r.error ?? "not a relative path"}` };
    if (p.segs.some((s) => s.kind === "elem")) return { error: `${what} steps into []: a grant covers one token, so a request that grants several has none` };
    // The value must be in every call: no case of a variant on the way, and no opt unless it may be left out.
    let cur = iface.methods.get(methodName).args[p.index ?? 0];
    let optional = false;
    for (const s of p.segs) {
      const u = iface.unwrapOpt(cur);
      optional ||= u.optional;
      const n = iface.node(u.ref);
      if (n.kind === "variant") return { error: `${what} passes through a case of a variant, so a call need not hold it` };
      cur = n.fields.find((f) => f.id === s.id).type;
    }
    if ((optional || iface.unwrapOpt(cur).optional) && !mayBeAbsent) return { error: `${what} is optional, but a grant needs its ${name} in every call` };
    return { r, t: tags.at(r, iface) ?? {} };
  };
  const who = grant.spender !== undefined ? "spender" : "to";
  const party = at(who, grant[who], false);
  if (party.error) return party.error;
  if (iface.prim(party.r.ref) !== "address" && !party.t.account) {
    return `grant ${who} ${JSON.stringify(grant[who])} is ${iface.describeType(party.r.ref)}; it must be an address or carry an account tag`;
  }
  const amount = at("amount", grant.amount, false);
  if (amount.error) return amount.error;
  const p = iface.prim(amount.r.ref);
  if (p !== "bool") {
    if (!amount.t.amount) return `grant amount ${JSON.stringify(grant.amount)} is ${iface.describeType(amount.r.ref)} without an amount tag; it must carry one, or be a bool`;
    if (!/^(nat|uint)/.test(p)) return `grant amount ${JSON.stringify(grant.amount)} is ${p}; an amount granted is never negative, so its type is unsigned`;
  }
  for (const rel of grant.ends ?? []) {
    const end = at("ends", rel, true);
    if (end.error) return end.error;
    if (!end.t.timestamp) return `grant ends ${JSON.stringify(rel)} has no timestamp tag`;
  }
  return null;
}

export function checkDynamic(iface, value, want, diag, at) {
  if (!value || typeof value !== "object") return;
  const from = value.from;
  if (from === "now" || from === "caller") {
    if (want !== "any") diag("error", "E_DYNAMIC_KIND", at, `"${from}" is not valid here; expected query:<method> returning ${want}`);
    return;
  }
  const name = from.slice("query:".length);
  const m = iface.methods.get(name);
  if (!m) return diag("error", "E_REF_UNRESOLVED", at, `dynamic ref "${from}": no method "${name}" in the interface`);
  if (m.mode !== "query" && m.mode !== "composite_query") diag("error", "E_REF_NOT_QUERY", at, `dynamic ref "${from}" must be a query method`);
  if (m.args.length !== 0 || m.results.length !== 1) diag("error", "E_REF_SHAPE", at, `dynamic ref "${from}" must take no arguments and return one value`);
  else {
    const p = iface.prim(iface.unwrapOpt(m.results[0]).ref);
    if (want === "numeric" && !NUMERIC.has(p)) diag("error", "E_REF_TYPE", at, `"${from}" returns ${p}, expected a number`);
    if (want === "text" && !TEXT.has(p)) diag("error", "E_REF_TYPE", at, `"${from}" returns ${p}, expected text`);
  }
}

export function parseTemplate(t) {
  const placeholders = [];
  let depth = 0;
  let segments = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ((c === "{" || c === "}" || c === "[" || c === "]") && t[i + 1] === c) { i++; continue; } // escaped
    if (c === "[") { if (depth) return { error: "nested [ ] segments are not allowed in v0" }; depth = 1; segments++; }
    else if (c === "]") { if (!depth) return { error: "unbalanced ]" }; depth = 0; }
    else if (c === "{") {
      const end = t.indexOf("}", i);
      if (end < 0) return { error: "unclosed {" };
      placeholders.push({ path: t.slice(i + 1, end), inOptional: depth === 1 });
      i = end;
    } else if (c === "}") return { error: "unbalanced }" };
  }
  if (depth) return { error: "unclosed [" };
  return { placeholders, segments };
}

export function outcomeCoverage(iface, methodName, classes, diag, at, hasDefault) {
  const m = iface.methods.get(methodName);
  if (m.results.length !== 1) return;
  const visit = (ref, prefix) => {
    const { ref: r } = iface.unwrapOpt(ref);
    const n = iface.node(r);
    if (n.kind !== "variant") return;
    for (const f of n.fields) {
      const key = `${prefix}${iface.fieldName(r, f.id)}`;
      if (classes[key]) continue;
      const inner = iface.node(iface.unwrapOpt(f.type).ref);
      if (inner.kind === "variant" && Object.keys(classes).some((k) => k.startsWith(`${key}.`))) visit(f.type, `${key}.`);
      else diag(hasDefault ? "info" : "warning", "W_OUTCOME_UNCLASSIFIED", at, `result case "${key}" has no class${hasDefault ? " (falls back to default)" : ""}`);
    }
  };
  visit(m.results[0], "");
}

/** The effect a method has without an effect tag (spec 5.3): queries read, updates write irreversibly. */
export function defaultEffect(mode) {
  return mode === "query" || mode === "composite_query" ? { kind: "read", irreversible: false } : { kind: "write", irreversible: true };
}

/** Why an intent or effect at a value address is not on a case of an argument (spec 5.2, D-053), or null. */
export function caseTargetError(iface, addr, res, tag) {
  if (addr.kind === "type") return `${tag} sits on a method or on a case of a variant in its arguments, never at a type: address (it can reach several methods)`;
  if (addr.kind === "result") return `${tag} sits on a method or on a case of a variant in its arguments, not in its results`;
  if (addr.segs.some((s) => s.kind === "elem")) return `${tag} on a case cannot step into a vector element ([]): one call holds many elements`;
  if (res.parent?.kind !== "variant") return `${tag} sits on a method or on a case of a variant in its arguments; this address ends on ${res.parent ? "a record field" : "a whole argument"}`;
  return null;
}

/**
 * Walk two segment lists of one method argument side by side. Returns where they part: { kind } of the container at
 * the first differing step, with the two labels, or null when one is a prefix of the other.
 */
function part(iface, start, a, b) {
  let cur = start;
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    cur = iface.unwrapOpt(cur).ref;
    const n = iface.node(cur);
    const x = a[k];
    const y = b[k];
    if (x.kind === "elem" || y.kind === "elem") {
      if (x.kind === y.kind) { cur = n.inner; continue; }
      return { kind: n.kind };
    }
    if (x.id !== y.id) return { kind: n.kind, a: x.label, b: y.label };
    cur = n.fields.find((f) => f.id === x.id).type;
  }
  return null;
}

/**
 * A case template's placeholder that selects another case of a variant the case address passes through, so it can
 * never be present (spec section 6, D-053): the reason, or null. Both paths resolve; `rel` is a method-tuple relpath.
 */
export function otherCase(iface, caseAddr, rel) {
  const p = parseRelPath(rel);
  const index = p.index ?? 0;
  if (index !== caseAddr.index) return null;
  const m = iface.methods.get(caseAddr.method);
  const at = part(iface, m.args[index], caseAddr.segs, p.segs);
  return at?.kind === "variant" ? `selects case "${at.b}" of a variant where this intent's case takes "${at.a}", so it is never present` : null;
}

/**
 * Whether one call can take two tagged cases of one method (spec 5.2, D-053): the reason, or null when they exclude
 * each other (they part at a variant) or nest.
 */
export function overlap(iface, a, b) {
  if (a.index !== b.index) return "they sit in different arguments";
  const m = iface.methods.get(a.method);
  const at = part(iface, m.args[a.index], a.segs, b.segs);
  return at && at.kind !== "variant" ? "their paths part at a record field" : null;
}
