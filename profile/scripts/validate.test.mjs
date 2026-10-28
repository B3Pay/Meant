// Run: npm test   (node --test scripts/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { idlHash, parseAddress, jcs } from "./validate.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts/validate.mjs");

async function validateJson(...args) {
  try {
    const { stdout } = await run("node", [CLI, ...args, "--json"]);
    return { code: 0, report: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code, report: JSON.parse(e.stdout) };
  }
}

test("idlHash matches Candid field ids emitted by candid-core", () => {
  assert.equal(idlHash("amount"), 3573748184);
  assert.equal(idlHash("owner"), 947296307);
  assert.equal(idlHash("to"), 25979);
  assert.equal(idlHash("Ok"), 17724);
});

test("address grammar", () => {
  assert.deepEqual(parseAddress("icrc1_transfer(0).to.owner").kind, "arg");
  assert.equal(parseAddress("icrc1_transfer->(0).Err.BadFee").kind, "result");
  assert.equal(parseAddress("type:Account.owner").kind, "type");
  assert.equal(parseAddress("icrc1_transfer").kind, "method");
  assert.equal(parseAddress("get_blocks->(0).blocks[].#3").segs.length, 3);
  assert.equal(parseAddress("icrc1_transfer.amount"), null, "a method address cannot carry a path");
  assert.equal(parseAddress("icrc1_transfer(0)..amount"), null);
  assert.equal(parseAddress("m(0).#4294967296"), null, "ids are u32");
  assert.equal(parseAddress("m(0).#4294967295").segs[0].id, 4294967295);
});

test("jcs sorts keys and is stable", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
});

test("standard packs pass", async () => {
  const { code, report } = await validateJson();
  assert.equal(code, 0, JSON.stringify(report, null, 2));
  assert.ok(report.results.length >= 2);
});

test("broken pack is rejected with the expected codes", async () => {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  pack.name = "broken";
  pack.annotations = [
    { at: "icrc1_transfer(0).amout", tag: "amount", args: { decimals: 8 } },                              // typo
    { at: "icrc1_transfer(0).memo", tag: "amount", args: { decimals: 8 } },                               // blob
    { at: "icrc1_transfer", tag: "idempotency", args: { mode: "replay_same_payload", stamp: "created_at_time" } }, // stamp untagged
    { at: "icrc1_transfer", tag: "outcome", args: { classes: { "Err.BadFee.expected_fee": "fix_input" } } }, // not a case
    { at: "icrc1_transfer", tag: "intent", args: { title: "Send", template: "Send {amount} to {recipient}" } }, // bad placeholder
    { at: "icrc1_transfer(0).fee", tag: "amount", args: { decimals: { from: "query:icrc1_transfer" } } },  // ref to update
    { at: "icrc1_balance_of", tag: "effect", args: { kind: "transfer", irreversible: true } },             // query as transfer
    { at: "icrc1_transfer(0).to", tag: "default", args: { value: "null", mode: "auto" } },                 // non-opt
  ];
  const dir = await mkdtemp(path.join(tmpdir(), "ca-"));
  const file = path.join(dir, "broken.profile.json");
  await writeFile(file, JSON.stringify(pack));
  const { code, report } = await validateJson(file);
  assert.equal(code, 1);
  const codes = new Set(report.results[0].diagnostics.map((d) => d.code));
  for (const c of ["E_ADDR_UNRESOLVED", "E_TAG_NOT_APPLICABLE", "E_STAMP_UNTAGGED", "E_OUTCOME_NOT_CASE", "E_TEMPLATE_PATH", "E_REF_NOT_QUERY", "E_EFFECT_MODE", "E_DEFAULT_NULL"]) {
    assert.ok(codes.has(c), `expected ${c}; got ${[...codes].join(", ")}`);
  }
});

test("schema rejects a value tag on a bare method and unknown tags", async () => {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  pack.annotations = [
    { at: "icrc1_transfer", tag: "amount", args: { decimals: 8 } },
    { at: "icrc1_transfer(0).amount", tag: "currency", args: {} },
  ];
  const dir = await mkdtemp(path.join(tmpdir(), "ca-"));
  const file = path.join(dir, "schema.profile.json");
  await writeFile(file, JSON.stringify(pack));
  const { code, report } = await validateJson(file);
  assert.equal(code, 1);
  assert.ok(report.results[0].diagnostics.every((d) => d.code === "E_SCHEMA"));
});

async function writeTemp(name, content) {
  const dir = await mkdtemp(path.join(tmpdir(), "ca-"));
  const file = path.join(dir, name);
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

test("addresses compare by resolved position, not by spelling", async () => {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  const amountId = idlHash("amount");
  // Same args under a #id spelling: duplicate warning. Different args: conflict.
  pack.annotations.push({ at: `icrc1_transfer(0).#${amountId}`, tag: "amount", args: { decimals: 6 } });
  const { code, report } = await validateJson(await writeTemp("eq.profile.json", pack));
  assert.equal(code, 1);
  assert.ok(report.results[0].diagnostics.some((d) => d.code === "E_CONFLICT"));
});

test("stamp lookup accepts an equivalent #id spelling of the timestamp tag", async () => {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  for (const a of pack.annotations) {
    if (a.tag === "timestamp" && a.at === "icrc1_transfer(0).created_at_time") a.at = `icrc1_transfer(0).#${idlHash("created_at_time")}`;
  }
  const { code, report } = await validateJson(await writeTemp("stamp.profile.json", pack));
  assert.equal(code, 0, JSON.stringify(report.results[0].diagnostics));
});

test("canister profile with type: addresses validates, and its tags reach every position", async () => {
  const did = path.join(ROOT, "examples/tokens.did");
  const prof = path.join(ROOT, "examples/tokens.profile.json");
  const { code } = await validateJson(prof, "--did", did);
  assert.equal(code, 0);
  const { stdout } = await run("node", [CLI, prof, "--did", did, "--resolved"]);
  const r = JSON.parse(stdout);
  const err = r.methods.send.results[0].cases.Err.cases.Insufficient.fields.balance.fields.e8s;
  assert.equal(err.tags.amount.args.decimals, 8, "type edge tag reaches an error field");
  assert.equal(r.methods.balance.results[0].fields.e8s.tags.describe.args.label, "Balance", "method address overrides type edge");
});

test("changed interface: rebound when compatible, stale when not", async () => {
  const prof = path.join(ROOT, "examples/tokens.profile.json");
  const base = await readFile(path.join(ROOT, "examples/tokens.did"), "utf8");
  const compatible = await writeTemp("v2.did", base.replace("service : {", "service : {\n  version : () -> (text) query;"));
  let { code, report } = await validateJson(prof, "--did", compatible);
  assert.equal(code, 0);
  assert.ok(report.results[0].diagnostics.some((d) => d.code === "W_REBOUND"));
  const breaking = await writeTemp("v3.did", base.replace("record { e8s : nat64 }", "record { units : nat64 }"));
  ({ code, report } = await validateJson(prof, "--did", breaking));
  assert.equal(code, 1);
  assert.ok(report.results[0].diagnostics.some((d) => d.code === "E_STALE"));
});

// ---------------------------------------------------------------- added with D-017..D-019 (second review)

async function codesFor(annotations, overrides = {}) {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  Object.assign(pack, { name: "probe", annotations }, overrides);
  const { report } = await validateJson(await writeTemp("probe.profile.json", pack));
  return { codes: new Set(report.results[0].diagnostics.map((d) => d.code)), diagnostics: report.results[0].diagnostics };
}

test("jcs follows RFC 8785 for non-ASCII keys, control characters and surrogate pairs", () => {
  assert.equal(jcs({ "é": "ü\u0001\n", a: 1 }), '{"a":1,"é":"ü\\u0001\\n"}');
  // Keys sort by UTF-16 code units: U+1F600 (D83D DE00) sorts before U+E000.
  assert.equal(jcs({ "": 1, "\u{1F600}": 2 }), '{"\u{1F600}":2,"":1}');
});

test("packs reject type: addresses", async () => {
  const { codes } = await codesFor([{ at: "type:Account", tag: "account", args: { encoding: "icrc1" } }]);
  assert.ok(codes.has("E_PACK_TYPE_REF"));
});

test("dynamic refs: wrong shape and wrong kind", async () => {
  const { codes } = await codesFor([
    { at: "icrc1_transfer(0).amount", tag: "amount", args: { decimals: { from: "query:icrc1_balance_of" } } }, // takes an argument
    { at: "icrc1_transfer(0).fee", tag: "amount", args: { decimals: { from: "now" } } },                       // now is only valid in default.value
  ]);
  assert.ok(codes.has("E_REF_SHAPE"), [...codes].join(","));
  assert.ok(codes.has("E_DYNAMIC_KIND"), [...codes].join(","));
});

test("templates: optional placeholder outside [ ], escapes, and syntax errors", async () => {
  const intent = (template) => ({ at: "icrc1_transfer", tag: "intent", args: { title: "Send", template } });
  let r = await codesFor([intent("Send {amount} to {to} with memo {memo}")]);
  assert.ok(r.codes.has("W_TEMPLATE_OPTIONAL"));
  r = await codesFor([intent("Send {{literal}} {amount} [[not optional]] to {to}")]);
  assert.ok(!r.codes.has("E_TEMPLATE") && !r.codes.has("E_TEMPLATE_PATH"), JSON.stringify(r.diagnostics));
  r = await codesFor([intent("Send {amount")]);
  assert.ok(r.codes.has("E_TEMPLATE"));
  r = await codesFor([intent("Send {amount}[ with memo {memo}")]);
  assert.ok(r.codes.has("E_TEMPLATE"));
  r = await codesFor([intent("Send {amount}[ with [memo {memo}]]")]);
  assert.ok(r.codes.has("E_TEMPLATE"), "nested [ ] is not allowed in v0");
});

test("pack outcome without default warns (D-019)", async () => {
  const pack = JSON.parse(await readFile(path.join(ROOT, "packs/icrc1.profile.json"), "utf8"));
  for (const a of pack.annotations) if (a.tag === "outcome") delete a.args.default;
  const { code, report } = await validateJson(await writeTemp("nodefault.profile.json", pack));
  assert.equal(code, 0);
  const codes = new Set(report.results[0].diagnostics.map((d) => d.code));
  assert.ok(codes.has("W_PACK_NO_DEFAULT"));
  assert.ok(!codes.has("W_OUTCOME_UNCLASSIFIED"), "every case of the fragment is classified");
});

test("list tag resolves cursor, next and items", async () => {
  const did = await writeTemp("blocks.did", `
type GetBlocksArgs = record { start : nat; length : nat };
type Block = record { id : nat; amount : nat };
service : {
  get_blocks : (GetBlocksArgs) -> (record { blocks : vec Block; next : opt nat }) query;
}`);
  const profile = async (args) => writeTemp("blocks.profile.json", {
    format: "candid-profile", format_version: 0, kind: "canister", name: "blocks", origin: "author", language: "en",
    binds: { interface_id: `candid-core:interface:v1:sha256:${"0".repeat(64)}` },
    annotations: [{ at: "get_blocks", tag: "list", args }],
  });
  let { code } = await validateJson(await profile({ cursor: "start", next: "next", items: "blocks" }), "--did", did);
  assert.equal(code, 0);
  let r = await validateJson(await profile({ cursor: "offset", next: "next", items: "blocks[].id" }), "--did", did);
  assert.equal(r.code, 1);
  assert.ok(r.report.results[0].diagnostics.some((d) => d.code === "E_ADDR_UNRESOLVED" && d.message.includes("list.cursor")));
});

test("pathless type: addresses are limited to records and variants; structural aliases warn (D-018)", async () => {
  const did = await writeTemp("alias.did", `
type Tokens = nat;
type Memo = blob;
type Balance = record { e8s : nat64 };
type Fee = record { e8s : nat64 };
type Account = record { owner : principal; subaccount : opt blob };
service : {
  send : (Tokens, Memo, Account) -> (Balance);
  fee : () -> (Fee) query;
}`);
  const base = { format: "candid-profile", format_version: 0, kind: "canister", name: "alias", origin: "author", language: "en" };
  // Learn the real interface_id first so the checks below are not confounded by W_REBOUND / E_STALE.
  const probe = await validateJson(await writeTemp("probe.profile.json", { ...base, binds: { interface_id: `candid-core:interface:v1:sha256:${"0".repeat(64)}` }, annotations: [{ at: "fee", tag: "describe", args: { label: "Fee" } }] }), "--did", did);
  const binds = { interface_id: probe.report.results[0].interface_id };
  assert.match(binds.interface_id ?? "", /^candid-core:interface:v1:sha256:[0-9a-f]{64}$/, JSON.stringify(probe.report));

  const bad = await validateJson(await writeTemp("bad.profile.json", { ...base, binds, annotations: [
    { at: "type:Tokens", tag: "amount", args: { decimals: 8 } },        // alias of nat: would tag every nat
    { at: "type:Memo", tag: "bytes", args: { encoding: "utf8" } },      // alias of blob: would tag every blob
  ] }), "--did", did);
  assert.equal(bad.code, 1);
  const typeNode = bad.report.results[0].diagnostics.filter((d) => d.code === "E_TYPE_NODE");
  assert.deepEqual(typeNode.map((d) => d.at).sort(), ["type:Memo", "type:Tokens"]);

  const good = await writeTemp("good.profile.json", { ...base, binds, annotations: [
    { at: "type:Account", tag: "account", args: { encoding: "icrc1" } },   // record: allowed, no alias
    { at: "type:Balance", tag: "describe", args: { label: "Balance" } },    // record: allowed, but Fee is the same node
    { at: "type:Balance.e8s", tag: "amount", args: { decimals: 8 } },
  ] });
  const ok = await validateJson(good, "--did", did);
  assert.equal(ok.code, 0, JSON.stringify(ok.report.results[0].diagnostics));
  const aliases = ok.report.results[0].diagnostics.filter((d) => d.code === "W_STRUCTURAL_ALIAS");
  assert.deepEqual(aliases.map((d) => d.at).sort(), ["type:Balance", "type:Balance.e8s"]);
  assert.ok(aliases.every((d) => d.message.includes('"Fee"')));
  assert.ok(!ok.report.results[0].diagnostics.some((d) => d.at === "type:Account"), "Account has no structural alias");
  // The alias is real: the Balance tags reach the Fee result.
  const { stdout } = await run("node", [CLI, good, "--did", did, "--resolved"]);
  const r = JSON.parse(stdout);
  assert.equal(r.methods.fee.results[0].fields.e8s.tags.amount.args.decimals, 8);
  assert.equal(r.methods.fee.results[0].tags.describe.args.label, "Balance");
});
