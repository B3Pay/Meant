// D-060: the get_api_doc text rendered from a resolved form (proposals/w0-icp-mcp.md).
// Goldens: UPDATE_GOLDENS=1 node --test packages/resolver/test/api-doc.test.mjs, then review the diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ApiDocError, renderApiDoc, resolveService, createSchemaValidator, loadPacks } from "../src/index.mjs";
import { HERE, readJson } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = path.join(HERE, "../bin/meant-profile.mjs");
const LEDGER = path.join(HERE, "fixtures/ledger.did");
const GOLDEN = path.join(HERE, "fixtures/api-doc");
const LEDGER_REFS = { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" };

async function ledgerResolved() {
  const validateSchema = await createSchemaValidator();
  const packs = (await loadPacks()).map((p) => ({ doc: p.doc, label: path.basename(p.file) }));
  const r = await resolveService({ did: await readFile(LEDGER, "utf8"), didLabel: "ledger.did", validateSchema, profiles: [], packs });
  assert.equal(r.ok, true);
  return r.resolved;
}

async function golden(name, text) {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDENS === "1") await writeFile(file, text);
  assert.equal(text, await readFile(file, "utf8"), `${name} differs; regenerate with UPDATE_GOLDENS=1 and review the diff`);
}

/** A resolved form with one method, for the sentences the packs do not reach. */
function form(method, extra = {}) {
  return {
    format: "candid-profile-resolved",
    format_version: 0,
    interface_id: "candid-core:interface:v1:sha256:00",
    profiles: [{ name: "t", origin: "author", profile_id: "candid-profile:v0:sha256:00" }],
    methods: { m: { mode: "update", args: [], results: [], ...method } },
    diagnostics: [],
    ...extra,
  };
}
const tag = (args) => ({ args, origin: "author", profile: "t" });

test("golden: the ICP ledger's .did with both packs and its decimals and symbol", async () => {
  await golden("ledger.md", renderApiDoc(await ledgerResolved(), { refs: LEDGER_REFS, title: "ICP ledger" }));
});

test("golden: the example canister profile, without refs", async () => {
  await golden("tokens-example.md", renderApiDoc(await readJson("fixtures/tokens-example.resolved.json")));
});

test("deterministic: the same bytes twice, and method order in the input does not matter", async () => {
  const r = await ledgerResolved();
  const reversed = { ...r, methods: Object.fromEntries(Object.entries(r.methods).reverse()) };
  assert.equal(renderApiDoc(r, { refs: LEDGER_REFS }), renderApiDoc(reversed, { refs: LEDGER_REFS }));
});

test("a dynamic reference without a value says what to ask the canister for", async () => {
  const text = renderApiDoc(await readJson("fixtures/icrc1.resolved.json"));
  assert.match(text, /an amount of the token \(symbol: what `icrc1_symbol` returns\) in base units \(decimals: what `icrc1_decimals` returns\)/);
});

test("transfer, approve, admin and destroy ask for a confirmation; read and write do not", () => {
  for (const kind of ["transfer", "approve", "admin", "destroy"]) {
    const text = renderApiDoc(form({ tags: { effect: tag({ kind, irreversible: true }) } }));
    assert.match(text, /\*\*ask the person to confirm before you call it\*\*/, kind);
    assert.match(text, /Ask the person to confirm before any call marked so below \(`m`\)/, kind);
  }
  for (const kind of ["read", "write"]) {
    const text = renderApiDoc(form({ tags: { effect: tag({ kind, irreversible: false }) } }));
    assert.doesNotMatch(text, /confirm/, kind);
  }
});

test("an update without an effect is a write, irreversible, and is not retried after an unknown outcome", () => {
  const text = renderApiDoc(form({}));
  assert.match(text, /Effect: `write`, irreversible\./);
  assert.match(text, /An update without an idempotency stamp \(`m`\) whose outcome is unknown/);
});

test("a read-only update is called as an update", () => {
  const text = renderApiDoc(form({ tags: { effect: tag({ kind: "read", irreversible: false, replicated: true }) } }));
  assert.match(text, /call it as an update, not a query, so that its answer is certified/);
  assert.doesNotMatch(text, /without an idempotency stamp/);
});

test("the experimental tags and display arguments have sentences", () => {
  const r = form(
      {
        tags: { list: tag({ cursor: "start", next: "next", items: "items" }) },
        args: [
          {
            candid: "record",
            fields: {
              start: { candid: "nat", tags: { range: tag({ min: "1", max: "100" }) } },
              note: { candid: "text", tags: { text: tag({ format: "url", max_len: 200, pattern: "^https://" }) } },
              wait: { candid: "nat64", tags: { duration: tag({ unit: "s" }) } },
              until: { candid: "nat64", tags: { timestamp: tag({ unit: "s", labels: { "0": "never" }, threshold: "99", message: "far away" }) } },
              who: { candid: "principal", tags: { named: tag({ set: "contacts" }) } },
              shown: { candid: "text", tags: { named: tag({ set: "contacts", by: "show" }) } },
              cap: { candid: "nat", tags: { amount: tag({ decimals: 2, symbol: "X", threshold: "1000", message: "No cap" }) } },
            },
          },
        ],
      },
      {},
    );
  r.methods.contacts = { mode: "query", tags: { names: tag({ set: "contacts", items: "Ok", name: "label", value: "id", show: "address", kind: "kind" }) }, args: [], results: [] };
  const text = renderApiDoc(r);
  assert.match(text, /from `1` to `100`/);
  assert.match(text, /an http or https URL; at most 200 characters; matching the regular expression `\^https:\/\/`/);
  assert.match(text, /a length of time, in seconds/);
  assert.match(text, /`0` means never; a value of `99` or more means far away/);
  assert.match(text, /a value of `1000` or more means No cap/);
  assert.match(text, /Paged: the items are at `items`; pass the result's `next` as `start`/);
  // by: "value" and by: "show" name different fields of the entry (review finding on #83)
  assert.match(text, /`m\(0\)\.who`: a name the person uses may stand for this value: find the one entry with that name in `contacts` and send its `id` here/);
  assert.match(text, /`m\(0\)\.shown`: a name the person uses may stand for this value: find the one entry with that name in `contacts` and send its `address` here/);
  assert.match(text, /Lists the names of the set `contacts`: the entries are the elements of `Ok`; in each, `label` is the name; `id` the value it stands for; `address` what to show beside the name; `kind` its kind/);
  assert.match(text, /\*\*Names:\*\* a name stands for a value only when exactly one entry/);
});

test("strict: what the renderer has no sentence for throws, and nothing is written", () => {
  const cases = [
    form({ tags: { effect: tag({ kind: "mint", irreversible: true }) } }),
    form({ tags: { brand_new: tag({}) } }),
    form({ tags: { effect: tag({ kind: "write", irreversible: true, colour: "red" }) } }),
    form({ args: [{ candid: "nat", tags: { amount: tag({ decimals: 8, token: "0x00" }) } }] }),
    form({ args: [{ candid: "blob", tags: { bytes: tag({ encoding: "base58" }) } }] }),
    form({ args: [{ candid: "nat64", tags: { timestamp: tag({ unit: "min" }) } }] }),
    form({ args: [{ candid: "nat", tags: { default: tag({ value: { from: "block_height" }, mode: "auto" }) } }] }),
    form({ args: [{ candid: "principal", tags: { named: tag({ set: "nobody_lists_it" }) } }] }),
    form(
      { args: [{ candid: "text", tags: { named: tag({ set: "s", by: "show" }) } }] },
      { methods: { m: { mode: "update", args: [{ candid: "text", tags: { named: tag({ set: "s", by: "show" }) } }], results: [] }, l: { mode: "query", tags: { names: tag({ set: "s", items: "", name: "n", value: "v" }) }, args: [], results: [] } } },
    ),
    form({ tags: { outcome: tag({ classes: { Ok: "fine" } }) } }),
  ];
  for (const r of cases) assert.throws(() => renderApiDoc(r), ApiDocError, JSON.stringify(r.methods.m));
});

test("only an Internet Computer resolved form without errors is rendered", async () => {
  const evm = await readJson("fixtures/erc20.resolved.json");
  assert.throws(() => renderApiDoc(evm), /chain "evm" has no get_api_doc/);
  assert.throws(() => renderApiDoc(form({}, { diagnostics: [{ severity: "error", code: "E_X", at: "m", message: "" }] })), /has errors/);
  assert.throws(() => renderApiDoc({ format: "something-else" }), TypeError);
  assert.throws(() => renderApiDoc(form({}), { refs: [] }), TypeError);
});

test("a grant says when it ends: its ends, never for an approve, when it is made for a transfer", () => {
  const grantForm = (kind, grant) => form({ tags: { effect: tag({ kind, irreversible: true, grant }) } });
  assert.match(renderApiDoc(grantForm("transfer", { to: "to", amount: "amount" })), /Grants the recipient at `to` up to the amount at `amount`, once: the grant ends when the transfer is made\./);
  assert.match(renderApiDoc(grantForm("approve", { spender: "spender", amount: "amount" })), /up to the amount at `amount`, with no end\./);
  assert.match(renderApiDoc(grantForm("approve", { spender: "spender", amount: "amount", ends: ["expires_at"] })), /until the latest of `expires_at`\./);
});

test("author text cannot add a link, emphasis, a strikethrough, an entity or a line; literals keep their backticks", () => {
  const text = renderApiDoc(
    form({ tags: { describe: tag({ label: "Pay [here](https://evil.example) *now*", help: "line one\n# not a heading" }), intent: tag({ title: "T", template: "Send `{amount}`" }) } }),
    { title: "A | B" },
  );
  assert.match(text, /^# A \\\| B$/m);
  assert.match(text, /Pay \\\[here\\\]\(https:\/\/evil\.example\) \\\*now\\\*\. line one \\# not a heading/);
  assert.doesNotMatch(text, /^# not a heading/m);
  assert.match(text, /Template: `` Send `\{amount\}` ``/);
  // review on B3Pay/Meant#321: `~` and `&`, as the consent package escapes them
  const more = renderApiDoc(form({ tags: { describe: tag({ label: "~~private~~ &copy; &#169;" }) } }));
  assert.match(more, /\\~\\~private\\~\\~ \\&copy; \\&\\#169;\./);
});

async function cli(...args) {
  try {
    const { stdout, stderr } = await run("node", [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("cli: api-doc prints the same text, takes refs as JSON or text, and refuses what it cannot write", async () => {
  const ok = await cli("api-doc", LEDGER, "--packs", "--quiet", "--ref", "query:icrc1_decimals=8", "--ref", "query:icrc1_symbol=ICP", "--title", "ICP ledger");
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, await readFile(path.join(GOLDEN, "ledger.md"), "utf8"));

  const twice = await cli("api-doc", LEDGER, "--ref", "a=1", "--ref", "a=2");
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--ref a is given twice/);
  assert.equal((await cli("api-doc", "--abi", LEDGER)).code, 2);
  assert.equal((await cli("resolve", LEDGER, "--title", "x")).code, 2);

  const dir = await mkdtemp(path.join(tmpdir(), "cp-"));
  const bad = path.join(dir, "bad.profile.json");
  await writeFile(bad, JSON.stringify({ profile: "candid-profile/v0", kind: "canister" }));
  const refused = await cli("api-doc", LEDGER, "--profile", bad);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /no api-doc: the profiles have errors/);
});
