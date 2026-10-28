// Doc annotations (spec section 9): tags written as doc comments in the .did, read by candid-core (doc attributes v1)
// and placed by src/doc-annotations.mjs. The inputs are real didToDocAttributes responses (fixtures/doc-attributes,
// provenance in its SOURCE.json); the profiles are then resolved by the pinned compiler like any other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { HERE, read, readJson, interfaceIdOf, resolve, errors, node } from "./helpers.mjs";
import { profileFromDocAttributes, DOC_ATTRIBUTES_VERSION } from "../src/index.mjs";

const DIR = path.join(HERE, "fixtures/doc-attributes");
const did = (name) => read(path.join(DIR, `${name}.did`));
const response = (name) => readJson(path.join(DIR, `${name}.doc-attributes.json`));
const compile = async (name, opts) => profileFromDocAttributes(await response(name), opts);
const pairs = (diagnostics) => diagnostics.map((d) => [d.severity, d.code, d.at]);

test("the fixtures are the responses for the .did files beside them, and name the same interface the pinned compiler does", async () => {
  const dids = (await readdir(DIR)).filter((f) => f.endsWith(".did")).sort();
  const source = await readJson(path.join(DIR, "SOURCE.json"));
  assert.deepEqual(Object.values(source.files).map((f) => f.from).sort(), dids);
  for (const file of dids) {
    const name = file.replace(/\.did$/, "");
    const r = await response(name);
    if (r.ok === false) continue;
    assert.equal(r.source_info.sources[0].source, await did(name), `${name}: regenerate with scripts/doc-attributes-fixtures.mjs`);
    assert.equal(r.contract.identities.interface, await interfaceIdOf(await did(name)), name);
  }
});

test("the spec section 9 example becomes an author profile that resolves cleanly", async () => {
  const { ok, doc, diagnostics } = await compile("spec-9", { name: "tokens" });
  assert.equal(ok, true);
  assert.deepEqual(diagnostics, []);
  const r0 = await response("spec-9");
  assert.deepEqual(
    { ...doc, annotations: undefined },
    {
      format: "candid-profile", format_version: 0, kind: "canister", name: "tokens", origin: "author", language: "en",
      description: "From the doc comments of memory:/spec-9.did.", binds: { interface_id: r0.contract.identities.interface }, annotations: undefined,
    },
  );
  const dyn = { from: "query:decimals" };
  assert.deepEqual(doc.annotations, [
    { at: "send", tag: "intent", args: { title: "Send", template: "Send {amount} to {to}[ with memo {memo}]" } },
    { at: "send", tag: "effect", args: { kind: "transfer", irreversible: true } },
    { at: "send(0).amount", tag: "amount", args: { decimals: dyn, symbol: "TOK" } },
    { at: "send(0).memo", tag: "bytes", args: { encoding: "utf8" } },
    { at: "send->(0).Ok", tag: "amount", args: { decimals: dyn, symbol: "TOK" } },
    { at: "send", tag: "describe", args: { help: "Send tokens to another principal." } },
    { at: "type:Tokens.e8s", tag: "amount", args: { decimals: 8, symbol: "ICP" } },
  ]);
  const r = await resolve(await did("spec-9"), { profiles: [doc] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.profiles.map((p) => [p.name, p.origin, p.status]), [["tokens", "author", "applied"]]);
  const send = r.resolved.methods.send;
  assert.equal(send.tags.describe.args.help, "Send tokens to another principal.");
  assert.deepEqual(node(send.args[0], "amount").tags.amount.args, { decimals: dyn, symbol: "TOK" });
  assert.deepEqual(node(send.results[0], "Ok").tags.amount.args, { decimals: dyn, symbol: "TOK" });
});

test("comments never move the interface: the profile binds the id of the .did without them", async () => {
  const { doc } = await compile("places");
  const bare = (await did("places")).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal(doc.binds.interface_id, await interfaceIdOf(bare));
});

test("every place a doc can put a tag: declarations, their fields, inline actor fields, results, tuples, dynamic values", async () => {
  const { ok, doc, diagnostics } = await compile("places");
  assert.equal(ok, true);
  assert.deepEqual(doc.annotations, [
    // declarations: prose on a record describes it, a nat alias is left to its uses
    { at: "type:Payment", tag: "describe", args: { help: "An account and an amount." } },
    // methods, in SourceInfo order (by name), found by their SourceInfo path, not the Contract's index (OQ-4 trap 1)
    { at: "multi(0)", tag: "amount", args: { decimals: { from: "query:decimals" } } },
    { at: "multi(1)", tag: "timestamp", args: { unit: "ns" } },
    // range bounds are decimal strings, and an integer past 2^53 stays exact
    { at: "multi(2)", tag: "range", args: { min: "1", max: "18446744073709551615" } },
    { at: "pay", tag: "intent", args: { title: "Pay", template: "Pay {amount} to {to}" } },
    { at: "pay", tag: "effect", args: { kind: "transfer", irreversible: true } },
    { at: "pay", tag: "outcome", args: { classes: { Ok: "success", "Err.TooOld": "fix_input" }, default: "fail" } },
    { at: "pay", tag: "describe", args: { help: "Pay someone.\n\nThe payment is final." } },
    // fields of declarations, in canonical id order; `at` reaches inside the field
    { at: "type:Payment.to", tag: "account", args: {} },
    { at: "type:Payment.to.subaccount", tag: "bytes", args: { encoding: "hex" } },
    { at: "type:Payment.count", tag: "describe", args: { label: "Count", help: "How many times." } },
    { at: "type:Payment.created_at", tag: "timestamp", args: { unit: "ns" } },
    { at: "type:Payment.created_at", tag: "default", args: { value: { from: "now" }, mode: "auto" } },
    { at: "type:Payment.amount", tag: "amount", args: { decimals: 8, symbol: "ICP" } },
    { at: "type:Payment.amount", tag: "describe", args: { help: "How much, in e8s." } },
    { at: "type:Status.Done", tag: "describe", args: { label: "Done" } },
    { at: "type:Status.Running", tag: "describe", args: { help: "Still running." } },
    // inline actor fields: an opt is passed through, a vec is []
    { at: "inline(0).who", tag: "describe", args: { help: "Who receives it." } },
    { at: "inline(0).mode", tag: "describe", args: { label: "Mode" } },
    { at: "inline(0).items[].price", tag: "amount", args: { decimals: 2 } },
    { at: "inline->(0).Ok", tag: "timestamp", args: { unit: "ms" } },
  ]);
  assert.deepEqual(pairs(diagnostics), [
    ["info", "I_DOC_PROSE", "type:Tokens"],
    ["info", "I_DOC_IGNORED", "old"],
    ["info", "I_DOC_IGNORED", "old"],
    ["warning", "W_DOC_UNKNOWN_TAG", "old"],
    ["info", "I_DOC_PROSE", "type:Payment.retries"],
  ]);
  assert.match(diagnostics[3].message, /^doc line 3: @amout: not a profile tag; did you mean @amount\?$/);
  assert.deepEqual([diagnostics[3].path, diagnostics[3].source], ["actor.methods[3]", "memory:/places.did"]);
  const r = await resolve(await did("places"), { profiles: [doc] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.equal(r.profiles[0].status, "applied");
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== "info"), []);
});

test("prose never makes an untagged integer an input of plain digits", async () => {
  const { doc, diagnostics } = await compile("places");
  // `retries : nat8` has only prose: not described, so the tool layer still has no reading for it (D-044)
  assert.equal(doc.annotations.some((a) => a.at === "type:Payment.retries"), false);
  assert.match(diagnostics.find((d) => d.at === "type:Payment.retries").message, /plain digits \(D-044\)/);
  // with a value tag that reads it, or an explicit @describe, the prose is help
  assert.equal(doc.annotations.find((a) => a.at === "type:Payment.amount" && a.tag === "describe").args.help, "How much, in e8s.");
  assert.deepEqual(doc.annotations.find((a) => a.at === "type:Payment.count").args, { label: "Count", help: "How many times." });
});

test("a service class whose methods come from a declared service type", async () => {
  const { ok, doc, diagnostics } = await compile("class");
  assert.equal(ok, true);
  assert.deepEqual(doc.annotations, [
    { at: "add", tag: "intent", args: { title: "Add", template: "Add {n}" } },
    { at: "get", tag: "effect", args: { kind: "read", irreversible: false } },
    { at: "get", tag: "describe", args: { help: "Read the counter." } },
    { at: "add(0).n", tag: "describe", args: { label: "How much" } },
  ]);
  assert.deepEqual(diagnostics, []);
  const r = await resolve(await did("class"), { profiles: [doc] });
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== "info"), []);
});

test("a tag no v0 address reaches, or one in the wrong place, is an error with its place", async () => {
  const { ok, doc, diagnostics } = await compile("unplaceable");
  assert.equal(ok, false);
  assert.equal(doc, null);
  assert.deepEqual(diagnostics.map((d) => [d.code, d.at]), [
    ["E_DOC_TARGET", "actor"], // a value tag on the service as a whole
    ["E_DOC_TARGET", "type:Callback.methods[0]"], // a method of another service type
    ["E_DOC_TARGET", "badat"], // at does not parse
    ["E_DOC_TARGET", "two"], // two arguments and no (i)
    ["E_DOC_VALUE", "unknowncall"], // later() is no dynamic value
    ["E_DOC_TARGET", "actor.methods[14].function.args[0].type.methods[0]"], // a method of a service passed as an argument
    ["E_DOC_VALUE", "badcall"], // query() takes one name
    ["E_DOC_TARGET", "bare"], // a value tag on a method without at
    ["E_DOC_VALUE", "fraction"], // no silent rounding
    ["E_DOC_VALUE", "identat"], // at is text
    ["E_DOC_TARGET", "misplaced"], // a method tag takes no at
    ["E_DOC_TARGET", "type:Hook.args[0].type.fields[0]"], // inside a func value (OQ-4 trap 6)
    ["E_DOC_TARGET", "type:Pair.a"], // a method tag on a field
    ["E_DOC_TARGET", "actor.methods[14].function.args[0].type.methods[0].function.args[0].type.fields[0]"], // a field of that method
    ["E_DOC_TARGET", "inline(0).y"], // (i) on a field
    ["E_DOC_TARGET", "actor.methods[7].function.args[1].type.args[0].type.fields[0]"], // inside a func argument
  ]);
  assert.ok(diagnostics.every((d) => d.severity === "error" && /^doc line 1: @(amount|effect|intent): /.test(d.message)));
  // a field inside a method of a service argument belongs to that method (the longest method path), not to `watch`
  assert.equal(diagnostics.filter((d) => /notify is a method of a service type that is not this canister's/.test(d.message)).length, 3);
});

test("docs above a quoted method name are not recorded upstream; were they, the name would still be refused (OQ-3)", async () => {
  const r = await response("unplaceable");
  const quoted = r.source_info.methods.find((m) => m.name === "quoted-name");
  // Fact (candid_parser 0.4.0, as pinned by candid-core): a doc comment above a quoted name is dropped
  assert.equal(quoted.docs, undefined);
  r.doc_attributes.items = [{
    kind: "method", origin: quoted.origin, path: quoted.path, name: quoted.name, prose: [],
    attributes: [{ name: "effect", doc_line: 0, args: [{ key: "kind", value: { kind: "text", value: "write" } }, { key: "irreversible", value: { kind: "bool", value: false } }] }],
  }];
  const out = profileFromDocAttributes(r);
  assert.deepEqual(out.diagnostics.map((d) => [d.code, d.at]), [["E_DOC_TARGET", quoted.path]]);
  assert.match(out.diagnostics[0].message, /OQ-3/);
});

test("candid-core's own failures pass through: a malformed attribute, a .did that does not compile", async () => {
  const malformed = await compile("malformed");
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.diagnostics, [{
    severity: "error", code: "E_DOC_SYNTAX", at: "actor.methods[0]",
    message: "doc_attribute_duplicate_key: doc line 1 of actor.methods[0]: @intent: the key `title` repeats",
  }]);
  const compileFailure = profileFromDocAttributes({ ok: false, diagnostics: [{ code: "unbound_type", message: "missing is not defined", span: { source_name: "memory:/x.did" } }] });
  assert.deepEqual(pairs(compileFailure.diagnostics), [["error", "E_CANDID", "memory:/x.did"]]);
});

test("only a doc attributes v1 response is read", async () => {
  const r = await response("spec-9");
  const input = (value) => profileFromDocAttributes(value).diagnostics.map((d) => d.code);
  assert.deepEqual(input(null), ["E_DOC_INPUT"]);
  assert.deepEqual(input([]), ["E_DOC_INPUT"]);
  assert.deepEqual(input({ contract: r.contract }), ["E_DOC_INPUT"]);
  assert.deepEqual(input({ ...r, doc_attributes: { ...r.doc_attributes, doc_attributes_version: DOC_ATTRIBUTES_VERSION + 1 } }), ["E_DOC_INPUT"]);
  assert.deepEqual(input({ ...r, source_info: { ...r.source_info, contract_id: "candid-core:contract:v1:sha256:" + "0".repeat(64) } }), ["E_DOC_INPUT"]);
  assert.deepEqual(input({ ok: false, diagnostics: [] }), ["E_DOC_INPUT"]);
});

test("no tag in the comments: no profile, and nothing wrong", async () => {
  const r = await response("spec-9");
  r.doc_attributes.items = r.doc_attributes.items.map((item) => ({ ...item, attributes: [] })).filter((item) => item.kind === "declaration");
  const out = profileFromDocAttributes(r);
  assert.deepEqual([out.ok, out.doc], [true, null]);
  assert.deepEqual(pairs(out.diagnostics), [["info", "I_DOC_IGNORED", "memory:/spec-9.did"]]);
});

test("name, origin, language and canister id are the caller's", async () => {
  const { doc } = await compile("class", { name: "counter", origin: "third_party", language: "de", canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" });
  assert.deepEqual([doc.name, doc.origin, doc.language, doc.binds.canister_id], ["counter", "third_party", "de", "ryjl3-tyaaa-aaaaa-aaaba-cai"]);
});
