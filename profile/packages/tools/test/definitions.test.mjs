import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMIT_TOOL, buildToolPlans, classifyReply, readToolInput, toolDefinitions } from "../src/index.mjs";
import { withStamp } from "../src/input.mjs";
import { ICRC1, ICRC2, LEDGERS, PACKS } from "./helpers.mjs";

// Arm C, the eval's tool arm, lives in the private repository only; its public copy (D-051) skips the comparison.
const ARM_C = new URL("../../mcp-adapters/src/arm-c/spec.mjs", import.meta.url);
const armC = existsSync(fileURLToPath(ARM_C)) ? await import(ARM_C.href) : null;

const shape = (defs) => Object.fromEntries(defs.map((d) => [d.name, { inputs: Object.keys(d.inputSchema.properties).sort(), required: [...d.inputSchema.required].sort() }]));

test("toolDefinitions on the pack fixtures: the same tools, inputs and required sets as arm C", { skip: !armC && "arm C (packages/mcp-adapters) is not in this tree (public copy)" }, () => {
  const ours = toolDefinitions(PACKS, { canisters: LEDGERS });
  assert.deepEqual(shape(ours), shape(armC.armCToolDefinitions()));
  assert.deepEqual(shape(ours), shape(armC.armCToolDefinitions({ aliases: false })));
  assert.ok(ours.some((d) => d.name === COMMIT_TOOL));
});

test("toolDefinitions: canister_id is one of the canisters, and absent without them", () => {
  const withCanisters = toolDefinitions(PACKS, { canisters: LEDGERS }).find((d) => d.name === "prepare_icrc1_transfer");
  assert.deepEqual(withCanisters.inputSchema.properties.canister_id.enum, LEDGERS.map((l) => l.id));
  assert.match(withCanisters.inputSchema.properties.canister_id.description, /ryjl3-tyaaa-aaaaa-aaaba-cai \(TKA\)/);
  const bare = toolDefinitions(PACKS).find((d) => d.name === "prepare_icrc1_transfer");
  assert.equal(bare.inputSchema.properties.canister_id, undefined);
  assert.deepEqual([...bare.inputSchema.required].sort(), ["amount", "to"]);
});

test("toolDefinitions: input words come from Formatter.describe() when the canisters agree", () => {
  const one = toolDefinitions(PACKS, { canisters: [LEDGERS[0]] }).find((d) => d.name === "prepare_icrc1_transfer");
  const amount = one.inputSchema.properties.amount;
  assert.match(amount.description, /at most 8 digits/);
  assert.match(amount.description, /1\.25 TKA/);
  assert.ok(new RegExp(amount.pattern).test("1.5 tka"));
  assert.ok(!new RegExp(amount.pattern).test("1.123456789"));
  // three ledgers with three decimals: the grammar without the numbers, and no pattern
  const three = toolDefinitions(PACKS, { canisters: LEDGERS }).find((d) => d.name === "prepare_icrc1_transfer").inputSchema.properties.amount;
  assert.doesNotMatch(three.description, /at most \d+ digits/);
  assert.equal(three.pattern, undefined);
  // a position whose words need no refs is the same either way
  const memo = (defs) => defs.find((d) => d.name === "prepare_icrc1_transfer").inputSchema.properties.memo.description;
  assert.equal(memo(toolDefinitions(PACKS, { canisters: LEDGERS })), memo(toolDefinitions(PACKS, { canisters: [LEDGERS[0]] })));
});

test("toolDefinitions: the stamp, auto defaults and hidden positions are not inputs", () => {
  const approve = toolDefinitions(PACKS).find((d) => d.name === "prepare_icrc2_approve");
  for (const filled of ["created_at_time", "fee"]) assert.equal(approve.inputSchema.properties[filled], undefined, filled);
  assert.match(approve.description, /created_at_time \(the idempotency stamp/);
});

test("toolDefinitions: a fresh copy each call, sorted by name", () => {
  const a = toolDefinitions(PACKS);
  a[0].name = "mutated";
  const b = toolDefinitions(PACKS);
  assert.notEqual(b[0].name, "mutated");
  assert.deepEqual(b.map((d) => d.name), [...b.map((d) => d.name)].sort());
});

test("buildToolPlans: a method with no rule is skipped with a reason, not thrown on", () => {
  const doc = structuredClone(ICRC1);
  doc.methods.odd_query = { mode: "query", args: [{ candid: "float64" }], results: [{ candid: "nat" }] };
  doc.methods.odd_update = { mode: "update", args: [], results: [{ candid: "nat" }] };
  doc.methods.no_args_field = { mode: "query", results: [{ candid: "nat" }] };
  const { plans, skipped } = buildToolPlans(doc);
  assert.ok(plans.has("prepare_icrc1_transfer"));
  assert.ok(plans.has("no_args_field"), "a method with no args field is a method without arguments");
  assert.deepEqual(skipped, [
    { method: "odd_query", reason: "(0): no rule for a float64 position without a value tag" },
    { method: "odd_update", reason: "an update method needs the intent tag" },
  ]);
});

test("buildToolPlans: tool-name collisions and multi-result queries are skipped with a reason, never dropped", () => {
  const doc = structuredClone(ICRC1);
  doc.methods.commit = { mode: "query", args: [], results: [{ candid: "nat" }] };
  doc.methods.prepare_icrc1_transfer = { mode: "query", args: [], results: [{ candid: "nat" }] };
  doc.methods.two_results = { mode: "query", args: [], results: [{ candid: "nat" }, { candid: "text" }] };
  const { plans, skipped } = buildToolPlans(doc);
  assert.equal(plans.has("commit"), false);
  assert.equal(plans.has("prepare_icrc1_transfer"), false);
  assert.equal(plans.has("two_results"), false);
  assert.deepEqual(skipped.map((s) => s.method).sort(), ["commit", "icrc1_transfer", "prepare_icrc1_transfer", "two_results"]);
  assert.match(skipped.find((s) => s.method === "commit").reason, /commit tool/);
  assert.match(skipped.find((s) => s.method === "icrc1_transfer").reason, /also prepare_icrc1_transfer's/);
  // no query handler can take the commit tool's name
  assert.equal(toolDefinitions(doc).filter((d) => d.name === COMMIT_TOOL).length, 0, "no prepare tool is left, so no commit tool");
});

test("buildToolPlans: a whole-argument opt keeps its optionality", () => {
  const doc = structuredClone(ICRC1);
  doc.methods.maybe_amount = { mode: "query", args: [{ candid: "nat", optional: true, tags: { amount: { args: { decimals: 0 } } } }], results: [{ candid: "nat" }] };
  const plan = buildToolPlans(doc).plans.get("maybe_amount");
  assert.equal(plan.params[0].optional, true);
  assert.deepEqual(readToolInput(plan, {}), { value: null, identity: [["amount", null]] });
  const def = toolDefinitions(doc).find((d) => d.name === "maybe_amount");
  assert.deepEqual(def.inputSchema.required ?? [], []);
});

test("buildToolPlans: forms are merged by method name, and a conflict is an error", () => {
  assert.equal(buildToolPlans([ICRC1, ICRC2]).plans.size, buildToolPlans([ICRC2, ICRC1, ICRC1]).plans.size);
  const other = structuredClone(ICRC2);
  other.methods.icrc1_balance_of = structuredClone(ICRC1.methods.icrc1_balance_of);
  assert.equal(buildToolPlans([ICRC1, other]).plans.size, buildToolPlans(PACKS).plans.size);
  other.methods.icrc1_balance_of.tags.describe = { args: { label: "Something else" } };
  assert.throws(() => buildToolPlans([ICRC1, other]), /resolved differently/);
  assert.throws(() => buildToolPlans({ format: "nope" }), /not a candid-profile-resolved v0/);
  assert.throws(() => toolDefinitions(PACKS, { canisters: [{}] }), /needs an `id`/);
});

test("the hand-written types declare exactly the runtime exports", async () => {
  const { readFileSync } = await import("node:fs");
  const dts = readFileSync(new URL("../src/index.d.mts", import.meta.url), "utf8");
  const declared = [...dts.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(await import("../src/index.mjs")).sort());
});

test("buildToolPlans: an argument field named canister_id is skipped, since the canister selector owns that input", () => {
  const doc = structuredClone(ICRC1);
  const m = structuredClone(doc.methods.icrc1_balance_of);
  m.args[0] = { candid: "record", fields: { canister_id: { candid: "nat", tags: { amount: { args: { decimals: 0 } } } } } };
  doc.methods.by_canister = m;
  const { plans, skipped } = buildToolPlans(doc);
  assert.equal(plans.has("by_canister"), false);
  assert.match(skipped.find((s) => s.method === "by_canister").reason, /canister_id/);
});

test("a field named __proto__ is an own property of the schema and of the value", () => {
  const doc = structuredClone(ICRC1);
  doc.methods.odd_field = JSON.parse('{"mode":"query","args":[{"candid":"record","fields":{"__proto__":{"candid":"nat","tags":{"amount":{"args":{"decimals":0}}}}}}],"results":[{"candid":"nat"}]}');
  const def = toolDefinitions(doc).find((d) => d.name === "odd_field");
  assert.ok(Object.hasOwn(def.inputSchema.properties, "__proto__"));
  assert.deepEqual(def.inputSchema.required, ["__proto__"]);
  const read = readToolInput(buildToolPlans(doc).plans.get("odd_field"), JSON.parse('{"__proto__":"5"}'));
  assert.equal(read.issues, undefined);
  assert.ok(Object.hasOwn(read.value, "__proto__"));
  assert.equal(read.value.__proto__, 5n);
});

test("buildToolPlans: a stamp that is the whole argument is skipped, never left unset (#37 review)", () => {
  const doc = structuredClone(ICRC1);
  const m = structuredClone(doc.methods.icrc1_transfer);
  m.args = [{ candid: "nat64", optional: true, tags: { timestamp: { args: { unit: "ns" } } } }];
  m.tags.idempotency.args.stamp = "(0)";
  doc.methods.stamp_only = m;
  const { plans, skipped } = buildToolPlans(doc);
  assert.equal(plans.has("prepare_stamp_only"), false);
  assert.match(skipped.find((s) => s.method === "stamp_only").reason, /one field of the argument record/);
});

test("buildToolPlans: a required stamp is filled by the layer, not skipped (#37 review)", () => {
  const doc = structuredClone(ICRC1);
  const m = structuredClone(doc.methods.icrc1_transfer);
  delete m.args[0].fields.created_at_time.optional;
  doc.methods.required_stamp = m;
  const { plans, skipped } = buildToolPlans(doc);
  assert.equal(skipped.find((s) => s.method === "required_stamp"), undefined);
  const plan = plans.get("prepare_required_stamp");
  assert.equal(plan.fields.find((f) => f.name === "created_at_time").role, "stamp");
  assert.equal(plan.params.some((p) => p.name === "created_at_time"), false, "the stamp is never an input");
  const read = readToolInput(plan, { to: "mxzaz-hqaaa-aaaar-qaada-cai", amount: "1" }, { refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" } });
  assert.equal(read.issues, undefined);
  assert.equal(withStamp(plan, read.value, 5n).created_at_time, 5n);
});

test("buildToolPlans: an outcome key through a record is followed, never left to the default (#37 review; B2 rule 5)", () => {
  const doc = structuredClone(ICRC1);
  const m = structuredClone(doc.methods.icrc1_transfer);
  m.results = [{ candid: "variant", cases: { Ok: { candid: "record", fields: { status: { candid: "variant", cases: { Done: { candid: "null" }, Queued: { candid: "null" } } } } }, Err: { candid: "null" } } }];
  m.tags.outcome.args = { classes: { "Ok.status.Done": "success", "Ok.status.Queued": "retry_same", Err: "fail" }, default: "fail" };
  doc.methods.nested = m;
  const missing = structuredClone(m);
  missing.tags.outcome.args = { classes: { "Ok.Nope": "success" }, default: "fail" };
  doc.methods.missing_case = missing;
  const { plans, skipped } = buildToolPlans(doc);
  const queued = classifyReply(plans.get("prepare_nested"), { tag: "Ok", value: { status: { tag: "Queued", value: null } } });
  assert.deepEqual([queued.cls, queued.path], ["retry_same", ["Ok", "status", "Queued"]]);
  assert.equal(classifyReply(plans.get("prepare_nested"), { tag: "Ok", value: { status: { tag: "Done", value: null } } }).cls, "success");
  assert.deepEqual(skipped, [{ method: "missing_case", reason: "the outcome key Ok.Nope names no field of the result" }]);
  assert.ok(plans.has("prepare_icrc1_transfer"), "the pack's own keys are all variant paths");
});
