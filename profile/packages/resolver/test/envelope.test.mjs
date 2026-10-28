// resolveService({ envelope }): the interface comes from a candid-core ContractEnvelope another tool wrote (here
// `candid-core-cli gen` 0.3.0), not from compiling the .did again. Same resolved form; a bad envelope is a diagnostic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveService, interfaceFromEnvelope, runCli } from "../src/index.mjs";
import { HERE, ROOT, icrc1, icrc2, read, readJson, validateSchema } from "./helpers.mjs";
import path from "node:path";
import { didToContract } from "@candid-core/cli";

const env = (name) => readJson(path.join(HERE, "fixtures/envelopes", `${name}.envelope.json`));
const CASES = [
  { name: "ledger", did: "packages/resolver/test/fixtures/ledger.did", packs: [{ doc: icrc1 }, { doc: icrc2 }], profiles: [] },
  { name: "tokens", did: "examples/tokens.did", packs: [], profiles: [{ doc: await readJson("examples/tokens.profile.json") }] },
];

for (const c of CASES) {
  test(`${c.name}: the envelope gives the resolved form the .did gives`, async () => {
    const fromDid = await resolveService({ did: await read(c.did), packs: c.packs, profiles: c.profiles, validateSchema });
    const fromEnvelope = await resolveService({ envelope: await env(c.name), packs: c.packs, profiles: c.profiles, validateSchema });
    assert.equal(fromDid.ok, true, JSON.stringify(fromDid.diagnostics.filter((d) => d.severity === "error")));
    assert.deepEqual(fromEnvelope, fromDid);
  });
}

test("a numeric label has no field-names entry and resolves as #n, as from the .did", async () => {
  const did = "type R = record { 1 : nat; 3 : text; memo : nat }; type V = variant { 7; ok }; service : { f : (R) -> (V) query }";
  const envelope = await didToContract(did);
  assert.equal(envelope.extensions["org.candid-core.field-names/v1"].length, 2, "only memo and ok are named");
  const fromDid = await resolveService({ did, validateSchema });
  const fromEnvelope = await resolveService({ envelope, validateSchema });
  assert.equal(fromEnvelope.ok, true, JSON.stringify(fromEnvelope.diagnostics));
  assert.deepEqual(fromEnvelope, fromDid);
});

test("exactly one of did and envelope", async () => {
  await assert.rejects(resolveService({ validateSchema }), TypeError);
  await assert.rejects(resolveService({ did: "service : {}", envelope: await env("tokens"), validateSchema }), TypeError);
});

test("a bad envelope is an E_ENVELOPE diagnostic, never a throw", async () => {
  const good = await env("tokens");
  for (const kind of ["opt", "vec", "record", "func", "service"]) assert.ok(good.contract.types.some((t) => t.kind === kind), `the fixture has a ${kind}`);
  const clone = () => structuredClone(good);
  const bad = [
    ["null", null],
    ["array", []],
    ["no contract", { extensions: {} }],
    ["did text", "service : {}"],
    ["other format", (() => { const e = clone(); e.contract.format = "other"; return e; })()],
    ["version 2", (() => { const e = clone(); e.contract.format_version = 2; return e; })()],
    ["no interface id", (() => { const e = clone(); delete e.contract.identities.interface; return e; })()],
    ["an interface id with no digest", (() => { const e = clone(); e.contract.identities.interface = "candid-core:interface:v1:not-a-hash"; return e; })()],
    ["an interface id with an uppercase digest", (() => { const e = clone(); e.contract.identities.interface = e.contract.identities.interface.toUpperCase().replace("CANDID-CORE:INTERFACE:V1:SHA256:", "candid-core:interface:v1:sha256:"); return e; })()],
    ["a declaration with no name", (() => { const e = clone(); delete e.contract.declarations[0].name; return e; })()],
    ["a declaration listed twice", (() => { const e = clone(); e.contract.declarations.push({ ...e.contract.declarations[0] }); return e; })()],
    ["another semantics profile", (() => { const e = clone(); e.contract.semantics_profile = "candid-2"; return e; })()],
    ["no canonicalization profile", (() => { const e = clone(); delete e.contract.canonicalization_profile; return e; })()],
    ["a declaration name that is not an identifier", (() => { const e = clone(); e.contract.declarations[0].name = "Foo-Bar"; return e; })()],
    ["a declaration naming a class", (() => { const e = clone(); const svc = e.contract.types.findIndex((t) => t.kind === "service"); e.contract.types.push({ kind: "class", init: [], service: svc }); e.contract.declarations.push({ name: "K", type: e.contract.types.length - 1 }); return e; })()],
    ["a field of class type", (() => { const e = clone(); const svc = e.contract.types.findIndex((t) => t.kind === "service"); e.contract.types.push({ kind: "class", init: [], service: svc }); e.contract.types.find((t) => t.kind === "record").fields[0].type = e.contract.types.length - 1; return e; })()],
    ["a oneway func with results", (() => { const e = clone(); const f = e.contract.types.find((t) => t.kind === "func" && t.results.length > 0); f.mode = "oneway"; return e; })()],
    ["a method with an empty name", (() => { const e = clone(); const svc = e.contract.types.find((t) => t.kind === "service"); svc.methods[0].name = ""; return e; })()],
    ["a method with no id", (() => { const e = clone(); const svc = e.contract.types.find((t) => t.kind === "service"); delete svc.methods[0].id; return e; })()],
    ["a method id that is not its name's hash", (() => { const e = clone(); const svc = e.contract.types.find((t) => t.kind === "service"); svc.methods[0].id += 1; return e; })()],
    ["a primitive stored twice", (() => { const e = clone(); const i = e.contract.types.findIndex((t) => t.kind === "primitive"); e.contract.types.push({ ...e.contract.types[i] }); e.contract.declarations.push({ name: "Twin", type: e.contract.types.length - 1 }); return e; })()],
    ["a record stored twice", (() => { const e = clone(); const r = e.contract.types.find((t) => t.kind === "record"); e.contract.types.push(structuredClone(r)); e.contract.declarations.push({ name: "Twin", type: e.contract.types.length - 1 }); return e; })()],
    ["two equal recursive types", (() => { const e = clone(); const nat = e.contract.types.findIndex((t) => t.kind === "primitive"); const j = e.contract.types.length; e.contract.types.push({ kind: "record", fields: [{ id: 0, type: nat }, { id: 1, type: j + 1 }] }, { kind: "opt", inner: j }, { kind: "record", fields: [{ id: 0, type: nat }, { id: 1, type: j + 3 }] }, { kind: "opt", inner: j + 2 }); e.contract.declarations.push({ name: "L1", type: j }, { name: "L2", type: j + 2 }); return e; })()],
    ["types not an array", (() => { const e = clone(); e.contract.types = {}; return e; })()],
    ["dangling service ref", (() => { const e = clone(); e.contract.actor = { kind: "service", service: 99999 }; return e; })()],
    ["dangling field ref", (() => { const e = clone(); const r = e.contract.types.find((t) => t.kind === "record"); r.fields[0].type = 4096; return e; })()],
    ["dangling declaration", (() => { const e = clone(); e.contract.declarations[0].type = -1; return e; })()],
    ["names not an array", (() => { const e = clone(); e.extensions["org.candid-core.field-names/v1"] = {}; return e; })()],
    ["no names extension", (() => { const e = clone(); delete e.extensions; return e; })()],
    ["a name that is not its id's", (() => { const e = clone(); e.extensions["org.candid-core.field-names/v1"][0][2] = "renamed"; return e; })()],
    ["a name for a field that does not exist", (() => { const e = clone(); e.extensions["org.candid-core.field-names/v1"].push([0, 1, "x"]); return e; })()],
    ["a field named twice", (() => { const e = clone(); const names = e.extensions["org.candid-core.field-names/v1"]; names.push([...names[0]]); return e; })()],
    ["a type nothing reaches", (() => { const e = clone(); e.contract.types.push({ kind: "record", fields: [] }); return e; })()],
    ["an unknown kind", (() => { const e = clone(); e.contract.types[0] = { kind: "tensor" }; return e; })()],
    ["a method that is not a func", (() => { const e = clone(); const svc = e.contract.types.find((t) => t.kind === "service"); svc.methods[0].function = e.contract.types.findIndex((t) => t.kind === "record"); return e; })()],
    ["a func with no args", (() => { const e = clone(); delete e.contract.types.find((t) => t.kind === "func").args; return e; })()],
    ["an unknown primitive", (() => { const e = clone(); e.contract.types.find((t) => t.kind === "primitive").primitive = "tensor"; return e; })()],
    ["a method listed twice", (() => { const e = clone(); const svc = e.contract.types.find((t) => t.kind === "service"); svc.methods.push({ ...svc.methods[0] }); return e; })()],
    ["a func with no mode", (() => { const e = clone(); delete e.contract.types.find((t) => t.kind === "func").mode; return e; })()],
    ["a func with an unknown mode", (() => { const e = clone(); e.contract.types.find((t) => t.kind === "func").mode = "replicated"; return e; })()],
    ["an opt of itself", (() => { const e = clone(); const i = e.contract.types.findIndex((t) => t.kind === "opt"); e.contract.types[i].inner = i; return e; })()],
    ["two opts of each other", (() => { const e = clone(); const i = e.contract.types.length; e.contract.types.push({ kind: "opt", inner: i + 1 }, { kind: "opt", inner: i }); return e; })()],
    ["a vec with no inner", (() => { const e = clone(); delete e.contract.types.find((t) => t.kind === "vec").inner; return e; })()],
    ["no actor", (() => { const e = clone(); delete e.contract.actor; return e; })()],
    ["an actor of another kind", (() => { const e = clone(); e.contract.actor = { kind: "module", service: 0 }; return e; })()],
    ["an actor naming a record", (() => { const e = clone(); e.contract.actor = { kind: "service", service: e.contract.types.findIndex((t) => t.kind === "record") }; return e; })()],
  ];
  for (const [what, envelope] of bad) {
    const r = await resolveService({ envelope, didLabel: "app.envelope.json", validateSchema });
    assert.equal(r.ok, false, what);
    assert.equal(r.resolved, null, what);
    assert.deepEqual(r.diagnostics.map((d) => [d.code, d.at]), [["E_ENVELOPE", "app.envelope.json"]], what);
    assert.equal(interfaceFromEnvelope(envelope).failure?.length, 1, what);
  }
});

test("a property a node's kind does not have is ignored, never a throw", async () => {
  const good = await env("tokens");
  const e = structuredClone(good);
  // every node gets every other kind's properties as non-arrays, keeping its own
  e.contract.types = good.contract.types.map((t) => ({ fields: {}, args: {}, results: {}, init: {}, methods: {}, inner: {}, service: {}, ...structuredClone(t) }));
  assert.ok(e.contract.types.some((t) => t.kind === "primitive" && !Array.isArray(t.fields)), "a primitive carries a stray fields object");
  const r = interfaceFromEnvelope(e);
  assert.equal(r.failure, undefined, JSON.stringify(r.failure));
  const resolved = await resolveService({ envelope: e, didLabel: "app.envelope.json", validateSchema });
  const plain = await resolveService({ envelope: good, didLabel: "app.envelope.json", validateSchema });
  assert.deepEqual(resolved, plain);
});

test("long chains of types are checked in about linear time", async () => {
  const e = structuredClone(await env("tokens"));
  const types = e.contract.types;
  const nat = types.findIndex((t) => t.kind === "primitive" && t.primitive === "nat");
  // 100,000 distinct nested types: an opt chain of 50,000 (every suffix walked again was quadratic) over a
  // vec/opt chain that only a refinement round per level could tell apart
  let last = nat;
  for (let i = 0; i < 50_000; i++) {
    types.push({ kind: i % 2 ? "opt" : "vec", inner: last });
    last = types.length - 1;
  }
  for (let i = 0; i < 50_000; i++) {
    types.push({ kind: "opt", inner: last });
    last = types.length - 1;
  }
  e.contract.declarations.push({ name: "Deep", type: last });
  const started = performance.now();
  assert.equal(interfaceFromEnvelope(e).failure, undefined);
  assert.ok(performance.now() - started < 20_000, "checked within 20 s (the quadratic walks took far longer)");
});

test("the CLI takes --envelope, and refuses it beside a .did", async () => {
  const io = () => {
    const out = { stdout: "", stderr: "" };
    return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } } };
  };
  const a = io();
  const envFile = path.join(HERE, "fixtures/envelopes/ledger.envelope.json");
  assert.equal(await runCli(["resolve", "--envelope", envFile, "--packs", "--packs-dir", path.join(ROOT, "packs")], a.io), 0, a.out.stderr);
  const b = io();
  assert.equal(await runCli(["resolve", path.join(HERE, "fixtures/ledger.did"), "--packs", "--packs-dir", path.join(ROOT, "packs")], b.io), 0, b.out.stderr);
  assert.equal(a.out.stdout, b.out.stdout);
  const c = io();
  assert.equal(await runCli(["resolve", path.join(HERE, "fixtures/ledger.did"), "--envelope", envFile], c.io), 2);
  assert.match(c.out.stderr, /not both/);
});

test("the CLI refuses a missing or unreadable envelope file with exit 2", async () => {
  const io = () => {
    const out = { stdout: "", stderr: "" };
    return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } } };
  };
  const missing = io();
  assert.equal(await runCli(["resolve", "--envelope", path.join(HERE, "fixtures/envelopes/nope.json")], missing.io), 2);
  assert.match(missing.out.stderr, /envelope/);
  const notJson = io();
  assert.equal(await runCli(["resolve", "--envelope", path.join(HERE, "fixtures/ledger.did")], notJson.io), 2);
  assert.match(notJson.out.stderr, /envelope/);
  assert.equal(missing.out.stdout + notJson.out.stdout, "");
});

