/**
 * Structural Candid subtyping over candid-core Contract graphs, with the pack-matching relaxation of D-019.
 *
 * No existing checker could be reused (see README.md, "Subtyping"): @dfinity/didc 0.0.4 exports only
 * getServiceMethods/encode/decode, and @candid-core/cli 0.2.0 exported only didToContract/didToModule/init (surveyed 2026-10-09; 0.3.0, pinned since D-037, adds
 * projectDid and checkCompatible, not checked here).
 * candid-core's service-level check (b3hr4d/candid-core#247) is an open issue, not code. So this is our own
 * implementation of the rules in the Candid specification, section "Upgrading and Subtyping > Rules"
 * (https://github.com/dfinity/candid/blob/c7659ca/spec/Candid.md), checked against the Rust crate
 * candid 0.10.37 (src/types/subtype.rs).
 *
 * `S <: T` ("S is a subtype of T") is decided between two Contract graphs (`Iface`), because a canister and a pack
 * fragment are compiled separately. Rules implemented, with the spec subsection each comes from:
 *
 *   Primitive types   t <: t;  nat <: int;  any <: reserved;  empty <: any.
 *   Vectors           vec S <: vec T            if S <: T.  (`blob` is `vec nat8`, so it needs no rule of its own.)
 *   Options           opt S <: opt T            if S <: T;
 *                     null <: opt T;
 *                     S <: opt T                if S <: T and T is not null, reserved or opt  (the "constituent" rule).
 *                     Optional, off by default (`lossyOpt`): the two "unusual" rules that make opt S <: opt T hold
 *                     even when S and T are unrelated (the value decodes as null). The spec says they exist only
 *                     to keep subtyping transitive, and that tools should warn when they are used. For pack matching
 *                     they would let `fee : opt text` match a pack that says `fee : opt nat`, so they are rejected.
 *   Records           record S <: record T      if every field of T is in S with S_f <: T_f, or is missing from S and
 *                                               has an optional type (null <: T_f, that is opt, null or reserved).
 *                                               Extra fields in S are ignored.
 *   Variants          variant S <: variant T    if every case of S is in T with S_c <: T_c. (S may have fewer cases.)
 *   Functions         func(A) -> (R) m <: func(A') -> (R') m'   if the modes are equal, tuple(A') <: tuple(A)
 *                                               (arguments contravariant) and tuple(R) <: tuple(R') (results covariant);
 *                                               tuples follow the record rule with positional ids 0, 1, ...
 *   Services          service S <: service T    if every method of T is in S and its function type is a subtype.
 *                                               Extra methods in S are ignored. (Init args of a service class are ignored.)
 *   Recursion         Coinductive: a pair under test is assumed to hold when met again.
 *
 * Not implemented, on purpose: the Rust crate's catch-all that accepts `S <: opt T` for any S with only a warning
 * (not a rule of the spec); `service <: principal` (not in the spec revision above).
 *
 * D-019 relaxation (`mode: "relaxed"`, spec profile-v0 section 7): when matching a pack, a variant reached through a
 * method *result* may have cases that the pack fragment lacks. Reached through means descending from the result by
 * record fields, opt, vec and variant payloads only, with covariant polarity; entering any func or service type
 * (where polarity can flip) resets to strict. Argument positions are always strict.
 *
 * Bounded work (profile-v0 section 11.6): depth and step limits fail closed to "not a subtype".
 */

const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_MAX_STEPS = 2_000_000;

const isNullLike = (iface, ref) => {
  const n = iface.types[ref];
  return n.kind === "opt" || (n.kind === "primitive" && (n.primitive === "null" || n.primitive === "reserved"));
};

/** A short rendering of a type for messages. Bounded in depth and width. */
export function show(iface, ref, depth = 2, seen = new Set()) {
  const n = iface.types[ref];
  if (n.kind === "primitive") return n.primitive;
  if (iface.isBlob(ref)) return "blob";
  if (n.kind === "opt") return `opt ${show(iface, n.inner, depth, seen)}`;
  if (n.kind === "vec") return `vec ${show(iface, n.inner, depth, seen)}`;
  if (depth <= 0 || seen.has(ref)) return n.kind;
  const next = new Set(seen).add(ref);
  if (n.kind === "record" || n.kind === "variant") {
    const parts = n.fields.slice(0, 4).map((f) => {
      const label = iface.fieldName(ref, f.id);
      const inner = iface.types[f.type];
      return n.kind === "variant" && inner.kind === "primitive" && inner.primitive === "null" ? label : `${label} : ${show(iface, f.type, depth - 1, next)}`;
    });
    return `${n.kind} { ${parts.join("; ")}${n.fields.length > 4 ? "; ..." : ""} }`;
  }
  if (n.kind === "func") return `func (${n.args.map((a) => show(iface, a, depth - 1, next)).join(", ")}) -> (${n.results.map((a) => show(iface, a, depth - 1, next)).join(", ")}) ${n.mode}`;
  return n.kind;
}

export class SubtypeChecker {
  /**
   * @param opts.lossyOpt  apply the spec's two "unusual" opt rules (default false)
   * @param opts.maxDepth  nesting limit, fails closed (default 256)
   * @param opts.maxSteps  pair-evaluation budget, fails closed (default 2,000,000)
   */
  constructor(opts = {}) {
    this.lossyOpt = Boolean(opts.lossyOpt);
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.gamma = new Set();
    this.relaxed = [];
    this.steps = 0;
    this.depth = 0;
    this.ids = new Map();
  }

  #id(iface) {
    if (!this.ids.has(iface)) this.ids.set(iface, this.ids.size);
    return this.ids.get(iface);
  }

  /** Start a new top-level query: assumptions from an earlier (possibly failed) query must not leak. */
  fresh() {
    this.gamma = new Set();
    this.depth = 0;
  }

  /**
   * Decide S <: T for `s` in iface S and `t` in iface T.
   * @param mode "strict" or "relaxed" (D-019, variants only)
   * @param path address-like path segments, for diagnostics
   * @returns null when it holds, else { path, message } for the first failure
   */
  sub(S, s, T, t, mode = "strict", path = []) {
    if (S === T && s === t) return null;
    const key = `${this.#id(S)}:${s}<:${this.#id(T)}:${t}|${mode}`;
    if (this.gamma.has(key)) return null; // coinductive assumption
    if (++this.steps > this.maxSteps) return { path: [...path], message: "step budget exceeded; treated as not a subtype" };
    if (this.depth >= this.maxDepth) return { path: [...path], message: "type nesting exceeds the depth limit; treated as not a subtype" };
    this.gamma.add(key);
    this.depth++;
    const err = this.#rules(S, s, T, t, mode, path);
    this.depth--;
    if (err) this.gamma.delete(key);
    return err;
  }

  #rules(S, s, T, t, mode, path) {
    const ns = S.types[s];
    const nt = T.types[t];
    const fail = (message) => ({ path: [...path], message });
    const mismatch = () => fail(`${show(S, s)} (${S.label}) is not a subtype of ${show(T, t)} (${T.label})`);
    const sp = ns.kind === "primitive" ? ns.primitive : null;
    const tp = nt.kind === "primitive" ? nt.primitive : null;

    if (tp === "reserved") return null; // <datatype> <: reserved
    if (sp === "empty") return null; // empty <: <datatype>

    if (nt.kind === "opt") {
      if (ns.kind === "opt") {
        const e = this.sub(S, ns.inner, T, nt.inner, mode, path); // opt S <: opt T if S <: T
        if (!e) return null;
        return this.lossyOpt ? null : e; // the two unusual rules, only when asked for
      }
      if (sp === "null") return null; // null <: opt T
      if (isNullLike(T, nt.inner)) return mismatch(); // S <: opt T needs not (null <: T)
      return this.sub(S, s, T, nt.inner, mode, path); // S <: opt T if S <: T
    }
    if (ns.kind === "opt") return mismatch(); // opt S is never a subtype of a non-opt T (T = reserved handled above)

    if (sp !== null || tp !== null) {
      if (sp !== null && tp !== null && (sp === tp || (sp === "nat" && tp === "int"))) return null;
      return mismatch();
    }
    if (ns.kind !== nt.kind) return mismatch();

    switch (ns.kind) {
      case "vec":
        return this.sub(S, ns.inner, T, nt.inner, mode, [...path, "[]"]);
      case "record": {
        const have = new Map(ns.fields.map((f) => [f.id, f.type]));
        for (const f of nt.fields) {
          const label = T.fieldName(t, f.id);
          if (have.has(f.id)) {
            const e = this.sub(S, have.get(f.id), T, f.type, mode, [...path, `.${label}`]);
            if (e) return e;
          } else if (!isNullLike(T, f.type)) {
            return fail(`field "${label}" (${show(T, f.type)}) is required by the ${T.label} but missing from the ${S.label}`);
          }
        }
        return null;
      }
      case "variant": {
        const have = new Map(nt.fields.map((f) => [f.id, f.type]));
        const extra = [];
        for (const f of ns.fields) {
          const label = S.fieldName(s, f.id);
          if (!have.has(f.id)) {
            if (mode === "relaxed") { extra.push(label); continue; } // D-019
            return fail(`variant case "${label}" is in the ${S.label} but not in the ${T.label}`);
          }
          const e = this.sub(S, f.type, T, have.get(f.id), mode, [...path, `.${label}`]);
          if (e) return e;
        }
        if (extra.length) this.relaxed.push({ at: pathString(path), cases: extra.sort() });
        return null;
      }
      case "func": {
        if (ns.mode !== nt.mode) return fail(`function mode is ${ns.mode} in the ${S.label} but ${nt.mode} in the ${T.label}`);
        // Arguments are contravariant: tuple(T args) <: tuple(S args). Calls from a func value cannot use the D-019 relaxation.
        for (let i = 0; i < ns.args.length; i++) {
          if (i < nt.args.length) {
            const e = this.sub(T, nt.args[i], S, ns.args[i], "strict", [...path, `(${i})`]);
            if (e) return e;
          } else if (!isNullLike(S, ns.args[i])) {
            return fail(`argument ${i} (${show(S, ns.args[i])}) is required by the ${S.label} but not supplied by the ${T.label}`);
          }
        }
        // Results are covariant: tuple(S results) <: tuple(T results).
        for (let i = 0; i < nt.results.length; i++) {
          if (i < ns.results.length) {
            const e = this.sub(S, ns.results[i], T, nt.results[i], "strict", [...path, `->(${i})`]);
            if (e) return e;
          } else if (!isNullLike(T, nt.results[i])) {
            return fail(`result ${i} (${show(T, nt.results[i])}) is expected by the ${T.label} but not returned by the ${S.label}`);
          }
        }
        return null;
      }
      case "service": {
        const have = new Map(ns.methods.map((m) => [m.name, m.function]));
        for (const m of nt.methods) {
          if (!have.has(m.name)) return fail(`method "${m.name}" is missing from the ${S.label}`);
          const e = this.sub(S, have.get(m.name), T, m.function, "strict", [...path, m.name]);
          if (e) return e;
        }
        return null;
      }
      default:
        return fail(`unsupported type kind ${ns.kind}`);
    }
  }
}

function pathString(path) {
  return path.join("");
}

/** Is type `s` of iface S a subtype of type `t` of iface T? A standalone entry point for tests and tools. */
export function typeSubtype(S, s, T, t, opts = {}) {
  const c = new SubtypeChecker(opts);
  const mode = opts.resultVariants === "relaxed" ? "relaxed" : "strict";
  const err = c.sub(S, s, T, t, mode);
  return err ? { ok: false, reasons: [{ at: pathString(err.path), message: err.message }], relaxed: [] } : { ok: true, reasons: [], relaxed: c.relaxed };
}

/**
 * Is the service of `canister` a subtype of the service of `fragment`, with the D-019 relaxation on result positions?
 * Both are Iface. Methods of the fragment are checked one by one; every failing method contributes one reason.
 * @param opts.resultVariants "relaxed" (default) applies D-019; "strict" is plain Candid subtyping
 * @param opts.lossyOpt see SubtypeChecker
 * @returns { ok, reasons: [{ at, message }], relaxed: [{ at, cases }] }
 */
export function matchService(canister, fragment, opts = {}) {
  const resultMode = opts.resultVariants === "strict" ? "strict" : "relaxed";
  const checker = new SubtypeChecker(opts);
  const reasons = [];
  const relaxed = [];
  const note = (at, message) => reasons.push({ at, message });
  const run = (at, fn) => {
    checker.fresh();
    const before = checker.relaxed.length;
    const e = fn();
    if (e) {
      note(pathString(e.path) || at, e.message);
      checker.relaxed.length = before; // a failed position contributes no relaxation
    }
  };
  for (const [name, fm] of fragment.methods) {
    const cm = canister.methods.get(name);
    if (!cm) { note(name, `method "${name}" is missing from the ${canister.label}`); continue; }
    if (cm.mode !== fm.mode) { note(name, `method "${name}" is ${cm.mode} in the ${canister.label} but ${fm.mode} in the ${fragment.label}`); continue; }
    // Arguments, contravariant (strict): tuple(fragment args) <: tuple(canister args).
    for (let i = 0; i < cm.args.length; i++) {
      if (i < fm.args.length) run(`${name}(${i})`, () => checker.sub(fragment, fm.args[i], canister, cm.args[i], "strict", [`${name}(${i})`]));
      else if (!isNullLike(canister, cm.args[i])) note(`${name}(${i})`, `argument ${i} (${show(canister, cm.args[i])}) is required by the ${canister.label} but not supplied by the ${fragment.label}`);
    }
    // Results, covariant (D-019 relaxation): tuple(canister results) <: tuple(fragment results).
    for (let i = 0; i < fm.results.length; i++) {
      if (i < cm.results.length) run(`${name}->(${i})`, () => checker.sub(canister, cm.results[i], fragment, fm.results[i], resultMode, [`${name}->(${i})`]));
      else if (!isNullLike(fragment, fm.results[i])) note(`${name}->(${i})`, `result ${i} (${show(fragment, fm.results[i])}) is expected by the ${fragment.label} but not returned by the ${canister.label}`);
    }
  }
  relaxed.push(...checker.relaxed);
  return { ok: reasons.length === 0, reasons, relaxed };
}
