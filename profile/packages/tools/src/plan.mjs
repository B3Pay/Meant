// Tool plans and tool definitions from any resolved form (#16, items 1 and 5).
//
// One tool per query method (named as the method), one `prepare_<method>` per update method, and one shared
// `commit`, as arm C does (packages/mcp-adapters/src/arm-c/spec.mjs). The rules for what a position becomes are
// arm C's (profile spec 5.3, `default`, `ui`, `idempotency`):
//   - a position with a value tag and no hiding rule is a string input in human units;
//   - so is an untagged `principal` position, read as its textual form (input.mjs, `inputReader`): it has exactly one,
//     checksummed, so it needs no profile meaning to be read exactly;
//   - so is an untagged integer position with a `describe`, read as decimal digits with no conversion: the profile
//     says what the number is (an action id, a page size), and the Candid type bounds it;
//   - an `auto` default (value null), the idempotency stamp and `ui.hidden` positions are not inputs; the tool layer
//     fills them (null, the stamp from the canister's clock);
//   - a `suggest` default stays an input.
// Unlike arm C, a method this file has no rule for is skipped with a reason rather than thrown on: an app's resolved
// form may hold methods no agent should call, and `buildToolPlans` reports them. Beyond arm C (its packs meet none of
// these; proposal w9-b3wallet-gaps.md, B2):
//   - a read-only update (`effect` read with `replicated: true`, D-038) is a read tool, sent as an update call;
//   - an update method without `idempotency` gets a prepare tool too; the tool layer never sends it again after an
//     unknown outcome (spec 5.3: without the tag, never retried automatically);
//   - outcome keys may pass through record fields (`Ok.state.Failed`), so long as no two keys read different fields
//     of one record (one reply could match both);
//   - a method with more than one argument takes each as an input of its own, `arg0`, `arg1` and so on.
// And beyond those (D-050, proposal w6-adoption.md items 2 and 3):
//   - a `text` position reads the text as given, within its `text` tag; a `bool` position reads "true" or "false";
//   - a record, variant or vec position with no value tag is one input given as JSON, whose leaves are read by these
//     rules (input.mjs, `inputWithoutRule`); a single argument that is a variant or a vec is the input `arg0`;
//   - outcome keys may start with a record field (`result.Ok` over `record { result : opt variant { Ok; Err } }`);
//   - an outcome with `default` alone classes every reply of a method whose result has no variant to select.
//
// The input words come from the format library (`Formatter.describe()`), so a form hint and a tool schema read
// one grammar. Arm C keeps its own frozen words (D-015, D-030, D-031).

import { MAX_VEC_ITEMS, inputReader, inputWithoutRule, nestedRole, readAs } from "./input.mjs";

export const COMMIT_TOOL = "commit";
export const prepareToolName = (method) => `prepare_${method}`;
const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/** The Candid id of a label: `#n` is n, a name is its idl hash (profile spec 3.2). */
export function labelId(label) {
  if (/^#(?:0|[1-9][0-9]*)$/.test(label)) return Number(label.slice(1));
  let h = 0;
  for (const b of new TextEncoder().encode(label)) h = (h * 223 + b) >>> 0;
  return h;
}

/**
 * The label ids of a relpath into a one-element tuple, or null if it is not a plain label path there. `(0).Ok`,
 * `.Ok`, `Ok` and `#17724` are one position (profile spec 3.2, rule 9), so positions are compared by these ids, never
 * by spelling.
 */
export function relpathIds(rel) {
  const m = /^(?:\(0\))?\.?((?:[A-Za-z_][A-Za-z0-9_]*|#[0-9]+)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|#[0-9]+))*)$/.exec(rel ?? "");
  return m ? m[1].split(".").map(labelId) : null;
}

/**
 * The methods of one or more resolved forms, merged by name and sorted. A method two forms resolve differently is an
 * error: merging layers is the resolver's job (profile spec section 8).
 * @param {object | object[]} resolved  candid-profile-resolved v0 documents
 * @returns {[string, any][]}
 */
export function resolvedMethods(resolved) {
  const docs = Array.isArray(resolved) ? resolved : [resolved];
  if (docs.length === 0) throw new TypeError("resolved: give at least one resolved form");
  const methods = new Map();
  for (const doc of docs) {
    if (doc === null || typeof doc !== "object" || doc.format !== "candid-profile-resolved" || doc.format_version !== 0) {
      throw new TypeError("resolved: not a candid-profile-resolved v0 document");
    }
    for (const [name, method] of Object.entries(doc.methods ?? {})) {
      const seen = methods.get(name);
      if (seen === undefined) methods.set(name, method);
      else if (JSON.stringify(seen) !== JSON.stringify(method)) throw new TypeError(`resolved: ${name} is resolved differently by two forms; merge them with the resolver first`);
    }
  }
  return [...methods.entries()].sort(byName);
}

/** @returns {{ role: "param" | "auto" | "stamp" | "hidden" | "none" } | { skip: string }} */
function classifyField(name, node, stampId) {
  const tags = node.tags ?? {};
  const optional = node.optional === true;
  const def = tags.default?.args;
  if (def !== undefined && def.value !== "null") return { skip: `${name}: a default value other than null has no rule` };
  if (stampId !== undefined && labelId(name) === stampId) {
    // a required stamp is allowed (the resolver's W_STAMP_REQUIRED): the layer always fills it
    if (!tags.timestamp || node.candid !== "nat64" || tags.timestamp.args?.unit !== "ns") return { skip: `${name}: the idempotency stamp must be a nat64 timestamp in ns` };
    return { role: "stamp" };
  }
  if (def?.mode === "auto") return optional ? { role: "auto" } : { skip: `${name}: an auto default needs an optional position` };
  if (tags.ui?.args?.hidden === true) return optional ? { role: "hidden" } : { skip: `${name}: a hidden position must be optional` };
  // a null or reserved position has one value, so it is filled, never asked for
  if (!readAs(node) && (node.candid === "null" || node.candid === "reserved") && !node.recursive) return { role: "none" };
  const why = inputWithoutRule(node, name);
  return why ? { skip: why } : { role: "param" };
}

/**
 * Why an outcome class key cannot be read by `classifyReply`, or undefined. It walks variant cases and record fields,
 * and at a record follows the one field the keys name there; so a key it could not follow, or two keys that read
 * different fields of one record (a reply could match both, at the same depth), skip the method rather than let a
 * reply fall to the default class or to whichever key comes first.
 */
function outcomeKeyWithoutRule(classes, result) {
  const fieldAt = new Map(); // the path to a record -> the first key through it, and the field that key reads there
  for (const key of Object.keys(classes ?? {})) {
    const ids = relpathIds(key);
    if (ids === null) return `the outcome key ${key} is not a path of cases and fields`;
    let node = result;
    for (const [i, id] of ids.entries()) {
      if (node?.candid === "variant") {
        const hit = Object.entries(node.cases ?? {}).find(([name]) => labelId(name) === id);
        if (hit === undefined) return `the outcome key ${key} names no case of the result`;
        node = hit[1];
      } else if (node?.candid === "record") {
        const hit = Object.entries(node.fields ?? {}).find(([name]) => labelId(name) === id);
        if (hit === undefined) return `the outcome key ${key} names no field of the result`;
        if (i === ids.length - 1) return `the outcome key ${key} ends on a record field; an outcome key selects a case`;
        const at = ids.slice(0, i).join(".");
        const first = fieldAt.get(at);
        if (first === undefined) fieldAt.set(at, { key, id });
        else if (first.id !== id) return `the outcome keys ${first.key} and ${key} read different fields of one record, so one reply could match both`;
        node = hit[1];
      } else return `the outcome key ${key} passes through a ${node?.candid ?? "missing"} position; only variant cases and record fields have a rule`;
    }
  }
  return undefined;
}

/** @returns {object | { skip: string }} */
function planMethod(name, m) {
  const tags = m.tags ?? {};
  const effect = tags.effect?.args;
  // a read-only update (D-038) is a read for consumers, and must be sent as an update so that its answer is certified
  const replicated = m.mode === "update" && effect?.kind === "read" && effect.irreversible === false && effect.replicated === true;
  // a composite query is a read too (arm C has none to meet: the ICRC-1/2 packs declare only queries and updates)
  const read = m.mode === "query" || m.mode === "composite_query" || replicated;
  const args = Array.isArray(m.args) ? m.args : [];
  const plan = {
    name: read ? name : prepareToolName(name),
    kind: read ? "read" : "prepare",
    method: name,
    mode: m.mode,
    /** a read sent as an update call */
    replicated,
    effect: effect ?? (read ? { kind: "read", irreversible: false } : { kind: "write", irreversible: true }),
    describe: tags.describe?.args,
    intent: tags.intent?.args,
    idempotency: tags.idempotency?.args,
    outcome: tags.outcome?.args,
    /** the method's single argument, or undefined (none, or more than one) */
    argNode: args.length === 1 ? args[0] : undefined,
    /** every argument, in order */
    argNodes: args,
    /** the inputs, in resolved-form order: { name, node, optional, path } */
    params: [],
    /** the argument record's field the stamp relpath resolves to */
    stampField: undefined,
    /** the record fields (or, with more than one argument, the arguments), inputs and filled ones: { name, node, role, optional } */
    fields: [],
    rootParam: false,
    /** the single argument is null or reserved: no input, and null is sent */
    rootNull: false,
    results: m.results ?? [],
  };
  plan.title = plan.intent?.title ?? plan.describe?.label ?? name;
  if (read && plan.results.length > 1) return { skip: "a query with more than one result has no rule (only the first would be shown)" };
  // the stamp would be an input, or left unset: the stamp rules are for writes
  if (replicated && plan.idempotency) return { skip: "a read-only update with an idempotency stamp has no rule" };
  if (!read) {
    for (const need of ["intent", "outcome"]) if (!tags[need]) return { skip: `an update method needs the ${need} tag` };
    if (plan.idempotency && plan.idempotency.mode !== "replay_same_payload") return { skip: `idempotency mode ${plan.idempotency.mode} has no rule` };
    if (!plan.idempotency && [...Object.values(plan.outcome.classes ?? {}), plan.outcome.default].includes("retry_new")) {
      return { skip: "the outcome class retry_new renews an idempotency stamp, and this method has none" };
    }
    // With keys, one result whose cases they select; with `default` alone, every reply is that class (spec 5.3, D-049)
    if (Object.keys(plan.outcome.classes ?? {}).length > 0) {
      if (plan.results.length !== 1) return { skip: "outcome keys need a method with one result" };
      const unread = outcomeKeyWithoutRule(plan.outcome.classes, plan.results[0]);
      if (unread) return { skip: unread };
    } else if (plan.outcome.default === undefined) return { skip: "the outcome has neither keys nor a default" };
  }
  if (args.length > 1) {
    // each argument is one input, named by its place; a record among them has no rule (its fields could collide)
    if (plan.idempotency) return { skip: "an idempotency stamp in a method with more than one argument has no rule" };
    for (const [i, node] of args.entries()) {
      const c = classifyField(`(${i})`, node);
      if (c.skip) return c;
      const optional = node.optional === true;
      plan.fields.push({ name: `arg${i}`, node, role: c.role, optional });
      if (c.role === "param") plan.params.push({ name: `arg${i}`, node, optional, path: `$args[${i}]` });
    }
  } else if (args.length === 1) {
    const root = args[0];
    const tag = readAs(root);
    if (tag) {
      const why = inputWithoutRule(root, "(0)"); // a text pattern the layer does not run
      if (why) return { skip: why };
      // the stamp is filled by the tool layer, so it must be a field beside the inputs, never the whole argument
      if (plan.idempotency) return { skip: `the stamp ${plan.idempotency.stamp} must name one field of the argument record` };
      plan.rootParam = true;
      plan.params.push({ name: tag, node: root, optional: root.optional === true, path: "$args[0]" });
    } else if (root.candid === "record") {
      let stampId;
      if (plan.idempotency) {
        const ids = relpathIds(plan.idempotency.stamp);
        if (ids === null || ids.length !== 1) return { skip: `the stamp ${plan.idempotency.stamp} must name one field of the argument record` };
        stampId = ids[0];
      }
      for (const [fname, fnode] of Object.entries(root.fields ?? {})) {
        // the canister selector of every tool (toolDefinitions, the tool layer) owns this input name
        if (fname === "canister_id") return { skip: "an argument field named canister_id would collide with the canister selector input" };
        const c = classifyField(fname, fnode, stampId);
        if (c.skip) return c;
        if (c.role === "stamp") plan.stampField = fname;
        const optional = fnode.optional === true;
        plan.fields.push({ name: fname, node: fnode, role: c.role, optional });
        if (c.role === "param") plan.params.push({ name: fname, node: fnode, optional, path: `$args[0].${fname}` });
      }
      if (plan.idempotency && !plan.fields.some((f) => f.role === "stamp")) return { skip: `the stamp field ${plan.idempotency.stamp} is not an argument field` };
    } else if (root.candid === "null" || root.candid === "reserved") {
      // one value only, so nothing to ask for: the tool takes no input and sends null
      if (plan.idempotency) return { skip: `the stamp ${plan.idempotency.stamp} must name one field of the argument record` };
      plan.rootNull = true;
    } else {
      // a variant or a vec (or a record a value tag does not cover) is one JSON input
      const why = inputWithoutRule(root, "(0)");
      if (why) return { skip: why };
      if (plan.idempotency) return { skip: `the stamp ${plan.idempotency.stamp} must name one field of the argument record` };
      plan.rootParam = true;
      plan.params.push({ name: "arg0", node: root, optional: root.optional === true, path: "$args[0]" });
    }
  }
  return plan;
}

/**
 * @param {object | object[]} resolved
 * @returns {{ plans: Map<string, any>, skipped: { method: string, reason: string }[] }}  plans keyed by tool name, sorted
 */
export function buildToolPlans(resolved) {
  const plans = new Map();
  const skipped = [];
  const byTool = new Map();
  for (const [name, m] of resolvedMethods(resolved)) {
    const p = planMethod(name, m);
    if (p.skip) skipped.push({ method: name, reason: p.skip });
    else byTool.set(p.name, [...(byTool.get(p.name) ?? []), p]);
  }
  // Two methods whose tools share a name (a query named prepare_x beside an update x), or one named like the commit
  // tool: neither is dropped silently, and neither is preferred, so all of them are skipped.
  for (const [tool, ps] of byTool) {
    if (tool === COMMIT_TOOL) for (const p of ps) skipped.push({ method: p.method, reason: `its tool name ${tool} is the commit tool's` });
    else if (ps.length > 1) for (const p of ps) skipped.push({ method: p.method, reason: `its tool name ${tool} is also ${ps.filter((q) => q !== p).map((q) => q.method).join(", ")}'s` });
    else plans.set(tool, ps[0]);
  }
  return { plans: new Map([...plans.entries()].sort(byName)), skipped };
}

/**
 * The names sets the resolved forms declare (spec 5.3, D-045): set -> { method, mode, replicated, args, results },
 * where `args` are the `names` tag's (items, name, value, show, kind) and `results` the method's result nodes.
 */
export function namesSets(resolved) {
  const sets = new Map();
  for (const [name, m] of resolvedMethods(resolved)) {
    const args = m.tags?.names?.args;
    if (!args) continue;
    const effect = m.tags.effect?.args;
    const replicated = m.mode === "update" && effect?.kind === "read" && effect.irreversible === false && effect.replicated === true;
    sets.set(args.set, { method: name, mode: m.mode, replicated, args, results: m.results ?? [] });
  }
  return sets;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Words for an input whose tag arguments differ between the canisters (or are not known): the grammar without them. */
const GENERIC = {
  amount: "Amount in the token's own units as a decimal number, optionally followed by the token's symbol. Never rounded: more digits after the point than the token has is an error.",
  timestamp: 'Time in RFC 3339 with an explicit zone, for example "2026-12-25T10:00:00Z", or relative to the current time as "+" and an ISO 8601 duration with weeks, days, hours, minutes and seconds only, for example "+PT24H".',
  duration: 'ISO 8601 duration with weeks, days, hours, minutes and seconds only, for example "PT24H" or "P7D".',
  account: 'ICRC-1 account in text form: a principal for its default subaccount, or "principal-checksum.subaccounthex".',
  subaccount: 'Subaccount as "#n" (the number n below 2^64) or as exactly 64 hex characters.',
  bytes: "Bytes, in the encoding the position's profile names.",
  principal: 'A principal (a canister or user id) in its textual form, for example "ryjl3-tyaaa-aaaaa-aaaba-cai".',
  integer: "A whole number in decimal digits, written as it is: no unit, separators, exponent or leading zeros.",
  text: "Text, exactly as given.",
  bool: 'Yes or no, written "true" or "false".',
};

/** The description of one input across the canisters: the formatter's own when every canister agrees, else generic. */
function grammarOf(node, refsList) {
  const seen = new Map();
  for (const refs of refsList) {
    let d;
    try {
      d = inputReader(node, refs).describe();
    } catch {
      return { summary: GENERIC[readAs(node)] };
    }
    seen.set(JSON.stringify(d), d);
  }
  return seen.size === 1 ? [...seen.values()][0] : { summary: GENERIC[readAs(node)] };
}

/** The schema of one input: a string for a position `readAs` names, else the JSON shape of a record, variant or vec. */
function inputProperty(node, optional, refsList, sets) {
  const d = node.tags?.describe?.args;
  const parts = [];
  if (d?.label) parts.push(`${d.label}.`);
  if (readAs(node)) {
    const grammar = grammarOf(node, refsList);
    const named = node.tags?.named?.args;
    parts.push(grammar.summary);
    // a name is no value of the grammar, so a named input has no pattern
    if (named) parts.push(`Or the name of one of the canister's ${named.set} entries, as ${sets.get(named.set)?.method ?? "its names method"} lists them, matched with case and spacing aside. A name more than one entry has is refused: ask the person which.`);
    if (d?.help) parts.push(d.help);
    if (optional) parts.push("Optional: leave it out for none.");
    return { type: "string", description: parts.join(" "), ...(grammar.pattern === undefined || named ? {} : { pattern: grammar.pattern }) };
  }
  let shape;
  if (node.candid === "record") {
    const entries = [];
    const required = [];
    for (const [name, f] of Object.entries(node.fields ?? {})) {
      if (nestedRole(name, f).role !== "param" || f.candid === "null" || f.candid === "reserved") continue;
      entries.push([name, inputProperty(f, f.optional === true, refsList, sets)]);
      if (f.optional !== true) required.push(name);
    }
    parts.push("A JSON object.");
    shape = { type: "object", properties: Object.fromEntries(entries), required, additionalProperties: false };
  } else if (node.candid === "variant") {
    const oneOf = Object.entries(node.cases ?? {}).map(([name, c]) => {
      const takes = !(c.candid === "null" || c.candid === "reserved") && !readAsNothing(c);
      return {
        type: "object",
        properties: { tag: { const: name }, ...(takes ? { value: inputProperty(c, c.optional === true, refsList, sets) } : {}) },
        required: takes && c.optional !== true ? ["tag", "value"] : ["tag"],
        additionalProperties: false,
      };
    });
    parts.push(`One of ${oneOf.length} cases, as a JSON object {"tag": the case, "value": its value}; a case without a value takes the tag alone.`);
    shape = { oneOf };
  } else {
    // an element cannot be left out without moving the others, so a none element is a JSON null
    const el = node.element;
    const none = readAsNothing(el);
    const items = none ? { type: "null" } : inputProperty(el, false, refsList, sets);
    parts.push(`A JSON array of at most ${MAX_VEC_ITEMS} elements${none ? ", each null" : el.optional === true ? "; null for an element that is none" : ""}.`);
    shape = { type: "array", items: el.optional === true && !none ? { anyOf: [items, { type: "null" }] } : items, maxItems: MAX_VEC_ITEMS };
  }
  if (d?.help) parts.push(d.help);
  if (optional) parts.push("Optional: leave it out for none.");
  return { ...shape, description: parts.join(" ") };
}

const readAsNothing = (node) => !readAs(node) && (node.candid === "null" || node.candid === "reserved");

const paramProperty = (param, refsList, sets) => inputProperty(param.node, param.optional, refsList, sets);

/** @param {{ id: string, label?: string }[]} canisters */
const canisterProperty = (canisters) => ({
  type: "string",
  enum: canisters.map((c) => c.id),
  description: `Canister id of the canister to call: ${canisters.map((c) => (c.label ? `${c.id} (${c.label})` : c.id)).join(", ")}.`,
});

function inputSchema(plan, canisters, refsList, sets) {
  // entries, not assignments: a field named `__proto__` must become an own property
  const entries = [];
  const required = [];
  if (canisters.length > 0) {
    entries.push(["canister_id", canisterProperty(canisters)]);
    required.push("canister_id");
  }
  for (const p of plan.params) {
    entries.push([p.name, paramProperty(p, refsList, sets)]);
    if (!p.optional) required.push(p.name);
  }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: Object.fromEntries(entries), required, additionalProperties: false };
}

function filledByToolLayer(plan) {
  const parts = [];
  for (const f of plan.fields) {
    if (f.role === "stamp") parts.push(`${f.name} (the idempotency stamp, set once from the canister's clock and reused for every retry)`);
    else if (f.role !== "param") parts.push(`${f.name} (left empty)`);
  }
  return parts.join("; ");
}

function definitionOf(plan, canisters, refsList, sets) {
  const schema = inputSchema(plan, canisters, refsList, sets);
  if (plan.kind === "read") {
    const label = plan.describe?.label;
    const what = plan.replicated ? `Read-only call of \`${plan.method}\`, sent as an update call so that the answer is certified; it changes nothing.` : `Read-only query of \`${plan.method}\`.`;
    return {
      name: plan.name,
      description: `${label ? `${label}. ` : ""}${what} The answer gives each value formatted for people and raw (base units for amounts, the tagged unit for times).`,
      inputSchema: schema,
      annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true, title: label ?? plan.method },
    };
  }
  const e = plan.effect;
  const filled = filledByToolLayer(plan);
  return {
    name: plan.name,
    description:
      `Prepare the call "${plan.title}" (\`${plan.method}\`, effect: ${e.kind}${e.irreversible ? ", irreversible" : ""}). Nothing is sent yet. ` +
      "Inputs are in human units and are checked exactly (nothing is rounded). " +
      (plan.idempotency ? "" : "This call has no idempotency stamp, so the canister cannot tell a repeat from a new call: once an attempt's outcome is unknown, it is never sent again (commit answers reconcile). ") +
      (filled ? `The tool layer fills in: ${filled}. ` : "") +
      "Returns a preview_id and the exact arguments; commit sends it after the person confirms. Preparing the same call again returns the same preview_id.",
    inputSchema: schema,
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true, title: plan.title },
  };
}

const commitDefinition = () => ({
  name: COMMIT_TOOL,
  description:
    "Send a call prepared by a prepare_* tool, exactly as previewed, once the person confirms it: the same bytes every time, so repeating commit is safe. " +
    "The result names an outcome: success; already_done (treat it as success); declined (the person said no: nothing was sent, do not commit it again without a new instruction); " +
    "retry_same (temporary: commit the same preview_id again later); retry_new (a new preview is returned, to confirm and commit); fix_input (correct the input and prepare again); " +
    "fail (do not retry); unknown (commit the same preview_id again; do not prepare a new call); reconcile (an earlier attempt may have executed: tell the person).",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { preview_id: { type: "string", description: "The preview_id returned by a prepare_* tool." } },
    required: ["preview_id"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true, openWorldHint: true, readOnlyHint: false, title: "Commit a prepared call" },
});

/**
 * MCP tool definitions (`name`, `description`, `inputSchema`, `annotations`) from any resolved form, sorted by name.
 * A fresh copy on every call.
 *
 * @param {object | object[]} resolved  one or more candid-profile-resolved v0 documents
 * @param {{ canisters?: { id: string, label?: string, refs?: Record<string, unknown> }[] }} [options]
 *   `canisters`: the canisters the tools may call. Given, every tool takes a required `canister_id` (one of their ids),
 *   and each input's words carry the tag arguments the canisters' `refs` resolve (decimals, symbol) when they agree.
 */
export function toolDefinitions(resolved, { canisters = [] } = {}) {
  if (!Array.isArray(canisters)) throw new TypeError("toolDefinitions: `canisters` must be an array");
  for (const c of canisters) if (typeof c?.id !== "string" || c.id === "") throw new TypeError("toolDefinitions: every canister needs an `id`");
  const refsList = canisters.length > 0 ? canisters.map((c) => c.refs ?? {}) : [{}];
  const { plans } = buildToolPlans(resolved);
  const sets = namesSets(resolved);
  const defs = [...plans.values()].map((p) => definitionOf(p, canisters, refsList, sets));
  if ([...plans.values()].some((p) => p.kind === "prepare")) defs.push(commitDefinition());
  defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.parse(JSON.stringify(defs));
}
