// The readers D-050 adds (proposal docs/proposals/w6-adoption.md, items 2 and 3), each against resolved nodes shaped as
// the resolver writes them, and every prepared value encoded by candid-core, so the domain shapes are the ones
// ic-reactor sends:
//   text   the text as given, within the `text` tag (max_len, pattern, format) and `range` lengths;
//   bool   "true" or "false";
//   JSON   a record, variant or vec with no value tag is one input whose leaves are read by their own rules;
//   outcome  keys that start with a record field (record { result : opt variant { ... } }), and `default` alone for a
//          result that has no variant to select.
import { test } from "node:test";
import assert from "node:assert/strict";
import { c } from "@candid-core/schema";
import { encodeArgs } from "@candid-core/schema/codec";
import { buildToolPlans, classifyReply, createToolLayer, readToolInput, toolDefinitions } from "../src/index.mjs";
import { MAX_NESTED_VALUES, MAX_TEXT_CHARS, MAX_VEC_ITEMS } from "../src/input.mjs";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const ALICE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const BOB = "mxzaz-hqaaa-aaaar-qaada-cai";
const tag = (args) => ({ args, origin: "author", profile: "test" });
const label = (text) => ({ describe: tag({ label: text }) });
const nul = { candid: "null" };
const write = (classes, def = "fail") => ({
  intent: tag({ title: "Do it" }),
  effect: tag({ kind: "write", irreversible: true }),
  outcome: tag({ ...(classes ? { classes } : {}), ...(def ? { default: def } : {}) }),
});
const OK_ERR = { candid: "variant", cases: { Ok: { candid: "nat64" }, Err: { candid: "text" } } };

// NNS-like: a command is a variant of records, one of which holds a list of records.
const FOLLOW = { candid: "record", fields: { topic: { candid: "int32", tags: label("Topic") }, followees: { candid: "vec", element: { candid: "record", fields: { id: { candid: "nat64", tags: label("Neuron") } } } } } };
const COMMAND = {
  candid: "variant",
  cases: {
    Follow: FOLLOW,
    StartDissolving: { candid: "record", fields: {} },
    RefreshVotingPower: nul,
    SetVisibility: { candid: "record", fields: { visibility: { candid: "int32", optional: true, tags: label("Visibility") } } },
  },
};
const MANAGE_ARGS = { candid: "record", fields: { id: { candid: "record", optional: true, fields: { id: { candid: "nat64", tags: label("Neuron") } } }, command: { ...COMMAND, optional: true } } };
const MANAGE_RESULT = { candid: "record", fields: { command: { candid: "variant", optional: true, cases: { Error: { candid: "record", fields: { error_message: { candid: "text" } } }, Follow: { candid: "record", fields: {} } } } } };

const RESOLVED = {
  format: "candid-profile-resolved",
  format_version: 0,
  methods: {
    // text, bool and an untagged text
    set_memo: {
      mode: "update",
      args: [{ candid: "record", fields: {
        memo: { candid: "text", tags: { text: tag({ max_len: 8 }) } },
        address: { candid: "text", tags: { text: tag({ pattern: "^bc1[a-z0-9]{6,}$" }), describe: tag({ label: "Bitcoin address" }) } },
        site: { candid: "text", optional: true, tags: { text: tag({ format: "url" }) } },
        note: { candid: "text", optional: true },
        public: { candid: "bool" },
      } }],
      results: [OK_ERR],
      tags: write({ Ok: "success" }),
    },
    // JSON: a variant of records with a list inside, and an optional record
    manage_neuron: {
      mode: "update",
      args: [MANAGE_ARGS],
      results: [MANAGE_RESULT],
      tags: write({ "command.Follow": "success", "command.Error": "fail" }),
    },
    // a single argument that is a variant: the input arg0
    choose: { mode: "update", args: [COMMAND], results: [OK_ERR], tags: write({ Ok: "success" }) },
    // default alone: a record result, and no result at all
    open_ticket: { mode: "update", args: [{ candid: "nat64", tags: label("Amount in e8s") }], results: [{ candid: "record", fields: { ticket: { candid: "nat64", optional: true } } }], tags: write(null, "success") },
    refresh: { mode: "update", args: [], results: [], tags: write(null, "success") },
    // a list of principals, as a query
    who: { mode: "query", args: [{ candid: "vec", element: { candid: "principal" } }], results: [{ candid: "nat" }], tags: {} },
    // a single null argument (NNS get_node_provider_by_caller): nothing to ask for
    by_caller: { mode: "query", args: [nul], results: [{ candid: "nat" }], tags: {} },
  },
};

const TYPES = {
  set_memo: [c.record({ memo: c.text, address: c.text, site: c.opt(c.text), note: c.opt(c.text), public: c.bool })],
  manage_neuron: (() => {
    const follow = c.record({ topic: c.int32, followees: c.vec(c.record({ id: c.nat64 })) });
    const command = c.variant({ Follow: follow, StartDissolving: c.record({}), RefreshVotingPower: c.null, SetVisibility: c.record({ visibility: c.opt(c.int32) }) });
    return [c.record({ id: c.opt(c.record({ id: c.nat64 })), command: c.opt(command) })];
  })(),
  choose: [c.variant({ Follow: c.record({ topic: c.int32, followees: c.vec(c.record({ id: c.nat64 })) }), StartDissolving: c.record({}), RefreshVotingPower: c.null, SetVisibility: c.record({ visibility: c.opt(c.int32) }) })],
  open_ticket: [c.nat64],
  refresh: [],
  who: [c.vec(c.principal)],
  by_caller: [c.null],
};
const encode = (method, args) => {
  const r = encodeArgs(TYPES[method], args);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.issues)}`);
  return r.bytes;
};
const { plans, skipped } = buildToolPlans(RESOLVED);
const read = (tool, input) => readToolInput(plans.get(tool), input);
const codes = (r) => (r.issues ?? []).map((i) => [i.path, i.code]);

test("every method here gets a tool", () => {
  assert.deepEqual(skipped, []);
  assert.deepEqual([...plans.keys()], ["by_caller", "prepare_choose", "prepare_manage_neuron", "prepare_open_ticket", "prepare_refresh", "prepare_set_memo", "who"]);
});

test("text is read as given, within max_len, pattern and format; bool is true or false", () => {
  const good = { memo: " hi  ", address: "bc1qxyz123", site: "https://example.org/a", public: "false" };
  const r = read("prepare_set_memo", good);
  assert.deepEqual(r.value, { memo: " hi  ", address: "bc1qxyz123", site: "https://example.org/a", note: null, public: false });
  assert.ok(encode("set_memo", [r.value]).length > 0);
  assert.deepEqual(read("prepare_set_memo", { ...good, public: " true " }).value.public, true);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, memo: "123456789" })), [["$args[0].memo", "E_MAX_LEN"]]);
  assert.equal(read("prepare_set_memo", { ...good, memo: "ééééééé🙂" }).value.memo, "ééééééé🙂", "8 characters, counted as code points");
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, memo: "a\uD800" })), [["$args[0].memo", "E_UTF8"]]);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" })), [["$args[0].address", "E_SYNTAX"]]);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, site: "javascript:alert(1)" })), [["$args[0].site", "E_SYNTAX"]]);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, public: "yes" })), [["$args[0].public", "E_SYNTAX"]]);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, public: true })), [["$args[0].public", "E_TYPE"]]);
  assert.deepEqual(codes(read("prepare_set_memo", { ...good, note: "x".repeat(MAX_TEXT_CHARS + 1) })), [["$args[0].note", "E_MAX_LEN"]]);
  assert.equal(read("prepare_set_memo", { ...good, note: "x".repeat(MAX_TEXT_CHARS) }).value.note.length, MAX_TEXT_CHARS);
});

test("the tool schema says the same: patterns, lengths, true or false", () => {
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "prepare_set_memo").inputSchema;
  assert.match(def.properties.memo.description, /^Text, exactly as given, at most 8 characters\.$/);
  assert.equal(def.properties.address.pattern, "^bc1[a-z0-9]{6,}$");
  assert.match(def.properties.address.description, /^Bitcoin address\. Text, exactly as given, at most 1024 characters, matching the pattern/);
  assert.match(def.properties.site.description, /an absolute http or https URL.*Optional/);
  assert.equal(def.properties.public.pattern, "^\\s*(?:true|false)\\s*$");
  assert.deepEqual(def.required, ["memo", "address", "public"]);
});

test("a pattern the layer does not run skips the method when the tools are made, with the reason", () => {
  for (const [pattern, why] of [["(a+)+$", /repeats a group that repeats/], ["(", /not an ECMAScript regular expression/], ["(?=x)", /lookaround/], ["x".repeat(300), /longer than 256/]]) {
    const doc = structuredClone(RESOLVED);
    doc.methods.set_memo.args[0].fields.memo.tags.text.args.pattern = pattern;
    doc.methods.lone = { mode: "query", args: [{ candid: "text", tags: { text: tag({ pattern }) } }], results: [{ candid: "nat" }], tags: {} };
    const s = buildToolPlans(doc).skipped;
    assert.deepEqual(s.map((x) => x.method), ["lone", "set_memo"], pattern);
    assert.match(s[0].reason, /^\(0\): /);
    assert.match(s[1].reason, /^memo: /);
    for (const x of s) assert.match(x.reason, why);
  }
});

test("a record, variant or vec is one JSON input; every leaf is read by its own rule", () => {
  const follow = { id: { id: "42" }, command: { tag: "Follow", value: { topic: "4", followees: [{ id: "27" }, { id: "28" }] } } };
  const r = read("prepare_manage_neuron", follow);
  assert.deepEqual(r.value, { id: { id: 42n }, command: { tag: "Follow", value: { topic: 4, followees: [{ id: 28n - 1n }, { id: 28n }] } } });
  assert.ok(encode("manage_neuron", [r.value]).length > 0);
  // a null case is a bare tag; an empty record is {}; an optional field inside is null when left out
  for (const [command, want] of [
    [{ tag: "RefreshVotingPower" }, { tag: "RefreshVotingPower" }],
    [{ tag: "StartDissolving", value: {} }, { tag: "StartDissolving", value: {} }],
    [{ tag: "SetVisibility", value: {} }, { tag: "SetVisibility", value: { visibility: null } }],
  ]) {
    const v = read("prepare_manage_neuron", { command }).value;
    assert.deepEqual(v, { id: null, command: want });
    assert.ok(encode("manage_neuron", [v]).length > 0, JSON.stringify(command));
  }
  const choose = read("prepare_choose", { arg0: { tag: "Follow", value: { topic: "-1", followees: [] } } });
  assert.deepEqual(choose.value, { tag: "Follow", value: { topic: -1, followees: [] } });
  assert.ok(encode("choose", [choose.value]).length > 0);
  const who = read("who", { arg0: [ALICE, BOB] });
  assert.deepEqual(who.value, [ALICE, BOB]);
  assert.ok(encode("who", [who.value]).length > 0);
});

test("a JSON input of the wrong shape says where, and nothing is guessed", () => {
  const at = (command) => codes(read("prepare_manage_neuron", { command }));
  assert.deepEqual(at({ tag: "Follow", value: { topic: "4", followees: [{ id: "x" }] } }), [["$args[0].command.Follow.followees[0].id", "E_SYNTAX"]]);
  assert.deepEqual(at({ tag: "Follow", value: { topic: 4, followees: [] } }), [["$args[0].command.Follow.topic", "E_TYPE"]]);
  assert.deepEqual(at({ tag: "Follow", value: { followees: [] } }), [["$args[0].command.Follow.topic", "E_MISSING"]]);
  assert.deepEqual(at({ tag: "Follow", value: { topic: "4", followees: [], extra: "1" } }), [["$args[0].command.Follow", "E_UNKNOWN_PARAM"]]);
  assert.deepEqual(at({ tag: "Unfollow" }), [["$args[0].command", "E_TYPE"]]);
  assert.deepEqual(at({ tag: "RefreshVotingPower", value: "now" }), [["$args[0].command.RefreshVotingPower", "E_TYPE"]]);
  assert.deepEqual(at({ tag: "Follow", value: { topic: "4", followees: {} } }), [["$args[0].command.Follow.followees", "E_TYPE"]]);
  assert.deepEqual(at({ Follow: {} }), [["$args[0].command", "E_TYPE"]]);
  assert.deepEqual(at("Follow"), [["$args[0].command", "E_TYPE"]]);
  assert.deepEqual(at({ tag: "Follow", value: { topic: "2147483648", followees: [] } }), [["$args[0].command.Follow.topic", "E_RANGE"]]);
  // a field named like an Object.prototype member is no input unless the record has it
  assert.deepEqual(at({ tag: "StartDissolving", value: JSON.parse('{"__proto__": "x"}') }), [["$args[0].command.StartDissolving", "E_UNKNOWN_PARAM"]]);
});

test("bounded work: at most 256 elements in a vec, and 4096 values in one input", () => {
  const many = (n) => ({ command: { tag: "Follow", value: { topic: "1", followees: Array.from({ length: n }, (_, i) => ({ id: String(i) })) } } });
  assert.equal(read("prepare_manage_neuron", many(MAX_VEC_ITEMS)).value.command.value.followees.length, MAX_VEC_ITEMS);
  assert.deepEqual(codes(read("prepare_manage_neuron", many(MAX_VEC_ITEMS + 1))), [["$args[0].command.Follow.followees", "E_TOO_LONG"]]);
  const doc = structuredClone(RESOLVED);
  doc.methods.deep = { mode: "query", args: [{ candid: "vec", element: { candid: "vec", element: { candid: "principal" } } }], results: [{ candid: "nat" }], tags: {} };
  const plan = buildToolPlans(doc).plans.get("deep");
  const rows = Array.from({ length: 20 }, () => Array.from({ length: 250 }, () => ALICE));
  const r = readToolInput(plan, { arg0: rows });
  assert.equal(MAX_NESTED_VALUES, 4096);
  assert.deepEqual(r.issues.map((i) => i.code), ["E_TOO_LONG"], "one issue, not one per value past the bound");
});

test("the same JSON input is the same intent; a different leaf is another", () => {
  const a = read("prepare_manage_neuron", { command: { tag: "Follow", value: { topic: "4", followees: [{ id: "27" }] } } });
  const b = read("prepare_manage_neuron", { command: { value: { followees: [{ id: " 27 " }], topic: "4" }, tag: "Follow" } });
  const other = read("prepare_manage_neuron", { command: { tag: "Follow", value: { topic: "4", followees: [{ id: "28" }] } } });
  assert.equal(JSON.stringify(a.identity), JSON.stringify(b.identity));
  assert.notEqual(JSON.stringify(a.identity), JSON.stringify(other.identity));
});

test("the JSON input's schema mirrors the Candid shape, with each leaf's own words", () => {
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "prepare_manage_neuron").inputSchema;
  const command = def.properties.command;
  assert.equal(command.oneOf.length, 4);
  const follow = command.oneOf.find((o) => o.properties.tag.const === "Follow");
  assert.deepEqual(follow.required, ["tag", "value"]);
  assert.equal(follow.properties.value.type, "object");
  assert.deepEqual(follow.properties.value.required, ["topic", "followees"]);
  assert.equal(follow.properties.value.properties.followees.type, "array");
  assert.equal(follow.properties.value.properties.followees.maxItems, MAX_VEC_ITEMS);
  assert.match(follow.properties.value.properties.followees.items.properties.id.description, /^Neuron\. A whole number/);
  assert.deepEqual(command.oneOf.find((o) => o.properties.tag.const === "RefreshVotingPower"), { type: "object", properties: { tag: { const: "RefreshVotingPower" } }, required: ["tag"], additionalProperties: false });
  assert.match(command.description, /One of 4 cases.*Optional: leave it out for none\.$/);
  assert.deepEqual(def.required, []);
});

test("outcome keys that start with a record field classify a wrapped reply; an absent one is the default", () => {
  const plan = plans.get("prepare_manage_neuron");
  assert.equal(classifyReply(plan, { command: { tag: "Follow", value: {} } }).cls, "success");
  assert.equal(classifyReply(plan, { command: { tag: "Error", value: { error_message: "no" } } }).cls, "fail");
  assert.deepEqual(classifyReply(plan, { command: null }).path, ["command"]);
  assert.equal(classifyReply(plan, { command: null }).cls, "fail", "no case: the default");
});

test("an outcome with default alone: every reply of a record or an empty result is that class, through the layer", async () => {
  const sent = [];
  const layer = createToolLayer({
    resolved: RESOLVED,
    canisters: [{ id: CANISTER }],
    encode: (method, _value, args) => encode(method, args),
    call: async (req) => {
      sent.push(req.method);
      return req.method === "open_ticket" ? { status: "replied", reply: { ticket: 7n } } : { status: "replied", reply: undefined };
    },
    now: async () => 1n,
    confirm: async () => true,
  });
  const p = (await layer.callTool("prepare_open_ticket", { canister_id: CANISTER, integer: "250000000" })).structuredContent;
  const done = (await layer.callTool("commit", { preview_id: p.preview.preview_id })).structuredContent;
  assert.equal(done.outcome, "success");
  assert.deepEqual(done.details, { ticket: "7" });
  const q = (await layer.callTool("prepare_refresh", { canister_id: CANISTER })).structuredContent;
  assert.equal((await layer.callTool("commit", { preview_id: q.preview.preview_id })).structuredContent.outcome, "success");
  assert.deepEqual(sent, ["open_ticket", "refresh"]);

  // keys or a default are needed, and keys need one result
  const doc = structuredClone(RESOLVED);
  doc.methods.refresh.tags.outcome.args = { classes: { Ok: "success" } };
  assert.deepEqual(buildToolPlans(doc).skipped, [{ method: "refresh", reason: "outcome keys need a method with one result" }]);
});

test("a named text position: a value is what its pattern matches; other text is a name, or passed on as text", () => {
  const doc = structuredClone(RESOLVED);
  const sets = { candid: "vec", element: { candid: "record", fields: { name: { candid: "text" }, addr: { candid: "text" } } } };
  doc.methods.book = { mode: "query", args: [], results: [sets], tags: { names: tag({ set: "contact", items: "(0)", name: "name", value: "addr" }) } };
  doc.methods.set_memo.args[0].fields.address.tags.named = tag({ set: "contact" });
  doc.methods.set_memo.args[0].fields.note.tags = { named: tag({ set: "contact" }) };
  const plan = buildToolPlans(doc).plans.get("prepare_set_memo");
  const names = { contact: [{ name: "Savings", value: "bc1qsavings1" }, { name: "Twice", value: "bc1qa000001" }, { name: "Twice", value: "bc1qb000002" }] };
  const base = { memo: "m", public: "true" };
  const r = (input) => readToolInput(plan, { ...base, ...input }, { names });
  assert.equal(r({ address: "bc1qtyped123" }).value.address, "bc1qtyped123", "a value is never looked up");
  assert.equal(r({ address: "savings" }).value.address, "bc1qsavings1");
  assert.deepEqual(codes(r({ address: "Nobody" })), [["$args[0].address", "E_SYNTAX"]], "not a value and not a name: the pattern refuses it");
  assert.deepEqual(codes(r({ address: "twice" })), [["$args[0].address", "E_NAME_AMBIGUOUS"]]);
  // without a pattern every text is looked up first, and text that names nothing is passed on as text (spec 5.3)
  assert.equal(r({ address: "bc1qtyped123", note: "Savings" }).value.note, "bc1qsavings1");
  assert.equal(r({ address: "bc1qtyped123", note: "call me" }).value.note, "call me");
});

test("a single null argument takes no input and sends null", () => {
  const r = read("by_caller", {});
  assert.equal(r.value, null);
  assert.ok(encode("by_caller", [r.value]).length > 0);
  assert.deepEqual(codes(read("by_caller", { arg0: null })), [["$args", "E_UNKNOWN_PARAM"]]);
  const def = toolDefinitions(RESOLVED).find((d) => d.name === "by_caller");
  assert.deepEqual(Object.keys(def.inputSchema.properties), []);
});

test("a vec element that can be none is null in the schema: vec null, vec opt text, vec opt record", () => {
  const text = { candid: "text" };
  const resolved = {
    format: "candid-profile-resolved",
    format_version: 0,
    methods: {
      tally: {
        mode: "query",
        args: [
          { candid: "vec", element: nul },
          { candid: "vec", element: { ...text, optional: true } },
          { candid: "vec", element: { candid: "record", optional: true, fields: { note: text } } },
        ],
        results: [{ candid: "nat" }],
        tags: {},
      },
    },
  };
  const def = toolDefinitions(resolved).find((d) => d.name === "tally").inputSchema.properties;
  assert.deepEqual(def.arg0.items, { type: "null" });
  assert.deepEqual(def.arg1.items.anyOf[1], { type: "null" });
  assert.equal(def.arg1.items.anyOf[0].type, "string");
  assert.equal(def.arg2.items.anyOf[0].type, "object");
  assert.deepEqual(def.arg2.items.anyOf[1], { type: "null" });
  assert.doesNotMatch(JSON.stringify(def), /leave it out/);

  const r = readToolInput(buildToolPlans(resolved).plans.get("tally"), { arg0: [null, null], arg1: [null, "hi"], arg2: [{ note: "a" }, null] });
  assert.deepEqual(r.value, [[null, null], [null, "hi"], [{ note: "a" }, null]]);
  const types = [c.vec(c.null), c.vec(c.opt(c.text)), c.vec(c.opt(c.record({ note: c.text })))];
  assert.ok(encodeArgs(types, r.value).ok);
});
