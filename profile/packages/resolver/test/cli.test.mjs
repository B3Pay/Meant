// Step 5: the CLI, and the real ICRC ledger .did the eval harness pins, resolved with both packs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HERE, ROOT, icrc1, icrc2, interfaceIdOf, canisterProfile, node, readJson } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = path.join(HERE, "../bin/candid-profile.mjs");
const LEDGER = path.join(HERE, "fixtures/ledger.did");

async function cli(...args) {
  try {
    const { stdout, stderr } = await run("node", [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
const write = async (name, content) => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "cp-")), name);
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};

test("the committed ledger.did is the recorded release file", async () => {
  const sources = await readJson("packages/resolver/test/fixtures/SOURCES.json");
  const rec = sources.files["ledger.did"];
  const bytes = await readFile(LEDGER);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), rec.sha256);
  assert.equal(bytes.length, rec.bytes);
  assert.match(rec.url, /^https:\/\/github\.com\/dfinity\/ic\/releases\/download\/.+\/ledger\.did$/);
});

// The eval harness lives in the private repository only; its public copy (D-051) skips this one comparison.
const HARNESS_ARTIFACTS = "eval/harness/artifacts.json";
test("the committed ledger.did is the file the eval harness pins", { skip: !existsSync(path.join(ROOT, HARNESS_ARTIFACTS)) && "the eval harness is not in this tree (public copy)" }, async () => {
  const rec = (await readJson("packages/resolver/test/fixtures/SOURCES.json")).files["ledger.did"];
  const pinned = (await readJson(HARNESS_ARTIFACTS)).ledger_suite.files["ledger.did"];
  assert.equal(rec.sha256, pinned.sha256, "same bytes as the harness pins");
  assert.equal(rec.url, pinned.url);
});

test("the real ledger .did plus both packs resolves cleanly with both packs matched", async () => {
  const { code, stdout, stderr } = await cli("resolve", LEDGER, "--packs");
  assert.equal(code, 0, stderr);
  const r = JSON.parse(stdout);
  assert.equal(r.format, "candid-profile-resolved");
  assert.deepEqual(r.profiles.map((p) => p.name), ["icrc1", "icrc2"]);
  assert.match(r.interface_id, /^candid-core:interface:v1:sha256:[0-9a-f]{64}$/);
  assert.equal(r.interface_id, await interfaceIdOf(await readFile(LEDGER, "utf8")));
  // Clean: nothing worse than info, and the infos are the two matches plus the untagged int16 of ICRC-21.
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== "info"), []);
  assert.deepEqual(r.diagnostics.map((d) => d.code).sort(), ["I_PACK_MATCHED", "I_PACK_MATCHED", "I_UNTAGGED_NUMERIC"]);
  assert.deepEqual(Object.keys(r), ["format", "format_version", "interface_id", "profiles", "methods", "diagnostics"]);

  const m = r.methods;
  assert.equal(Object.keys(m).length, 26, "every method of the ledger is in the resolved form");
  // ICRC-1 on the ledger's own types (TransferArg, Tokens, Timestamp, Subaccount are aliases there).
  const t = m.icrc1_transfer;
  assert.equal(t.tags.effect.args.kind, "transfer");
  assert.equal(t.tags.idempotency.args.stamp, "created_at_time");
  assert.equal(node(t.args[0], "amount").tags.amount.profile, "icrc1");
  assert.deepEqual(node(t.args[0], "amount").tags.amount.args.decimals, { from: "query:icrc1_decimals" });
  assert.equal(node(t.args[0], "created_at_time").tags.timestamp.args.unit, "ns");
  assert.equal(node(t.args[0], "to").tags.account.profile, "icrc1");
  assert.equal(node(t.results[0], "Err", "BadFee", "expected_fee").tags.amount.profile, "icrc1");
  assert.equal(m.icrc1_balance_of.results[0].tags.amount.profile, "icrc1");
  // ICRC-2.
  assert.equal(m.icrc2_approve.tags.effect.args.kind, "approve");
  assert.equal(node(m.icrc2_approve.args[0], "expires_at").tags.timestamp.profile, "icrc2");
  assert.equal(node(m.icrc2_transfer_from.args[0], "from").tags.account.profile, "icrc2");
  assert.equal(node(m.icrc2_allowance.results[0], "allowance").tags.amount.profile, "icrc2");
  // The ledger has more standards than the packs know; those methods carry only the default effect.
  assert.equal(m.icrc3_get_blocks.tags.effect.origin, "default");
  assert.equal(m.icrc21_canister_call_consent_message.tags.effect.origin, "default");
  // Recursive types are cut, not expanded forever (ICRC-3 Value).
  assert.ok(JSON.stringify(m.icrc3_get_blocks).includes('"recursive":true'));
  // Stderr says what happened.
  assert.match(stderr, /applied\s+icrc1\s+pack/);
  assert.match(stderr, /applied\s+icrc2\s+pack/);
  assert.match(stderr, /0 error, 0 warning, 3 info/);
});

test("the ledger resolves the same with the packs given explicitly, and an author profile layers on top", async () => {
  const packs = path.join(ROOT, "packs");
  const viaFlag = await cli("resolve", LEDGER, "--profile", path.join(packs, "icrc1.profile.json"), "--profile", path.join(packs, "icrc2.profile.json"), "--quiet");
  const viaSearch = await cli("resolve", LEDGER, "--packs", "--quiet");
  assert.equal(viaFlag.code, 0);
  assert.equal(viaFlag.stderr, "");
  const strip = (s) => { const j = JSON.parse(s); delete j.diagnostics; return j; };
  assert.deepEqual(strip(viaFlag.stdout), strip(viaSearch.stdout));

  const author = canisterProfile({ interfaceId: await interfaceIdOf(await readFile(LEDGER, "utf8")), annotations: [
    { at: "icrc1_transfer(0).memo", tag: "bytes", args: { encoding: "hex" } },
    { at: "icrc1_transfer", tag: "describe", args: { label: "Move tokens" } },
  ] });
  const file = await write("mine.profile.json", author);
  const { code, stdout, stderr } = await cli("resolve", LEDGER, "--profile", file, "--packs");
  assert.equal(code, 0, stderr);
  const r = JSON.parse(stdout);
  assert.deepEqual(r.profiles.map((p) => `${p.name}:${p.origin}`), ["mine:author", "icrc1:pack", "icrc2:pack"]);
  assert.deepEqual(node(r.methods.icrc1_transfer.args[0], "memo").tags.bytes, { args: { encoding: "hex" }, origin: "author", profile: "mine" });
  assert.equal(r.methods.icrc1_transfer.tags.describe.profile, "mine");
  assert.equal(node(r.methods.icrc1_transfer.args[0], "memo").tags.default.profile, "icrc1", "the pack's other tags on the position stay");
  const over = r.diagnostics.filter((d) => d.code === "W_OVERRIDDEN");
  assert.equal(over.length, 1);
  assert.equal(over[0].profile, "icrc1");
  assert.match(stderr, /W_OVERRIDDEN\s+\[icrc1\]/);
});

test("exit codes: 1 for an error diagnostic (the form is still printed), 2 for usage and I/O", async () => {
  // An explicit pack that does not match.
  const noTransfer = await write("no-transfer.did", icrc1.binds.requires.replace(/  icrc1_transfer : .*\n/, ""));
  let r = await cli("resolve", noTransfer, "--profile", path.join(ROOT, "packs/icrc1.profile.json"));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).profiles.length, 0);
  assert.match(r.stderr, /E_PACK_NOT_MATCHED/);
  // Not compiling: no resolved form on stdout.
  r = await cli("resolve", await write("bad.did", "service : { oops : ("), "--packs");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /E_CANDID/);
  // Usage.
  for (const args of [[], ["resolve"], ["resolve", LEDGER, "--bogus"], ["resolve", LEDGER, "--profile"], ["resolve", "/no/such.did"], ["resolve", LEDGER, "--profile", "/no/such.json"], ["frobnicate"], ["resolve", LEDGER, "--packs", "--packs-dir", "/no/such/dir"]]) {
    r = await cli(...args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
  r = await cli("--help");
  assert.equal(r.code, 0);
  assert.match(r.stderr, /usage: candid-profile resolve/);
});

test("--packs-dir selects another directory, and a schema-invalid profile is reported", async () => {
  const dir = path.dirname(await write("icrc2.profile.json", icrc2));
  const r = await cli("resolve", LEDGER, "--packs", "--packs-dir", dir, "--quiet");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).profiles.map((p) => p.name), ["icrc2"]);
  const bad = await write("bad.profile.json", { format: "candid-profile", name: "bad" });
  const e = await cli("resolve", LEDGER, "--profile", bad);
  assert.equal(e.code, 1);
  assert.match(e.stderr, /E_SCHEMA/);
});
