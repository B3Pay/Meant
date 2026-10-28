// The tool rules an interface beyond the ICRC packs needs (proposal docs/proposals/w9-b3wallet-gaps.md, B2, items 1,
// 2, 4, 5 and 6), each against a resolved form shaped like B3Wallet's wallet canister:
//   1. a read-only update (D-038) is a read tool, sent as an update call;
//   2. an update without `idempotency` gets a prepare tool, and is never sent again after an unknown outcome;
//   4. an untagged integer position with a `describe` is an integer input;
//   5. outcome keys through a record field are classified;
//   6. a method with more than one argument takes each as an input.
// The packs meet none of them, so their tools stay as they were (definitions.test.mjs, principal.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { c } from "@candid-core/schema";
import { encodeArgs } from "@candid-core/schema/codec";
import { buildToolPlans, classifyReply, createToolLayer, readToolInput, toolDefinitions } from "../src/index.mjs";
import { PACKS } from "./helpers.mjs";

const WALLET = "uxrrr-q7777-77774-qaaaq-cai";
const OWNER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const label = (text) => ({ describe: { args: { label: text }, origin: "author", profile: "test" } });
const tag = (args) => ({ args, origin: "author", profile: "test" });
const nul = { candid: "null" };

const ACTION_STATE = { candid: "variant", cases: { Waiting: nul, Ready: nul, Executed: { candid: "nat64" }, Failed: { candid: "text" } } };
const PENDING_RESULT = {
  candid: "variant",
  cases: { Ok: { candid: "record", fields: { id: { candid: "nat64" }, state: ACTION_STATE } }, Err: { candid: "variant", cases: { NotFound: nul, TimelockActive: nul } } },
};
const action = (effect, classes) => ({
  mode: "update",
  args: [{ candid: "nat64", tags: label("Action") }],
  results: [PENDING_RESULT],
  tags: { intent: tag({ title: "Run an action", template: "Run action {(0)}" }), effect: tag(effect), outcome: tag({ classes, default: "fail" }) },
});

/** A wallet-like resolved form: every method here meets one of the rules above. */
const RESOLVED = {
  format: "candid-profile-resolved",
  format_version: 0,
  methods: {
    // rule 1 and rule 4
    balance: {
      mode: "update",
      args: [{ candid: "nat32", tags: { describe: tag({ label: "Account", help: "The account's id, from accounts." }) } }],
      results: [{ candid: "variant", cases: { Ok: { candid: "nat" }, Err: { candid: "text" } } }],
      tags: { effect: tag({ kind: "read", irreversible: false, replicated: true }) },
    },
    // rule 4 in a record, with an optional field
    audit_log: {
      mode: "query",
      args: [{ candid: "record", fields: { limit: { candid: "nat16", tags: label("Entries") }, before_seq: { candid: "nat64", optional: true, tags: label("Before entry") } } }],
      results: [{ candid: "vec", element: { candid: "text" } }],
      tags: {},
    },
    // rules 2, 4 and 5
    execute: action({ kind: "transfer", irreversible: true }, { "Ok.state.Executed": "success", "Ok.state.Failed": "fail", "Ok.state.Ready": "retry_same", "Err.TimelockActive": "retry_same" }),
    approve: action({ kind: "write", irreversible: true }, { Ok: "success", "Err.NotFound": "fail" }),
    // rule 6
    request_join: {
      mode: "update",
      args: [
        { candid: "principal", tags: label("Who") },
        { candid: "nat8", optional: true, tags: label("Seats") },
      ],
      results: [{ candid: "variant", cases: { Ok: { candid: "nat64" }, Err: { candid: "text" } } }],
      tags: { intent: tag({ title: "Ask to join", template: "Ask to join as {(0)}" }), effect: tag({ kind: "write", irreversible: false }), outcome: tag({ classes: { Ok: "success" }, default: "fail" }) },
    },
  },
};

const TYPES = {
  balance: [c.nat32],
  audit_log: [c.record({ limit: c.nat16, before_seq: c.opt(c.nat64) })],
  execute: [c.nat64],
  approve: [c.nat64],
  request_join: [c.principal, c.opt(c.nat8)],
};
const bytesOf = (method, args) => {
  const r = encodeArgs(TYPES[method], args);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.issues)}`);
  return r.bytes;
};

/** A layer over a scripted wallet: `answers` go to successive update calls, `query` answers queries. */
function setup({ resolved = RESOLVED, answers = [], confirm = async () => true, reconcile = async () => ({ status: "found" }), query = () => ({ status: "replied", reply: [] }), withConfirm = true } = {}) {
  const sent = [];
  const asked = [];
  const reconciled = [];
  const encoded = [];
  let t = 1791547200000000000n;
  const layer = createToolLayer({
    resolved,
    canisters: [{ id: WALLET, label: "wallet" }],
    // hosts encode `args`, the whole tuple; `value` is the single argument, kept for older hosts
    encode: (method, value, args) => (encoded.push({ method, value, args }), bytesOf(method, args)),
    now: async () => (t += 1_000_000_000n),
    ...(withConfirm ? { confirm: async (preview) => (asked.push(preview), confirm(preview)) } : {}),
    reconcile: async (o) => (reconciled.push(o), reconcile(o)),
    call: async (req) => {
      assert.deepEqual(req.arg, bytesOf(req.method, req.args), "the bytes sent encode the argument tuple");
      sent.push(req);
      if (req.mode === "query") return query(req);
      const a = answers.shift();
      assert.ok(a, `no scripted answer for send ${sent.length}`);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return { layer, sent, asked, reconciled, encoded };
}
const ok = (value) => ({ status: "replied", reply: { tag: "Ok", value } });
const state = (tag, value = null) => ok({ id: 7n, state: { tag, value } });
const call = async (layer, tool, input) => (await layer.callTool(tool, { canister_id: WALLET, ...input })).structuredContent;
const commit = async (layer, preview_id) => (await layer.callTool("commit", { preview_id })).structuredContent;

test("the wallet-like form: which methods get which tool", () => {
  const { plans, skipped } = buildToolPlans(RESOLVED);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    [...plans.values()].map((p) => [p.name, p.kind, p.replicated, p.params.map((q) => q.name)]),
    [
      ["audit_log", "read", false, ["limit", "before_seq"]],
      ["balance", "read", true, ["integer"]],
      ["prepare_approve", "prepare", false, ["integer"]],
      ["prepare_execute", "prepare", false, ["integer"]],
      ["prepare_request_join", "prepare", false, ["arg0", "arg1"]],
    ],
  );
});

// --- rule 1 -------------------------------------------------------------------------------------------------------

test("rule 1: a read-only update is a read tool, sent once as an update call, with no confirmation", async () => {
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "balance");
  assert.match(def.description, /^Read-only call of `balance`, sent as an update call so that the answer is certified; it changes nothing\. /);
  assert.equal(def.annotations.readOnlyHint, true);
  assert.match(toolDefinitions(RESOLVED).find((d) => d.name === "audit_log").description, /^Read-only query of `audit_log`\. /, "a query keeps its words");

  const { layer, sent, asked } = setup({ answers: [ok(1234n)] });
  const r = await call(layer, "balance", { integer: "2" });
  assert.deepEqual(r, { status: "replied", method: "balance", canister: WALLET, value: { tag: "Ok", value: "1234" } });
  assert.deepEqual(sent.map((s) => [s.mode, s.args]), [["update", [2]]]);
  assert.equal(asked.length, 0);
});

test("rule 1: a form with only reads needs no confirm hook", async () => {
  const reads = { ...RESOLVED, methods: { balance: RESOLVED.methods.balance, audit_log: RESOLVED.methods.audit_log } };
  const { layer } = setup({ resolved: reads, withConfirm: false, answers: [ok(1n)] });
  assert.equal((await call(layer, "balance", { integer: "0" })).status, "replied");
  assert.equal(layer.listTools().some((d) => d.name === "commit"), false);
});

test("rule 1: a read with no answer says nothing was read, never to commit a preview", async () => {
  const { layer } = setup({ answers: [{ status: "unknown", message: "timeout" }, { status: "rejected", reject_code: 5, message: "trapped" }] });
  const unknown = await layer.callTool("balance", { canister_id: WALLET, integer: "2" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /^No answer arrived, so nothing was read\./);
  assert.doesNotMatch(unknown.content[0].text, /preview_id/);
  const rejected = await layer.callTool("balance", { canister_id: WALLET, integer: "2" });
  assert.match(rejected.content[0].text, /^The canister refused the read, so nothing was read\./);
  assert.equal(rejected.structuredContent.reject_code, 5);
  const q = setup({ query: () => ({ status: "unknown", message: "no reply" }) });
  assert.match((await q.layer.callTool("audit_log", { canister_id: WALLET, limit: "1" })).content[0].text, /^No answer arrived/, "a query too");
});

test("rule 1: only the valid form is a read; with a stamp it has no rule", () => {
  const doc = structuredClone(RESOLVED);
  doc.methods.plain_read_update = structuredClone(doc.methods.balance);
  doc.methods.plain_read_update.tags.effect = tag({ kind: "read", irreversible: false }); // W_EFFECT_MODE: an update
  doc.methods.stamped_read = structuredClone(doc.methods.balance);
  doc.methods.stamped_read.tags.idempotency = tag({ mode: "replay_same_payload", stamp: "created_at" });
  const { plans, skipped } = buildToolPlans(doc);
  assert.equal(plans.has("plain_read_update"), false);
  assert.deepEqual(skipped, [
    { method: "plain_read_update", reason: "an update method needs the intent tag" },
    { method: "stamped_read", reason: "a read-only update with an idempotency stamp has no rule" },
  ]);
});

// --- rule 2 -------------------------------------------------------------------------------------------------------

test("rule 2: an update without idempotency is prepared, confirmed and sent; its tool says it is never resent", async () => {
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "prepare_approve");
  assert.match(def.description, /This call has no idempotency stamp, so the canister cannot tell a repeat from a new call: once an attempt's outcome is unknown, it is never sent again \(commit answers reconcile\)\./);
  const { layer, sent, asked } = setup({ answers: [ok({ id: 7n, state: { tag: "Waiting", value: null } })] });
  const prepared = await call(layer, "prepare_approve", { integer: "7" });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.preview.arguments, "7");
  assert.equal((await call(layer, "prepare_approve", { integer: "7" })).preview.preview_id, prepared.preview.preview_id, "one intent, one preview");
  const done = await commit(layer, prepared.preview.preview_id);
  assert.equal(done.outcome, "success");
  assert.deepEqual(sent.map((s) => [s.mode, s.value, s.args]), [["update", 7n, [7n]]]);
  assert.equal(asked.length, 1);
  assert.equal((await commit(layer, prepared.preview.preview_id)).outcome, "already_done");
  assert.equal(sent.length, 1);
});

for (const [what, answer] of [
  ["an unknown outcome", { status: "unknown", message: "timeout" }],
  ["a call that throws", new Error("connection reset")],
  ["a reject 4", { status: "rejected", reject_code: 4, message: "trapped" }],
]) {
  test(`rule 2: after ${what}, the call is held: never sent again, no read-back, and a new preparation is refused`, async () => {
    const { layer, sent, reconciled } = setup({ answers: [answer] });
    const { preview } = await call(layer, "prepare_approve", { integer: "7" });
    const held = await layer.callTool("commit", { preview_id: preview.preview_id });
    assert.equal(held.isError, true);
    assert.equal(held.structuredContent.outcome, "reconcile");
    assert.equal(held.structuredContent.finding.status, "unreadable");
    assert.match(held.structuredContent.finding.reason, /^the method has no idempotency stamp, so a second send could run it twice/);
    assert.match(held.content[0].text, /do not send or prepare this call again/);
    assert.equal((await commit(layer, preview.preview_id)).outcome, "reconcile", "committing again sends nothing");
    assert.equal((await call(layer, "prepare_approve", { integer: "7" })).outcome, "reconcile", "preparing it again is refused");
    assert.equal(sent.length, 1);
    assert.deepEqual(reconciled, [], "the reconcile hook matches stamps; there is none to match");
  });
}

test("rule 2: a reject that proves no execution, and retry_same, may be sent again (the same bytes)", async () => {
  const { layer, sent } = setup({ answers: [{ status: "rejected", reject_code: 1, message: "busy" }, state("Ready"), state("Executed", 3n)] });
  const { preview } = await call(layer, "prepare_execute", { integer: "7" });
  assert.equal((await commit(layer, preview.preview_id)).outcome, "not_executed");
  assert.equal((await commit(layer, preview.preview_id)).outcome, "retry_same");
  assert.equal((await commit(layer, preview.preview_id)).outcome, "success");
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => Buffer.from(s.arg).equals(Buffer.from(sent[0].arg))));
});

test("rule 2: retry_new renews a stamp, so a method without one that classes a case so has no rule", () => {
  const doc = structuredClone(RESOLVED);
  doc.methods.approve.tags.outcome.args.classes["Err.TimelockActive"] = "retry_new";
  doc.methods.execute.tags.outcome.args.default = "retry_new";
  const { skipped } = buildToolPlans(doc);
  assert.deepEqual(skipped.map((s) => s.method), ["approve", "execute"]);
  assert.ok(skipped.every((s) => s.reason === "the outcome class retry_new renews an idempotency stamp, and this method has none"));
});

// --- rule 4 -------------------------------------------------------------------------------------------------------

test("rule 4: an integer input reads decimal digits as they are, within the Candid type", () => {
  const { plans } = buildToolPlans(RESOLVED);
  const read = (tool, input) => readToolInput(plans.get(tool), input);
  assert.deepEqual(read("balance", { integer: " 42 " }), { value: 42, identity: [["integer", "42"]] }, "nat32 is a number, trimmed");
  assert.deepEqual(read("prepare_execute", { integer: "18446744073709551615" }).value, 18446744073709551615n, "nat64 is a bigint, to its maximum");
  assert.deepEqual(read("audit_log", { limit: "100" }).value, { limit: 100, before_seq: null });
  const codes = (tool, input) => read(tool, input).issues?.map((i) => [i.param, i.code]);
  assert.deepEqual(codes("audit_log", { limit: "65536" }), [["limit", "E_RANGE"]]);
  assert.deepEqual(codes("prepare_execute", { integer: "-1" }), [["integer", "E_RANGE"]]);
  for (const bad of ["007", "1e3", "1.0", "+1", "1_000", "1 000", "0x10", "", "-0"]) assert.deepEqual(codes("prepare_execute", { integer: bad }), [["integer", "E_SYNTAX"]], bad);
  assert.deepEqual(codes("prepare_execute", { integer: 7 }), [["integer", "E_TYPE"]]);
  assert.deepEqual(codes("prepare_execute", { integer: "1".repeat(1025) }), [["integer", "E_TOO_LONG"]]);
});

test("rule 4: signed types take a minus sign; the bounds are the type's", () => {
  const doc = { ...RESOLVED, methods: { at: { mode: "query", args: [{ candid: "int8", tags: label("Offset") }], results: [{ candid: "nat" }], tags: {} } } };
  const plan = buildToolPlans(doc).plans.get("at");
  assert.equal(readToolInput(plan, { integer: "-128" }).value, -128);
  assert.deepEqual(readToolInput(plan, { integer: "128" }).issues.map((i) => i.code), ["E_RANGE"]);
  const prop = toolDefinitions(doc)[0].inputSchema.properties.integer;
  assert.equal(prop.description, 'Offset. A whole number in decimal digits, from -128 to 127, written as it is: no unit, separators, exponent or leading zeros. For example "1" or "-42".');
});

test("rule 4: the schema says what the number is, and its pattern admits every input that is read", () => {
  const defs = new Map(toolDefinitions(RESOLVED).map((d) => [d.name, d]));
  const limit = defs.get("audit_log").inputSchema.properties.limit;
  assert.equal(limit.description, 'Entries. A whole number in decimal digits, from 0 to 65535, written as it is: no unit, separators, exponent or leading zeros. For example "1" or "42".');
  assert.deepEqual(defs.get("audit_log").inputSchema.required, ["limit"]);
  assert.match(defs.get("balance").inputSchema.properties.integer.description, /^Account\. A whole number .* from 0 to 4294967295, .* The account's id, from accounts\.$/);
  const pattern = new RegExp(limit.pattern, "u");
  for (const yes of ["0", "7", " 65535 ", "99999"]) assert.match(yes, pattern);
  for (const no of ["007", "-1", "1e3", "", "1.5"]) assert.doesNotMatch(no, pattern);
});

test("rule 4: an integer without a describe still has no rule", () => {
  const doc = structuredClone(RESOLVED);
  delete doc.methods.audit_log.args[0].fields.limit.tags;
  doc.methods.approve.args[0] = { candid: "nat64" };
  const { skipped } = buildToolPlans(doc);
  assert.deepEqual(skipped, [
    { method: "approve", reason: "(0): no rule for a nat64 position without a value tag or a describe" },
    { method: "audit_log", reason: "limit: no rule for a nat16 position without a value tag or a describe" },
  ]);
});

// --- rule 5 -------------------------------------------------------------------------------------------------------

test("rule 5: an outcome key through a record field classifies the reply; the case names the path", () => {
  const plan = buildToolPlans(RESOLVED).plans.get("prepare_execute");
  const cls = (reply) => {
    const r = classifyReply(plan, reply);
    return [r.cls, r.path.join(".")];
  };
  assert.deepEqual(cls({ tag: "Ok", value: { id: 7n, state: { tag: "Executed", value: 3n } } }), ["success", "Ok.state.Executed"]);
  assert.deepEqual(cls({ tag: "Ok", value: { id: 7n, state: { tag: "Failed", value: "ledger refused" } } }), ["fail", "Ok.state.Failed"]);
  assert.deepEqual(cls({ tag: "Ok", value: { id: 7n, state: { tag: "Ready", value: null } } }), ["retry_same", "Ok.state.Ready"]);
  assert.deepEqual(cls({ tag: "Ok", value: { id: 7n, state: { tag: "Waiting", value: null } } }), ["fail", "Ok.state.Waiting"], "an unclassed state takes the default");
  assert.deepEqual(cls({ tag: "Err", value: { tag: "TimelockActive", value: null } }), ["retry_same", "Err.TimelockActive"]);
  // keys are positions, so `(0).Ok.state.Executed` and the label id are the same key
  const respelled = structuredClone(RESOLVED);
  respelled.methods.execute.tags.outcome.args.classes = { "(0).Ok.#2215343633.Executed": "success" }; // #2215343633 is the idl hash of "state"
  assert.deepEqual(classifyReply(buildToolPlans(respelled).plans.get("prepare_execute"), { tag: "Ok", value: { id: 7n, state: { tag: "Executed", value: 3n } } }).cls, "success");
});

test("rule 5: through the layer, a failed run reads as a failure with its reason, not as Ok", async () => {
  const { layer } = setup({ answers: [state("Failed", "ledger refused")] });
  const { preview } = await call(layer, "prepare_execute", { integer: "7" });
  const r = await commit(layer, preview.preview_id);
  assert.deepEqual([r.outcome, r.case, r.details], ["fail", "Ok.state.Failed", "ledger refused"]);
});

test("rule 5: keys a reply could match twice, or that end on a field, still have no rule", () => {
  const doc = structuredClone(RESOLVED);
  doc.methods.execute.results[0].cases.Ok.fields.phase = ACTION_STATE;
  doc.methods.execute.tags.outcome.args.classes = { "Ok.state.Executed": "success", "Ok.phase.Failed": "fail" };
  doc.methods.approve.tags.outcome.args.classes = { "Ok.state": "success" };
  const missing = structuredClone(RESOLVED.methods.approve);
  missing.tags.outcome.args.classes = { "Ok.status.Done": "success" };
  doc.methods.missing = missing;
  const { skipped } = buildToolPlans(doc);
  assert.deepEqual(skipped, [
    { method: "approve", reason: "the outcome key Ok.state ends on a record field; an outcome key selects a case" },
    { method: "execute", reason: "the outcome keys Ok.state.Executed and Ok.phase.Failed read different fields of one record, so one reply could match both" },
    { method: "missing", reason: "the outcome key Ok.status.Done names no field of the result" },
  ]);
});

// --- rule 6 -------------------------------------------------------------------------------------------------------

test("rule 6: each argument of a method with several is an input of its own, and the tuple is encoded", async () => {
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "prepare_request_join");
  assert.deepEqual(Object.keys(def.inputSchema.properties), ["arg0", "arg1"]);
  assert.deepEqual(def.inputSchema.required, ["arg0"]);
  assert.match(def.inputSchema.properties.arg0.description, /^Who\. A principal/);
  assert.match(def.inputSchema.properties.arg1.description, /^Seats\. A whole number .* from 0 to 255, .* Optional: leave it out for none\.$/);

  const plan = buildToolPlans(RESOLVED).plans.get("prepare_request_join");
  assert.deepEqual(plan.params.map((p) => p.path), ["$args[0]", "$args[1]"]);
  assert.deepEqual(readToolInput(plan, { arg0: OWNER }), { value: [OWNER, null], identity: [["arg0", OWNER], ["arg1", null]] });

  const { layer, sent, encoded } = setup({ answers: [ok(9n)] });
  const { preview } = await call(layer, "prepare_request_join", { arg0: OWNER, arg1: "3" });
  assert.deepEqual(preview.arguments, [OWNER, 3]);
  assert.equal((await commit(layer, preview.preview_id)).outcome, "success");
  assert.deepEqual(encoded.at(-1), { method: "request_join", value: [OWNER, 3], args: [OWNER, 3] });
  assert.deepEqual(sent[0].args, [OWNER, 3]);
});

test("rule 6: a stamp among several arguments has no rule; a record among them is one JSON input (D-050)", () => {
  const doc = structuredClone(RESOLVED);
  doc.methods.request_join.args[1] = { candid: "record", fields: { seats: { candid: "nat8", tags: label("Seats") } } };
  const stamped = structuredClone(RESOLVED.methods.request_join);
  stamped.tags.idempotency = tag({ mode: "replay_same_payload", stamp: "(1)" });
  doc.methods.stamped = stamped;
  const { plans, skipped } = buildToolPlans(doc);
  assert.deepEqual(skipped, [{ method: "stamped", reason: "an idempotency stamp in a method with more than one argument has no rule" }]);
  const plan = plans.get("prepare_request_join");
  assert.deepEqual(readToolInput(plan, { arg0: OWNER, arg1: { seats: "2" } }).value, [OWNER, { seats: 2 }]);
});

test("one-argument and argument-free methods get their tuple too: hosts may encode `args` for every method", async () => {
  const { layer, encoded } = setup({ query: () => ({ status: "replied", reply: ["a"] }) });
  await call(layer, "audit_log", { limit: "2" });
  assert.deepEqual(encoded.at(-1).args, [{ limit: 2, before_seq: null }]);
  assert.deepEqual(encoded.at(-1).value, { limit: 2, before_seq: null });
});

test("the packs: every rule here leaves their tools as they were", () => {
  const { plans, skipped } = buildToolPlans(PACKS);
  assert.deepEqual(skipped, []);
  assert.ok([...plans.values()].every((p) => !p.replicated && (p.kind === "read" || p.idempotency)));
  assert.ok(toolDefinitions(PACKS).every((d) => !/no idempotency stamp|sent as an update call/.test(d.description)));
});
