// An outcome for a result that is not a variant (spec 5.3, D-049): `classes` may be left out, and `default` is then
// the class of every reply. The schema needs one of the two; a variant result with `default` alone is unclassified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileInterface, resolveService } from "../src/index.mjs";
import { validateSchema } from "./helpers.mjs";

const DID = `
type Ticket = record { id : nat64; amount : nat64 };
service : {
  open_ticket : (record { amount : nat64 }) -> (record { ticket : opt Ticket });
  refresh : () -> ();
  claim : (nat64) -> (variant { Ok : nat64; Err : text });
}`;
const ID = (await compileInterface(DID)).iface.interfaceId;
const profile = (annotations) => ({
  format: "candid-profile", format_version: 0, kind: "canister", name: "outcomes", origin: "author", language: "en",
  binds: { interface_id: ID },
  annotations,
});
const resolve = (annotations) => resolveService({ did: DID, validateSchema, profiles: [{ doc: profile(annotations) }] });
const codes = (r, severity) => r.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

test("a record result and an empty result take an outcome with default alone", async () => {
  const r = await resolve([
    { at: "open_ticket", tag: "outcome", args: { default: "success" } },
    { at: "refresh", tag: "outcome", args: { default: "success" } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== "info"), []);
  assert.deepEqual(r.resolved.methods.open_ticket.tags.outcome.args, { default: "success" }, "no classes are made up");
  assert.deepEqual(r.resolved.methods.refresh.tags.outcome.args, { default: "success" });
});

test("the schema needs classes, default or both", async () => {
  const r = await resolve([{ at: "open_ticket", tag: "outcome", args: {} }]);
  assert.equal(r.ok, false);
  assert.deepEqual([...new Set(codes(r, "error"))], ["E_SCHEMA"]);
});

test("a variant result with default alone leaves every case to the default, at info level", async () => {
  const r = await resolve([{ at: "claim", tag: "outcome", args: { default: "fail" } }]);
  assert.equal(r.ok, true);
  const unclassified = r.diagnostics.filter((d) => d.code === "W_OUTCOME_UNCLASSIFIED");
  assert.deepEqual(unclassified.map((d) => [d.severity, d.message]), [
    ["info", 'result case "Ok" has no class (falls back to default)'],
    ["info", 'result case "Err" has no class (falls back to default)'],
  ]);
});

test("keys still have to select variant cases", async () => {
  const r = await resolve([{ at: "open_ticket", tag: "outcome", args: { classes: { ticket: "success" }, default: "success" } }]);
  assert.deepEqual(codes(r, "error"), ["E_OUTCOME_NOT_CASE"]);
});
