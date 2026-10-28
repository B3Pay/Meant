// The tool layer (#16, item 3): tools from a resolved form, run against an injected encoder, call and clock, with a
// confirmation hook awaited before any send. No transport, no keys, no Node built-ins: the host supplies all three.
//
// What it owes the profile spec (5.3, "idempotency", the outcome classes and the consumer rules) and D-017:
//   - An intent is the canister, the method and the converted arguments without the stamp (a relative time counts by
//     its duration). Preparing an intent that is prepared, unknown or waiting on a reconciliation returns the same
//     preview. Only a settled intent is stamped again, with a later stamp.
//   - commit awaits `confirm(preview)` before every send. A decline sends nothing and answers `declined`; a prepared
//     intent with no attempt is settled by it, an intent with an attempt keeps its state (#10, item 4, recommended
//     answer; open).
//   - success and already_done settle the intent; a later commit of it answers already_done without sending.
//   - retry_same is handed back: nothing sleeps here, the caller (or the person) commits again. The third retry_same of
//     an intent stops it (consumer rule 3): a reconciliation after an unknown outcome, else settled as fail.
//   - retry_new re-stamps into a new preview for the person to confirm, its relative times resolved again against the
//     new clock reading (#10, item 3, recommended; open). A CreatedInFuture re-stamp is capped by the ledger_time the
//     error reports (consumer rule 2).
//   - After an unknown outcome, any answer other than success, already_done or retry_same needs a reconciliation
//     (consumer rule 1, widened as #9 item 1 recommends; open), run by the injected `reconcile` when there is one.
//     retry_same is the exception because committing it again resends the same bytes with the same stamp, which
//     replay_same_payload makes safe: an earlier attempt that executed answers Duplicate (already_done) within the
//     window, and TooOld (retry_new, so a reconciliation) once the window has closed.
//   - A reject with code 1, 2 or 3 proves the call did not execute; 4 and 5, and any reject from the management
//     canister, are unknown outcomes (#8, recommended; open). A third answered unknown of an intent needs a
//     reconciliation, so a call that traps every time is not committed forever (#8, item 4).
//   - A `call` that throws is treated as an unknown outcome before the error is passed on: it may have executed.
//   - An update method without `idempotency` has no stamp, so nothing can make a second send safe or match the first in
//     the canister's history: after an unknown outcome (a throw, `unknown`, a reject 4 or 5) its intent is held at
//     `reconcile` with no read-back, and never sent again (spec 5.3: without the tag, never retried automatically).
//   - A read-only update (D-038) is a read: no preview, no confirmation, sent once as an update call.

import { COMMIT_TOOL, buildToolPlans, labelId, namesSets, relpathIds, toolDefinitions } from "./plan.mjs";
import { argTuple, displayArguments, displayValue, hex, readToolInput, withStamp } from "./input.mjs";

const MANAGEMENT = "aaaaa-aa";
/** Reject codes that prove the call did not execute (#8). */
const NOT_EXECUTED_CODES = new Set([1, 2, 3]);
/** Answered unknown outcomes (reject 4 or 5) of one intent before a reconciliation is needed (#8, item 4). */
const MAX_ANSWERED_UNKNOWN = 2;
/** retry_same answers of one intent before it stops being resent (spec 5.3, consumer rule 3: "at most a few"). */
const MAX_RETRY_SAME = 3;
/** Why an update without an idempotency stamp is held after an unknown outcome. */
const UNSTAMPED =
  "the method has no idempotency stamp, so a second send could run it twice and its history cannot be matched to this attempt; it is not sent again. Read the canister's state to learn whether it ran";

/**
 * The class of a decoded variant reply: its path against the outcome tag's keys, longest first. The path follows the
 * reply's variant cases, and at a record the one field the keys read there (`Ok.state.Failed`; `buildToolPlans` skips
 * keys that read two fields of one record).
 */
export function classifyReply(plan, reply) {
  // keys are relpaths, compared by the positions they resolve to (`(0).Ok`, `.Ok` and `Ok` are one key)
  const keys = Object.entries(plan.outcome.classes ?? {}).map(([k, cls]) => ({ ids: relpathIds(k) ?? [], cls }));
  const path = [];
  const ids = [];
  let node = plan.results[0];
  let value = reply;
  for (;;) {
    let step;
    if (node?.candid === "variant" && value !== null && typeof value === "object" && typeof value.tag === "string") {
      step = value.tag;
      node = node.cases?.[step];
      value = value.value;
    } else if (node?.candid === "record" && value !== null && typeof value === "object") {
      const next = keys.find((k) => k.ids.length > ids.length && ids.every((id, i) => k.ids[i] === id))?.ids[ids.length];
      step = next === undefined ? undefined : Object.keys(node.fields ?? {}).find((f) => labelId(f) === next);
      if (step === undefined || !Object.hasOwn(value, step)) break;
      node = node.fields[step];
      value = value[step];
    } else break;
    path.push(step);
    ids.push(labelId(step));
  }
  for (let n = path.length; n > 0; n--) {
    const want = ids.slice(0, n).join(".");
    const hit = keys.find((k) => k.ids.join(".") === want);
    if (hit) return { cls: hit.cls, path, node, value };
  }
  return { cls: plan.outcome.default ?? "fail", path, node, value };
}

const SUMMARY = {
  replied: "The query answered.",
  read_rejected: "The canister refused the read, so nothing was read.",
  read_unknown: "No answer arrived, so nothing was read. Reading changes nothing; call the tool again to read again.",
  prepared: "Prepared. Nothing has been sent; commit it with its preview_id once the person has seen it.",
  repeated: "This call is already prepared and not settled: the same preview is returned. It has not executed.",
  declined: "Declined: the person did not confirm, so nothing was sent. Do not commit it again without a new instruction.",
  declined_after_unknown: "Declined: nothing was sent this time, but an earlier attempt had an unknown outcome and may have executed. Tell the person; do not prepare a new call.",
  success: "Success: the call was executed.",
  already_done: "Already done: an identical call had already been executed. Treat it as done.",
  retry_same: "Temporarily refused, not executed. Commit the same preview_id again later, or tell the person.",
  retry_new: "The stamp was refused, so it was not executed. A new preview was prepared; show it to the person and commit it.",
  fix_input: "Not executed: correct the input and prepare the call again.",
  fail: "Not executed, and trying again will not help.",
  not_executed: "Rejected before it ran, so it was not executed. Commit the same preview_id again, or tell the person.",
  unknown: "The outcome is unknown: it may have executed. Commit the same preview_id again; do not prepare a new call.",
  reconcile: "An earlier attempt may have executed. Tell the person what happened; do not send or prepare this call again until they decide.",
  error: "Nothing was sent.",
};

const result = (structured, isError = false, summary = undefined) => {
  const key = summary ?? (structured.outcome === "declined" && structured.earlier_outcome === "unknown" ? "declined_after_unknown" : (structured.outcome ?? structured.status));
  const out = { content: [{ type: "text", text: `${SUMMARY[key] ?? ""}\n${JSON.stringify(structured, null, 2)}` }], structuredContent: structured };
  return isError ? { ...out, isError: true } : out;
};
const failure = (message, extra = {}) => result({ status: "error", message, ...extra }, true);

/** The value at a names relpath (`Ok`, `(0)`, `label`, `a.b`), walking the resolved nodes beside it; undefined if absent. */
function walk(node, value, path) {
  for (const step of path.replace(/^\(0\)/, "").split(".").filter(Boolean)) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (node?.candid === "variant") {
      if (value.tag !== step) return undefined;
      node = node.cases?.[step];
      value = value.value;
    } else if (node?.candid === "record" && Object.hasOwn(value, step)) {
      node = node.fields?.[step];
      value = value[step];
    } else return undefined;
  }
  return { node, value };
}

/** A names set's entries from its method's reply (spec 5.3, D-045), or undefined when the reply holds no list. */
function entriesOf(set, reply) {
  const items = walk(set.results[0], reply, set.args.items);
  if (!items || !Array.isArray(items.value)) return undefined;
  const element = items.node?.element;
  const field = (item, k) => (set.args[k] === undefined ? undefined : walk(element, item, set.args[k])?.value);
  return items.value
    .map((item) => ({ name: field(item, "name"), value: field(item, "value"), show: field(item, "show"), kind: field(item, "kind") }))
    .filter((e) => typeof e.name === "string");
}

/**
 * The entries of names set `set` in a reply of the method that lists it (spec 5.3, D-045), as the layer reads them
 * when a call is prepared: `{ name, value, show, kind }` per item, read through the profile's `items`, `name`, `value`,
 * `show` and `kind` relpaths. Undefined when the resolved form has no such set or the reply holds no list.
 */
export function nameEntries(resolved, set, reply) {
  const s = namesSets(resolved).get(set);
  return s === undefined ? undefined : entriesOf(s, reply);
}

/**
 * @param {object} config
 * @param {object | object[]} config.resolved  candid-profile-resolved v0 documents
 * @param {{ id: string, label?: string, refs?: Record<string, unknown> }[]} config.canisters  the canisters the tools
 *   may call, each with its resolved dynamic tag values (`{ "query:icrc1_decimals": 8, ... }`)
 * @param {(method: string, value: unknown, args: unknown[]) => Uint8Array | Promise<Uint8Array>} config.encode  the
 *   method's arguments (candid-core domain shapes) to the bytes that will be sent: candid-core's `encodeArgs` of
 *   `args`, the whole argument tuple. `value` is the single argument (the tuple again for a method with more than
 *   one), for hosts written before methods with more than one argument had tools
 * @param {(req: { canister: string, method: string, mode: string, arg: Uint8Array, value: unknown, args: unknown[] }) => Promise<
 *   { status: "replied", reply: unknown } | { status: "rejected", reject_code: number, message: string } | { status: "unknown", message: string }>} config.call
 *   sends `arg`, exactly, as a query or an update call (`mode`); `reply` is the decoded first result value. `value`
 *   and `args` are what `arg` encodes, as `encode` gets them, for hosts that send values (ic-reactor 4 today:
 *   B3Pay/ic-reactor#876, #877)
 * @param {(o: { canister: string }) => Promise<bigint>} config.now  the clock of the canister named, ns since the Unix
 *   epoch (canisters on different subnets keep different times)
 * @param {(preview: object) => Promise<boolean | { approved: boolean }>} [config.confirm]  asked before every send;
 *   required when the form has an update method (there is no auto-approve default)
 * @param {(o: { canister: string, method: string, value: unknown, stamp: bigint, preview: object }) => Promise<
 *   { status: "found", block?: bigint | string } | { status: "absent" | "not_yet" } | { status: "unreadable", reason?: string }>} [config.reconcile]
 *   consumer rule 1: look for the original in the canister's history (for ICRC-1/2, `@meantjs/reconcile`)
 */
export function createToolLayer({ resolved, canisters, encode, call, now, confirm, reconcile }) {
  if (!Array.isArray(canisters) || canisters.length === 0) throw new TypeError("createToolLayer: give at least one canister");
  for (const [name, fn] of [["encode", encode], ["call", call], ["now", now]]) if (typeof fn !== "function") throw new TypeError(`createToolLayer: \`${name}\` must be a function`);
  if (reconcile !== undefined && typeof reconcile !== "function") throw new TypeError("createToolLayer: `reconcile` must be a function");
  const { plans, skipped } = buildToolPlans(resolved);
  const writes = [...plans.values()].some((p) => p.kind === "prepare");
  if (writes && typeof confirm !== "function") throw new TypeError("createToolLayer: `confirm` must be a function (it is awaited before every send)");
  const definitions = toolDefinitions(resolved, { canisters });
  const sets = namesSets(resolved);
  const byId = new Map(canisters.map((c) => [c.id, c]));

  let counter = 0;
  const previews = new Map();
  const intents = new Map();
  // per intent key: the highest stamp sent (the ordering floor), and every stamp handed out (never reused exactly)
  const lastStamp = new Map();
  const takenStamps = new Map();

  function canisterOf(input) {
    const id = input?.canister_id;
    if (typeof id !== "string" || !byId.has(id)) return { error: `canister_id must be one of ${[...byId.keys()].join(", ")}` };
    return { canister: byId.get(id) };
  }

  const withoutCanister = (input) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const { canister_id, ...rest } = input;
    return rest;
  };

  const needsClock = (plan) => plan.params.some((p) => p.node.tags?.timestamp);

  /** The entries of each names set the plan's inputs may use, read from the canister now: once per intent (spec 5.3). */
  async function readNames(plan, canister) {
    const out = {};
    for (const p of plan.params) {
      const set = p.node.tags?.named?.args?.set;
      const s = sets.get(set);
      if (s === undefined || Object.hasOwn(out, set)) continue; // an undeclared set is E_NAMES_UNREAD at reading
      const arg = await encode(s.method, undefined, []);
      // a read-only update goes as an update call, as any read of it does (D-038)
      const r = await call({ canister: canister.id, method: s.method, mode: s.replicated ? "update" : "query", arg, value: undefined, args: [] });
      const entries = r.status === "replied" ? entriesOf(s, r.reply) : undefined;
      if (entries !== undefined) out[set] = entries;
    }
    return out;
  }

  async function runQuery(plan, input) {
    const c = canisterOf(input);
    if (c.error) return failure(c.error);
    const clock = needsClock(plan) ? await now({ canister: c.canister.id }) : undefined;
    const names = await readNames(plan, c.canister);
    const read = readToolInput(plan, withoutCanister(input), { refs: c.canister.refs ?? {}, now: clock, names });
    if (read.issues) return failure("the inputs were not read", { issues: read.issues });
    const args = argTuple(plan, read.value);
    const arg = await encode(plan.method, read.value, args);
    // a read-only update goes as an update call, or the certification it declares is lost (spec 5.3, D-038)
    const r = await call({ canister: c.canister.id, method: plan.method, mode: plan.replicated ? "update" : "query", arg, value: read.value, args });
    if (r.status !== "replied") {
      return result({ status: r.status, method: plan.method, canister: c.canister.id, message: r.message, reject_code: r.reject_code }, true, r.status === "rejected" ? "read_rejected" : "read_unknown");
    }
    return result({ status: "replied", method: plan.method, canister: c.canister.id, value: displayValue(plan.results[0], r.reply, c.canister.refs ?? {}) });
  }

  const previewView = (p) => ({
    preview_id: p.id,
    method: p.plan.method,
    canister: p.canister.id,
    title: p.plan.title,
    effect: p.plan.effect,
    arguments: displayArguments(p.plan, p.value, p.canister.refs ?? {}, p.intent?.names),
    arg_hex: hex(p.bytes),
  });

  async function makePreview(intent, clock, cap) {
    const read = readToolInput(intent.plan, intent.input, { refs: intent.canister.refs ?? {}, now: clock, names: intent.names });
    if (read.issues) return { issues: read.issues };
    let stamp;
    if (intent.plan.idempotency) {
      const earlier = lastStamp.get(intent.key);
      stamp = clock;
      if (earlier !== undefined && stamp <= earlier) stamp = earlier + 1n;
      const capped = cap !== undefined && cap < stamp;
      if (capped) stamp = cap; // consumer rule 2, on the final stamp
      // a stamp declined before any send set no floor (it was never seen), but it is never handed out again; a capped
      // stamp steps down so it stays at most the cap
      let taken = takenStamps.get(intent.key);
      if (taken === undefined) takenStamps.set(intent.key, (taken = new Set()));
      while (taken.has(stamp)) stamp += capped ? -1n : 1n;
      taken.add(stamp);
    }
    const value = withStamp(intent.plan, read.value, stamp);
    const bytes = await encode(intent.plan.method, value, argTuple(intent.plan, value));
    const p = { id: `p${++counter}`, intent, plan: intent.plan, canister: intent.canister, value, bytes, stamp, state: "open" };
    previews.set(p.id, p);
    intent.preview = p;
    return { preview: p };
  }

  async function runPrepare(plan, input) {
    const c = canisterOf(input);
    if (c.error) return failure(c.error);
    const raw = withoutCanister(input);
    const clock = await now({ canister: c.canister.id });
    // the names as they are now: the intent keeps them, so every preview of it reads the same values
    const names = await readNames(plan, c.canister);
    const read = readToolInput(plan, raw, { refs: c.canister.refs ?? {}, now: clock, names });
    if (read.issues) return failure("the call was not prepared", { issues: read.issues });
    const key = JSON.stringify([c.canister.id, plan.method, read.identity]);
    let existing = intents.get(key);
    // A preparation of the same intent still encoding: wait for it, then answer as for any repeat (one intent, one stamp).
    if (existing?.state === "preparing") {
      await existing.ready.catch(() => {});
      existing = intents.get(key);
    }
    if (existing !== undefined && ["prepared", "unknown", "reconcile"].includes(existing.state)) {
      if (existing.state === "reconcile") return result({ outcome: "reconcile", preview: previewView(existing.preview), finding: existing.finding }, true);
      // after an unknown outcome the call may have executed: say so, never "not executed"
      if (existing.state === "unknown" || existing.hadUnknown) return result({ status: "repeated", outcome: "unknown", preview: previewView(existing.preview) });
      return result({ status: "repeated", preview: previewView(existing.preview) });
    }
    // Registered before the first await, so a concurrent preparation of it finds it.
    const intent = { key, plan, canister: c.canister, input: raw, names, state: "preparing", hadUnknown: false, answeredUnknown: 0, retriedSame: 0, attempts: 0, busy: false };
    const previous = existing;
    intents.set(key, intent);
    let made;
    intent.ready = (async () => {
      made = await makePreview(intent, clock);
    })();
    try {
      await intent.ready;
    } catch (e) {
      if (previous === undefined) intents.delete(key);
      else intents.set(key, previous);
      throw e;
    }
    if (made.issues) {
      if (previous === undefined) intents.delete(key);
      else intents.set(key, previous);
      return failure("the call was not prepared", { issues: made.issues });
    }
    intent.state = "prepared";
    return result({ status: "prepared", preview: previewView(made.preview) });
  }

  async function runReconcile(intent, caseName) {
    const p = intent.preview;
    // fail closed: until the read-back settles it, no commit sends again, even if the hook throws (consumer rule 1)
    intent.state = "reconcile";
    let finding;
    try {
      if (!p.plan.idempotency) finding = { status: "unreadable", reason: UNSTAMPED };
      else if (reconcile === undefined) finding = { status: "unreadable", reason: "this tool layer has no reconcile hook" };
      else finding = await reconcile({ canister: p.canister.id, method: p.plan.method, value: p.value, stamp: p.stamp, preview: previewView(p) });
    } catch (e) {
      finding = { status: "unreadable", reason: `the reconcile hook failed: ${e?.message ?? String(e)}` };
    }
    if (finding === null || typeof finding !== "object") finding = { status: "unreadable", reason: "the reconcile hook gave no answer" };
    const view = { status: finding.status, ...(finding.block === undefined ? {} : { block: String(finding.block) }), ...(finding.reason === undefined ? {} : { reason: finding.reason }), ...(caseName ? { after: caseName } : {}) };
    if (finding.status === "found") {
      intent.state = "done";
      return result({ outcome: "already_done", preview_id: p.id, reconciled: view });
    }
    // absent: the read-back is conclusive (the hook answers not_yet while an attempt can still land), so the intent is
    // settled and may be prepared again with a new stamp, after the person decides
    intent.state = finding.status === "absent" ? "settled" : "reconcile";
    intent.finding = view;
    return result({ outcome: "reconcile", preview_id: p.id, finding: view }, true);
  }

  async function runCommit(input) {
    const id = input?.preview_id;
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => k !== "preview_id")) return failure("commit takes one input, preview_id");
    const p = typeof id === "string" ? previews.get(id) : undefined;
    if (p === undefined) return failure(`${JSON.stringify(id)} is not a preview_id from this tool layer`);
    if (p.state === "superseded") return failure(`${p.id} was replaced by ${p.successor}, which needs the person's confirmation`, { successor: p.successor });
    const intent = p.intent;
    if (intent.state === "done") return result({ outcome: "already_done", preview_id: p.id, sent: false });
    if (intent.state === "settled") return failure(`${p.id} is settled; prepare the call again for a new attempt`);
    if (intent.busy) return failure(`${p.id} is being committed already`);
    intent.busy = true;
    try {
      if (intent.state === "reconcile") return await runReconcile(intent);
      const answer = await confirm(previewView(p));
      const approved = answer === true || (answer !== null && typeof answer === "object" && answer.approved === true);
      if (!approved) {
        if (intent.attempts === 0) intent.state = "settled";
        // an earlier unknown attempt may have executed: the decline sends nothing, but it does not make the call unsent
        return result({ outcome: "declined", preview_id: p.id, sent: false, ...(intent.hadUnknown ? { earlier_outcome: "unknown" } : {}) });
      }
      intent.attempts++;
      // the floor counts sent stamps only, and never moves down: a capped re-stamp must not let a later intent reuse a stamp that ran
      const floor = lastStamp.get(intent.key);
      if (p.stamp !== undefined && (floor === undefined || p.stamp > floor)) lastStamp.set(intent.key, p.stamp);
      let r;
      try {
        r = await call({ canister: p.canister.id, method: p.plan.method, mode: "update", arg: p.bytes, value: p.value, args: argTuple(p.plan, p.value) });
      } catch (e) {
        // A call that throws (a network timeout, in most agents) may have executed: it is an unknown outcome, answered as
        // one (spec section 4: repeat the same commit), not passed on as an error the agent could take for "not sent"
        r = { status: "unknown", message: String(e?.message ?? e) };
      }
      return await settle(intent, p, r);
    } finally {
      intent.busy = false;
    }
  }

  async function settle(intent, p, r) {
    const base = { preview_id: p.id, method: p.plan.method, canister: p.canister.id };
    if (r.status === "unknown") {
      intent.hadUnknown = true;
      if (!p.plan.idempotency) return runReconcile(intent, "unknown");
      intent.state = "unknown";
      return result({ outcome: "unknown", ...base, message: r.message }, true);
    }
    if (r.status === "rejected") {
      if (NOT_EXECUTED_CODES.has(r.reject_code) && p.canister.id !== MANAGEMENT) {
        return result({ outcome: "not_executed", ...base, reject_code: r.reject_code, message: r.message }, true);
      }
      intent.hadUnknown = true;
      intent.answeredUnknown++;
      if (!p.plan.idempotency || intent.answeredUnknown > MAX_ANSWERED_UNKNOWN) return runReconcile(intent, `reject ${r.reject_code}`);
      intent.state = "unknown";
      return result({ outcome: "unknown", ...base, reject_code: r.reject_code, message: r.message }, true);
    }
    const c = classifyReply(p.plan, r.reply);
    const caseName = c.path.join(".");
    const details = displayValue(c.node, c.value, p.canister.refs ?? {});
    const answer = { ...base, case: caseName, ...(details === null ? {} : { details }) };
    if (c.cls === "success" || c.cls === "already_done") {
      intent.state = "done";
      return result({ outcome: c.cls, ...answer });
    }
    if (intent.hadUnknown && c.cls !== "retry_same") return runReconcile(intent, caseName);
    switch (c.cls) {
      case "retry_same":
        // consumer rule 3: the retries stop after a few. With an earlier unknown outcome the call may have executed, so
        // rule 1 applies; without one every answer said "not executed", so the intent settles and a new attempt is a
        // new preparation the person confirms again
        if (++intent.retriedSame >= MAX_RETRY_SAME) {
          if (intent.hadUnknown) return runReconcile(intent, caseName);
          intent.state = "settled";
          return result({ outcome: "fail", ...answer, retries_spent: intent.retriedSame }, true);
        }
        return result({ outcome: "retry_same", ...answer }, true);
      case "retry_new": {
        // consumer rule 2 caps only a CreatedInFuture re-stamp, by the case the reply named, never by a field's name alone
        const createdInFuture = c.path[c.path.length - 1] === "CreatedInFuture";
        const reported = createdInFuture && c.value !== null && typeof c.value === "object" && typeof c.value.ledger_time === "bigint" ? c.value.ledger_time : undefined;
        const made = await makePreview(intent, await now({ canister: p.canister.id }), reported);
        if (made.issues) {
          intent.state = "settled";
          return result({ outcome: "fix_input", ...answer, issues: made.issues }, true);
        }
        p.state = "superseded";
        p.successor = made.preview.id;
        intent.attempts = 0;
        return result({ outcome: "retry_new", ...answer, next: previewView(made.preview) }, true);
      }
      default:
        intent.state = "settled";
        return result({ outcome: c.cls === "fix_input" ? "fix_input" : "fail", ...answer }, true);
    }
  }

  const handlers = new Map([[COMMIT_TOOL, runCommit]]);
  for (const plan of plans.values()) handlers.set(plan.name, plan.kind === "read" ? (input) => runQuery(plan, input) : (input) => runPrepare(plan, input));

  return {
    /** MCP tool definitions; a fresh copy each call. */
    listTools: () => JSON.parse(JSON.stringify(definitions)),
    /** The methods the form has that got no tool, and why. */
    skipped: skipped.map((s) => ({ ...s })),
    /** Run a tool. Resolves to `{ content, structuredContent, isError? }`; throws only when a host function throws. */
    async callTool(name, input) {
      const handler = handlers.get(name);
      if (handler === undefined) return failure(`unknown tool ${String(name)}; the tools are ${[...handlers.keys()].sort().join(", ")}`);
      return handler(input);
    },
  };
}
