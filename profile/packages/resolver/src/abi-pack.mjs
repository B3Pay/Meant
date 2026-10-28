/**
 * EVM packs (spec section 15, D-054). A pack with `binds.abi` applies to a contract that has every one of its
 * functions: the same selector (so the same name and parameter types), the same output types, and the same kind of
 * call (a query, or an update that is payable exactly when the pack's is). There is no subtyping.
 *
 * Parameter names are not part of a selector, and contracts name the parameters of one standard differently (EIP-20
 * says `_to`, OpenZeppelin `to`, WETH `dst`). A pack's addresses and template placeholders use the pack's own names;
 * when the pack applies, they are rewritten to the contract's names, component by component, by position.
 */
import { parseAddress, parseRelPath } from "./address.mjs";
import { componentKey, parseAbi, typeString } from "./abi.mjs";

/**
 * @param iface  an AbiIface
 * @param pack   a schema-valid pack document with `binds.abi`
 * @returns {{ matched: boolean, reasons: { at: string, message: string }[], relaxed: [], functions: object[] } | { error: { at: string, message: string }[] }}
 */
export function matchAbiPack(iface, pack) {
  const { functions, errors } = parseAbi(pack.binds.abi, "binds.abi");
  if (errors.length) return { error: errors };
  const reasons = [];
  const kind = (f) => (f.stateMutability === "view" || f.stateMutability === "pure" ? "a query (view or pure)" : f.stateMutability === "payable" ? "payable" : "not payable");
  const outputs = (f) => `(${f.outputs.map((o) => typeString(o.type)).join(",")})`;
  for (const f of functions) {
    const g = iface.functions.get(f.name);
    if (!g || g.selector !== f.selector) reasons.push({ at: f.name, message: `no function ${f.typeSignature} (selector ${f.selector})` });
    else if (outputs(g) !== outputs(f)) reasons.push({ at: f.name, message: `returns ${outputs(g)}, the pack's ${outputs(f)}` });
    else if (kind(g) !== kind(f)) reasons.push({ at: f.name, message: `is ${kind(g)}, the pack's ${kind(f)}` });
  }
  return { matched: reasons.length === 0, reasons, relaxed: [], functions };
}

/** A path through the pack's type, spelled with the contract's names; null when the pack's own type lacks it. */
function mapSegs(packT, ownT, segs) {
  let p = packT;
  let c = ownT;
  let out = "";
  for (const s of segs) {
    if (s.kind === "elem") {
      if (p.kind !== "array") return null;
      out += "[]";
      p = p.element;
      c = c.element;
      continue;
    }
    if (p.kind !== "tuple") return null;
    const i = p.components.findIndex((comp, j) => componentKey(comp, j) === s.label);
    if (i < 0) return null;
    out += `.${componentKey(c.components[i], i)}`;
    p = p.components[i].type;
    c = c.components[i].type;
  }
  return out;
}

const tupleOf = (params) => ({ kind: "tuple", components: params });

/** A template with each placeholder rewritten by `map` (null keeps it); escapes and literal text are kept as written. */
function mapTemplate(template, map) {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if ((c === "{" || c === "}" || c === "[" || c === "]") && template[i + 1] === c) {
      out += c + c;
      i++;
      continue;
    }
    if (c === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) return template; // does not parse: left for E_TEMPLATE
      const path = template.slice(i + 1, end);
      out += `{${map(path) ?? path}}`;
      i = end;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * The pack with its addresses and templates in the contract's names. `functions` are the pack's (matchAbiPack).
 * A document whose names already agree comes back equal to the original.
 */
export function translatePack(pack, functions, iface) {
  const mine = new Map(functions.map((f) => [f.name, f]));
  const pair = (name) => (mine.has(name) && iface.functions.has(name) ? [mine.get(name), iface.functions.get(name)] : null);
  const at = (text) => {
    const addr = parseAddress(text);
    const fs = addr && addr.kind !== "type" ? pair(addr.method) : null;
    if (!fs || addr.kind === "method") return text;
    const [p, c] = fs;
    if (addr.kind === "arg") {
      const mapped = addr.index === 0 && p.inputs.length ? mapSegs(tupleOf(p.inputs), tupleOf(c.inputs), addr.segs) : null;
      return mapped === null ? text : `${addr.method}(0)${mapped}`;
    }
    const out = p.outputs[addr.index];
    const mapped = out ? mapSegs(out.type, c.outputs[addr.index].type, addr.segs) : null;
    return mapped === null ? text : `${addr.method}->(${addr.index})${mapped}`;
  };
  const placeholder = (method) => (path) => {
    const fs = pair(method);
    const rel = parseRelPath(path);
    if (!fs || !rel || (rel.index ?? 0) !== 0 || !fs[0].inputs.length) return null;
    const mapped = mapSegs(tupleOf(fs[0].inputs), tupleOf(fs[1].inputs), rel.segs);
    return mapped === null ? null : `${rel.index === null ? "" : "(0)"}${rel.index === null ? mapped.slice(1) : mapped}`;
  };
  const annotations = pack.annotations.map((a) => {
    const method = parseAddress(a.at)?.method;
    const args = a.tag === "intent" && typeof a.args?.template === "string" && method ? { ...a.args, template: mapTemplate(a.args.template, placeholder(method)) } : a.args;
    return { ...a, at: at(a.at), args };
  });
  return { ...pack, annotations };
}
