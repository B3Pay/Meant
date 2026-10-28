// Runs inside the scratch consumer that check.mjs builds: the library packages are installed there from their packed
// tarballs, with no workspace links and no repository next to them, exactly as an app would install them from npm.
// Every import below goes through the consumer's node_modules. Fixtures sit next to this file (check.mjs copies them).
// check.mjs runs it with code generation from strings disabled, as a page whose Content-Security-Policy has no
// 'unsafe-eval' would: everything here runs without eval or `new Function`, the resolver on its precompiled schema.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const PACKAGES = JSON.parse(readFileSync("packages.json", "utf8"));
const require = createRequire(path.resolve("package.json"));
const step = (what) => console.log(`  ok ${what}`);

assert.throws(() => new Function("return 1"), EvalError, "run this with --disallow-code-generation-from-strings");
step("eval and new Function are off for the whole smoke");

// 1. Every export of every package loads, the JSON data under its import attribute.
for (const name of PACKAGES) {
  const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
  for (const key of Object.keys(manifest.exports)) {
    const subpaths = key.includes("*") ? expand(name, manifest, key) : [key];
    for (const sub of subpaths) {
      const spec = sub === "." ? name : `${name}/${sub.slice(2)}`;
      const mod = sub.endsWith(".json") ? await import(spec, { with: { type: "json" } }) : await import(spec);
      assert.ok(Object.keys(mod).length > 0, `${spec} exports nothing`);
    }
  }
  step(`${name}: every export loads`);
}

/** The files a pattern export (`./packs/*`) reaches in the installed package. */
function expand(name, manifest, key) {
  const target = manifest.exports[key];
  const [prefix, suffix] = target.split("*");
  const dir = path.join(path.dirname(require.resolve(`${name}/package.json`)), prefix);
  const files = readdirSync(dir).filter((f) => f.endsWith(suffix));
  assert.ok(files.length > 0, `${name} ${key}: no file matches ${target}`);
  return files.map((f) => key.replace("*", f.slice(0, f.length - suffix.length)));
}

// 2. The resolver on its defaults: the schema and the packs it ships, no spec/ or packs/ anywhere near it.
const resolver = await import("@meantjs/profile");
const did = readFileSync("ledger.did", "utf8");
const validateSchema = await resolver.createSchemaValidator();
const packs = (await resolver.loadPacks()).map(({ doc }) => ({ doc }));
assert.deepEqual(packs.map(({ doc }) => doc.name), ["icrc1", "icrc2"]);
const r = await resolver.resolveService({ did, validateSchema, packs });
assert.equal(r.ok, true, JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
assert.deepEqual(r.profiles.map((p) => [p.name, p.status]), [["icrc1", "applied"], ["icrc2", "applied"]]);
step("@meantjs/profile resolves the ICRC ledger .did with the packs it ships");

const browser = await import("@meantjs/profile/browser");
const viaBrowser = await browser.resolveService({ did, validateSchema: await browser.createSchemaValidator(), packs: browser.STANDARD_PACKS.map(({ doc }) => ({ doc })) });
assert.deepEqual(viaBrowser, r);
step("@meantjs/profile/browser gives the same resolved form");

// 3. The CLI, through the bin npm linked.
const cli = spawnSync(path.resolve("node_modules/.bin/candid-profile"), ["resolve", "ledger.did", "--packs", "--quiet"], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.deepEqual(JSON.parse(cli.stdout), JSON.parse(JSON.stringify(r.resolved)));
step("candid-profile resolve --packs prints the same resolved form");

// 4. Format: exact conversion both ways.
const format = await import("@meantjs/format");
assert.equal(format.parseAmount("0.29 TKA", { decimals: 8, symbol: "TKA" }), "29000000");
assert.equal(format.displayAmount(29000000n, { decimals: 8, symbol: "TKA" }), "0.29 TKA");
assert.throws(() => format.parseAmount("0.123456789 TKA", { decimals: 8, symbol: "TKA" }), format.FormatError);
step("@meantjs/format parses and displays without rounding");

// 5. Consent: the golden ICRC-21 message of the plain transfer (test/golden/transfer-tka-basic.json), from the resolved form made above.
const consent = await import("@meantjs/consent");
const golden = JSON.parse(readFileSync("transfer-tka-basic.json", "utf8"));
const refs = { "query:icrc1_decimals": golden.ledger.decimals, "query:icrc1_symbol": golden.ledger.symbol };
const arg = Uint8Array.from(golden.arg_hex.match(/../g), (h) => parseInt(h, 16));
for (const form of ["generic", "fields"]) {
  const response = consent.icrc21ConsentMessage({ method: golden.method, arg, user_preferences: golden[form].request.user_preferences }, { resolved: r.resolved, refs });
  assert.deepEqual(consent.toJson(response), golden[form].response, form);
}
step("@meantjs/consent renders the golden consent messages");

// 6. Tools: the tool set and exact input reading.
const tools = await import("@meantjs/tools");
const canisters = [{ id: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "TKA", refs }];
const names = tools.toolDefinitions([r.resolved], { canisters }).map((t) => t.name);
for (const name of ["commit", "icrc1_balance_of", "prepare_icrc1_transfer", "prepare_icrc2_approve"]) assert.ok(names.includes(name), name);
const { plans } = tools.buildToolPlans([r.resolved]);
const input = tools.readToolInput(plans.get("prepare_icrc1_transfer"), { to: canisters[0].id, amount: "0.29 TKA" }, { refs });
assert.equal(input.value.amount, 29000000n);
step("@meantjs/tools builds the tools and reads human units exactly");

// 7. Reconcile: the block a transfer leaves.
const reconcile = await import("@meantjs/reconcile");
const caller = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
const tx = reconcile.expectedTransaction("icrc1_transfer", { ...input.value, created_at_time: 1791547200000000000n }, caller);
assert.equal(tx.op, "xfer");
assert.equal(tx.amt, 29000000n);
step("@meantjs/reconcile maps a transfer to its ICRC-3 block");
