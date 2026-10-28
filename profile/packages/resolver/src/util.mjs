import { sha256Hex } from "./sha256.mjs";

// The pure label helpers live in idl.mjs, so that the address entry loads nothing else.
export { U32_MAX, idlHash } from "./idl.mjs";

/** RFC 8785 (JCS) canonical JSON for the value shapes profiles use. */
export function jcs(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}

export function profileId(doc) {
  return `candid-profile:v0:sha256:${sha256Hex(jcs(doc))}`;
}
