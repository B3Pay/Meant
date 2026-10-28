// Read-only accessors over the resolved form (docs/profile-v0.md section 10). The resolved form is data from
// a resolver, so nothing here trusts its shape beyond what the code reads.

import { idlHash } from "@meantjs/profile/address";
import { CODES, fail } from "./errors.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The method entry of a resolved form, or a ConsentError. */
export function methodOf(resolved, name) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods)) {
    fail(CODES.RESOLVED_FORM, "not a candid-profile-resolved document (format, methods)");
  }
  if (typeof name !== "string" || !Object.hasOwn(resolved.methods, name)) {
    fail(CODES.METHOD_UNKNOWN, `the resolved form has no method ${JSON.stringify(String(name))}`);
  }
  const m = resolved.methods[name];
  if (!isObject(m) || !Array.isArray(m.args)) fail(CODES.RESOLVED_FORM, `method ${name} has no args array`);
  return m;
}

/** The Candid field or case id of a resolved-form key: `#123` is the raw id, any other key is a name. */
export function keyId(key) {
  return /^#(0|[1-9][0-9]{0,9})$/.test(key) ? Number(key.slice(1)) : idlHash(key);
}

/** Own entries of a `fields` or `cases` object (never walks the prototype chain). */
export function entriesOf(bucket) {
  return isObject(bucket) ? Object.entries(bucket) : [];
}

/** `describe.label` of a position or method, when it is a non-empty string. */
export function labelOf(node) {
  const label = node?.tags?.describe?.args?.label;
  return typeof label === "string" && label.trim() !== "" ? label : undefined;
}

export function tagArgs(node, tag) {
  return node?.tags && Object.hasOwn(node.tags, tag) ? (node.tags[tag]?.args ?? {}) : undefined;
}

/** The effect kind of a method: its tag, or the spec default (section 5.3: queries read, updates write). */
export function effectKind(method) {
  return method.tags?.effect?.args?.kind ?? (method.mode === "query" || method.mode === "composite_query" ? "read" : "write");
}
