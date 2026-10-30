import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAccount } from "@meantjs/format";
import { generateConsent } from "../src/consent.mjs";
import { ConsentError } from "../src/errors.mjs";
import { ALICE, BOB, LEDGERS, SPENDER, encodeCall, icrc1, icrc2, refsFor, subaccountText, syntheticResolved, tag, inspectMarkdown as inspect } from "./helpers.mjs";

const TKA = refsFor(LEDGERS.TKA);
const TKB = refsFor(LEDGERS.TKB);
const TKC = refsFor(LEDGERS.TKC);

const transferArgs = ({ to = `record { owner = principal "${ALICE}"; subaccount = null }`, amount = "29_000_000 : nat", memo = "null", fee = "null", from = "null", at = "null" } = {}) =>
  `(record { to = ${to}; amount = ${amount}; memo = ${memo}; fee = ${fee}; from_subaccount = ${from}; created_at_time = ${at} })`;

function transfer(args, { refs = TKA, form = "generic", ...rest } = {}) {
  return generateConsent({ resolved: icrc1, method: "icrc1_transfer", arg: encodeCall("icrc1_transfer", args), refs, form, ...rest });
}
const generic = (r) => r.message.GenericDisplayMessage;
const fields = (r) => r.message.FieldsDisplayMessage;

test("transfer, 0.29 TKA to Alice, both forms, written out", () => {
  const args = transferArgs();
  assert.equal(
    generic(transfer(args)),
    [
      "# Send tokens",
      "",
      `Send \`0.29 TKA\` to \`${ALICE}\``,
      "",
      "- **Amount:** `0.29 TKA`",
      "- **Recipient:** `" + ALICE + "`",
    ].join("\n"),
  );
  assert.deepEqual(fields(transfer(args, { form: "fields" })), {
    intent: `Send tokens: Send 0.29 TKA to ${ALICE}`,
    fields: [
      ["Amount", { TokenAmount: { decimals: 8, amount: 29000000n, symbol: "TKA" } }],
      ["Recipient", { Text: { content: ALICE } }],
    ],
  });
});

test("transfer: optional segments appear exactly when their values are present, in template order", () => {
  const full = transfer(
    transferArgs({ to: `record { owner = principal "${BOB}"; subaccount = opt ${subaccountText(7)} }`, memo: `opt blob "rent"`, fee: "opt (10_000 : nat)", from: `opt ${subaccountText(1)}`, at: "opt (1_791_547_200_000_000_000 : nat64)" }),
    { form: "fields" },
  );
  const bobSeven = displayAccount({ owner: BOB, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)) });
  assert.match(bobSeven, /\.7$/);
  assert.equal(fields(full).intent, `Send tokens: Send 0.29 TKA to ${bobSeven} from subaccount #1 with memo rent paying fee 0.0001 TKA`);
  assert.deepEqual(fields(full).fields.map(([label]) => label), ["Amount", "Recipient", "From subaccount", "Memo", "Fee"]);
  assert.deepEqual(fields(full).fields[4], ["Fee", { TokenAmount: { decimals: 8, amount: 10000n, symbol: "TKA" } }]);

  const bare = transfer(transferArgs({ memo: `opt blob "x"` }), { form: "fields" });
  assert.equal(fields(bare).intent, `Send tokens: Send 0.29 TKA to ${ALICE} with memo x`);
  assert.deepEqual(fields(bare).fields.map(([label]) => label), ["Amount", "Recipient", "Memo"]);
});

test("transfer: created_at_time is the idempotency stamp; it is not part of the message", () => {
  const withStamp = generic(transfer(transferArgs({ at: "opt (1_791_547_200_000_000_000 : nat64)" })));
  const without = generic(transfer(transferArgs()));
  assert.equal(withStamp, without);
});

test("amounts: exact for every decimals, trailing zeros removed, never rounded", () => {
  const cases = [
    [TKA, "1 : nat", "0.00000001 TKA"],
    [TKA, "100_000_000 : nat", "1 TKA"],
    [TKA, "150_000_000 : nat", "1.5 TKA"],
    [TKA, "0 : nat", "0 TKA"],
    [TKB, "1 : nat", "0.000001 TKB"],
    [TKB, "2_750_000 : nat", "2.75 TKB"],
    [TKC, "1 : nat", "0.000000000000000001 TKC"],
    [TKC, "123_456_789_012_345_678 : nat", "0.123456789012345678 TKC"],
    [TKC, "18_446_744_073_709_551_616 : nat", "18.446744073709551616 TKC"],
    [TKC, "123_456_789_012_345_678_901_234_567_890 : nat", "123456789012.34567890123456789 TKC"],
  ];
  for (const [refs, amount, shown] of cases) {
    const g = generic(transfer(transferArgs({ amount }), { refs }));
    assert.ok(g.includes(`- **Amount:** \`${shown}\``), `${amount} on ${refs["query:icrc1_symbol"]}: ${g}`);
  }
});

test("memo: valid UTF-8 shows as text; anything the formatter will not show as text shows as 0x hex", () => {
  const memoLine = (bytes) => fields(transfer(transferArgs({ memo: `opt blob "${bytes}"` }), { form: "fields" })).fields.find(([l]) => l === "Memo")[1].Text.content;
  assert.equal(memoLine("invoice 42"), "invoice 42");
  assert.equal(memoLine("\\ff\\fe"), "0xfffe", "not UTF-8");
  assert.equal(memoLine("a\\0ab"), "0x610a62", "a newline is a control character");
  assert.equal(memoLine("0xabc"), "0x3078616263", "text that starts with 0x is shown as hex so it cannot pass for hex");
  assert.equal(memoLine("\\e2\\80\\ae"), "0xe280ae", "a bidi override is a format character");
});

test("memo: a Markdown-hostile memo renders as one code span in the generic form (CommonMark reference parser)", () => {
  const memo = "[Approve](https://evil.example) **now** <script>x</script> `tick` &amp;";
  const g = generic(transfer(transferArgs({ memo: `opt blob "${memo.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` })));
  const { types, codes, html } = inspect(g);
  assert.ok(!types.has("link") && !types.has("image") && !types.has("html_inline") && !types.has("html_block"), [...types].join());
  assert.equal(codes.filter((c) => c === memo).length, 2, "the memo appears verbatim in the sentence and in the list, each inside code");
  assert.doesNotMatch(html.replace(/<code>[\s\S]*?<\/code>/g, ""), /<(a|img|script)\b/);
});

test("memo: the fields form is plain text, so the hostile memo is shown as it is, unescaped", () => {
  const memo = "[Approve](https://evil.example) **now**";
  const r = transfer(transferArgs({ memo: `opt blob "${memo}"` }), { form: "fields" });
  assert.ok(fields(r).intent.endsWith(`with memo ${memo}`));
  assert.deepEqual(fields(r).fields.at(-1), ["Memo", { Text: { content: memo } }]);
});

test("template escapes: {{ }} [[ ]] are literal braces and brackets", () => {
  const resolved = syntheticResolved("note", [{ candid: "record", fields: { text: { candid: "text" } } }], {
    intent: tag({ title: "Note", template: "Set {{text}} to [[{text}]][ and {text}]" }),
  });
  const arg = encodeCall("note", `(record { text = "hi" })`, `service : { note : (record { text : text }) -> () }`);
  assert.equal(fields(generateConsent({ resolved, method: "note", arg, form: "fields" })).intent, 'Note: Set {text} to [ "hi" ] and "hi"'.replace('[ "hi" ]', '["hi"]').replace(" ] ", "] "));
});

test("template: an absent placeholder outside [ ] reads (none), it is not invented", () => {
  const resolved = syntheticResolved("note", [{ candid: "record", fields: { text: { candid: "text", optional: true } } }], {
    intent: tag({ title: "Note", template: "Say {text}" }),
  });
  const arg = encodeCall("note", `(record { text = null })`, `service : { note : (record { text : opt text }) -> () }`);
  const f = fields(generateConsent({ resolved, method: "note", arg, form: "fields" }));
  assert.equal(f.intent, "Note: Say (none)");
  assert.deepEqual(f.fields, [["text", { Text: { content: "(none)" } }]]);
  assert.equal(generic(generateConsent({ resolved, method: "note", arg, form: "generic" })).includes("*(none)*"), true);
});

test("template: a broken template falls back to the generic intent and says so", () => {
  const resolved = syntheticResolved("pay", [{ candid: "record", fields: { amount: { candid: "nat" } } }], {
    intent: tag({ title: "Pay", template: "Pay {amount" }),
  });
  const arg = encodeCall("pay", `(record { amount = 5 })`, `service : { pay : (record { amount : nat }) -> () }`);
  const r = generateConsent({ resolved, method: "pay", arg, form: "fields" });
  assert.equal(fields(r).intent, "Pay");
  assert.deepEqual(fields(r).fields, [["amount", { Text: { content: "5" } }]]);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["W_TEMPLATE_FALLBACK"]);
});

test("template: a placeholder the method lacks drops its optional segment, and outside one falls back", () => {
  const node = [{ candid: "record", fields: { amount: { candid: "nat" } } }];
  const did = `service : { pay : (record { amount : nat }) -> () }`;
  const arg = encodeCall("pay", `(record { amount = 5 })`, did);
  const inside = syntheticResolved("pay", node, { intent: tag({ title: "Pay", template: "Pay {amount}[ memo {memo}]" }) });
  assert.equal(fields(generateConsent({ resolved: inside, method: "pay", arg, form: "fields" })).intent, "Pay: Pay 5");
  const outside = syntheticResolved("pay", node, { intent: tag({ title: "Pay", template: "Pay {amount} memo {memo}" }) });
  const r = generateConsent({ resolved: outside, method: "pay", arg, form: "fields" });
  assert.equal(fields(r).intent, "Pay");
  assert.equal(r.diagnostics[0].code, "W_TEMPLATE_FALLBACK");
});

test("template: one that renders as empty text leaves the title alone, with no paragraph (spec section 12 rule 1)", () => {
  const resolved = syntheticResolved("note", [{ candid: "record", fields: { text: { candid: "text", optional: true } } }], {
    intent: tag({ title: "Note", template: "[Say {text}]" }),
  });
  const arg = encodeCall("note", `(record { text = null })`, `service : { note : (record { text : opt text }) -> () }`);
  assert.deepEqual(fields(generateConsent({ resolved, method: "note", arg, form: "fields" })), { intent: "Note", fields: [] });
  const r = generateConsent({ resolved, method: "note", arg, form: "generic" });
  assert.equal(generic(r), "# Note");
  assert.deepEqual(r.diagnostics, []);
});

test("generic intent: a method without an intent tag uses describe.label or the method name, and lists its arguments", () => {
  const balanceArgs = `(record { owner = principal "${ALICE}"; subaccount = opt ${subaccountText(2)} })`;
  const labelled = generateConsent({ resolved: icrc1, method: "icrc1_balance_of", arg: encodeCall("icrc1_balance_of", balanceArgs), refs: TKA, form: "generic" });
  assert.equal(generic(labelled), ["# Balance of an account", "", `- **Argument 1:** \`${displayAccount({ owner: ALICE, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 2 : 0)) })}\``].join("\n"));

  const fieldsForm = generateConsent({ resolved: icrc1, method: "icrc1_balance_of", arg: encodeCall("icrc1_balance_of", balanceArgs), refs: TKA, form: "fields" });
  assert.equal(fields(fieldsForm).intent, "Balance of an account");

  const none = generateConsent({ resolved: icrc1, method: "icrc1_decimals", arg: encodeCall("icrc1_decimals", "()"), form: "generic" });
  assert.equal(generic(none), "# Call icrc1_decimals\n\nThis call has no arguments.");
  assert.deepEqual(fields(generateConsent({ resolved: icrc1, method: "icrc1_decimals", arg: encodeCall("icrc1_decimals", "()"), form: "fields" })), { intent: "Call icrc1_decimals", fields: [] });
});

test("generic intent: records are flattened, absent optionals are left out, tagged positions are single rows", () => {
  const resolved = syntheticResolved("send", [
    {
      candid: "record",
      fields: {
        to: { candid: "principal" },
        note: { candid: "text", optional: true },
        gone: { candid: "text", optional: true },
        nested: { candid: "record", fields: { n: { candid: "nat64" }, tags: { candid: "vec", element: { candid: "text" } } } },
        choice: { candid: "variant", cases: { Fast: { candid: "null" }, Slow: { candid: "nat" } } },
        amount: { candid: "nat", tags: { amount: tag({ decimals: 2, symbol: "USD" }), describe: tag({ label: "Price" }) } },
      },
    },
  ]);
  const did = `service : { send : (record { to : principal; note : opt text; gone : opt text; nested : record { n : nat64; tags : vec text }; choice : variant { Fast; Slow : nat }; amount : nat }) -> () }`;
  const arg = encodeCall("send", `(record { to = principal "${SPENDER}"; note = opt "hello"; gone = null; nested = record { n = 7; tags = vec { "a"; "b" } }; choice = variant { Slow = 3 }; amount = 12_345 })`, did);
  const g = generic(generateConsent({ resolved, method: "send", arg, form: "generic" }));
  assert.equal(
    g,
    [
      "# Call send",
      "",
      `- **to:** \`${SPENDER}\``,
      '- **note:** `"hello"`',
      "- **nested.n:** `7`",
      '- **nested.tags:** `vec { "a"; "b" }`',
      "- **choice:** `variant { Slow = 3 }`",
      "- **Price:** `123.45 USD`",
    ].join("\n"),
  );
});

test("untagged values are Candid text: text quoted and escaped, blobs as escapes, floats and nulls", () => {
  const resolved = syntheticResolved("f", [{ candid: "text" }, { candid: "blob" }, { candid: "float64" }, { candid: "null" }, { candid: "bool" }]);
  const arg = encodeCall("f", `("a \\"q\\" \\\\ b\\n", blob "\\de\\ad", 2.5, null, true)`, `service : { f : (text, blob, float64, null, bool) -> () }`);
  const f = fields(generateConsent({ resolved, method: "f", arg, form: "fields" }));
  assert.deepEqual(f.fields.map(([l, v]) => [l, v.Text.content]), [
    ["Argument 1", '"a \\"q\\" \\\\ b\\n"'],
    ["Argument 2", 'blob "\\de\\ad"'],
    ["Argument 3", "2.5"],
    ["Argument 4", "null"],
    ["Argument 5", "true"],
  ]);
});

test("tagged children inside an untagged composite use their formatter", () => {
  const resolved = syntheticResolved(
    "f",
    [{ candid: "record", fields: { price: { candid: "nat", tags: { amount: tag({ decimals: 2, symbol: "EUR" }) } }, who: { candid: "principal" } } }],
    { intent: tag({ title: "Order", template: "Place {(0)}" }) },
  );
  const arg = encodeCall("f", `(record { price = 1050; who = principal "aaaaa-aa" })`, `service : { f : (record { price : nat; who : principal }) -> () }`);
  const f = fields(generateConsent({ resolved, method: "f", arg, form: "fields" }));
  assert.equal(f.intent, 'Order: Place record { price = 10.5 EUR; who = principal "aaaaa-aa" }');
});

test("absent values are never described: no default fee, no balance, nothing about state", () => {
  const g = generic(transfer(transferArgs()));
  assert.doesNotMatch(g, /fee|balance|available|remaining|after/i);
  const approve = generateConsent({ resolved: icrc2, method: "icrc2_approve", arg: encodeCall("icrc2_approve", `(record { spender = record { owner = principal "${SPENDER}"; subaccount = null }; amount = 5 : nat; expires_at = null; expected_allowance = null; memo = null; fee = null; from_subaccount = null; created_at_time = null })`), refs: TKA });
  assert.doesNotMatch(generic(approve), /balance|available|remaining/i);
});

test("a dynamic ref the caller did not supply stops the message (E_REF_UNRESOLVED); nothing is shown without its decimals", () => {
  assert.throws(() => transfer(transferArgs(), { refs: {} }), (e) => e instanceof ConsentError && e.code === "E_REF_UNRESOLVED");
  assert.throws(() => transfer(transferArgs(), { refs: { "query:icrc1_decimals": 8 } }), (e) => e.code === "E_REF_UNRESOLVED");
});

test("a formatter that refuses a value falls back to raw Candid text, with a diagnostic", () => {
  const r = transfer(transferArgs({ to: `record { owner = principal "${ALICE}"; subaccount = opt blob "\\01\\02" }` }), { form: "fields" });
  assert.equal(fields(r).fields[1][1].Text.content, `record { owner = principal "${ALICE}"; subaccount = opt blob "\\01\\02" }`);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["W_FORMAT_FALLBACK"]);
  assert.match(r.diagnostics[0].message, /E_LENGTH/);
});

test("invisible characters in untagged text are shown, not passed through", () => {
  const resolved = syntheticResolved("f", [{ candid: "text" }]);
  const arg = encodeCall("f", `("pay\\u{202e}gnp.exe\\u{0}")`, `service : { f : (text) -> () }`);
  const f = fields(generateConsent({ resolved, method: "f", arg, form: "fields" }));
  assert.equal(f.fields[0][1].Text.content, '"pay\\u{202e}gnp.exe\\u{0}"');
});

test("raw arguments (spec section 11 item 1) are appended on request, both forms", () => {
  const args = transferArgs({ memo: `opt blob "x"` });
  const f = fields(transfer(args, { form: "fields", rawArguments: true }));
  assert.equal(f.fields.at(-1)[0], "Raw arguments");
  assert.match(f.fields.at(-1)[1].Text.content, /^\(record \{ to = /);
  const g = generic(transfer(args, { rawArguments: true }));
  assert.match(g, /\*\*Raw arguments:\*\*\n\n```\n\(record \{ to = .*\)\n```$/);
  const { types } = inspect(g);
  assert.ok(types.has("code_block"));
});

test("limits: more fields or more list elements than a person can read is refused, never truncated", () => {
  const manyFields = {};
  for (let i = 0; i < 70; i++) manyFields[`f${i}`] = { candid: "nat" };
  const resolved = syntheticResolved("f", [{ candid: "record", fields: manyFields }]);
  const arg = encodeCall("f", `(record { ${Object.keys(manyFields).map((k) => `${k} = 1`).join("; ")} })`, `service : { f : (record { ${Object.keys(manyFields).map((k) => `${k} : nat`).join("; ")} }) -> () }`);
  assert.throws(() => generateConsent({ resolved, method: "f", arg }), (e) => e.code === "E_TOO_LARGE");
  const vec = syntheticResolved("g", [{ candid: "vec", element: { candid: "nat" } }], { intent: tag({ title: "Many", template: "Do {(0)[]}" }) });
  const longArg = encodeCall("g", `(vec { ${Array.from({ length: 300 }, () => "1").join("; ")} })`, `service : { g : (vec nat) -> () }`);
  assert.throws(() => generateConsent({ resolved: vec, method: "g", arg: longArg }), (e) => e.code === "E_TOO_LARGE");
});

test("a placeholder over a list shows every element, joined, in one row", () => {
  const vec = syntheticResolved("g", [{ candid: "record", fields: { ids: { candid: "vec", element: { candid: "nat" } } } }], { intent: tag({ title: "Many", template: "Close {ids[]}" }) });
  const arg = encodeCall("g", `(record { ids = vec { 1; 2; 3 } })`, `service : { g : (record { ids : vec nat }) -> () }`);
  const f = fields(generateConsent({ resolved: vec, method: "g", arg, form: "fields" }));
  assert.equal(f.intent, "Many: Close 1, 2, 3");
  assert.deepEqual(f.fields, [["ids", { Text: { content: "1, 2, 3" } }]]);
  assert.equal(generic(generateConsent({ resolved: vec, method: "g", arg, form: "generic" })).split("\n")[2], "Close `1`, `2`, `3`");
});

test("generic intent: ui.order puts ordered fields first, ascending; the rest keep the resolved form's order", () => {
  const resolved = syntheticResolved("f", [
    { candid: "record", fields: { a: { candid: "nat" }, b: { candid: "nat", tags: { ui: tag({ order: 2 }) } }, c: { candid: "nat", tags: { ui: tag({ order: 1 }) } }, d: { candid: "nat" } } },
  ]);
  const arg = encodeCall("f", `(record { a = 1; b = 2; c = 3; d = 4 })`, `service : { f : (record { a : nat; b : nat; c : nat; d : nat }) -> () }`);
  const f = fields(generateConsent({ resolved, method: "f", arg, form: "fields" }));
  assert.deepEqual(f.fields.map(([l]) => l), ["c", "b", "a", "d"]);
});

test("principals: bare canonical text at the top level, `principal \"...\"` inside a composite", () => {
  const resolved = syntheticResolved("f", [{ candid: "principal" }, { candid: "record", fields: { p: { candid: "principal" } } }], { intent: tag({ title: "T", template: "To {(0)} and {(1)}" }) });
  const arg = encodeCall("f", `(principal "aaaaa-aa", record { p = principal "aaaaa-aa" })`, `service : { f : (principal, record { p : principal }) -> () }`);
  assert.equal(fields(generateConsent({ resolved, method: "f", arg, form: "fields" })).intent, 'T: To aaaaa-aa and record { p = principal "aaaaa-aa" }');
});
