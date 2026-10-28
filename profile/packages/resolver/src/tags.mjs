/**
 * Tag storage and position enumeration. TagIndex, `positions` are moved verbatim from scripts/validate.mjs;
 * LayeredTags is the multi-profile merge of spec section 8.
 */
import { edgeKey } from "./address.mjs";

// ---------------------------------------------------------------- tag index

/** Tags reachable at a position: node tags < edge tags < method-position tags (spec §8). */
export class TagIndex {
  constructor() { this.byKey = new Map(); }
  add(key, tag, entry) {
    if (!this.byKey.has(key)) this.byKey.set(key, {});
    this.byKey.get(key)[tag] = entry;
  }
  at({ key, parent, ref }, iface) {
    const nodeTags = this.byKey.get(`n:${iface.unwrapOpt(ref).ref}`);
    const edgeTags = parent ? this.byKey.get(edgeKey(parent)) : undefined;
    const posTags = this.byKey.get(key);
    if (!nodeTags && !edgeTags && !posTags) return undefined;
    return { ...(nodeTags ?? {}), ...(edgeTags ?? {}), ...(posTags ?? {}) };
  }
}

/** Every value position of a method side, with canonical key, parent edge and display address. */
export function* positions(iface, methodName, side, maxDepth = 8) {
  const m = iface.methods.get(methodName);
  const tuple = side === "args" ? m.args : m.results;
  const sideKey = side === "args" ? "arg" : "res";
  function* rec(ref, parent, ids, display, index, depth, seen) {
    const key = `m:${methodName}|${sideKey}|${index}|${ids.join("/")}`;
    const { ref: r } = iface.unwrapOpt(ref);
    const cyclic = seen.has(r) || depth >= maxDepth;
    yield { ref, parent, key, display, cyclic };
    if (cyclic) return;
    const n = iface.node(r);
    const next = new Set(seen).add(r);
    if (n.kind === "record" || n.kind === "variant") {
      for (const f of n.fields) {
        yield* rec(f.type, { container: r, kind: n.kind, id: f.id }, [...ids, String(f.id)], `${display}.${iface.fieldName(r, f.id)}`, index, depth + 1, next);
      }
    } else if (n.kind === "vec" && !iface.isBlob(r)) {
      yield* rec(n.inner, { container: r, kind: "vec" }, [...ids, "[]"], `${display}[]`, index, depth + 1, next);
    }
  }
  for (let i = 0; i < tuple.length; i++) {
    yield* rec(tuple[i], null, [], `${methodName}${side === "args" ? "" : "->"}(${i})`, i, 0, new Set());
  }
}

/**
 * Spec section 8, merging. One TagIndex per layer, highest precedence first (author, third_party, pack, inferred).
 *   - Within a layer: a method-position tag beats a `type:` edge tag beats a whole-declaration tag (TagIndex.at).
 *   - Across layers: the first layer that has the tag at the position wins; the same tag in lower layers is overridden.
 * Merging is per tag per position: other tags on the position are kept.
 */
export class LayeredTags {
  /** @param layers Array<{ name: string, index: TagIndex }> */
  constructor(layers) { this.layers = layers; }

  static #first(parts) {
    let out;
    for (const t of parts) {
      if (!t) continue;
      out ??= {};
      for (const k of Object.keys(t)) if (!(k in out)) out[k] = t[k];
    }
    return out;
  }

  /** Effective tags at a value position (undefined when none). */
  at(pos, iface) { return LayeredTags.#first(this.layers.map((l) => l.index.at(pos, iface))); }

  /** Effective tags on a method (always an object). */
  methodTags(name) { return LayeredTags.#first(this.layers.map((l) => l.index.byKey.get(`m:${name}`))) ?? {}; }

  /** Every candidate per tag at a value position, highest layer first: { tag -> [entry, ...] }. */
  candidates(pos, iface) { return this.#collect(this.layers.map((l) => l.index.at(pos, iface))); }

  candidatesAtMethod(name) { return this.#collect(this.layers.map((l) => l.index.byKey.get(`m:${name}`))); }

  #collect(parts) {
    const out = {};
    for (const t of parts) {
      if (!t) continue;
      for (const [k, v] of Object.entries(t)) (out[k] ??= []).push(v);
    }
    return out;
  }
}
