// Names (spec section 5.3, D-045): the names and named tags. The matching rule is tested in packages/format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interfaceIdOf, canisterProfile, resolve, byCode, errors, validateSchema } from "./helpers.mjs";
import { validateProfile } from "../src/index.mjs";

const DID = `
type Kind = variant { Icp; Bitcoin };
type Account = record { id : nat32; label : text; address : text; kind : Kind };
type Member = record { id : principal; label : text };
type Transfer = record { from : nat32; to : text; amount : nat };
service : {
  accounts : () -> (variant { Ok : vec Account; Err : text }) query;
  members : () -> (vec Member) query;
  members_update : () -> (vec Member);
  members_read : () -> (vec Member);
  account : (nat32) -> (opt Account) query;
  count : () -> (nat) query;
  propose : (Transfer) -> ();
  remove : (principal) -> ();
}
`;
const interfaceId = await interfaceIdOf(DID);
const ACCOUNTS = { at: "accounts", tag: "names", args: { set: "account", items: "Ok", name: "label", value: "id", show: "address", kind: "kind" } };
const MEMBERS = { at: "members", tag: "names", args: { set: "member", items: "(0)", name: "label", value: "id" } };

const run = (annotations) => resolve(DID, { profiles: [canisterProfile({ interfaceId, annotations })] });

test("a names set and the positions named by it resolve, and the resolved form carries both", async () => {
  const r = await run([
    ACCOUNTS, MEMBERS,
    { at: "propose(0).from", tag: "named", args: { set: "account" } },
    { at: "propose(0).to", tag: "named", args: { set: "account", by: "show" } },
    { at: "remove(0)", tag: "named", args: { set: "member" } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
  assert.deepEqual(r.resolved.methods.accounts.tags.names.args, ACCOUNTS.args);
  assert.deepEqual(r.resolved.methods.propose.args[0].fields.to.tags.named.args, { set: "account", by: "show" });
});

test("names needs a query or a read-only update without arguments, over a vec of records with a text name", async () => {
  const at = (r, code) => byCode(r, code).map((d) => d.at);
  let r = await run([{ ...MEMBERS, at: "members_update" }]);
  assert.deepEqual(at(r, "E_NAMES_MODE"), ["members_update"]);
  r = await run([
    { ...MEMBERS, at: "members_read" },
    { at: "members_read", tag: "effect", args: { kind: "read", irreversible: false, replicated: true } },
  ]);
  assert.deepEqual(at(r, "E_NAMES_MODE"), [], JSON.stringify(r.diagnostics));
  r = await run([{ ...ACCOUNTS, at: "account", args: { ...ACCOUNTS.args, items: "(0)" } }]);
  assert.deepEqual(at(r, "E_NAMES_SHAPE"), ["account", "account"]); // takes an argument; opt record, not a vec
  r = await run([{ ...MEMBERS, at: "count" }]);
  assert.deepEqual(at(r, "E_NAMES_SHAPE"), ["count"]);
  r = await run([{ ...ACCOUNTS, args: { ...ACCOUNTS.args, name: "id" } }]);
  assert.deepEqual(at(r, "E_NAMES_FIELD"), ["accounts"]);
  r = await run([{ ...ACCOUNTS, args: { ...ACCOUNTS.args, show: "nickname" } }]);
  assert.match(byCode(r, "E_ADDR_UNRESOLVED")[0].message, /names\.show/);
  r = await run([ACCOUNTS, { ...MEMBERS, args: { ...MEMBERS.args, set: "account" } }]);
  assert.deepEqual(at(r, "E_NAMES_SET_DUPLICATE"), ["members"]);
});

test("a named position needs a declared set and the type of the field that fills it", async () => {
  const codes = async (named) => (await run([ACCOUNTS, MEMBERS, named])).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
  assert.deepEqual(await codes({ at: "propose(0).to", tag: "named", args: { set: "contact" } }), ["E_NAMED_SET"]);
  assert.deepEqual(await codes({ at: "propose(0).to", tag: "named", args: { set: "account" } }), ["E_NAMED_TYPE"]); // text, not nat32
  assert.deepEqual(await codes({ at: "propose(0).from", tag: "named", args: { set: "account", by: "show" } }), ["E_NAMED_TYPE"]);
  assert.deepEqual(await codes({ at: "remove(0)", tag: "named", args: { set: "member", by: "show" } }), ["E_NAMED_SET"]); // no show
});

test("the schema requires a set, items, name and value, and limits by and the set's name", async () => {
  const bad = [
    { at: "accounts", tag: "names", args: { set: "account", items: "Ok", name: "label" } },
    { at: "accounts", tag: "names", args: { set: "Account", items: "Ok", name: "label", value: "id" } },
    { at: "propose(0).to", tag: "named", args: { set: "account", by: "label" } },
    { at: "propose(0).to", tag: "named", args: {} },
    { at: "propose(0).to", tag: "names", args: ACCOUNTS.args },
  ];
  for (const annotation of bad) {
    const v = await validateProfile(canisterProfile({ interfaceId, annotations: [annotation] }), { validateSchema, did: DID });
    assert.equal(v.ok, false, JSON.stringify(annotation));
    assert.ok(v.diagnostics.some((d) => d.code === "E_SCHEMA"), JSON.stringify(v.diagnostics));
  }
});

test("a named text position without a text.pattern is W_NAMED_UNPATTERNED, and a pattern clears it", async () => {
  const to = { at: "propose(0).to", tag: "named", args: { set: "account", by: "show" } };
  let r = await run([ACCOUNTS, to]);
  assert.deepEqual(byCode(r, "W_NAMED_UNPATTERNED").map((d) => d.at), ["propose(0).to"]);
  r = await run([ACCOUNTS, to, { at: "propose(0).to", tag: "text", args: { pattern: "^[a-z0-9.-]+$" } }]);
  assert.deepEqual(byCode(r, "W_NAMED_UNPATTERNED"), []);
  assert.equal(r.ok, true, JSON.stringify(errors(r)));
});
