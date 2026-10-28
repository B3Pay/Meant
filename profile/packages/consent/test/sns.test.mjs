// SNS validator renderings (src/sns.mjs): golden cases, governance's wrapper, the reply codec and the reviewer's check.
//
// Independent checks: argument bytes come from the Rust candid crates (@dfinity/didc); replies are decoded by the same
// crates as `variant { Ok : text; Err : text }`, the type SNS governance decodes them as; the wrapper is checked
// against the expected value of the upstream governance test; Markdown structure is read with the CommonMark
// reference parser.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decode as didcDecode, encode as didcEncode } from "@dfinity/didc";
import { Parser } from "commonmark";
import {
  SNS_RENDERING_RULES,
  decodeValidatorResult,
  encodeValidatorResult,
  handleSnsValidatorCall,
  parseGovernanceRendering,
  snsValidatorRendering,
  verifySnsRendering,
} from "@meantjs/consent/sns";
import { LEDGERS, encodeCall, fromHex, hexOf, icrc1, refsFor } from "./helpers.mjs";
import { DAPP_DID, dapp, functionDebug, governanceRendering, proposalPayloadSummary, sha256Hex } from "./sns-helpers.mjs";
import { RESOLVED_FOR_RUST, buildSnsGolden, payloadOf, renderSnsReview, resolvedJson, sourceOf, wrappedExample } from "./sns-golden/build.mjs";
import { CASES, DAPP_ID, WRAPPED_EXAMPLE } from "./sns-golden/cases.mjs";

const dir = new URL("./sns-golden/", import.meta.url);
const stored = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), "utf8"));
const UPSTREAM = readFileSync(new URL("./upstream/sns/execute-generic-function-rendering.txt", import.meta.url), "utf8");
const RESULT_DID = "type R = variant { Ok : text; Err : text }; service : { validate : () -> (R); echo : (R) -> () }";

/** Rust candid's reading of reply bytes as the reply type SNS governance decodes them as, then encoded again by Rust candid. */
function rustRoundTrip(bytes) {
  const text = didcDecode({ idl: RESULT_DID, input: hexOf(bytes), serviceMethod: "validate", inputFormat: "hex", targetFormat: "candid" });
  return { text, hex: didcEncode({ idl: RESULT_DID, input: text, targetFormat: "hex", withType: { kind: "methodParams", name: "echo" } }) };
}
const candidText = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

/** Headings (level list), node types and code literals of a Markdown document, by the CommonMark reference parser. */
function structure(markdown) {
  const walker = new Parser().parse(markdown).walker();
  const headings = [];
  const types = new Set();
  const codes = [];
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering) continue;
    types.add(e.node.type);
    if (e.node.type === "heading") headings.push(e.node.level);
    if (e.node.type === "code") codes.push(e.node.literal);
  }
  return { headings, types, codes };
}

const fnFor = (method, extra = {}) => functionDebug({ target: DAPP_ID, targetMethod: method, validator: DAPP_ID, validatorMethod: `validate_${method}`, ...extra });

test("sns golden: the case list, the JSON files and the review file are in step", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, CASES.map((c) => c.id).sort());
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, "case ids are unique");
  assert.equal(readFileSync(new URL("REVIEW.md", dir), "utf8"), renderSnsReview(CASES), "run `npm run golden -w packages/consent`, read the REVIEW.md diff, commit");
});

test("sns golden: the resolved forms the Rust tests read are the resolver's output", () => {
  const names = readdirSync(new URL("resolved/", dir)).sort();
  assert.deepEqual(names, Object.keys(RESOLVED_FOR_RUST).map((n) => `${n}.resolved.json`).sort());
  for (const name of Object.keys(RESOLVED_FOR_RUST)) {
    assert.equal(readFileSync(new URL(`resolved/${name}.resolved.json`, dir), "utf8"), resolvedJson(name), "run `npm run golden -w packages/consent` and commit");
  }
});

for (const c of CASES) {
  test(`sns golden ${c.id}`, () => {
    const g = stored(c.id);
    // the payload is what the Rust candid crates make of the textual arguments
    assert.equal(g.payload_hex, hexOf(encodeCall(c.encodeAs ?? c.method, c.args, sourceOf(c).did)), "payload_hex");
    assert.equal(g.payload_sha256, sha256Hex(fromHex(g.payload_hex)), "payload_sha256");
    // 1. regression
    assert.deepEqual(buildSnsGolden(c), g);
    // 2. the reply bytes are what governance decodes, and say the same thing
    const kind = "Ok" in g.reply ? "Ok" : "Err";
    const rust = rustRoundTrip(fromHex(g.reply_hex));
    assert.match(rust.text, new RegExp(`^\\(\\s*variant\\s*\\{\\s*${kind}\\s*=\\s*"`), "Rust candid reads the same case");
    assert.equal(rust.hex, g.reply_hex, "Rust candid encodes what it read to the same bytes");
    assert.deepEqual(decodeValidatorResult(fromHex(g.reply_hex)), g.reply);
    assert.equal(hexOf(handleSnsValidatorCall(payloadOf(c), { resolved: sourceOf(c).resolved, method: c.method, refs: sourceOf(c).refs })), g.reply_hex, "the canister wrapper");

    // 3. the hand-worked expectations
    if (c.expect.err) {
      assert.match(g.reply.Err, c.expect.err);
      return;
    }
    const text = g.reply.Ok;
    const blocks = text.split("\n\n");
    assert.equal(blocks[0], `### ${c.expect.title}`, "title at heading level 3");
    if (c.expect.sentence !== null) assert.equal(blocks[1], c.expect.sentence, "the intent sentence");
    assert.ok(text.includes(`**Method:** \`${c.method}\`. **Effect:** ${c.expect.effect}.`), "method and effect");
    const raw = /\*\*Arguments \(Candid, as sent, no units applied\):\*\*\n\n```\n(.*)\n```/.exec(text)?.[1];
    assert.ok(raw, "the Candid block");
    for (const piece of c.expect.raw) assert.ok(raw.includes(piece), `the Candid block has ${piece}`);
    assert.ok(text.endsWith(`- Rules: \`${SNS_RENDERING_RULES}\``), "ends with the rules");
    for (const p of sourceOf(c).resolved.profiles) assert.ok(text.includes(`\`${p.profile_id}\``), `names profile ${p.name}`);
    // nothing state-dependent, no stamp
    assert.doesNotMatch(blocks.slice(0, 3).join("\n"), /balance|available|remaining|1791547200000000000/i);

    // 4. inside governance's wrapper: governance's headings and one of ours, nothing else; values are inert
    const wrapped = governanceRendering(fnFor(c.method), payloadOf(c), text);
    const s = structure(wrapped);
    assert.deepEqual(s.headings, [1, 2, 2, 2, 3], "headings");
    for (const bad of ["link", "image", "html_inline", "html_block", "emph", "strong_emph"]) assert.ok(!s.types.has(bad), bad);
    if (c.expect.memo !== undefined) assert.equal(s.codes.filter((x) => x === c.expect.memo).length, 2, "the memo is one code span in the sentence and one in the list");
  });
}

test("sns: the review file's wrapped example is the dapp case inside governance's layout", () => {
  const p = parseGovernanceRendering(wrappedExample());
  assert.equal(p.targetMethod, WRAPPED_EXAMPLE.targetMethod);
  assert.equal(p.validatorMethod, WRAPPED_EXAMPLE.validatorMethod);
  assert.equal(p.targetCanisterId, DAPP_ID);
  assert.equal(p.payloadRendering, stored(WRAPPED_EXAMPLE.caseId).reply.Ok);
});

test("sns: governance's stored rendering parses as upstream writes it (dfinity/ic test vector)", () => {
  const p = parseGovernanceRendering(UPSTREAM);
  assert.equal(p.payloadSha256, sha256Hex(Uint8Array.from([1, 2, 3])));
  assert.equal(p.payloadRendering, "Payload rendering here");
  assert.equal(p.targetMethod, "test_method");
  assert.equal(p.validatorMethod, "test_validator_method");
  assert.equal(p.targetCanisterId, "rrkah-fqaaa-aaaaa-aaaaq-cai");
  assert.equal(p.validatorCanisterId, "rrkah-fqaaa-aaaaa-aaaaq-cai");
  // the test helper writes governance's layout byte for byte
  const fn = functionDebug({ target: "rrkah-fqaaa-aaaaa-aaaaq-cai", targetMethod: "test_method", validator: "rrkah-fqaaa-aaaaa-aaaaq-cai", validatorMethod: "test_validator_method" });
  assert.equal(governanceRendering(fn, Uint8Array.from([1, 2, 3]), "Payload rendering here"), UPSTREAM);
  for (const bad of ["", "# Proposal to execute nervous system function:", UPSTREAM.replace("039058", "zz9058"), UPSTREAM.replace("## Payload:\n\n", "## Payload:\n")]) {
    assert.equal(parseGovernanceRendering(bad), null, JSON.stringify(bad.slice(-40)));
  }
});

test("sns: the Candid block does not depend on the profile's units, the sentence does", () => {
  const c = CASES.find((x) => x.id === "transfer-tka-basic");
  const payload = payloadOf(c);
  const as8 = snsValidatorRendering({ payload, resolved: icrc1, method: c.method, refs: refsFor(LEDGERS.TKA) }).Ok;
  const as6 = snsValidatorRendering({ payload, resolved: icrc1, method: c.method, refs: refsFor(LEDGERS.TKB) }).Ok;
  const block = (t) => t.slice(t.indexOf("```"));
  assert.equal(block(as8), block(as6));
  assert.match(as8, /Send `1\.5 TKA`/);
  assert.match(as6, /Send `150 TKB`/);
});

test("sns: a rendering that would exceed the message limit is refused, never truncated", () => {
  const memo = "a".repeat(12_000);
  const args = `(record { to = record { owner = principal "${DAPP_ID}"; subaccount = null }; amount = 1 : nat; memo = opt blob "${memo}" })`;
  const r = snsValidatorRendering({ payload: encodeCall("pay_grant", args, DAPP_DID), resolved: dapp, method: "pay_grant" });
  assert.match(r.Err, /^E_TOO_LARGE: /);
  assert.ok(r.diagnostics.some((d) => d.code === "E_TOO_LARGE"));
});

test("sns: anything that is not bytes, or no resolved form, is an Err, not a throw", () => {
  for (const [input, code] of [
    [{ payload: "4449444c0000", resolved: dapp, method: "pause" }, /^E_DECODE: /],
    [{ payload: 42, resolved: dapp, method: "pause" }, /^E_DECODE: /],
    [{ payload: new Uint8Array(), resolved: dapp, method: "pause" }, /^E_DECODE: /],
    [{ payload: encodeCall("pause", "()", DAPP_DID), resolved: { format: "x" }, method: "pause" }, /^E_RESOLVED_FORM: /],
    [{ payload: encodeCall("pause", "()", DAPP_DID), resolved: dapp }, /^E_METHOD_UNKNOWN: /],
  ]) {
    const r = snsValidatorRendering(input);
    assert.deepEqual(Object.keys(r), ["Err"]);
    assert.match(r.Err, code);
    assert.ok(r.Err.length <= 1003);
  }
});

test("sns: the reply codec reads Rust-encoded replies and refuses other types", () => {
  for (const reply of [{ Ok: "fine" }, { Err: "Invalid: amount" }, { Ok: "" }]) {
    const [kind, value] = Object.entries(reply)[0];
    const bytes = fromHex(didcEncode({ idl: RESULT_DID, input: `(variant { ${kind} = ${candidText(value)} })`, targetFormat: "hex", withType: { kind: "type", name: "R" } }));
    assert.deepEqual(decodeValidatorResult(bytes), reply);
    assert.equal(hexOf(encodeValidatorResult(reply)), hexOf(bytes), "same bytes as Rust candid");
  }
  assert.throws(() => decodeValidatorResult(fromHex(didcEncode({ idl: RESULT_DID, input: '("just text")', targetFormat: "hex" }))), { code: "E_DECODE" });
  for (const bad of [{ Ok: 1 }, { Ok: "a", Err: "b" }, { Fine: "x" }, null]) assert.throws(() => encodeValidatorResult(bad), { code: "E_REQUEST" });
});

// ---------------------------------------------------------------------------------------------- the reviewer's check

const grant = CASES.find((x) => x.id === "dapp-pay-grant");
const grantPayload = payloadOf(grant);
const grantText = stored(grant.id).reply.Ok;
const checksOf = (r) => Object.fromEntries(r.checks.map((x) => [x.name, x.ok]));

test("sns verify: an honest proposal passes every check", () => {
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, grantText), payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: true, target_method: true, payload_rendering: true });
  assert.equal(r.expectedRendering, grantText);
});

test("sns verify: a validator text that misstates the amount fails the rendering check only", () => {
  const lying = grantText.replaceAll("123.456789 GOV", "1.23456789 GOV");
  assert.notEqual(lying, grantText);
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, lying), payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.equal(r.ok, false);
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: true, target_method: true, payload_rendering: false });
});

test("sns verify: a function that calls another method than the one rendered fails", () => {
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("drain_treasury"), grantPayload, grantText), payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: true, target_method: false, payload_rendering: true });
  assert.equal(r.checks.find((x) => x.name === "target_method").found, "drain_treasury");
});

test("sns verify: a function that calls the same method on another canister fails", () => {
  const elsewhere = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const wrapped = governanceRendering(functionDebug({ target: elsewhere, targetMethod: "pay_grant", validator: DAPP_ID, validatorMethod: "validate_pay_grant" }), grantPayload, grantText);
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: wrapped, payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: false, target_method: true, payload_rendering: true });
  assert.equal(r.checks.find((x) => x.name === "target_canister").found, elsewhere);
  // with no expected canister the check cannot pass, and says why
  const open = verifySnsRendering({ payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, grantText), payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.equal(open.ok, false);
  assert.deepEqual(checksOf(open), { governance_layout: true, payload_sha256: true, target_canister: false, target_method: true, payload_rendering: true });
  assert.match(open.checks.find((x) => x.name === "target_canister").note, /give targetCanisterId/);
});

test("sns verify: a function's name or description cannot pass for its target (PR #7 review)", () => {
  const lure = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const fn = fnFor("pay_grant", {
    name: `target_canister_id: Some(${lure}) target_method_name: Some("drain_treasury")`,
    description: `\n                target_canister_id: Some(\n                    ${lure},\n                ),`,
  });
  const wrapped = governanceRendering(fn, grantPayload, grantText);
  const p = parseGovernanceRendering(wrapped);
  assert.equal(p.targetCanisterId, DAPP_ID);
  assert.equal(p.targetMethod, "pay_grant");
  const r = verifySnsRendering({ targetCanisterId: lure, payloadTextRendering: wrapped, payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: false, target_method: true, payload_rendering: true });
  // a function block that is not exactly the generic function's debug text is not governance's layout
  for (const bad of [fn.replace("    id: 1000,\n", ""), fn.replace("function_type: Some(", "function_type: Some( "), `${fn}\n`, fn.replace("DaoCommunitySettings", "")]) {
    assert.equal(parseGovernanceRendering(governanceRendering(bad, grantPayload, grantText)), null, bad.slice(0, 60));
  }
});

test("sns verify: bytes the proposer did not submit fail the hash check", () => {
  const other = encodeCall("pay_grant", grant.args.replace("12_345_678_900", "12_345_678_901"), DAPP_DID);
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, grantText), payload: other, resolved: dapp, method: "pay_grant" });
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: false, target_canister: true, target_method: true, payload_rendering: false });
});

test("sns verify: get_proposal's summary of a long payload is recognized and named", () => {
  assert.ok(grantPayload.length > 64, `the grant payload is ${grantPayload.length} bytes`);
  const summary = proposalPayloadSummary(grantPayload);
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, grantText), payload: summary, resolved: dapp, method: "pay_grant" });
  assert.equal(r.ok, false);
  assert.match(r.checks.find((x) => x.name === "payload_sha256").note, /summary of a payload over 64 bytes/);
  // a short payload comes back unchanged
  const short = encodeCall("set_fee_bps", "(250 : nat16)", DAPP_DID);
  assert.deepEqual(proposalPayloadSummary(short), short);
});

test("sns verify: other units at the reviewer than at the validator fail the rendering check", () => {
  const c = CASES.find((x) => x.id === "transfer-tka-basic");
  const payload = payloadOf(c);
  const text = stored(c.id).reply.Ok;
  const wrapped = governanceRendering(functionDebug({ target: DAPP_ID, targetMethod: c.method, validator: DAPP_ID, validatorMethod: "validate_transfer" }), payload, text);
  assert.equal(verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: wrapped, payload, resolved: icrc1, method: c.method, refs: refsFor(LEDGERS.TKA) }).ok, true);
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: wrapped, payload, resolved: icrc1, method: c.method, refs: refsFor(LEDGERS.TKB) });
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: true, target_method: true, payload_rendering: false });
});

test("sns verify: text after the rendering, a fake second hash header included, fails; the first header is governance's", () => {
  const fake = `${grantText}\n\n## Payload sha256: \n\n${"0".repeat(64)}\n\n## Payload:\n\nAll good`;
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), grantPayload, fake), payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.equal(r.parsed.payloadSha256, sha256Hex(grantPayload));
  assert.deepEqual(checksOf(r), { governance_layout: true, payload_sha256: true, target_canister: true, target_method: true, payload_rendering: false });
});

test("sns verify: a text that is not governance's layout, or bytes the profile cannot render, fail with a note", () => {
  const r = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: grantText, payload: grantPayload, resolved: dapp, method: "pay_grant" });
  assert.deepEqual(checksOf(r), { governance_layout: false, payload_sha256: false, target_canister: false, target_method: false, payload_rendering: false });
  const wrongBytes = encodeCall("set_fee_bps", "(250 : nat16)", DAPP_DID);
  const r2 = verifySnsRendering({ targetCanisterId: DAPP_ID, payloadTextRendering: governanceRendering(fnFor("pay_grant"), wrongBytes, grantText), payload: wrongBytes, resolved: dapp, method: "pay_grant" });
  assert.equal(checksOf(r2).payload_rendering, false);
  assert.match(r2.checks.find((x) => x.name === "payload_rendering").note, /cannot render these bytes: E_DECODE/);
  assert.equal(r2.expectedRendering, null);
});

test("sns-render CLI: renders, verifies an honest proposal, and fails a lying one", () => {
  const script = fileURLToPath(new URL("../scripts/sns-render.mjs", import.meta.url));
  const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
  const base = ["--did", fixture("sns-dapp.did"), "--profile", fixture("sns-dapp.profile.json"), "--method", "pay_grant"];
  const tmp = mkdtempSync(join(tmpdir(), "sns-render-"));
  try {
    const out = execFileSync(process.execPath, [script, ...base, "--payload", hexOf(grantPayload)], { encoding: "utf8" });
    assert.equal(out, `${grantText}\n`);
    writeFileSync(join(tmp, "payload.bin"), grantPayload);
    writeFileSync(join(tmp, "honest.txt"), governanceRendering(fnFor("pay_grant"), grantPayload, grantText));
    writeFileSync(join(tmp, "lying.txt"), governanceRendering(fnFor("pay_grant"), grantPayload, grantText.replaceAll("123.456789 GOV", "1.23456789 GOV")));
    const verify = (file, ...more) => spawnSync(process.execPath, [script, ...base, "--payload-file", join(tmp, "payload.bin"), "--verify", join(tmp, file), ...more], { encoding: "utf8" });
    const honest = verify("honest.txt", "--target", DAPP_ID);
    assert.equal(honest.status, 0, honest.stderr);
    assert.match(honest.stdout, /^PASS governance_layout\nPASS payload_sha256 .*\nPASS target_canister .*\nPASS target_method .*\nPASS payload_rendering\n$/);
    const elsewhere = verify("honest.txt", "--target", "rrkah-fqaaa-aaaaa-aaaaq-cai");
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stdout, /FAIL target_canister/);
    const untargeted = verify("honest.txt");
    assert.equal(untargeted.status, 1);
    assert.match(untargeted.stderr, /--verify needs --target/);
    const lying = verify("lying.txt", "--target", DAPP_ID);
    assert.equal(lying.status, 1);
    assert.match(lying.stdout, /FAIL payload_rendering/);
    const bad = spawnSync(process.execPath, [script, ...base, "--payload", "zz"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--payload must be hex/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
