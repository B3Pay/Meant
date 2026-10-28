/**
 * Doc annotations (spec section 9): the profile tags an author writes as doc comments in the `.did`, read by
 * candid-core (doc attributes v1, `docs/doc-attributes.md` in the candid-core repository) and turned here into an
 * `author` canister profile bound to the interface's `interface_id`.
 *
 * candid-core parses every `@name(key = value, ...)` doc line, refuses a malformed one and hands each out with the
 * SourceInfo path of the item it documents; it gives no name a meaning. This module decides which names are profile
 * tags and where each lands:
 *
 *   method docs         method tags at the method; value tags need `at` ("<relpath>" for the arguments,
 *                       "-><relpath>" for the results); `describe` without `at` describes the method
 *   declaration docs    `type:<Decl>`, plus `at` when given (a pathless address is the resolver's E_TYPE_NODE check)
 *   field docs          `type:<Decl>.<path>` in a declaration, or a method address for a field of an inline actor
 *                       type (the OQ-4 mapping, docs/proposals/w1-source-info.md), plus `at` when given
 *   prose               `describe.help` of the item, except where it would change how a value is read (below)
 *
 * Only bare names that are profile tags are read. A dotted name (`@ui.hidden`) belongs to another tool and is left
 * alone; so is any other bare name, with a warning when it is one or two letters from a tag (`@amout`).
 *
 * Prose never makes an integer typable. The tool layer reads an untagged integer with a `describe` as plain digits
 * (D-044), so a comment such as "the amount in e8s" would turn a bare number into an agent input without a unit. Prose
 * on an integer position is attached only when the same doc gives it a value tag that reads it (`amount`,
 * `timestamp`, `duration`, `named`) or an explicit `@describe`; otherwise it is reported (I_DOC_PROSE).
 *
 * New diagnostic codes, proposed in docs/proposals/w1-doc-attributes.md: E_DOC_INPUT, E_DOC_SYNTAX, E_DOC_TARGET,
 * E_DOC_VALUE, W_DOC_UNKNOWN_TAG, I_DOC_IGNORED, I_DOC_PROSE; candid-core's compile failures pass through as E_CANDID.
 */
import { parsePath } from "./address.mjs";
import { METHOD_TAGS, NUMERIC } from "./checks.mjs";

/** The doc attributes version this module reads. */
export const DOC_ATTRIBUTES_VERSION = 1;

const TAGS = new Set([
  "amount", "timestamp", "duration", "account", "subaccount", "bytes", "default", "describe", "text", "range", "ui",
  "named", ...METHOD_TAGS,
]);
/** Value tags that decide how an integer is read: prose next to one of them cannot change the reading. */
const READING_TAGS = new Set(["amount", "timestamp", "duration", "named"]);
/** Arguments the schema holds as decimal strings (`int_string`): a number written there is kept as its digits. */
const STRING_INTEGERS = new Set(["range.min", "range.max"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// the schema's relpath, without the leading "->"
const RELPATH = /^(\((0|[1-9][0-9]*)\))?(\.?([A-Za-z_][A-Za-z0-9_]*|#(0|[1-9][0-9]{0,9}))|\[\])?((\.([A-Za-z_][A-Za-z0-9_]*|#(0|[1-9][0-9]{0,9})))|\[\])*$/;
// one step of a SourceInfo occurrence path after its origin (OQ-4)
const STEP = /\.(type|inner|function|fields|args|results|methods|init)(?:\[(0|[1-9][0-9]*)\])?/y;

class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * An `author` canister profile from the doc comments of a `.did`.
 *
 * @param response what `didToDocAttributes(sources)` of `@candid-core/cli` returns: `{ ok: true, contract,
 *        source_info, doc_attributes }`, or `{ ok: false, diagnostics }`, which is passed through
 * @param opts.name        the profile's name (default "doc-annotations")
 * @param opts.origin      "author" (default) or "third_party"
 * @param opts.language    default "en"
 * @param opts.canisterId  bind the profile to one canister too
 * @returns { ok, doc, diagnostics }: `doc` is the profile, or null when the comments hold no tag (or the response is
 *          not readable); `ok` is false when any diagnostic is an error. Run the profile through `resolveService` as
 *          usual: this module places tags, the resolver checks them.
 */
export function profileFromDocAttributes(response, opts = {}) {
  const diagnostics = [];
  const read = readResponse(response, diagnostics);
  if (read === null) return { ok: false, doc: null, diagnostics };
  const graph = new Graph(read.contract, read.sourceInfo);
  const annotations = [];
  for (const item of read.items) placeItem(graph, item, annotations, diagnostics);
  const ok = !diagnostics.some((d) => d.severity === "error");
  if (annotations.length === 0) {
    if (ok) diagnostics.push({ severity: "info", code: "I_DOC_IGNORED", at: read.entry, message: "the doc comments hold no profile tag, so there is no profile" });
    return { ok, doc: null, diagnostics };
  }
  const binds = { interface_id: read.contract.identities.interface };
  if (opts.canisterId !== undefined) binds.canister_id = opts.canisterId;
  const doc = {
    format: "candid-profile",
    format_version: 0,
    kind: "canister",
    name: opts.name ?? "doc-annotations",
    origin: opts.origin ?? "author",
    language: opts.language ?? "en",
    description: `From the doc comments of ${read.entry}.`,
    binds,
    annotations,
  };
  return { ok, doc, diagnostics };
}

function readResponse(response, diagnostics) {
  const fail = (message) => {
    diagnostics.push({ severity: "error", code: "E_DOC_INPUT", at: "service.did", message });
    return null;
  };
  if (response === null || typeof response !== "object" || Array.isArray(response)) return fail("not a didToDocAttributes response: not a JSON object");
  if (response.ok === false) {
    const list = Array.isArray(response.diagnostics) ? response.diagnostics : [];
    for (const d of list) {
      const syntax = typeof d?.code === "string" && (d.code.startsWith("doc_attribute_") || d.resource_limit?.resource === "source_nesting");
      diagnostics.push({ severity: "error", code: syntax ? "E_DOC_SYNTAX" : "E_CANDID", at: d?.path ?? d?.span?.source_name ?? "service.did", message: `${d?.code}: ${d?.message}` });
    }
    if (list.length === 0) fail("the response failed and gives no diagnostics");
    return null;
  }
  const { contract, source_info: sourceInfo, doc_attributes: attrs } = response;
  if (response.ok !== true || !contract || !sourceInfo || !attrs) return fail("not a didToDocAttributes response: it needs ok, contract, source_info and doc_attributes (is @candid-core/cli older than doc attributes?)");
  if (attrs.doc_attributes_version !== DOC_ATTRIBUTES_VERSION) return fail(`doc_attributes_version is ${JSON.stringify(attrs.doc_attributes_version)}; this compiler reads version ${DOC_ATTRIBUTES_VERSION}`);
  const id = contract.identities?.interface;
  if (typeof id !== "string" || !/^candid-core:interface:v1:sha256:[0-9a-f]{64}$/.test(id)) return fail("the contract has no identities.interface");
  if (sourceInfo.contract_id !== contract.identities.contract) return fail("source_info belongs to another contract");
  if (!Array.isArray(attrs.items) || !Array.isArray(sourceInfo.methods) || !Array.isArray(sourceInfo.field_labels)) return fail("doc_attributes.items, source_info.methods and source_info.field_labels must be arrays");
  const entry = sourceInfo.sources?.[0]?.name ?? "the .did";
  return { contract, sourceInfo, items: attrs.items, entry };
}

/** The Contract and SourceInfo lookups placement needs. */
class Graph {
  constructor(contract, sourceInfo) {
    this.types = contract.types;
    this.decls = new Map(contract.declarations.map((d) => [d.name, d.type]));
    const actor = contract.actor;
    this.service = actor?.kind === "service" ? actor.service : actor?.kind === "class" ? this.types[actor.class].service : null;
    this.methods = new Map();
    for (const m of this.service === null ? [] : this.types[this.service].methods) this.methods.set(m.name, this.types[m.function]);
    // trap 1: SourceInfo's method index is not the Contract's; methods are found by their SourceInfo path
    this.methodEntries = sourceInfo.methods;
    this.fieldLabels = new Map(sourceInfo.field_labels.map((f) => [f.path, f]));
  }
  unwrapOpt(ref) {
    while (this.types[ref]?.kind === "opt") ref = this.types[ref].inner;
    return ref;
  }
  kindOf(ref) {
    const n = this.types[this.unwrapOpt(ref)];
    return n?.kind === "primitive" ? n.primitive : n?.kind;
  }
  /** The SourceInfo method entry an item path starts with: equal to it, or followed by a step. */
  methodEntryOf(path) {
    let best = null;
    for (const m of this.methodEntries) {
      if ((path === m.path || path.startsWith(`${m.path}.`)) && (best === null || m.path.length > best.path.length)) best = m;
    }
    return best;
  }
  /** The canister method an entry describes, or a DocError saying why it is not one. */
  canisterMethod(entry) {
    if (entry.service !== this.service) throw new DocError("E_DOC_TARGET", `${entry.name} is a method of a service type that is not this canister's (a callback or a reference), so a profile cannot address it`);
    if (!IDENT.test(entry.name)) throw new DocError("E_DOC_TARGET", `method "${entry.name}" is not identifier-shaped; v0 addresses cannot name it (OQ-3)`);
    return { name: entry.name, func: this.methods.get(entry.name) };
  }
  /**
   * Where an item's docs land: { kind: "method", method, func } | { kind: "value", address, ref, method?, func? }
   * | { kind: "actor" }. Throws a DocError for an item no address reaches.
   */
  place(item) {
    if (item.kind === "actor") return { kind: "actor" };
    const entry = this.methodEntryOf(item.path);
    if (entry !== null) {
      const { name, func } = this.canisterMethod(entry);
      if (item.path === entry.path) return { kind: "method", method: name, func };
      const steps = readSteps(item.path.slice(entry.path.length));
      const side = steps[0]?.step === "function" ? steps[1] : undefined;
      if (side === undefined || (side.step !== "args" && side.step !== "results") || side.index === undefined) throw new DocError("E_DOC_TARGET", `cannot read the occurrence path ${item.path}`);
      const tuple = side.step === "args" ? func.args : func.results;
      const base = `${name}${side.step === "args" ? "" : "->"}(${side.index})`;
      return { kind: "value", ...this.walk(base, tuple[side.index], steps.slice(2), item.path), method: name, func };
    }
    const decl = /^type:([A-Za-z_][A-Za-z0-9_]*)/.exec(item.path);
    if (decl === null || !this.decls.has(decl[1])) throw new DocError("E_DOC_TARGET", `cannot read the occurrence path ${item.path}`);
    const rest = item.path.slice(decl[0].length);
    return { kind: "value", ...this.walk(`type:${decl[1]}`, this.decls.get(decl[1]), readSteps(rest), item.path) };
  }
  /** Follow occurrence steps from a ref, writing the address: `.label` per field, nothing for opt, `[]` for vec. */
  walk(address, ref, steps, path) {
    let prefix = path.slice(0, path.length - steps.reduce((n, s) => n + s.text.length, 0));
    for (const s of steps) {
      prefix += s.text;
      const node = this.types[ref];
      if (s.step === "type") continue;
      if (s.step === "inner" && (node?.kind === "opt" || node?.kind === "vec")) {
        if (node.kind === "vec") address += "[]";
        ref = node.inner;
        continue;
      }
      if (s.step === "fields" && (node?.kind === "record" || node?.kind === "variant") && s.index < node.fields.length) {
        const field = node.fields[s.index];
        const entry = this.fieldLabels.get(prefix);
        if (entry !== undefined && (entry.container !== ref || entry.id !== field.id)) throw new DocError("E_DOC_TARGET", `SourceInfo and the Contract disagree at ${prefix}`);
        const name = entry?.label?.kind === "named" ? entry.label.name : null;
        address += name !== null && IDENT.test(name) ? `.${name}` : `.#${field.id}`;
        ref = field.type;
        continue;
      }
      // trap 6: a position inside a func or service value has no v0 address
      if (s.step === "args" || s.step === "results" || s.step === "methods" || s.step === "function") throw new DocError("E_DOC_TARGET", `${path} is inside a func or service value, which v0 addresses cannot reach`);
      throw new DocError("E_DOC_TARGET", `cannot follow ${path} through the Contract`);
    }
    return { address, ref };
  }
}

function readSteps(text) {
  const steps = [];
  let i = 0;
  while (i < text.length) {
    STEP.lastIndex = i;
    const m = STEP.exec(text);
    if (m === null) throw new DocError("E_DOC_TARGET", `cannot read the occurrence path step "${text.slice(i)}"`);
    steps.push({ step: m[1], index: m[2] === undefined ? undefined : Number(m[2]), text: m[0] });
    i = STEP.lastIndex;
  }
  return steps;
}

function placeItem(graph, item, annotations, diagnostics) {
  // `at` is the item's address once it has one, else its SourceInfo path; `path` and `source` say where the comment is
  let at = item.path;
  const where = { path: item.path, ...(item.origin?.source ? { source: item.origin.source } : {}) };
  const diag = (severity, code, line, name, message) => diagnostics.push({
    severity, code, at, message: line === null ? message : `doc line ${line + 1}: @${name}: ${message}`, ...where,
  });
  let place;
  try {
    place = graph.place(item);
    at = place.kind === "method" ? place.method : place.kind === "value" ? place.address : "actor";
  } catch (e) {
    if (!(e instanceof DocError)) throw e;
    for (const a of item.attributes) {
      if (TAGS.has(a.name)) diag("error", e.code, a.doc_line, a.name, e.message);
    }
    if (prose(item) !== null) diag("info", "I_DOC_PROSE", null, null, `the prose is not attached: ${e.message}`);
    return;
  }
  const own = []; // this item's annotations, for the prose rule
  for (const a of item.attributes) {
    if (!TAGS.has(a.name)) {
      if (a.name.includes(".")) diag("info", "I_DOC_IGNORED", a.doc_line, a.name, "a dotted name belongs to another tool; not a profile tag");
      else {
        const near = nearestTag(a.name);
        if (near !== null) diag("warning", "W_DOC_UNKNOWN_TAG", a.doc_line, a.name, `not a profile tag; did you mean @${near}?`);
        else diag("info", "I_DOC_IGNORED", a.doc_line, a.name, "not a profile tag; left for other tools");
      }
      continue;
    }
    try {
      const args = {};
      let target;
      for (const { key, value } of a.args) {
        if (key === "at") {
          if (value?.kind !== "text") throw new DocError("E_DOC_VALUE", "`at` is a path written as text, for example at = \"amount\" or at = \"->(0).Ok\"");
          target = value.value;
        } else args[key] = jsonValue(value, `${a.name}.${key}`);
      }
      const address = targetOf(graph, place, a.name, target);
      const annotation = { at: address, tag: a.name, args };
      annotations.push(annotation);
      own.push({ annotation, explicitAt: target !== undefined });
    } catch (e) {
      if (!(e instanceof DocError)) throw e;
      diag("error", e.code, a.doc_line, a.name, e.message);
    }
  }
  const help = prose(item);
  if (help === null) return;
  const skip = (why) => diag("info", "I_DOC_PROSE", null, null, `the prose is not attached: ${why}`);
  if (place.kind === "actor") return skip("no tag describes the service as a whole");
  const self = place.kind === "method" ? place.method : place.address;
  const describe = own.find((o) => o.annotation.tag === "describe" && !o.explicitAt);
  if (describe !== undefined) {
    if (describe.annotation.args.help !== undefined) return skip("@describe already gives help");
    describe.annotation.args.help = help;
    return;
  }
  if (place.kind === "value") {
    const kind = graph.kindOf(place.ref);
    if (item.kind === "declaration" && kind !== "record" && kind !== "variant") {
      return skip(`type:${item.name} is a ${kind}, and only a record or a variant can be described as a whole (spec 3.2 rule 8); describe the fields or methods that use it`);
    }
    const read = own.some((o) => !o.explicitAt && READING_TAGS.has(o.annotation.tag));
    if (NUMERIC.has(kind) && !read) {
      return skip("as describe.help it would make this untagged integer an agent input of plain digits (D-044); add a value tag such as @amount, or an explicit @describe if plain digits are right");
    }
  }
  annotations.push({ at: self, tag: "describe", args: { help } });
}

/** The address an attribute lands on, or a DocError. */
function targetOf(graph, place, tag, target) {
  const methodTag = METHOD_TAGS.has(tag);
  if (place.kind === "actor") throw new DocError("E_DOC_TARGET", "no tag applies to the service as a whole; put it on a method, a declaration or a field");
  if (place.kind === "method") {
    if (methodTag) {
      if (target !== undefined) throw new DocError("E_DOC_TARGET", "a method tag applies to the method itself and takes no `at`");
      return place.method;
    }
    if (target === undefined) {
      if (tag === "describe") return place.method;
      throw new DocError("E_DOC_TARGET", "a value tag on a method needs `at`: at = \"<path>\" for an argument, at = \"-><path>\" for a result");
    }
    const results = target.startsWith("->");
    const rel = results ? target.slice(2) : target;
    if (rel === "" || !RELPATH.test(rel)) throw new DocError("E_DOC_TARGET", `at = ${JSON.stringify(target)} is not a relative path (spec 3.1 relpath)`);
    const m = /^\((\d+)\)/.exec(rel);
    const tuple = results ? place.func.results : place.func.args;
    if (m === null && tuple.length !== 1) throw new DocError("E_DOC_TARGET", `${place.method} has ${tuple.length} ${results ? "results" : "arguments"}, so at must start with (i) (spec 3.2 rule 9)`);
    return `${place.method}${results ? "->" : ""}${m === null ? "(0)" : m[0]}${tail(m === null ? rel : rel.slice(m[0].length))}`;
  }
  if (methodTag) throw new DocError("E_DOC_TARGET", "a method tag belongs on a method's doc comment");
  if (target === undefined) return place.address;
  if (target.startsWith("->") || target.startsWith("(") || !RELPATH.test(target)) {
    throw new DocError("E_DOC_TARGET", `at = ${JSON.stringify(target)}: on a field or a declaration, at is a path inside it, such as "owner" or "[].amount"`);
  }
  return `${place.address}${tail(target)}`;
}

/** A relpath tail as address segments: "amount" -> ".amount", ".a[]" and "[]" stay. */
function tail(rel) {
  if (rel === "") return "";
  const text = rel.startsWith(".") || rel.startsWith("[") ? rel : `.${rel}`;
  if (parsePath(text) === null) throw new DocError("E_DOC_TARGET", `cannot read the path ${JSON.stringify(rel)}`);
  return text;
}

/** A doc value as the JSON a profile holds (spec section 4), or a DocError. */
function jsonValue(v, where) {
  switch (v?.kind) {
    case "text":
    case "ident":
      return v.value;
    case "bool":
      return v.value;
    case "number": {
      // no silent rounding (spec 5.3, D-006): a fraction is refused, an integer is kept exact
      if (!/^-?(0|[1-9][0-9]*)$/.test(v.value)) throw new DocError("E_DOC_VALUE", `${v.value} is not a whole number; no tag argument takes a fraction`);
      const n = BigInt(v.value);
      if (STRING_INTEGERS.has(where)) return n.toString();
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
    }
    case "call": {
      if (v.name === "query") {
        const [m] = v.args;
        if (v.args.length !== 1 || (m.kind !== "ident" && m.kind !== "text") || !IDENT.test(m.value)) throw new DocError("E_DOC_VALUE", "query(...) takes one method name, for example query(decimals)");
        return { from: `query:${m.value}` };
      }
      if (v.name === "now" || v.name === "caller") {
        if (v.args.length !== 0) throw new DocError("E_DOC_VALUE", `${v.name}() takes no arguments`);
        return { from: v.name };
      }
      throw new DocError("E_DOC_VALUE", `${v.name}(...) is not a dynamic value; the dynamic values are query(<method>), now() and caller() (spec 4)`);
    }
    case "list":
      return v.items.map((x) => jsonValue(x, where));
    case "record":
      return Object.fromEntries(v.fields.map((f) => [f.key, jsonValue(f.value, `${where}.${f.key}`)]));
    default:
      throw new DocError("E_DOC_VALUE", `a value of kind ${JSON.stringify(v?.kind)} is not one this compiler reads`);
  }
}

/** An item's prose as describe.help: lines of a paragraph joined by spaces, paragraphs by a blank line. */
function prose(item) {
  const paragraphs = [];
  let current = [];
  for (const line of item.prose ?? []) {
    if (line === "") {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.length ? paragraphs.join("\n\n") : null;
}

/** The profile tag one or two edits from a name, if exactly one is. */
function nearestTag(name) {
  const near = [...TAGS].filter((t) => editDistance(t, name) <= 2 && Math.min(t.length, name.length) > 2);
  return near.length === 1 ? near[0] : null;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
