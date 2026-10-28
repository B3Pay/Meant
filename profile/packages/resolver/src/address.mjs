/**
 * Address grammar (spec section 3). Addresses are compared by their resolved form, never as strings (D-011):
 *   method positions  -> "m:<method>|<arg|res>|<index>|<id>/<id>/[]..."
 *   type: edges       -> "e:<container>:<id or []>"   (applies wherever the edge is reached)
 *   type: whole decl  -> "n:<node>"                   (records and variants only, E_TYPE_NODE otherwise)
 *
 * Browser-safe: this module and idl.mjs import nothing else, and the package exports them as
 * `@meantjs/profile/address` (test/address-entry.test.mjs keeps it that way).
 */
import { idlHash, U32_MAX } from "./idl.mjs";

export { idlHash, U32_MAX };

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const NUMID = "#(?:0|[1-9][0-9]{0,9})";
const SEG_RE = new RegExp(`\\.(${IDENT}|${NUMID})|\\[\\]`, "y");

export function parsePath(str) {
  const segs = [];
  let i = 0;
  while (i < str.length) {
    SEG_RE.lastIndex = i;
    const m = SEG_RE.exec(str);
    if (!m) return null;
    if (m[0] === "[]") segs.push({ kind: "elem" });
    else if (m[1].startsWith("#")) {
      const id = Number(m[1].slice(1));
      if (id > U32_MAX) return null;
      segs.push({ kind: "field", label: m[1], id });
    } else segs.push({ kind: "field", label: m[1], id: idlHash(m[1]) });
    i = SEG_RE.lastIndex;
  }
  return segs;
}

export function parseAddress(at) {
  let m = new RegExp(`^type:(${IDENT})(.*)$`).exec(at);
  if (m) {
    const segs = parsePath(m[2]);
    return segs && { kind: "type", decl: m[1], segs };
  }
  m = new RegExp(`^(${IDENT})(?:\\((\\d+)\\)|->\\((\\d+)\\))?(.*)$`).exec(at);
  if (!m) return null;
  const segs = parsePath(m[4]);
  if (!segs) return null;
  if (m[2] !== undefined) return { kind: "arg", method: m[1], index: Number(m[2]), segs };
  if (m[3] !== undefined) return { kind: "result", method: m[1], index: Number(m[3]), segs };
  if (segs.length) return null;
  return { kind: "method", method: m[1], segs: [] };
}

export function parseRelPath(rel) {
  const m = /^(?:\((\d+)\))?(.*)$/.exec(rel);
  let rest = m[2];
  if (rest && !rest.startsWith(".") && !rest.startsWith("[")) rest = `.${rest}`;
  const segs = parsePath(rest);
  return segs && { index: m[1] === undefined ? null : Number(m[1]), segs };
}

const segKey = (s) => (s.kind === "elem" ? "[]" : String(s.id));
export const methodKey = (method, side, index, segs) => `m:${method}|${side}|${index}|${segs.map(segKey).join("/")}`;
export const edgeKey = (parent) => `e:${parent.container}:${parent.kind === "vec" ? "[]" : parent.id}`;
