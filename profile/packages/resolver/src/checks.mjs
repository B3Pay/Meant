/**
 * Per-annotation semantic checks (spec sections 3 to 6). Moved verbatim from scripts/validate.mjs.
 */
export const NUMERIC = new Set(["nat", "int", "nat8", "nat16", "nat32", "nat64", "int8", "int16", "int32", "int64"]);
export const TIMEISH = new Set(["nat", "int", "nat32", "nat64", "int64"]);
export const METHOD_TAGS = new Set(["intent", "effect", "idempotency", "outcome", "list", "names"]);
/** Tags that convert a value between its wire form and a human form; a stale profile must not supply them (spec section 7). */
export const VALUE_CONVERSION_TAGS = new Set(["amount", "timestamp", "duration", "account", "subaccount", "bytes", "named"]);
export const STALE_CODES = new Set(["E_ADDR_UNRESOLVED", "E_TYPE_NODE", "E_TAG_NOT_APPLICABLE", "E_REF_UNRESOLVED", "E_REF_NOT_QUERY", "E_REF_SHAPE", "E_REF_TYPE", "E_STAMP_UNTAGGED", "E_OUTCOME_NOT_CASE", "E_TEMPLATE_PATH", "E_TAG_TARGET", "E_NAMES_MODE", "E_NAMES_SHAPE", "E_NAMES_FIELD", "E_NAMED_SET", "E_NAMED_TYPE"]);

export function checkApplicability(iface, tag, ref) {
  const { ref: r } = iface.unwrapOpt(ref);
  const p = iface.prim(r);
  switch (tag) {
    case "amount": return NUMERIC.has(p) ? null : `amount needs a numeric type, found ${iface.describeType(ref)}`;
    case "timestamp":
    case "duration": return TIMEISH.has(p) ? null : `${tag} needs nat/int/nat32/nat64/int64, found ${iface.describeType(ref)}`;
    case "account": return iface.isAccount(r) ? null : `account needs record { owner : principal; subaccount : opt blob }, found ${iface.describeType(ref)}`;
    case "subaccount":
    case "bytes": return iface.isBlob(r) ? null : `${tag} needs blob, found ${iface.describeType(ref)}`;
    case "text": return p === "text" ? null : `text needs text, found ${iface.describeType(ref)}`;
    case "range": return NUMERIC.has(p) || p === "text" || iface.node(r).kind === "vec" ? null : `range needs numeric, text or vec, found ${iface.describeType(ref)}`;
    default: return null;
  }
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
    if (want === "text" && p !== "text") diag("error", "E_REF_TYPE", at, `"${from}" returns ${p}, expected text`);
  }
}

export function parseTemplate(t) {
  const placeholders = [];
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ((c === "{" || c === "}" || c === "[" || c === "]") && t[i + 1] === c) { i++; continue; } // escaped
    if (c === "[") { if (depth) return { error: "nested [ ] segments are not allowed in v0" }; depth = 1; }
    else if (c === "]") { if (!depth) return { error: "unbalanced ]" }; depth = 0; }
    else if (c === "{") {
      const end = t.indexOf("}", i);
      if (end < 0) return { error: "unclosed {" };
      placeholders.push({ path: t.slice(i + 1, end), inOptional: depth === 1 });
      i = end;
    } else if (c === "}") return { error: "unbalanced }" };
  }
  if (depth) return { error: "unclosed [" };
  return { placeholders };
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
