// One tool per case (B2 rule 3 of docs/proposals/w9-b3wallet-gaps.md, D-053): a method whose single argument is a
// variant with an intent or an effect on a case gets a tool for each case, against resolved nodes shaped as the
// resolver writes them; every prepared value is encoded by candid-core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { c } from "@candid-core/schema";
import { encodeArgs } from "@candid-core/schema/codec";
import { buildToolPlans, caseToolName, createToolLayer, readToolInput, toolDefinitions } from "../src/index.mjs";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const ALICE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const tag = (args) => ({ args, origin: "author", profile: "test" });
const SEND = tag({ kind: "transfer", irreversible: true });
const READ_UPDATE = tag({ kind: "read", irreversible: false, replicated: true });
const OK_ERR = { candid: "variant", cases: { Ok: { candid: "nat64" }, Err: { candid: "text" } } };
const OUTCOME = tag({ classes: { Ok: "success", Err: "fail" } });
const AMOUNT = { candid: "nat", tags: { amount: tag({ decimals: 8, symbol: "TKN" }) } };

// A proposal of one of several actions: a tagged case, an untagged one, two without payload, and one without a rule.
const ACTION = {
  candid: "variant",
  cases: {
    AddMember: { candid: "record", fields: { who: { candid: "principal" } } },
    Pause: { candid: "null", tags: { intent: tag({ title: "Pause the wallet", template: "Pause the wallet" }), effect: tag({ kind: "admin", irreversible: false }) } },
    Ratio: { candid: "float64", tags: { describe: tag({ label: "Set a ratio" }) } },
    Resume: { candid: "null", tags: { effect: tag({ kind: "admin", irreversible: false }) } },
    Transfer: {
      candid: "record",
      fields: { amount: AMOUNT, to: { candid: "principal" } },
      tags: { intent: tag({ title: "Propose a transfer", template: "Send {Transfer.amount} to {Transfer.to}" }), effect: SEND },
    },
  },
};
// A wallet request: two cases only read (sent as updates so that the answer is certified), one sends at once.
const REQUEST = {
  candid: "variant",
  cases: {
    Accounts: { candid: "null", tags: { effect: READ_UPDATE, describe: tag({ label: "List the accounts" }) } },
    Balance: { candid: "text", tags: { effect: READ_UPDATE, text: tag({ max_len: 16 }) } },
    Send: { candid: "record", fields: { amount: AMOUNT }, tags: { intent: tag({ title: "Send now" }) } },
  },
};

// A lookup by one of two keys: a query's cases are reads.
const LOOKUP = {
  candid: "variant",
  cases: {
    ById: { candid: "nat64", tags: { describe: tag({ label: "Look up by id" }) } },
    ByName: { candid: "text", tags: { intent: tag({ title: "Look up by name", template: "Look up {ByName}" }) } },
  },
};
const { Ratio: _ratio, ...WITHOUT_RATIO } = ACTION.cases;

const RESOLVED = {
  format: "candid-profile-resolved",
  format_version: 0,
  methods: {
    propose: { mode: "update", args: [ACTION], results: [OK_ERR], tags: { intent: tag({ title: "Propose an action" }), effect: SEND, outcome: OUTCOME } },
    request: { mode: "update", args: [REQUEST], results: [OK_ERR], tags: { intent: tag({ title: "Wallet request" }), effect: SEND, outcome: OUTCOME } },
    look: { mode: "query", args: [LOOKUP], results: [{ candid: "text" }], tags: {} },
    // a stamp would sit inside a case: no case tools yet
    stamped: {
      mode: "update",
      args: [{ candid: "variant", cases: { Go: { candid: "record", fields: { at: { candid: "nat64", optional: true } } , tags: { effect: SEND } } } }],
      results: [OK_ERR],
      tags: { intent: tag({ title: "Go" }), effect: SEND, outcome: OUTCOME, idempotency: tag({ mode: "replay_same_payload", stamp: "Go.at" }) },
    },
    // a variant that is not the whole argument stays one JSON input
    nested: {
      mode: "update",
      args: [{ candid: "record", fields: { id: { candid: "nat64", tags: { describe: tag({ label: "Id" }) } }, action: { ...ACTION, cases: WITHOUT_RATIO } } }],
      results: [OK_ERR],
      tags: { intent: tag({ title: "Nested" }), effect: SEND, outcome: OUTCOME },
    },
  },
};

const TYPES = (() => {
  const action = c.variant({ AddMember: c.record({ who: c.principal }), Pause: c.null, Ratio: c.float64, Resume: c.null, Transfer: c.record({ amount: c.nat, to: c.principal }) });
  return { propose: [action], request: [c.variant({ Accounts: c.null, Balance: c.text, Send: c.record({ amount: c.nat }) })] };
})();
const encode = (method, args) => {
  const r = encodeArgs(TYPES[method], args);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.issues)}`);
  return r.bytes;
};
const { plans, skipped } = buildToolPlans(RESOLVED);

test("a method whose variant argument has case tags gets one tool per case, named for the case", () => {
  assert.deepEqual([...plans.keys()], [
    "look_ById",
    "look_ByName",
    "prepare_nested",
    "prepare_propose_AddMember",
    "prepare_propose_Pause",
    "prepare_propose_Resume",
    "prepare_propose_Transfer",
    "prepare_request_Send",
    "request_Accounts",
    "request_Balance",
  ]);
  assert.equal(plans.has("prepare_propose"), false);
  assert.equal(caseToolName("propose", "Transfer", false), "prepare_propose_Transfer");
  assert.equal(caseToolName("request", "Accounts", true), "request_Accounts");
  assert.deepEqual(skipped, [
    { method: "propose", reason: "case Ratio: (0).Ratio: no rule for a float64 position without a value tag" },
    { method: "stamped", reason: "tools per case of a method with an idempotency stamp have no rule yet (the stamp would sit inside a case)" },
  ]);
});

test("a case tool's title, effect and kind come from its case, else from its method", () => {
  const t = plans.get("prepare_propose_Transfer");
  assert.equal(t.method, "propose");
  assert.equal(t.case, "Transfer");
  assert.equal(t.title, "Propose a transfer");
  assert.deepEqual(t.effect, SEND.args);
  assert.deepEqual(t.params.map((p) => [p.name, p.path]), [["amount", "$args[0].Transfer.amount"], ["to", "$args[0].Transfer.to"]]);
  // no case intent: the case's describe, else "<method> <Case>"; the effect the method's
  assert.equal(plans.get("prepare_propose_AddMember").title, "propose AddMember");
  assert.deepEqual(plans.get("prepare_propose_AddMember").effect, SEND.args);
  assert.equal(plans.get("prepare_propose_Resume").title, "propose Resume");
  assert.deepEqual(plans.get("prepare_propose_Resume").effect, { kind: "admin", irreversible: false });
  // a read-only update case is a read tool, sent as an update; the method's outcome is the prepare tool's
  const accounts = plans.get("request_Accounts");
  assert.equal(accounts.kind, "read");
  assert.equal(accounts.replicated, true);
  assert.equal(accounts.title, "List the accounts");
  assert.equal(plans.get("prepare_request_Send").kind, "prepare");
  assert.deepEqual(plans.get("prepare_request_Send").outcome, OUTCOME.args);
  // a query's cases are reads
  assert.equal(plans.get("look_ById").kind, "read");
  assert.equal(plans.get("look_ById").title, "Look up by id");
  assert.equal(plans.get("look_ByName").title, "Look up by name");
  assert.deepEqual(readToolInput(plans.get("look_ById"), { integer: "7" }).value, { tag: "ById", value: 7n });
  // a tagged variant inside a record stays one JSON input
  assert.deepEqual(plans.get("prepare_nested").params.map((p) => p.name), ["id", "action"]);
});

test("a case tool sends its case around the payload, a null payload as a bare tag, and candid-core encodes it", () => {
  const transfer = readToolInput(plans.get("prepare_propose_Transfer"), { amount: "1.5", to: ALICE });
  assert.deepEqual(transfer.value, { tag: "Transfer", value: { amount: 150_000_000n, to: ALICE } });
  const pause = readToolInput(plans.get("prepare_propose_Pause"), {});
  assert.deepEqual(pause.value, { tag: "Pause" });
  const balance = readToolInput(plans.get("request_Balance"), { text: "main" });
  assert.deepEqual(balance.value, { tag: "Balance", value: "main" });
  for (const [method, v] of [["propose", transfer.value], ["propose", pause.value], ["request", balance.value], ["request", readToolInput(plans.get("request_Accounts"), {}).value]]) {
    assert.ok(encode(method, [v]).length > 0);
  }
  // two cases with the same inputs are two intents
  assert.notDeepEqual(pause.identity, readToolInput(plans.get("prepare_propose_Resume"), {}).identity);
  // issues name the place inside the case
  assert.deepEqual(readToolInput(plans.get("prepare_propose_Transfer"), { amount: "1.123456789", to: ALICE }).issues.map((i) => i.path), ["$args[0].Transfer.amount"]);
});

test("the definitions name the case each tool sends", () => {
  const defs = new Map(toolDefinitions(RESOLVED).map((d) => [d.name, d]));
  const t = defs.get("prepare_propose_Transfer");
  assert.match(t.description, /^Prepare the call "Propose a transfer" \(`propose` with the case `Transfer`, effect: transfer, irreversible\)\./);
  assert.deepEqual(Object.keys(t.inputSchema.properties), ["amount", "to"]);
  assert.equal(t.annotations.title, "Propose a transfer");
  assert.deepEqual(Object.keys(defs.get("prepare_propose_Pause").inputSchema.properties), []);
  assert.match(defs.get("request_Accounts").description, /^List the accounts\. Read-only call of `request` with the case `Accounts`, sent as an update call/);
  assert.equal(defs.get("request_Balance").annotations.title, "request Balance");
});

test("through the layer: two cases with the same inputs are two previews, and the case reaches the canister", async () => {
  const sent = [];
  const layer = createToolLayer({
    resolved: RESOLVED,
    canisters: [{ id: CANISTER }],
    encode: (method, _value, args) => encode(method, args),
    call: async (req) => {
      sent.push([req.method, req.mode, req.value]);
      return { status: "replied", reply: req.method === "request" && req.mode === "update" && req.value.tag === "Accounts" ? { tag: "Ok", value: 2n } : { tag: "Ok", value: 1n } };
    },
    now: async () => 1n,
    confirm: async () => true,
  });
  const pause = (await layer.callTool("prepare_propose_Pause", { canister_id: CANISTER })).structuredContent;
  const resume = (await layer.callTool("prepare_propose_Resume", { canister_id: CANISTER })).structuredContent;
  assert.notEqual(pause.preview.preview_id, resume.preview.preview_id);
  assert.deepEqual(pause.preview.effect, { kind: "admin", irreversible: false });
  assert.equal(pause.preview.title, "Pause the wallet");
  assert.equal((await layer.callTool("commit", { preview_id: resume.preview.preview_id })).structuredContent.outcome, "success");
  const read = (await layer.callTool("request_Accounts", { canister_id: CANISTER })).structuredContent;
  assert.equal(read.status, "replied");
  assert.deepEqual(sent, [["propose", "update", { tag: "Resume" }], ["request", "update", { tag: "Accounts" }]]);
});

test("two tools with one name are both skipped, as for methods", () => {
  const doc = structuredClone(RESOLVED);
  doc.methods.request_Accounts = { mode: "query", args: [], results: [{ candid: "text" }], tags: {} };
  const r = buildToolPlans(doc);
  assert.equal(r.plans.has("request_Accounts"), false);
  assert.deepEqual(r.skipped.filter((s) => s.reason.startsWith("its tool name request_Accounts")).map((s) => s.reason).sort(), [
    "its tool name request_Accounts is also request's case Accounts's",
    "its tool name request_Accounts is also request_Accounts's",
  ]);
});
