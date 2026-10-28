import { didToContract } from "@candid-core/cli";
import { Iface } from "./iface.mjs";
import { U32_MAX, idlHash } from "./idl.mjs";

/**
 * Compile Candid source text to an Iface with @candid-core/cli (wasm).
 * @returns { iface } or { failure: [candid-core diagnostics] }
 */
export async function compileInterface(source, label = "interface") {
  const env = await didToContract(source);
  if (env.ok === false) return { failure: env.diagnostics };
  return { iface: new Iface(env, label) };
}

/**
 * An Iface from a candid-core ContractEnvelope another tool already wrote (the one `candid-core-cli gen` writes next
 * to a generated module), without compiling the .did again. The envelope is checked for the shape the resolver reads;
 * its identities are taken as written (nothing here can recompute them).
 * @returns { iface } or { failure: [{ code, message }] }
 */
export function interfaceFromEnvelope(envelope, label = "interface") {
  const fail = (message) => ({ failure: [{ code: "invalid_envelope", message }] });
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return fail("not a JSON object");
  const c = envelope.contract;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return fail("no `contract` object (is this a candid-core ContractEnvelope?)");
  if (c.format !== "candid-core") return fail(`contract.format is ${JSON.stringify(c.format)}, expected "candid-core"`);
  if (c.format_version !== 1) return fail(`contract.format_version is ${JSON.stringify(c.format_version)}, this resolver reads version 1`);
  const id = c.identities?.interface;
  if (typeof id !== "string" || !/^candid-core:interface:v1:sha256:[0-9a-f]{64}$/.test(id)) return fail("no contract.identities.interface of the form candid-core:interface:v1:sha256:<64 lowercase hex>");
  // the Candid semantics and the canonical interning this resolver implements; the interface id covers both markers
  if (c.semantics_profile !== "candid-1") return fail(`contract.semantics_profile is ${JSON.stringify(c.semantics_profile)}, this resolver implements "candid-1"`);
  if (c.canonicalization_profile !== "candid-core-canon-1") return fail(`contract.canonicalization_profile is ${JSON.stringify(c.canonicalization_profile)}, this resolver implements "candid-core-canon-1"`);
  if (!Array.isArray(c.types) || !Array.isArray(c.declarations)) return fail("contract.types and contract.declarations must be arrays");
  const names = envelope.extensions?.["org.candid-core.field-names/v1"];
  if (!Array.isArray(names)) return fail("no extensions[\"org.candid-core.field-names/v1\"] array: without it every field and case would be renamed to its id");
  const bad = badGraph(c, names);
  if (bad) return fail(bad);
  try {
    return { iface: new Iface(envelope, label) };
  } catch (e) {
    return fail(`the contract graph cannot be read: ${e.message}`);
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(["primitive", "opt", "vec", "record", "variant", "func", "service", "class"]);
const MODES = new Set(["update", "query", "composite_query", "oneway"]);
const PRIMITIVES = new Set([
  "nat", "nat8", "nat16", "nat32", "nat64", "int", "int8", "int16", "int32", "int64",
  "float32", "float64", "bool", "text", "null", "reserved", "empty", "principal",
]);

/**
 * The first thing in the contract graph this resolver cannot read, as a readable sentence; null if none. Checked
 * here, before anything walks the graph, so a malformed envelope is an E_ENVELOPE diagnostic and never a throw or a
 * loop further in: every reference is an index into `types`, declaration names are distinct strings, every node has the fields its kind needs, a method is
 * a `func` with a mode (a oneway one with no results) and an id that is its name's hash, declarations are named by
 * Candid identifiers, a class appears only as the actor, an actor names a `service` or `class`, every node is reached from the actor
 * or a declaration, no `opt` contains only itself, and every name in the field-names
 * table is the name of a field its container has, with that id.
 */
function badGraph(c, names) {
  const n = c.types.length;
  const ok = (r) => Number.isInteger(r) && r >= 0 && r < n;
  const isKind = (r, kind) => ok(r) && c.types[r]?.kind === kind;
  const refs = (a) => Array.isArray(a) && a.every(ok);
  const declNames = new Set();
  for (const [i, d] of c.declarations.entries()) {
    if (!ok(d?.type)) return `dangling type reference: declarations[${i}].type`;
    if (typeof d.name !== "string" || !IDENT.test(d.name)) return `declarations[${i}] needs a Candid identifier as its name, got ${JSON.stringify(d.name)}`;
    if (declNames.has(d.name)) return `declaration ${JSON.stringify(d.name)} is listed twice`;
    declNames.add(d.name);
  }
  for (const [i, t] of c.types.entries()) {
    const at = `types[${i}]`;
    if (t === null || typeof t !== "object" || !KINDS.has(t.kind)) return `${at} has no known kind`;
    switch (t.kind) {
      case "primitive":
        if (!PRIMITIVES.has(t.primitive)) return `${at}: ${JSON.stringify(t.primitive)} is not a Candid primitive`;
        break;
      case "opt":
      case "vec":
        if (!ok(t.inner)) return `dangling type reference: ${at}.inner`;
        break;
      case "record":
      case "variant": {
        if (!Array.isArray(t.fields)) return `${at}: a ${t.kind} needs fields`;
        const ids = new Set();
        for (const f of t.fields) {
          if (!ok(f?.type)) return `dangling type reference: ${at}.fields`;
          if (!Number.isInteger(f.id) || f.id < 0 || f.id > U32_MAX || ids.has(f.id)) return `${at}: field ids must be distinct u32 values`;
          ids.add(f.id);
        }
        break;
      }
      case "func":
        if (!refs(t.args) || !refs(t.results)) return `dangling type reference: ${at}.args or .results`;
        if (!MODES.has(t.mode)) return `${at}: a func needs a mode (update, query, composite_query or oneway), got ${JSON.stringify(t.mode)}`;
        if (t.mode === "oneway" && t.results.length > 0) return `${at}: a oneway func has no results`;
        break;
      case "service":
        if (!Array.isArray(t.methods)) return `${at}: a service needs methods`;
        const methodNames = new Set();
        for (const m of t.methods) {
          if (typeof m?.name !== "string" || m.name === "") return `${at}: every method needs a non-empty name`;
          if (!Number.isInteger(m.id) || m.id < 0 || m.id > U32_MAX || m.id !== idlHash(m.name)) return `${at}: method ${JSON.stringify(m.name)} needs the id ${idlHash(m.name)} (the hash of its name), got ${JSON.stringify(m.id)}`;
          if (methodNames.has(m.name)) return `${at}: method ${JSON.stringify(m.name)} is listed twice`;
          methodNames.add(m.name);
          if (!isKind(m.function, "func")) return `${at}: method ${JSON.stringify(m.name)} does not name a func type`;
        }
        break;
      case "class":
        if (!refs(t.init) || !isKind(t.service, "service")) return `${at}: a class needs init arguments and a service type`;
        break;
    }
  }
  // each opt is walked once: a chain already known to end in a non-opt is not walked again (linear in the graph)
  const state = new Uint8Array(n); // 0 unseen, 1 on the chain being walked, 2 ends in a non-opt
  for (const [i, t] of c.types.entries()) {
    if (t.kind !== "opt" || state[i] !== 0) continue;
    const chain = [];
    let r = i;
    for (; c.types[r].kind === "opt" && state[r] === 0; r = c.types[r].inner) {
      state[r] = 1;
      chain.push(r);
    }
    if (c.types[r].kind === "opt" && state[r] === 1) return `types[${i}]: an opt that contains only opts of itself`;
    for (const q of chain) state[q] = 2;
  }
  // A class is valid only as the actor (contract-graph.md, validation checklist 5): no declaration or type refers to one.
  const isClass = (r) => c.types[r].kind === "class";
  if (c.declarations.some((d) => isClass(d.type))) return "a declaration names a class: a class is only the actor";
  for (const [i, t] of c.types.entries()) {
    if (childrenOf(t).some(isClass)) return `types[${i}] refers to a class: a class is only the actor`;
  }
  const a = c.actor;
  if (a === null || typeof a !== "object") return "no actor: the envelope describes no service";
  if (a.kind === "service" ? !isKind(a.service, "service") : a.kind === "class" ? !isKind(a.class, "class") : true) {
    return "actor must name a service or a class type";
  }
  // Every node is reachable from the actor or a declaration (contract-graph.md, validation checklist 6): nothing the
  // interface id does not cover rides along in an envelope this resolver accepts.
  const reached = new Uint8Array(n);
  const stack = [a.kind === "service" ? a.service : a.class, ...c.declarations.map((d) => d.type)];
  for (const r of stack) reached[r] = 1;
  while (stack.length > 0) {
    for (const r of childrenOf(c.types[stack.pop()])) {
      if (reached[r] === 0) {
        reached[r] = 1;
        stack.push(r);
      }
    }
  }
  const stray = reached.indexOf(0);
  if (stray !== -1) return `types[${stray}] is reached from neither the actor nor a declaration`;
  const named = new Set();
  for (const [k, e] of names.entries()) {
    if (!Array.isArray(e) || e.length !== 3) return `field-names entry ${k} is not [container, id, name]`;
    const [container, id, name] = e;
    const t = ok(container) ? c.types[container] : undefined;
    if (t?.kind !== "record" && t?.kind !== "variant") return `field-names entry ${k} names no record or variant`;
    if (typeof name !== "string" || !t.fields.some((f) => f.id === id) || idlHash(name) !== id) return `field-names entry ${k}: ${JSON.stringify(name)} is not the name of field ${id} of types[${container}]`;
    // two names for one field (they can share a hash) would leave the name to the order of the entries
    if (named.has(`${container}:${id}`)) return `field-names entry ${k} names field ${id} of types[${container}] a second time`;
    named.add(`${container}:${id}`);
  }
  const twin = duplicateNodes(c.types);
  if (twin) return `types[${twin[0]}] and types[${twin[1]}] are the same type: the graph is not interned as candid-core-canon-1 requires`;
  // A field with no entry keeps its numeric label (`#n`, spec §3.2 rule 1): candid-core writes none for `1 : nat` or a tuple
  // field, so a missing entry cannot be told from a numeric label and is not checked.
  return null;
}

/**
 * The references of a node, in a fixed order, reading only the properties its kind has (checked above): another
 * property on the node, such as `fields` on a primitive, is ignored. Record and variant fields go by id, methods by name.
 */
function childrenOf(t) {
  switch (t.kind) {
    case "opt": case "vec": return [t.inner];
    case "record": case "variant": return [...t.fields].sort((a, b) => a.id - b.id).map((f) => f.type);
    case "func": return [...t.args, ...t.results];
    case "service": return [...t.methods].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((m) => m.function);
    case "class": return [...t.init, t.service];
    default: return [];
  }
}

/** What a node is apart from its references: two nodes with equal keys are equal types if their references are. */
function localKey(t) {
  switch (t.kind) {
    case "primitive": return JSON.stringify(["p", t.primitive]);
    case "record": case "variant": return JSON.stringify([t.kind, t.fields.map((f) => f.id).sort((a, b) => a - b)]);
    case "func": return JSON.stringify(["f", t.mode, t.args.length, t.results.length]);
    case "service": return JSON.stringify(["s", t.methods.map((m) => m.name).sort()]);
    case "class": return JSON.stringify(["c", t.init.length]);
    default: return JSON.stringify([t.kind]);
  }
}

/**
 * Two indexes holding structurally equal types (recursion included), or null. candid-core-canon-1 interns every type
 * once, and the resolver relies on it: an alias reaches a method position only through an equal reference (profile
 * spec 3.2 rule 7). Equal types are the states a DFA minimization merges, so this is Hopcroft's partition refinement
 * (O(k n log n) for n nodes with at most k references each): start from blocks of equal `localKey`, and split a block whenever its nodes' j-th
 * references fall in different blocks, always queueing the smaller half. Two nodes still sharing a block are equal.
 */
function duplicateNodes(types) {
  const n = types.length;
  const succ = types.map(childrenOf);
  const preds = types.map(() => new Map()); // preds[t].get(j): the nodes whose j-th reference is t
  for (const [s, refs] of succ.entries()) {
    for (const [j, t] of refs.entries()) {
      const list = preds[t].get(j);
      if (list) list.push(s);
      else preds[t].set(j, [s]);
    }
  }
  // blocks are segments [start, end) of `elems`; `where[i]` is i's index in `elems`
  const elems = new Int32Array(n);
  const where = new Int32Array(n);
  const block = new Int32Array(n);
  const start = [];
  const end = [];
  const groups = new Map();
  for (const [i, t] of types.entries()) {
    const k = localKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  let fill = 0;
  for (const members of groups.values()) {
    start.push(fill);
    for (const i of members) {
      block[i] = start.length - 1;
      where[i] = fill;
      elems[fill++] = i;
    }
    end.push(fill);
  }
  const queued = new Set();
  const work = [];
  const queue = (b) => {
    for (let x = start[b]; x < end[b]; x++) {
      for (const j of preds[elems[x]].keys()) {
        const key = `${b},${j}`;
        if (!queued.has(key)) {
          queued.add(key);
          work.push([b, j]);
        }
      }
    }
  };
  for (let b = 0; b < start.length; b++) queue(b);
  const marked = [];
  while (work.length > 0) {
    const [b, j] = work.pop();
    queued.delete(`${b},${j}`);
    const touched = [];
    // the splitter's members are copied first: marking moves nodes inside their blocks, the splitter's own included
    for (const t of elems.slice(start[b], end[b])) {
      for (const s of preds[t].get(j) ?? []) {
        // s has one j-th reference, so it is marked at most once per splitter; marked nodes move to their block's front
        const y = block[s];
        if (marked[y] === undefined || marked[y] === 0) {
          marked[y] = 0;
          touched.push(y);
        }
        const to = start[y] + marked[y]++;
        const other = elems[to];
        elems[where[s]] = other;
        where[other] = where[s];
        elems[to] = s;
        where[s] = to;
      }
    }
    for (const y of touched) {
      const m = marked[y];
      marked[y] = 0;
      const size = end[y] - start[y];
      if (m === size) continue;
      // the smaller part becomes the new block z; y keeps the rest (and any of its splitters already queued)
      const z = start.length;
      if (m <= size - m) {
        start.push(start[y]);
        end.push(start[y] + m);
        start[y] += m;
      } else {
        start.push(start[y] + m);
        end.push(end[y]);
        end[y] = start[y] + m;
      }
      for (let x = start[z]; x < end[z]; x++) block[elems[x]] = z;
      queue(z);
    }
  }
  for (let b = 0; b < start.length; b++) {
    if (end[b] - start[b] > 1) {
      const pair = [elems[start[b]], elems[start[b] + 1]].sort((p, q) => p - q);
      return pair;
    }
  }
  return null;
}
