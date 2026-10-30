// x402 payments (D-058): USDC's EIP-3009 messages (packs/usdc.profile.json, packs/usdc-base-sepolia.profile.json) and
// x402's Permit2 payment (packs/x402-exact-permit2.profile.json), whose spender the profile pins (`fixed`). The requests
// are x402's own EIP-3009 example, two real x402 Permit2 payments settled on Base Sepolia (decoded from their settle
// calls; each signature recovers to its owner over the digest pinned here, docs/proposals/w0-x402.md §1) and made-up
// mainnet requests. Every digest pinned below was computed by an independent Python EIP-712 from the EIP's text, not by
// this package. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchemaValidator, resolveService, validateProfile } from "@meantjs/profile";
import { encodeCall, parseAbi } from "@meantjs/profile/evm";
import { eip712Consent, evmConsent } from "../src/evm.mjs";
import { checkGrant, confirmTerms, readTerms, termsText } from "../src/terms.mjs";

const validateSchema = await createSchemaValidator();
const doc = (name) => JSON.parse(readFileSync(new URL(`../../../packs/${name}.profile.json`, import.meta.url), "utf8"));
const resolvedOf = async (name) => {
  const v = await validateProfile(doc(name), { validateSchema, resolved: true });
  assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
  return v.resolved;
};
const usdc = await resolvedOf("usdc");
const sepolia = await resolvedOf("usdc-base-sepolia");
const x402 = await resolvedOf("x402-exact-permit2");
const permit2 = await resolvedOf("permit2");
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return `${e.code}: ${e.message}`;
  }
  return null;
};

const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ALICE = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const PAYEE = "0x5037546753d64F77A6fA95B6f85659B6a4A7F6FD"; // the payee of the two real Permit2 payments
const NONCE = `0x${"ab".repeat(32)}`;
const MAX256 = (2n ** 256n - 1n).toString();
const NOTE = "This is a signature, not a transaction: whoever holds it can submit it.";

const AUTH = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
const authorization = (primaryType, domain, message) => ({ types: { [primaryType]: AUTH }, primaryType, domain, message });
const BASE = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE };
const PAY = { from: ALICE, to: BOB, value: "2500000", validAfter: "1793318000", validBefore: "1793318600", nonce: NONCE };

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
/** A real x402 Permit2 payment on Base Sepolia, as its settle call carried it (transaction 0x79b9a6c5…1472). */
const realPayment = {
  types: WITNESS_TYPES,
  primaryType: "PermitWitnessTransferFrom",
  domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2 },
  message: { permitted: { token: USDC_SEPOLIA.toLowerCase(), amount: "11000" }, spender: PROXY, nonce: "3844945942549819", deadline: "1793318289", witness: { to: PAYEE.toLowerCase(), validAfter: "0" } },
};
const SEPOLIA_TOKENS = { [USDC_SEPOLIA]: { decimals: 6, symbol: "USDC" } };

test("x402's EIP-3009 example on Base Sepolia: one payment to `to`, which ends when it can no longer be submitted", () => {
  const example = authorization("TransferWithAuthorization", { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA }, {
    from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    value: "10000",
    validAfter: "1740672089",
    validBefore: "1740672154",
    nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
  });
  const r = eip712Consent({ resolved: sepolia, typedData: example, chainId: 84532 });
  const digest = "0xf256992871671abcb27ff92885a7afa46218724e5fc0bac35d050115aa1d22e6";
  assert.equal(
    r.message,
    [
      "# Pay USDC by signature",
      "",
      "Send `0.01 USDC` from `0x857b06519E91e3A54538791bDbb0E22373e36b66` to `0x209693Bc6afc0C5328bA36FaF03C514EF312287C`, once. Valid after `2025-02-27 16:01:29 UTC`. Expires: `2025-02-27 16:02:34 UTC`.",
      "",
      "- **Amount:** `0.01 USDC`",
      "- **From:** `0x857b06519E91e3A54538791bDbb0E22373e36b66`",
      "- **To:** `0x209693Bc6afc0C5328bA36FaF03C514EF312287C`",
      "- **Valid after:** `2025-02-27 16:01:29 UTC`",
      "- **Expires:** `2025-02-27 16:02:34 UTC`",
      "",
      `**Contract:** \`${USDC_SEPOLIA}\` on chain 84532`,
      "",
      `**EIP-712 digest:** \`${digest}\``,
      "",
      NOTE,
    ].join("\n"),
  );
  assert.deepEqual([r.typeHash, r.digest], ["0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267", digest]);
  // the token is the verifying contract; the grant ends at validBefore, one second after its last valid moment
  assert.deepEqual(r.grant, { kind: "transfer", to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", token: USDC_SEPOLIA, amount: { units: "10000", unlimited: false }, ends: { at: "1740672154" } });
  assert.equal(r.model.effect, "transfer");
});

test("USDC on Ethereum, Base and Arbitrum signs as USD Coin: its three messages, and what each grants", () => {
  const transfer = eip712Consent({ resolved: usdc, typedData: authorization("TransferWithAuthorization", BASE, PAY), chainId: 8453, form: "fields" });
  assert.deepEqual(transfer.message, {
    intent: `Pay USDC by signature: Send 2.5 USDC from ${ALICE} to ${BOB}, once. Valid after 2026-10-29T23:53:20Z. Expires: 2026-10-30T00:03:20Z.`,
    fields: [
      ["Amount", "2.5 USDC"],
      ["From", ALICE],
      ["To", BOB],
      ["Valid after", "2026-10-29T23:53:20Z"],
      ["Expires", "2026-10-30T00:03:20Z"],
      ["Contract", `${USDC_BASE} on chain 8453`],
      ["Signature", NOTE.slice(0, -1)],
      ["EIP-712 digest", "0x5a0037a267d27526ee317e8ef7732c45695417c48da1a0f03efde925dc33f2e0"],
    ],
  });
  assert.deepEqual(transfer.grant, { kind: "transfer", to: BOB, token: USDC_BASE, amount: { units: "2500000", unlimited: false }, ends: { at: "1793318600" } });
  // ReceiveWithAuthorization: the same payment, which only the payee can submit
  const receive = eip712Consent({ resolved: usdc, typedData: authorization("ReceiveWithAuthorization", BASE, PAY), chainId: 8453 });
  assert.equal(receive.message.split("\n")[2], `Send \`2.5 USDC\` from \`${ALICE}\` to \`${BOB}\`, once; only \`${BOB}\` can submit it. Valid after \`2026-10-29 23:53:20 UTC\`. Expires: \`2026-10-30 00:03:20 UTC\`.`);
  assert.deepEqual([receive.typeHash, receive.digest], ["0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8", "0x2d984ddfdec0fe851c2454a0fc885b1abb9316659edafa00d991d66fd3856a10"]);
  assert.deepEqual(receive.grant, transfer.grant);
  // CancelAuthorization grants nothing, so no terms cover it: it needs its own yes
  const cancel = eip712Consent({ resolved: usdc, chainId: 8453, typedData: { types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", domain: BASE, message: { authorizer: ALICE, nonce: NONCE } } });
  assert.equal(cancel.message.split("\n")[2], `Cancel the unused USDC payment signature of \`${ALICE}\` with nonce \`${NONCE}\`.`);
  assert.deepEqual([cancel.typeHash, cancel.digest, cancel.grant, cancel.model.effect], ["0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429", "0x16959e23f1a2411110af657b04ba5de48870c12692f0e82fed340d84c419f50d", null, "write"]);
  // a payment valid from the start of Unix time that never expires, on Ethereum; one on Arbitrum
  const never = eip712Consent({ resolved: usdc, chainId: 1, typedData: authorization("TransferWithAuthorization", { ...BASE, chainId: 1, verifyingContract: USDC_ETH }, { ...PAY, validAfter: "0", validBefore: MAX256 }) });
  assert.equal(never.message.split("\n")[2], `Send \`2.5 USDC\` from \`${ALICE}\` to \`${BOB}\`, once. Valid after \`1970-01-01 00:00:00 UTC\`. Expires: \`Never\`.`);
  assert.deepEqual([never.digest, never.grant.ends], ["0xe8dd0c787d6ce2935d5503785126f026afc258e57bd1dccab46d4f88e7e39cc2", { never: true }]);
  const arb = eip712Consent({ resolved: usdc, chainId: 42161, typedData: authorization("TransferWithAuthorization", { ...BASE, chainId: 42161, verifyingContract: USDC_ARB }, PAY) });
  assert.deepEqual([arb.digest, arb.grant.token], ["0xaa3161f5905f8167830d34578668d1e1b3195488b31e0e226f1a8a0de348699a", USDC_ARB]);
});

test("a USDC request for another domain, contract or chain gets no text", () => {
  const sepoliaDomain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA };
  for (const [label, resolved, typedData, chainId, want] of [
    ["Base Sepolia's name on Base", usdc, authorization("TransferWithAuthorization", { ...BASE, name: "USDC" }, PAY), 8453, 'E_DOMAIN: profile usdc describes the domain whose name is "USD Coin", not "USDC"'],
    ["the mainnets' name on Base Sepolia", sepolia, authorization("TransferWithAuthorization", { ...sepoliaDomain, name: "USD Coin" }, PAY), 84532, 'E_DOMAIN: profile usdc-base-sepolia describes the domain whose name is "USDC", not "USD Coin"'],
    ["version 1", usdc, authorization("TransferWithAuthorization", { ...BASE, version: "1" }, PAY), 8453, 'E_DOMAIN: profile usdc describes the domain whose version is "2", not "1"'],
    ["a look-alike token on Base", usdc, authorization("TransferWithAuthorization", { ...BASE, verifyingContract: BOB }, PAY), 8453, `E_DEPLOYMENT: profile usdc describes ${USDC_ETH} on chain 1, ${USDC_BASE} on chain 8453, ${USDC_ARB} on chain 42161, not ${BOB} on chain 8453`],
    ["Base's USDC with Base Sepolia's chain id", usdc, authorization("TransferWithAuthorization", { ...BASE, chainId: 84532 }, PAY), 84532, `E_DEPLOYMENT: profile usdc describes ${USDC_ETH} on chain 1, ${USDC_BASE} on chain 8453, ${USDC_ARB} on chain 42161, not ${USDC_BASE} on chain 84532`],
    ["the wallet on another chain", usdc, authorization("TransferWithAuthorization", BASE, PAY), 1, "E_DOMAIN: the domain is for chain 8453, the wallet is on chain 1"],
    ["a permit (EIP-2612), which these profiles do not describe", usdc, { types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "Permit", domain: BASE, message: { owner: ALICE, spender: BOB, value: "1", nonce: "0", deadline: "1" } }, 8453, "E_TYPE_HASH: no message of the resolved form has the type hash 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9 (Permit); a request is matched by its type hash, never by its name"],
  ]) {
    assert.equal(codeOf(() => eip712Consent({ resolved, typedData, chainId })), want, label);
  }
});

test("x402's Permit2 payment: words only with x402's proxy as the spender, which alone sends the tokens to the witness's `to`", () => {
  const r = eip712Consent({ resolved: x402, typedData: realPayment, chainId: 84532, tokens: SEPOLIA_TOKENS });
  const digest = "0xb7d4c3350b3445c498b1daf57934808f6b085d6f43f3958cc8f3ee1d8f06115b";
  assert.equal(
    r.message,
    [
      "# Pay by x402 through Permit2",
      "",
      `Send \`0.011 USDC (${USDC_SEPOLIA})\` to \`${PAYEE}\`, once, through x402's payment contract. Usable from \`now\`. Signature expires: \`2026-10-29 23:58:09 UTC\`.`,
      "",
      `- **Amount:** \`0.011 USDC (${USDC_SEPOLIA})\``,
      `- **To:** \`${PAYEE}\``,
      "- **Usable from:** `now`",
      "- **Signature expires:** `2026-10-29 23:58:09 UTC`",
      "",
      `**Contract:** \`${PERMIT2}\` on chain 84532`,
      "",
      `**EIP-712 digest:** \`${digest}\``,
      "",
      NOTE,
    ].join("\n"),
  );
  assert.deepEqual([r.typeHash, r.digest], ["0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7", digest]);
  assert.deepEqual(r.grant, { kind: "transfer", to: PAYEE, token: USDC_SEPOLIA, amount: { units: "11000", unlimited: false }, ends: { at: "1793318289" } });
  // the second real payment, which differs by its nonce and deadline
  const second = { ...realPayment, message: { ...realPayment.message, nonce: "5216997821287258", deadline: "1793318985" } };
  assert.equal(eip712Consent({ resolved: x402, typedData: second, chainId: 84532, tokens: SEPOLIA_TOKENS }).digest, "0xd4baaa1475925ca1f0927507dda647f24c0a9e9230ccd68f54a1efb2b14a2491");
  // the proxy's address in one case is the same address
  const lower = { ...realPayment, message: { ...realPayment.message, spender: PROXY.toLowerCase() } };
  assert.equal(eip712Consent({ resolved: x402, typedData: lower, chainId: 84532, tokens: SEPOLIA_TOKENS }).digest, digest);
  // on Base, in Base's USDC
  const base = eip712Consent({
    resolved: x402,
    chainId: 8453,
    tokens: { [USDC_BASE]: { decimals: 6, symbol: "USDC" } },
    typedData: { types: WITNESS_TYPES, primaryType: "PermitWitnessTransferFrom", domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2 }, message: { permitted: { token: USDC_BASE, amount: "2500000" }, spender: PROXY, nonce: "7", deadline: "1793318600", witness: { to: BOB, validAfter: "1793318000" } } },
  });
  assert.equal(base.message.split("\n")[2], `Send \`2.5 USDC (${USDC_BASE})\` to \`${BOB}\`, once, through x402's payment contract. Usable from \`2026-10-29 23:53:20 UTC\`. Signature expires: \`2026-10-30 00:03:20 UTC\`.`);
  assert.deepEqual([base.digest, base.grant.to, base.grant.ends], ["0x83ae9016f35609bdef421c86dd3e4342d77da6ef648fbc88984363e04be72380", BOB, { at: "1793318600" }]);
});

test("x402's Permit2 message with any other spender, witness or contract gets no text", () => {
  const thief = "0x1111111111111111111111111111111111111111";
  const upto = {
    ...realPayment,
    types: { ...WITNESS_TYPES, Witness: [{ name: "to", type: "address" }, { name: "facilitator", type: "address" }, { name: "validAfter", type: "uint256" }] },
    message: { ...realPayment.message, witness: { to: PAYEE, facilitator: PROXY, validAfter: "0" } },
  };
  for (const [label, resolved, typedData, want] of [
    // Permit2 lets the spender pick where the tokens go: with another spender the witness's `to` binds nothing
    ["another spender", x402, { ...realPayment, message: { ...realPayment.message, spender: thief } }, `E_FIXED: PermitWitnessTransferFrom(0).spender is ${thief}, but the profile describes PermitWitnessTransferFrom only with ${PROXY} there, so this request gets no text`],
    ["x402's upto scheme, whose witness names a facilitator", x402, upto, "E_TYPE_HASH: no message of the resolved form has the type hash 0x51dff6974ad4388c499e7fcfe838d2bd767162553a144098ce20ea661d70c2ee (PermitWitnessTransferFrom); a request is matched by its type hash, never by its name"],
    ["Permit2's own profile, which leaves witnesses out (O9)", permit2, realPayment, "E_TYPE_HASH: no message of the resolved form has the type hash 0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7 (PermitWitnessTransferFrom); a request is matched by its type hash, never by its name"],
    ["a look-alike Permit2", x402, { ...realPayment, domain: { ...realPayment.domain, verifyingContract: thief } }, `E_DEPLOYMENT: profile x402-exact-permit2 describes ${PERMIT2} on chain 1, ${PERMIT2} on chain 8453, ${PERMIT2} on chain 42161, ${PERMIT2} on chain 84532, not ${thief} on chain 84532`],
    ["a domain with a version", x402, { ...realPayment, domain: { ...realPayment.domain, version: "1" } }, 'E_DOMAIN: profile x402-exact-permit2 describes a domain without a version, not one whose version is "1"'],
  ]) {
    assert.equal(codeOf(() => eip712Consent({ resolved, typedData, chainId: 84532, tokens: SEPOLIA_TOKENS })), want, label);
  }
  // the pin is checked before the token table: no text, not even a request for the token's decimals
  assert.match(codeOf(() => eip712Consent({ resolved: x402, typedData: { ...realPayment, message: { ...realPayment.message, spender: thief } }, chainId: 84532 })), /^E_FIXED: /);
  // a resolved form whose pin is not an address is not trusted
  const forged = structuredClone(x402);
  forged.messages.PermitWitnessTransferFrom.args[0].fields.spender.tags.fixed.args.value = "x402";
  assert.match(codeOf(() => eip712Consent({ resolved: forged, typedData: realPayment, chainId: 84532, tokens: SEPOLIA_TOKENS })), /^E_RESOLVED_FORM: PermitWitnessTransferFrom\(0\)\.spender: fixed: /);
  forged.messages.PermitWitnessTransferFrom.args[0].fields.spender.tags.fixed = {};
  assert.match(codeOf(() => eip712Consent({ resolved: forged, typedData: realPayment, chainId: 84532, tokens: SEPOLIA_TOKENS })), /^E_RESOLVED_FORM: PermitWitnessTransferFrom\(0\)\.spender: fixed: /);
});

test("terms cover an x402 payment to the payee they name, up to their amount and their end, and no other", () => {
  const wallet = {
    tokens: { USDC: { address: USDC_SEPOLIA, decimals: 6 }, "USDC on Base": { address: USDC_BASE, decimals: 6 } },
    apps: { "Weather API": PAYEE },
    now: 1793318000n * 1_000_000_000n, // 2026-10-29 23:53:20 UTC
  };
  const terms = confirmTerms(readTerms({ token: "USDC", to: "Weather API", max_amount: "0.02", expires_by: "1 day" }, wallet));
  assert.equal(termsText(terms), `Weather API (${PAYEE}) may be sent at most 0.02 USDC, until the end of 30 October 2026 (UTC).`);
  const { grant } = eip712Consent({ resolved: x402, typedData: realPayment, chainId: 84532, tokens: SEPOLIA_TOKENS });
  assert.deepEqual(checkGrant(terms, grant, wallet), { fits: true, reasons: [] });
  assert.deepEqual(checkGrant(terms, { ...grant, to: BOB }, wallet), { fits: false, reasons: [`the recipient is ${BOB}, the terms say Weather API (${PAYEE})`] });
  assert.deepEqual(checkGrant(terms, { ...grant, amount: { units: "30000", unlimited: false } }, wallet), { fits: false, reasons: ["the request allows 0.03 USDC, the terms say at most 0.02 USDC"] });
  // a USDC payment by EIP-3009 that stays valid for a year ends later than the terms allow
  const year = eip712Consent({ resolved: usdc, chainId: 8453, typedData: authorization("TransferWithAuthorization", BASE, { ...PAY, to: PAYEE, validBefore: String(1793318000 + 365 * 86400) }) });
  assert.equal(year.digest, "0xcd958eb9ccadeb172da6704d626b73905172a370058b966e7f1aad2579fa1b8b");
  const baseTerms = confirmTerms(readTerms({ token: "USDC on Base", to: "Weather API", max_amount: "5", expires_by: "1 day" }, wallet));
  assert.deepEqual(checkGrant(baseTerms, year.grant, wallet), { fits: false, reasons: ["the permission lasts until 29 October 2027 at 23:53:20 (UTC), the terms say until the end of 30 October 2026 (UTC)"] });
  // the same payment for ten minutes fits
  const tenMinutes = eip712Consent({ resolved: usdc, chainId: 8453, typedData: authorization("TransferWithAuthorization", BASE, { ...PAY, to: PAYEE }) });
  assert.deepEqual(checkGrant(baseTerms, tenMinutes.grant, wallet), { fits: true, reasons: [] });
});

test("a pin holds in a call too: evmConsent refuses a function's argument that is not the pinned address", async () => {
  const ABI = ["function pay(address via, address to, uint256 amount) returns (bool)"];
  const profile = {
    format: "candid-profile",
    format_version: 0,
    kind: "contract",
    name: "router",
    origin: "author",
    binds: { abi: ABI },
    annotations: [
      { at: "pay", tag: "intent", args: { title: "Pay", template: "Pay {amount} to {to}" } },
      { at: "pay", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount" } } },
      { at: "pay(0).amount", tag: "amount", args: { decimals: 6, symbol: "USDC" } },
      { at: "pay(0).via", tag: "fixed", args: { value: PROXY } },
    ],
  };
  const r = await resolveService({ abi: ABI, validateSchema, profiles: [{ doc: profile }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const [pay] = parseAbi(ABI).functions;
  const call = (via) => encodeCall(pay, { via, to: BOB, amount: "1500000" });
  const ok = evmConsent({ resolved: r.resolved, calldata: call(PROXY), to: ALICE });
  assert.equal(ok.message.split("\n")[2], `Pay \`1.5 USDC\` to \`${BOB}\``);
  assert.deepEqual(ok.grant, { kind: "transfer", to: BOB, token: ALICE, amount: { units: "1500000", unlimited: false }, ends: { now: true } });
  assert.equal(codeOf(() => evmConsent({ resolved: r.resolved, calldata: call(BOB), to: ALICE })), `E_FIXED: pay(0).via is ${BOB}, but the profile describes pay only with ${PROXY} there, so this request gets no text`);
});
