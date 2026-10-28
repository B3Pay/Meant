/**
 * A compiled Candid interface: the candid-core Contract graph plus the field-name table, with the lookups the
 * resolver needs (address resolution, opt-transparent walks, shape tests). Moved verbatim from scripts/validate.mjs;
 * the only additions are `label` (used in subtype diagnostics) and `interfaceId`.
 */
import { idlHash } from "./util.mjs";
import { parseRelPath, methodKey, edgeKey } from "./address.mjs";

export class Iface {
  /** @param envelope a candid-core ContractEnvelope; @param label how diagnostics name this side ("canister", "pack fragment") */
  constructor(envelope, label = "interface") {
    this.label = label;
    this.contract = envelope.contract;
    this.types = this.contract.types;
    this.names = new Map();
    for (const [c, id, name] of envelope.extensions?.["org.candid-core.field-names/v1"] ?? []) {
      this.names.set(`${c}:${id}`, name);
    }
    this.decls = new Map(this.contract.declarations.map((d) => [d.name, d.type]));
    // Interning: structurally equal declarations share one node. A type: address on one reaches the others (spec §3.2 rule 7).
    this.aliases = new Map();
    for (const d of this.contract.declarations) {
      if (!this.aliases.has(d.type)) this.aliases.set(d.type, []);
      this.aliases.get(d.type).push(d.name);
    }
    this.methods = new Map();
    const actor = this.contract.actor;
    const svcRef = actor?.kind === "service" ? actor.service : actor?.kind === "class" ? this.types[actor.class].service : null;
    if (svcRef !== null && svcRef !== undefined) {
      for (const m of this.types[svcRef].methods) {
        const f = this.types[m.function];
        this.methods.set(m.name, { mode: f.mode, args: f.args, results: f.results });
      }
    }
  }
  get interfaceId() { return this.contract.identities.interface ?? null; }
  node(ref) { return this.types[ref]; }
  unwrapOpt(ref) {
    let optional = false;
    while (this.types[ref].kind === "opt") { optional = true; ref = this.types[ref].inner; }
    return { ref, optional };
  }
  fieldName(container, id) { return this.names.get(`${container}:${id}`) ?? `#${id}`; }
  isBlob(ref) { const n = this.types[ref]; return n.kind === "vec" && this.types[n.inner].kind === "primitive" && this.types[n.inner].primitive === "nat8"; }
  prim(ref) { const n = this.types[ref]; return n.kind === "primitive" ? n.primitive : null; }
  isAccount(ref) {
    const n = this.types[ref];
    if (n.kind !== "record" || n.fields.length !== 2) return false;
    const owner = n.fields.find((f) => f.id === idlHash("owner"));
    const sub = n.fields.find((f) => f.id === idlHash("subaccount"));
    if (!owner || !sub || this.prim(owner.type) !== "principal") return false;
    const s = this.types[sub.type];
    return s.kind === "opt" && this.isBlob(s.inner);
  }
  describeType(ref) {
    const { ref: r, optional } = this.unwrapOpt(ref);
    const n = this.types[r];
    const base = n.kind === "primitive" ? n.primitive : this.isBlob(r) ? "blob" : n.kind;
    return optional ? `opt ${base}` : base;
  }
  /** Walk segments from a start ref. Returns {ref, parent} or {error}. */
  walk(start, segs) {
    let cur = start;
    let parent = null;
    for (const s of segs) {
      cur = this.unwrapOpt(cur).ref;
      const n = this.types[cur];
      if (s.kind === "elem") {
        if (n.kind !== "vec") return { error: `"[]" applied to ${this.describeType(cur)}` };
        parent = { container: cur, kind: "vec" };
        cur = n.inner;
        continue;
      }
      if (n.kind !== "record" && n.kind !== "variant") return { error: `".${s.label}" applied to ${this.describeType(cur)}` };
      const f = n.fields.find((x) => x.id === s.id);
      if (!f) return { error: `no ${n.kind === "record" ? "field" : "case"} "${s.label}" in ${n.kind}` };
      parent = { container: cur, kind: n.kind, id: s.id };
      cur = f.type;
    }
    return { ref: cur, parent };
  }
  /** Resolve an address. Returns {ref, parent, key} | {method, key} | {error}. */
  resolve(addr) {
    if (addr.kind === "type") {
      const start = this.decls.get(addr.decl);
      if (start === undefined) return { error: `no declaration "${addr.decl}"` };
      const r = this.walk(start, addr.segs);
      if (r.error) return r;
      if (!r.parent) {
        // Pathless: the whole declared type. Only records and variants, or a primitive alias would tag every such value (spec §3.2 rule 8).
        const kind = this.types[this.unwrapOpt(r.ref).ref].kind;
        if (kind !== "record" && kind !== "variant") {
          const t = this.describeType(r.ref);
          return { error: `pathless type: address on "${addr.decl}" (${t}) would tag every ${t} in the interface; use a field path or a method address`, code: "E_TYPE_NODE" };
        }
      }
      return { ...r, key: r.parent ? edgeKey(r.parent) : `n:${this.unwrapOpt(r.ref).ref}` };
    }
    const m = this.methods.get(addr.method);
    if (!m) return { error: `no method "${addr.method}"` };
    if (addr.kind === "method") return { method: m, key: `m:${addr.method}` };
    const tuple = addr.kind === "arg" ? m.args : m.results;
    if (addr.index >= tuple.length) return { error: `${addr.kind} index ${addr.index} out of range (${tuple.length})` };
    const r = this.walk(tuple[addr.index], addr.segs);
    if (r.error) return r;
    return { ...r, key: methodKey(addr.method, addr.kind === "arg" ? "arg" : "res", addr.index, addr.segs) };
  }
  resolveRel(methodName, side, rel) {
    const m = this.methods.get(methodName);
    const p = parseRelPath(rel);
    if (!p) return { error: `bad relative path "${rel}"` };
    const tuple = side === "args" ? m.args : m.results;
    let index = p.index;
    if (index === null) {
      if (tuple.length !== 1) return { error: `relative path "${rel}" must start with (i): ${side} tuple has ${tuple.length} elements` };
      index = 0;
    }
    if (index >= tuple.length) return { error: `index ${index} out of range` };
    const r = this.walk(tuple[index], p.segs);
    if (r.error) return r;
    return { ...r, key: methodKey(methodName, side === "args" ? "arg" : "res", index, p.segs) };
  }
}
