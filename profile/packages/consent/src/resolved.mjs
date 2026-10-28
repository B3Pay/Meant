// Read-only accessors over the resolved form (docs/profile-v0.md section 10). The resolved form is data from
// a resolver, so nothing here trusts its shape beyond what the code reads.

import { idlHash } from "@meantjs/profile/address";
import { CODES, fail } from "./errors.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The method entry of a resolved form, or a ConsentError. `chain` is "evm" for an EVM contract's form (spec section 15);
 * a Candid entry point never reads one, whose positions are ABI types, not Candid.
 */
export function methodOf(resolved, name, chain = undefined) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods)) {
    fail(CODES.RESOLVED_FORM, "not a candid-profile-resolved document (format, methods)");
  }
  if (resolved.chain !== chain) {
    fail(CODES.RESOLVED_FORM, resolved.chain === "evm" ? "this resolved form is an EVM contract's (chain evm): use evmConsent, not a Candid entry point" : `expected the resolved form of an EVM contract (chain evm), found ${resolved.chain === undefined ? "a Candid service's" : `chain ${JSON.stringify(resolved.chain)}`}`);
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

/**
 * A position of an EVM contract's resolved form (spec section 15) read as the Candid shapes the model walks: a tuple is
 * a record, an array a vec, any other ABI type a primitive of that name. `abi` is kept, so display writes ABI text.
 */
export function abiView(node, where, depth = 0) {
  if (!isObject(node) || typeof node.abi !== "string") fail(CODES.RESOLVED_FORM, `${where}: not an EVM resolved-form position`);
  if (depth > 64) fail(CODES.UNSUPPORTED_TYPE, `${where}: nested deeper than 64`);
  if (node.abi === "tuple") {
    return { ...node, candid: "record", fields: Object.fromEntries(entriesOf(node.fields).map(([k, c]) => [k, abiView(c, `${where}.${k}`, depth + 1)])) };
  }
  if (node.abi === "array") return { ...node, candid: "vec", element: abiView(node.element, `${where}[]`, depth + 1) };
  return { ...node, candid: node.abi };
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

/**
 * The effect kind of a call: its effect tag (the call's, `callTag`; the method's by default), or the spec default
 * (section 5.3: queries read, updates write).
 */
export function effectKind(method, tag = method.tags?.effect) {
  return tag?.args?.kind ?? (method.mode === "query" || method.mode === "composite_query" ? "read" : "write");
}

/**
 * The `intent` or `effect` entry (`{ args, origin, profile }`) a call takes: that of the deepest tagged variant case
 * its decoded arguments hold (spec section 5.2, D-053), else the method's. The resolver lets the tagged cases of one
 * method only exclude each other or nest, so the cases one call holds are a chain; a resolved form with tagged cases
 * that one call holds side by side is not one a resolver writes, and the method's entry is used for it.
 *
 * @param {object} method  a method of the resolved form
 * @param {unknown[]} argValues  its decoded arguments (decode.mjs: records by key, variants as { tag, value })
 * @param {"intent" | "effect"} tag
 */
export function callTag(method, argValues, tag) {
  let best = null; // { entry, chain }: the hit with the most hits above and at it
  let hits = 0;
  const visit = (node, value, chain) => {
    if (!isObject(node) || node.recursive === true || !isObject(value)) return; // null: an absent optional, a bare case
    if (node.candid === "record") {
      for (const [key, child] of entriesOf(node.fields)) if (Object.hasOwn(value, key)) visit(child, value[key], chain);
    } else if (node.candid === "variant") {
      const hit = entriesOf(node.cases).find(([key]) => key === value.tag);
      if (hit === undefined) return;
      const child = hit[1];
      const entry = isObject(child) && isObject(child.tags) && Object.hasOwn(child.tags, tag) ? child.tags[tag] : undefined;
      if (isObject(entry)) {
        chain += 1;
        hits += 1;
        if (best === null || chain > best.chain) best = { entry, chain };
      }
      visit(child, value.value, chain);
    }
  };
  method.args.forEach((node, i) => visit(node, argValues[i], 0));
  return best !== null && best.chain === hits ? best.entry : method.tags?.[tag];
}
