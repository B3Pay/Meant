// Named inputs (spec 5.3, D-045): a tool takes a name where the profile says one may stand for the value. The names
// are read from the canister when the call is prepared, and the same rule as every other consumer resolves them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolPlans, createToolLayer, displayValue, nameEntries, readToolInput, toolDefinitions } from "../src/index.mjs";

const WALLET = "uxrrr-q7777-77774-qaaaq-cai";
const DANA = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const tag = (args) => ({ args, origin: "author", profile: "test" });
const nul = { candid: "null" };
const ACCOUNT = {
  candid: "record",
  fields: { id: { candid: "nat32" }, label: { candid: "text" }, address: { candid: "text" }, kind: { candid: "variant", cases: { Icp: nul, Bitcoin: nul } } },
};
const RESOLVED = {
  format: "candid-profile-resolved",
  format_version: 0,
  methods: {
    accounts: {
      mode: "query",
      args: [],
      results: [{ candid: "variant", cases: { Ok: { candid: "vec", element: ACCOUNT }, Err: { candid: "text" } } }],
      tags: { names: tag({ set: "account", items: "Ok", name: "label", value: "id", show: "address", kind: "kind" }) },
    },
    members: {
      mode: "query",
      args: [],
      results: [{ candid: "vec", element: { candid: "record", fields: { id: { candid: "principal" }, label: { candid: "text" } } } }],
      tags: { names: tag({ set: "member", items: "(0)", name: "label", value: "id" }) },
    },
    balance: {
      mode: "query",
      args: [{ candid: "nat32", tags: { describe: tag({ label: "Account" }), named: tag({ set: "account" }) } }],
      results: [{ candid: "nat" }],
      tags: {},
    },
    remove_member: {
      mode: "update",
      args: [{ candid: "principal", tags: { describe: tag({ label: "Member" }), named: tag({ set: "member" }) } }],
      results: [{ candid: "variant", cases: { Ok: nul, Err: { candid: "text" } } }],
      tags: { intent: tag({ title: "Remove a member", template: "Remove {(0)}" }), effect: tag({ kind: "admin", irreversible: true }), outcome: tag({ classes: { Ok: "success" }, default: "fail" }) },
    },
  },
};
const kind = (k) => ({ tag: k, value: null });
const ACCOUNTS = [
  { id: 1, label: "Main", address: "a-main-icp", kind: kind("Icp") },
  { id: 2, label: "Main", address: "a-main-btc", kind: kind("Bitcoin") },
  { id: 4, label: "Savings", address: "a-savings", kind: kind("Icp") },
];
const MEMBERS = [{ id: DANA, label: "Dana's phone" }];
const entries = { account: ACCOUNTS.map((a) => ({ name: a.label, value: a.id, show: a.address, kind: a.kind })) };

test("a named input says it takes a name, and has no pattern a name would fail", () => {
  const defs = new Map(toolDefinitions(RESOLVED).map((d) => [d.name, d]));
  const balance = defs.get("balance").inputSchema.properties.integer;
  assert.match(balance.description, /Or the name of one of the canister's account entries, as accounts lists them/);
  assert.equal(balance.pattern, undefined);
  assert.equal(defs.get("prepare_remove_member").inputSchema.properties.principal.pattern, undefined);
});

test("readToolInput reads a value as a value, one matching name as its value, and refuses the rest", () => {
  const plan = buildToolPlans(RESOLVED).plans.get("balance");
  const read = (integer, names = entries) => readToolInput(plan, { integer }, { names });
  assert.deepEqual(read("1"), { value: 1, identity: [["integer", "1"]] });
  assert.deepEqual(read("  savings "), { value: 4, identity: [["integer", "4"]] }); // the same intent as "4"
  assert.equal(read("Main").issues[0].code, "E_NAME_AMBIGUOUS");
  assert.match(read("Main").issues[0].message, /2 entries of account are named "Main" \(1, 2\): ask the person which one/);
  assert.equal(read("Vault").issues[0].code, "E_NAME_NOT_FOUND");
  assert.equal(read("Savings", {}).issues[0].code, "E_NAMES_UNREAD");
});

test("the layer reads the names when the call is prepared, and sends the value a name stands for", async () => {
  const sent = [];
  const layer = createToolLayer({
    resolved: RESOLVED,
    canisters: [{ id: WALLET }],
    encode: (method) => new TextEncoder().encode(method),
    now: async () => 1_000_000_000n,
    confirm: async () => true,
    call: async (req) => {
      sent.push({ method: req.method, mode: req.mode, args: req.args });
      if (req.method === "accounts") return { status: "replied", reply: { tag: "Ok", value: ACCOUNTS } };
      if (req.method === "members") return { status: "replied", reply: MEMBERS };
      if (req.method === "balance") return { status: "replied", reply: 150_000_000n };
      return { status: "replied", reply: { tag: "Ok", value: null } };
    },
  });
  const r = await layer.callTool("balance", { canister_id: WALLET, integer: "Savings" });
  assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
  assert.deepEqual(sent, [
    { method: "accounts", mode: "query", args: [] },
    { method: "balance", mode: "query", args: [4] },
  ]);
  const prepared = (await layer.callTool("prepare_remove_member", { canister_id: WALLET, principal: "dana's PHONE" })).structuredContent;
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.deepEqual(prepared.preview.arguments, { raw: DANA, name: "Dana's phone" }); // the value, and its name beside it
  // the typed principal is the same intent: the same preview comes back
  const again = (await layer.callTool("prepare_remove_member", { canister_id: WALLET, principal: DANA })).structuredContent;
  assert.deepEqual([again.status, again.preview.preview_id], ["repeated", prepared.preview.preview_id]);
});

test("nameEntries reads a set's entries from a reply through the profile's fields", () => {
  assert.deepEqual(nameEntries(RESOLVED, "account", { tag: "Ok", value: ACCOUNTS }), entries.account);
  assert.deepEqual(nameEntries(RESOLVED, "member", MEMBERS), [{ name: "Dana's phone", value: DANA, show: undefined, kind: undefined }]);
  assert.equal(nameEntries(RESOLVED, "account", { tag: "Err", value: "no" }), undefined);
  assert.equal(nameEntries(RESOLVED, "contact", []), undefined);
});

// Review of #54 (Codex): a named amount, a typed value without the names list, and a named account record.
const PRESETS = {
  ...RESOLVED,
  methods: {
    presets: {
      mode: "query",
      args: [],
      results: [{ candid: "vec", element: { candid: "record", fields: { label: { candid: "text" }, units: { candid: "nat" } } } }],
      tags: { names: tag({ set: "preset", items: "(0)", name: "label", value: "units" }) },
    },
    quote: {
      mode: "query",
      args: [{ candid: "nat", tags: { amount: tag({ decimals: 8, symbol: "ICP" }), named: tag({ set: "preset" }) } }],
      results: [{ candid: "nat" }],
      tags: {},
    },
  },
};

test("a name at an amount sends the canister's base units as they are, as one intent with the same amount typed", () => {
  const plan = buildToolPlans(PRESETS).plans.get("quote");
  const param = plan.params[0].name;
  const names = { preset: [{ name: "Salary", value: 100_000_000n }] };
  const byName = readToolInput(plan, { [param]: "salary" }, { names });
  const typed = readToolInput(plan, { [param]: "1 ICP" }, { names });
  assert.equal(byName.value, 100_000_000n); // not 10^16: the base units are never read again as "100000000 ICP"
  assert.deepEqual(byName, typed);
});

test("a typed value needs no names list: it is read even when the list could not be read", () => {
  const plan = buildToolPlans(PRESETS).plans.get("quote");
  const param = plan.params[0].name;
  assert.equal(readToolInput(plan, { [param]: "1 ICP" }, { names: {} }).value, 100_000_000n);
  assert.equal(readToolInput(plan, { [param]: "salary" }, { names: {} }).issues[0].code, "E_NAMES_UNREAD");
});

test("a named account shows the name only beside the account it belongs to", () => {
  const node = {
    candid: "record",
    fields: { owner: { candid: "principal" }, subaccount: { candid: "blob", optional: true } },
    tags: { account: tag({}), named: tag({ set: "contact" }) },
  };
  const names = { contact: [{ name: "Dana", value: { owner: DANA, subaccount: null } }] };
  assert.equal(displayValue(node, { owner: WALLET, subaccount: null }, {}, names).name, undefined);
  assert.equal(displayValue(node, { owner: DANA, subaccount: null }, {}, names).name, "Dana");
});
