// The drop-in on its own, off chain: the order of a task, what the guarded account signs and keeps, and the words of
// each refusal. Then the whole replay (`node run.mjs --check`), which needs `npm run fetch` first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explain, PROFILES, signingCheck, TERMS_TOOL } from "../src/signing-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x5037546753d64F77A6fA95B6f85659B6a4A7F6FD";
const OTHER = "0x00000000000000000000000000000000DeaDBeef";
const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NOW = BigInt(Date.UTC(2026, 10, 4, 12)) * 1_000_000n; // 2026-11-04 12:00 UTC, in nanoseconds
// x402's client reads the clock itself (Date.now(), for an authorization's validBefore). Give it the wallet's clock, so
// that these tests read the same on any day. The replay runs in its own process, on the real clock.
mock.timers.enable({ apis: ["Date"], now: Number(NOW / 1_000_000n) });
const wallet = { chainId: 84532, tokens: { USDC: { address: USDC, decimals: 6 } }, apps: { "Weather API": PAYEE }, now: () => NOW };
const TERMS = { token: "USDC", to: "Weather API", max_amount: "0.05", expires_by: "1 day" };
const requirements = (over = {}) => ({ scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: PAYEE, maxTimeoutSeconds: 300, ...over, extra: { name: "USDC", version: "2", ...over.extra } });
const check = await signingCheck(wallet);
const confirmed = () => {
  const task = check.task(TERMS);
  task.confirm(task.text);
  return task;
};
const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { error, words: explain(error) };
  }
  assert.fail("the request was signed");
};

test("the six profiles validate and each becomes a resolved form", () => {
  assert.equal(PROFILES.length, 6);
  assert.equal(check.forms.length, 6);
  assert.deepEqual(PROFILES.map((p) => p.name), ["usdc", "usdc-domain-usdc", "usdc-base-sepolia", "permit2", "x402-exact-permit2", "x402-upto-permit2"]);
});

test("a task's text is the terms in words, for the wallet's own screen", () => {
  const task = check.task(TERMS);
  assert.equal(task.text, `Weather API (${PAYEE}) may be sent at most 0.05 USDC, until the end of 5 November 2026 (UTC).`);
  assert.throws(() => task.confirm(`${task.text} `), { code: "E_TERMS_ORDER" });
});

test("a term the wallet cannot read is refused, never guessed", () => {
  assert.throws(() => check.task({ ...TERMS, token: "USDT" }), { code: "E_TERMS_TOKEN" });
  assert.throws(() => check.task({ ...TERMS, to: "Wether API" }), { code: "E_TERMS_PARTY" });
  assert.throws(() => check.task({ ...TERMS, max_amount: "0.0000001" }), { code: "E_TERMS_AMOUNT" });
});

test("nothing is signed before the user confirms, or after they decline", async () => {
  const task = check.task(TERMS);
  const before = await refusal(new ExactEvmScheme(task.guard(key)).createPaymentPayload(2, requirements()));
  assert.equal(before.words.code, "E_TERMS_ORDER");
  assert.equal(before.words.title, "Not signed: no confirmed terms cover this request.");
  task.confirm(task.text);
  task.decline();
  const after = await refusal(new ExactEvmScheme(task.guard(key)).createPaymentPayload(2, requirements()));
  assert.equal(after.words.code, "E_TERMS_ORDER");
});

test("a payment within the terms is signed as x402's client built it, and the signature verifies", async () => {
  const { payload } = await new ExactEvmScheme(confirmed().guard(key)).createPaymentPayload(2, requirements());
  const a = payload.authorization;
  assert.equal(a.to, PAYEE);
  assert.equal(a.value, "10000");
  const valid = await verifyTypedData({
    address: key.address,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
    signature: payload.signature,
  });
  assert.equal(valid, true);
});

test("the guarded account keeps no other way to sign", () => {
  const guarded = confirmed().guard(key);
  assert.deepEqual(Object.keys(guarded).sort(), ["address", "signTypedData"]);
  assert.equal(guarded.address, key.address);
  assert.equal(Object.isFrozen(guarded), true);
});

test("a request over the terms, or to another payee, is refused with the reason in words", async () => {
  const more = await refusal(new ExactEvmScheme(confirmed().guard(key)).createPaymentPayload(2, requirements({ amount: "25000000" })));
  assert.equal(more.words.code, "E_GUARD_REFUSED");
  assert.equal(more.words.title, "Not signed: this request is not what you confirmed.");
  assert.deepEqual(more.words.why, ["The request allows 25 USDC, the terms say at most 0.05 USDC."]);
  const payee = await refusal(new ExactEvmScheme(confirmed().guard(key)).createPaymentPayload(2, requirements({ payTo: OTHER })));
  assert.deepEqual(payee.words.why, [`The recipient is ${OTHER}, the terms say Weather API (${PAYEE}).`]);
});

test("a request for another chain says so, and a look-alike domain names the closest profile", async () => {
  const base = await refusal(new ExactEvmScheme(confirmed().guard(key)).createPaymentPayload(2, requirements({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin" } })));
  assert.equal(base.words.code, "E_GUARD_UNKNOWN");
  assert.equal(base.words.title, "Not signed: this request is for another chain.");
  assert.deepEqual(base.words.why, ["The domain is for chain 8453, the wallet is on chain 84532."]);
  const lookalike = await refusal(new ExactEvmScheme(confirmed().guard(key)).createPaymentPayload(2, requirements({ extra: { name: "USD Coin" } })));
  assert.equal(lookalike.words.title, "Not signed: this request is not what it claims to be.");
  // Two profiles read Base Sepolia's USDC by name; the first of them in PROFILES is the one shown.
  assert.deepEqual(lookalike.words.why, ['Profile usdc-domain-usdc describes the domain whose name is "USDC", not "USD Coin".']);
});

test("explain leaves alone an error the check did not raise", () => {
  assert.equal(explain(new Error("network down")), null);
  assert.equal(explain(new TypeError("x")), null);
});

test("the terms tool takes the fields readTerms reads", () => {
  assert.equal(TERMS_TOOL.name, "propose_terms");
  assert.deepEqual(Object.keys(TERMS_TOOL.inputSchema.properties).sort(), ["expires_by", "max_amount", "spender", "to", "token"]);
  assert.deepEqual(TERMS_TOOL.inputSchema.required, ["token", "max_amount", "expires_by"]);
});

test("the replay on the local chain holds every expectation (node run.mjs --check)", { timeout: 120_000 }, () => {
  assert.ok(existsSync(join(here, "..", "artifacts", "permit2.hex")), "the contract code is missing: run `npm run fetch` first");
  const run = spawnSync(process.execPath, [join(here, "..", "run.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Every expectation held\./);
});
