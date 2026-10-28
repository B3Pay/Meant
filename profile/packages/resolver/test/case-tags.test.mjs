// intent and effect on a case of a variant in the arguments (spec sections 5.2, 5.3 and 6, D-053).
import { test } from "node:test";
import assert from "node:assert/strict";
import { interfaceIdOf, canisterProfile, resolve, byCode, errors, node, validateSchema } from "./helpers.mjs";
import { validateProfile } from "../src/index.mjs";

const DID = `
type Action = variant {
  Transfer : record { to : principal; amount : nat };
  AddMember : record { who : principal };
  Pause;
  Nested : variant { A : nat; B : text };
};
type Command = record {
  id : nat;
  command : opt variant { Disburse : record { amount : nat }; Split : nat };
  other : variant { P; Q };
};
service : {
  propose : (Action) -> (nat);
  manage : (Command) -> (nat);
  two : (Action, Action) -> ();
  batch : (vec Action) -> ();
  look : (Action) -> (nat) query;
  status : () -> (variant { Ok; Err });
}
`;
const interfaceId = await interfaceIdOf(DID);
const SEND = { kind: "transfer", irreversible: true };
const ADMIN = { kind: "admin", irreversible: false };
const READ = { kind: "read", irreversible: false };
const intent = (at, title, template = title) => ({ at, tag: "intent", args: { title, template } });
const effect = (at, args) => ({ at, tag: "effect", args });
const run = (...annotations) => resolve(DID, { profiles: [canisterProfile({ interfaceId, annotations })] });

test("intent and effect on a case resolve, and the resolved form carries them on the case node", async () => {
  const r = await run(
    effect("propose", SEND),
    intent("propose", "Propose an action"),
    intent("propose(0).Transfer", "Propose a transfer", "Send {Transfer.amount} to {Transfer.to}"),
    effect("propose(0).Transfer", SEND),
    intent("propose(0).AddMember", "Add a member", "Add {AddMember.who}"),
    effect("propose(0).Pause", ADMIN),
  );
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const arg = r.resolved.methods.propose.args[0];
  assert.deepEqual(node(arg, "Transfer").tags.intent.args, { title: "Propose a transfer", template: "Send {Transfer.amount} to {Transfer.to}" });
  assert.deepEqual(node(arg, "Transfer").tags.effect.args, SEND);
  assert.deepEqual(node(arg, "Pause").tags.effect.args, ADMIN);
  assert.equal(node(arg, "Nested").tags, undefined);
  // The method keeps its own tags: a consumer that reads only those still sees the strongest effect.
  assert.deepEqual(r.resolved.methods.propose.tags.effect.args, SEND);
});

test("the single-profile validator accepts a case address for intent and effect", async () => {
  const doc = canisterProfile({ interfaceId, annotations: [effect("propose", SEND), effect("propose(0).Transfer", SEND), intent("propose(0).Pause", "Pause")] });
  const v = await validateProfile(doc, { validateSchema, did: DID });
  assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
});

test("the schema keeps the other method tags on method addresses", async () => {
  const doc = canisterProfile({ interfaceId, annotations: [{ at: "propose(0).Transfer", tag: "outcome", args: { classes: { Ok: "success" } } }] });
  const v = await validateProfile(doc, { validateSchema, did: DID });
  assert.equal(v.ok, false);
  assert.ok(v.diagnostics.every((d) => d.code === "E_SCHEMA"), JSON.stringify(v.diagnostics));
});

test("intent or effect at a value address that is not a case of an argument is E_TAG_TARGET", async () => {
  for (const [at, why] of [
    ["propose(0).Transfer.amount", /ends on a record field/],
    ["propose(0)", /ends on a whole argument/],
    ["batch(0)[].Transfer", /vector element/],
    ["status->(0).Ok", /not in its results/],
    ["type:Action.Transfer", /type: address/],
  ]) {
    for (const a of [intent(at, "Title"), effect(at, SEND)]) {
      const r = await run(effect("propose", SEND), effect("batch", SEND), a);
      const e = byCode(r, "E_TAG_TARGET");
      assert.equal(e.length, 1, `${a.tag} at ${at}: ${JSON.stringify(r.diagnostics)}`);
      assert.match(e[0].message, why, at);
      assert.equal(errors(r).length, 1, `${a.tag} at ${at}: ${JSON.stringify(r.diagnostics)}`);
    }
  }
});

test("a case effect that needs confirmation under a method effect that does not is E_CASE_EFFECT", async () => {
  // No method effect: an update's default is write.
  let r = await run(effect("propose(0).Transfer", SEND));
  assert.equal(byCode(r, "E_CASE_EFFECT").length, 1, JSON.stringify(r.diagnostics));
  assert.match(byCode(r, "E_CASE_EFFECT")[0].message, /method's effect is write, irreversible \(the default\)/);
  r = await run(effect("propose", { kind: "write", irreversible: true }), effect("propose(0).Transfer", SEND));
  assert.equal(byCode(r, "E_CASE_EFFECT").length, 1, JSON.stringify(r.diagnostics));
  // Any of the four confirmation kinds on the method bounds any of them on a case.
  r = await run(effect("propose", { kind: "admin", irreversible: true }), effect("propose(0).Transfer", SEND));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test("an irreversible case effect under a reversible method effect is E_CASE_EFFECT", async () => {
  const r = await run(effect("propose", ADMIN), effect("propose(0).Transfer", SEND));
  const e = byCode(r, "E_CASE_EFFECT");
  assert.equal(e.length, 1, JSON.stringify(r.diagnostics));
  assert.match(e[0].message, /irreversible/);
});

test("a case effect weaker than its method's is valid", async () => {
  const r = await run(effect("propose", SEND), effect("propose(0).Pause", { kind: "write", irreversible: false }), effect("propose(0).Nested", READ));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  // A read case of an update method gets the same warning a read update method does.
  assert.equal(byCode(r, "W_EFFECT_MODE").length, 1, JSON.stringify(r.diagnostics));
});

test("a case effect is checked against its method's mode", async () => {
  const r = await run(effect("look(0).Transfer", SEND));
  assert.equal(byCode(r, "E_EFFECT_MODE").length, 1, JSON.stringify(r.diagnostics));
  assert.equal(byCode(r, "E_CASE_EFFECT").length, 1, "the query's default effect is a read");
});

test("tagged cases that one value can take both are E_CASE_OVERLAP: parted at a record field or in different arguments", async () => {
  let r = await run(intent("manage(0).command.Disburse", "Disburse"), intent("manage(0).other.P", "P"));
  let e = byCode(r, "E_CASE_OVERLAP");
  assert.equal(e.length, 1, JSON.stringify(r.diagnostics));
  assert.match(e[0].message, /part at a record field/);
  r = await run(intent("two(0).Transfer", "First"), intent("two(1).Pause", "Second"));
  e = byCode(r, "E_CASE_OVERLAP");
  assert.equal(e.length, 1, JSON.stringify(r.diagnostics));
  assert.match(e[0].message, /different arguments/);
});

test("cases of one variant, nested cases and cases with different tags do not overlap", async () => {
  const r = await run(
    effect("propose", SEND),
    intent("propose(0).Transfer", "Transfer"),
    intent("propose(0).AddMember", "Add a member"),
    intent("propose(0).Nested", "Nested"),
    intent("propose(0).Nested.A", "Nested A"),
    effect("manage", SEND),
    intent("manage(0).command.Disburse", "Disburse"),
    effect("manage(0).other.P", READ),
  );
  assert.deepEqual(byCode(r, "E_CASE_OVERLAP"), []);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test("a case template names values from the argument tuple, and a sibling case of a variant on its path is E_TEMPLATE_PATH", async () => {
  let r = await run(intent("manage(0).command.Disburse", "Disburse", "Disburse {command.Disburse.amount} of neuron {id}"));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  r = await run(intent("propose(0).Transfer", "Transfer", "Send {Transfer.amount} and add {AddMember.who}"));
  let e = byCode(r, "E_TEMPLATE_PATH");
  assert.equal(e.length, 1, JSON.stringify(r.diagnostics));
  assert.match(e[0].message, /\{AddMember\.who\}: selects case "AddMember" .* takes "Transfer", so it is never present/);
  r = await run(intent("manage(0).command.Disburse", "Disburse", "Split {command.Split}"));
  e = byCode(r, "E_TEMPLATE_PATH");
  assert.equal(e.length, 1, JSON.stringify(r.diagnostics));
  // Relative to the case, as w9-case-intents.md first proposed, is not the grammar: the path does not resolve.
  r = await run(intent("propose(0).Transfer", "Transfer", "Send {amount}"));
  assert.equal(byCode(r, "E_TEMPLATE_PATH").length, 1, JSON.stringify(r.diagnostics));
});

test("a case template on a method with several arguments uses (i) paths, and another argument is never a sibling case", async () => {
  const r = await run(effect("two", SEND), intent("two(1).Transfer", "Second transfer", "Send {(1).Transfer.amount} after {(0).Transfer.amount}"));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});
