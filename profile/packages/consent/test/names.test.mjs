// Names in consent messages (spec section 5.3, D-045): a `named` position whose value one entry of its set has is
// shown as "name (value)", never the name alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateConsent } from "../src/index.mjs";
import { ALICE, BOB, encodeCall, inspectMarkdown, syntheticResolved, tag } from "./helpers.mjs";

const DID = "service : { send : (record { to : principal; from : nat32 }) -> () }";
const resolved = syntheticResolved(
  "send",
  [
    {
      candid: "record",
      fields: {
        to: { candid: "principal", tags: { describe: tag({ label: "To" }), named: tag({ set: "contact" }) } },
        from: { candid: "nat32", tags: { describe: tag({ label: "From account" }), named: tag({ set: "account" }) } },
      },
    },
  ],
  { intent: tag({ title: "Send", template: "Send to {to} from {from}" }) },
);
const names = {
  contact: [{ name: "Dana `phone`\nnew line", value: ALICE }],
  account: [{ name: "Savings", value: 4 }, { name: "Main", value: 1 }, { name: "Main", value: 1n }],
};
const consent = (to, from, extra = {}) =>
  generateConsent({ resolved, method: "send", arg: encodeCall("send", `(record { to = principal "${to}"; from = ${from} : nat32 })`, DID), names, ...extra });

test("a value with one name shows the name beside it, in both forms", () => {
  const fields = consent(ALICE, 4, { form: "fields" }).message.FieldsDisplayMessage;
  assert.deepEqual(fields.fields, [
    ["To", { Text: { content: `Dana \`phone\` new line (${ALICE})` } }],
    ["From account", { Text: { content: "Savings (4)" } }],
  ]);
  assert.equal(fields.intent, `Send: Send to Dana \`phone\` new line (${ALICE}) from Savings (4)`);
  // The name is text someone chose: in the Markdown form it sits in the value's code span, so nothing in it is parsed.
  const { codes, types } = inspectMarkdown(consent(ALICE, 4).message.GenericDisplayMessage);
  assert.ok(codes.includes(`Dana \`phone\` new line (${ALICE})`), JSON.stringify(codes));
  assert.ok(!types.has("emph") && !types.has("link"), [...types].join(","));
});

test("a value no entry has, or two entries have, is shown alone, as it is without names", () => {
  const fields = (to, from, extra) => consent(to, from, { form: "fields", ...extra }).message.FieldsDisplayMessage.fields;
  assert.deepEqual(fields(BOB, 1), [
    ["To", { Text: { content: BOB } }],
    ["From account", { Text: { content: "1" } }], // "Main" twice: no one name
  ]);
  assert.deepEqual(fields(ALICE, 4, { names: {} }), [
    ["To", { Text: { content: ALICE } }],
    ["From account", { Text: { content: "4" } }],
  ]);
});

test("a variant case with no payload matches an entry that holds it as a bare { tag }", () => {
  const did = "service : { join : (record { role : variant { Viewer; Owner } }) -> () }";
  const roles = syntheticResolved(
    "join",
    [
      {
        candid: "record",
        fields: {
          role: {
            candid: "variant",
            cases: { Viewer: { candid: "null" }, Owner: { candid: "null" } },
            tags: { describe: tag({ label: "Role" }), named: tag({ set: "role" }) },
          },
        },
      },
    ],
    { intent: tag({ title: "Join", template: "Join as {role}" }) },
  );
  const names = { role: [{ name: "Read only", value: { tag: "Viewer" } }] };
  const fields = (role) =>
    generateConsent({ resolved: roles, method: "join", arg: encodeCall("join", `(record { role = variant { ${role} } })`, did), names, form: "fields" })
      .message.FieldsDisplayMessage.fields;
  assert.match(fields("Viewer")[0][1].Text.content, /^Read only \(/);
  assert.doesNotMatch(fields("Owner")[0][1].Text.content, /Read only/);
});

test("a named amount is a Text field with its name, and a TokenAmount without one", () => {
  const did = "service : { pay : (record { from : nat }) -> () }";
  const pay = syntheticResolved(
    "pay",
    [
      {
        candid: "record",
        fields: {
          from: {
            candid: "nat",
            tags: { describe: tag({ label: "From" }), amount: tag({ decimals: 0, symbol: "TOK" }), named: tag({ set: "pot" }) },
          },
        },
      },
    ],
    { intent: tag({ title: "Pay", template: "Pay from {from}" }) },
  );
  const fields = (n) =>
    generateConsent({ resolved: pay, method: "pay", arg: encodeCall("pay", `(record { from = ${n} : nat })`, did), names: { pot: [{ name: "Savings", value: 4n }] }, form: "fields" })
      .message.FieldsDisplayMessage.fields;
  assert.deepEqual(fields(4), [["From", { Text: { content: "Savings (4 TOK)" } }]]);
  assert.deepEqual(fields(5), [["From", { TokenAmount: { decimals: 0, amount: 5n, symbol: "TOK" } }]]);
});

test("a named record with no template is one field with its name, and its parts without one", () => {
  const did = "service : { use : (record { pot : record { id : nat32 } }) -> () }";
  const use = syntheticResolved("use", [
    {
      candid: "record",
      fields: {
        pot: {
          candid: "record",
          fields: { id: { candid: "nat32", tags: { describe: tag({ label: "Id" }) } } },
          tags: { describe: tag({ label: "Pot" }), named: tag({ set: "pot" }) },
        },
      },
    },
  ]);
  const fields = (id) =>
    generateConsent({ resolved: use, method: "use", arg: encodeCall("use", `(record { pot = record { id = ${id} : nat32 } })`, did), names: { pot: [{ name: "Savings", value: { id: 4 } }] }, form: "fields" })
      .message.FieldsDisplayMessage.fields;
  assert.deepEqual(fields(4), [["Pot", { Text: { content: "Savings (record { id = 4 })" } }]]);
  assert.deepEqual(fields(5), [["Id", { Text: { content: "5" } }]]);
});
