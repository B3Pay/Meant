// The terms guard in front of an EVM signer (D-062): x402 payments as x402's own client hands them to its signer
// (`@x402/evm` 2.28.0, exact/client/eip3009.ts: uint256 values as bigints, addresses checksummed), signed only when a
// profile reads them and their grant fits the terms the user confirmed. The Permit2 payment is the real one of
// x402.test.mjs, whose digest an independent Python EIP-712 computed. The signer is a stand-in that records what it was
// asked to sign. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchemaValidator, validateProfile } from "@meantjs/profile";
import { eip712Consent } from "../src/evm.mjs";
import { CODES } from "../src/index.mjs";
import { GUARD_CODES, GuardError, guardSigner } from "../src/guard.mjs";
import { TERMS_CODES, TermsError, readTerms, termsGate } from "../src/terms.mjs";

const validateSchema = await createSchemaValidator();
const resolvedOf = async (name) => {
  const v = await validateProfile(JSON.parse(readFileSync(new URL(`../../../packs/${name}.profile.json`, import.meta.url), "utf8")), { validateSchema, resolved: true });
  assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
  return v.resolved;
};
/** Every profile with EIP-712 messages that ships in @meantjs/profile, as a wallet would pass them. */
const FORMS = await Promise.all(["usdc", "usdc-domain-usdc", "usdc-base-sepolia", "erc2612", "dai-permit", "permit2", "x402-exact-permit2", "x402-upto-permit2"].map(resolvedOf));
const x402 = FORMS[6];

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x5037546753d64F77A6fA95B6f85659B6a4A7F6FD";
const ALICE = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const SEPOLIA = 84532;
/** 29 October 2026, 23:00 UTC: an hour before the real payment's signature expires (23:58:09). */
const NOW = BigInt(Date.parse("2026-10-29T23:00:00Z")) * 1_000_000n;
const WALLET = { tokens: { USDC: { address: USDC_SEPOLIA, decimals: 6 } }, apps: { "Weather API": PAYEE }, now: NOW };
const TERMS = { token: "USDC", to: "Weather API", max_amount: "0.02", expires_by: "2026-10-30" };

const WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};
/** The real x402 Permit2 payment on Base Sepolia (transaction 0x79b9a6c5…1472), as x402's client passes it: bigints. */
const payment = (message = {}) => ({
  domain: { name: "Permit2", chainId: SEPOLIA, verifyingContract: PERMIT2 },
  types: WITNESS_TYPES,
  primaryType: "PermitWitnessTransferFrom",
  message: { permitted: { token: USDC_SEPOLIA, amount: 11000n }, spender: PROXY, nonce: 3844945942549819n, deadline: 1793318289n, witness: { to: PAYEE, validAfter: 0n }, ...message },
});
const REAL_DIGEST = "0xb7d4c3350b3445c498b1daf57934808f6b085d6f43f3958cc8f3ee1d8f06115b";
const AUTH = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
/** x402's EIP-3009 payment in Base Sepolia's USDC, built as exact/client/eip3009.ts builds it. */
const authorization = (message = {}) => ({
  domain: { name: "USDC", version: "2", chainId: SEPOLIA, verifyingContract: USDC_SEPOLIA },
  types: { TransferWithAuthorization: AUTH },
  primaryType: "TransferWithAuthorization",
  message: { from: ALICE, to: PAYEE, value: 15000n, validAfter: 0n, validBefore: 1793318600n, nonce: `0x${"ab".repeat(32)}`, ...message },
});

/** A stand-in signer with every way a viem LocalAccount can sign; it records each request it is asked to sign. */
function fakeSigner() {
  const signed = [];
  const never = (name) => () => assert.fail(`${name} must not be reachable through the guard`);
  return {
    signed,
    address: ALICE,
    signTypedData: async (params) => (signed.push(params), `0x${"5".repeat(130)}`),
    readContract: async (args) => ({ read: args.functionName }),
    signTransaction: never("signTransaction"),
    signMessage: never("signMessage"),
    signAuthorization: never("signAuthorization"),
  };
}
/** A gate whose terms the user confirmed, and the guarded signer behind it. */
function setup({ terms = TERMS, forms = FORMS, confirm = true } = {}) {
  const signer = fakeSigner();
  const gate = termsGate();
  const shown = gate.propose(readTerms(terms, WALLET));
  if (confirm) gate.confirm(shown);
  return { signer, gate, guarded: guardSigner(signer, { gate, wallet: WALLET, chainId: SEPOLIA, forms, now: () => NOW }) };
}
const refusal = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal");
};

test("an x402 Permit2 payment that fits the confirmed terms is signed, exactly as read", async () => {
  const { signer, guarded } = setup();
  const request = payment();
  assert.equal(await guarded.signTypedData(request), `0x${"5".repeat(130)}`);
  assert.equal(signer.signed.length, 1);
  assert.deepEqual(signer.signed[0], request);
  assert.notEqual(signer.signed[0], request, "the signer gets the copy that was checked, not the caller's object");
  assert.equal(eip712Consent({ resolved: x402, typedData: signer.signed[0], chainId: SEPOLIA, tokens: { [USDC_SEPOLIA]: { decimals: 6, symbol: "USDC" } } }).digest, REAL_DIGEST);
});

test("an x402 EIP-3009 payment in USDC that fits is signed", async () => {
  const { signer, guarded } = setup();
  await guarded.signTypedData(authorization());
  assert.equal(signer.signed.length, 1);
});

test("nothing is read or signed before the user confirms the terms", async () => {
  const { signer, guarded } = setup({ confirm: false });
  const e = await refusal(guarded.signTypedData(payment()));
  assert.ok(e instanceof TermsError);
  assert.equal(e.code, TERMS_CODES.ORDER);
  assert.equal(signer.signed.length, 0);
});

test("a payment over the terms, or to another payee, is refused with its reasons and not signed", async () => {
  for (const [label, request, reason] of [
    ["0.03 USDC under terms of 0.02", payment({ permitted: { token: USDC_SEPOLIA, amount: 30000n } }), /0\.03 USDC/],
    ["paid to Bob, not the Weather API", payment({ witness: { to: BOB, validAfter: 0n } }), new RegExp(BOB)],
    ["EIP-3009 over the terms", authorization({ value: 20001n }), /0\.020001 USDC/],
  ]) {
    const { signer, guarded } = setup();
    const e = await refusal(guarded.signTypedData(request));
    assert.ok(e instanceof GuardError, label);
    assert.equal(e.code, GUARD_CODES.REFUSED, label);
    assert.ok(e.reasons.length > 0 && e.reasons.some((r) => reason.test(r)), `${label}: ${e.reasons.join("; ")}`);
    assert.match(e.consent.digest, /^0x[0-9a-f]{64}$/, label);
    assert.equal(signer.signed.length, 0, label);
  }
});

test("a request no profile reads is refused: another chain, a spender other than x402's proxy, an unknown message", async () => {
  for (const [label, request, code] of [
    ["the domain names Base, the signer signs for Base Sepolia", { ...payment(), domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2 } }, "E_DOMAIN"],
    ["x402's witness with another spender", payment({ spender: BOB }), "E_FIXED"],
    ["a message no profile has", { domain: { name: "Mail", chainId: SEPOLIA, verifyingContract: PERMIT2 }, types: { Mail: [{ name: "body", type: "string" }] }, primaryType: "Mail", message: { body: "hi" } }, "E_TYPE_HASH"],
  ]) {
    const { signer, guarded } = setup();
    const e = await refusal(guarded.signTypedData(request));
    assert.ok(e instanceof GuardError, label);
    assert.equal(e.code, GUARD_CODES.UNKNOWN, label);
    assert.equal(e.reasons.length, FORMS.length, label);
    assert.ok(e.reasons.some((r) => r.includes(code)), `${label}: ${e.reasons.join("; ")}`);
    assert.equal(signer.signed.length, 0, label);
  }
});

test("profiles that read a request but disagree on its grant refuse it", async () => {
  const altered = structuredClone(x402);
  delete altered.messages.PermitWitnessTransferFrom.tags.effect.args.grant.ends; // a transfer that ends at once
  const { signer, guarded } = setup({ forms: [x402, altered] });
  const e = await refusal(guarded.signTypedData(payment()));
  assert.equal(e.code, GUARD_CODES.UNKNOWN);
  assert.equal(e.reasons.length, 2);
  assert.equal(signer.signed.length, 0);
});

test("the terms cover one request: the same one may be signed again, another is refused", async () => {
  const { signer, guarded } = setup();
  await guarded.signTypedData(payment());
  await guarded.signTypedData(payment()); // x402's client retrying the same payment
  const e = await refusal(guarded.signTypedData(payment({ nonce: 5216997821287258n })));
  assert.equal(e.code, TERMS_CODES.ORDER);
  assert.equal(signer.signed.length, 2);
});

test("the guarded signer keeps only address, signTypedData and the read-only readContract", async () => {
  const { guarded } = setup();
  assert.deepEqual(Object.keys(guarded).sort(), ["address", "readContract", "signTypedData"]);
  assert.ok(Object.isFrozen(guarded));
  assert.equal(guarded.address, ALICE);
  assert.deepEqual(await guarded.readContract({ functionName: "nonces" }), { read: "nonces" });
  const { readContract, ...noReads } = fakeSigner();
  assert.deepEqual(Object.keys(guardSigner(noReads, { gate: termsGate(), wallet: WALLET, chainId: SEPOLIA, forms: FORMS })).sort(), ["address", "signTypedData"]);
});

test("guardSigner refuses options it cannot guard with", () => {
  const gate = termsGate();
  for (const [label, signer, options] of [
    ["no signTypedData", { address: ALICE }, { gate, wallet: WALLET, chainId: SEPOLIA, forms: FORMS }],
    ["no gate", fakeSigner(), { wallet: WALLET, chainId: SEPOLIA, forms: FORMS }],
    ["no wallet", fakeSigner(), { gate, chainId: SEPOLIA, forms: FORMS }],
    ["no forms", fakeSigner(), { gate, wallet: WALLET, chainId: SEPOLIA, forms: [] }],
  ]) {
    assert.throws(() => guardSigner(signer, options), { code: CODES.REQUEST }, label);
  }
});

test("eip712Consent reads uint256 values given as bigints, as viem and x402 pass them, and bounds them", () => {
  const strings = { ...payment(), message: { permitted: { token: USDC_SEPOLIA, amount: "11000" }, spender: PROXY, nonce: "3844945942549819", deadline: "1793318289", witness: { to: PAYEE, validAfter: "0" } } };
  const tokens = { [USDC_SEPOLIA]: { decimals: 6, symbol: "USDC" } };
  assert.equal(eip712Consent({ resolved: x402, typedData: payment(), chainId: SEPOLIA, tokens }).digest, REAL_DIGEST);
  assert.equal(eip712Consent({ resolved: x402, typedData: strings, chainId: SEPOLIA, tokens }).digest, REAL_DIGEST);
  for (const amount of [-1n, 2n ** 256n]) {
    assert.throws(() => eip712Consent({ resolved: x402, typedData: payment({ permitted: { token: USDC_SEPOLIA, amount } }), chainId: SEPOLIA, tokens }), { code: CODES.DECODE }, String(amount));
  }
});
