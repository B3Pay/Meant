// x402 payments (D-058, D-059): USDC's EIP-3009 messages and its EIP-2612 permit (packs/usdc.profile.json where USDC
// signs as "USD Coin", packs/usdc-domain-usdc.profile.json where it signs as "USDC", and packs/usdc-base-sepolia.profile.json
// as 0.5.0 published it), and x402's two Permit2 payments, `exact` (packs/x402-exact-permit2.profile.json) and the
// usage-based `upto` (packs/x402-upto-permit2.profile.json), whose spenders the profiles pin (`fixed`). The requests are
// x402's own EIP-3009 example, real x402 payments settled on Base and Base Sepolia with the USDC permits that came with
// two of them (decoded from their settle calls; each signature recovers to its signer over the digest pinned here,
// docs/proposals/w0-x402.md §1 and docs/proposals/w0-x402-upto-networks.md §1.1), and made-up requests on the other
// chains. Every digest pinned below was computed by an independent Python EIP-712 from the EIP's text, not by this
// package. No chain, no network, nothing signed.
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
const usdcNamed = await resolvedOf("usdc-domain-usdc");
const x402 = await resolvedOf("x402-exact-permit2");
const upto = await resolvedOf("x402-upto-permit2");
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
const UPTO = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_FUJI = "0x5425890298aed601595a70AB815c96711a31Bc65";
const USDC_AVALANCHE = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const USDC_ARB_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const USDC_MONAD = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const OPG = "0xFbC2051AE2265686a469421b2C5A2D5462FbF5eB"; // OpenGradient's token on Base, 18 decimals, read on chain
/** The `usdc` profile's seven deployments, as E_DEPLOYMENT names them: each address once, with its chain. */
const USD_COIN_LISTED = `${USDC_ETH} on chain 1; ${USDC_POLYGON} on chain 137; ${USDC_BASE} on chain 8453; ${USDC_ARB} on chain 42161; ${USDC_FUJI} on chain 43113; ${USDC_AVALANCHE} on chain 43114; ${USDC_ARB_SEPOLIA} on chain 421614`;
const EXACT_CHAINS = "1, 50, 51, 137, 143, 1328, 1329, 4326, 8453, 10143, 31612, 42161, 42220, 43113, 43114, 80002, 84532, 421614, 5042002, 11142220";
const UPTO_CHAINS = "1, 50, 51, 137, 143, 1328, 1329, 4326, 8453, 10143, 31612, 42161, 43113, 43114, 80002, 84532, 421614, 5042002";
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

test("USDC on Ethereum, Base and Arbitrum signs as USD Coin: its three EIP-3009 messages, and what each grants", () => {
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
    ["a look-alike token on Base", usdc, authorization("TransferWithAuthorization", { ...BASE, verifyingContract: BOB }, PAY), 8453, `E_DEPLOYMENT: profile usdc describes ${USD_COIN_LISTED}, not ${BOB} on chain 8453`],
    ["Base's USDC with Base Sepolia's chain id", usdc, authorization("TransferWithAuthorization", { ...BASE, chainId: 84532 }, PAY), 84532, `E_DEPLOYMENT: profile usdc describes ${USD_COIN_LISTED}, not ${USDC_BASE} on chain 84532`],
    ["the wallet on another chain", usdc, authorization("TransferWithAuthorization", BASE, PAY), 1, "E_DOMAIN: the domain is for chain 8453, the wallet is on chain 1"],
    ["DAI's older permit, which USDC does not have", usdc, { types: { Permit: [{ name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }] }, primaryType: "Permit", domain: BASE, message: { holder: ALICE, spender: BOB, nonce: "0", expiry: "0", allowed: true } }, 8453, "E_TYPE_HASH: no message of the resolved form has the type hash 0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb (Permit); a request is matched by its type hash, never by its name"],
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
    ["a look-alike Permit2", x402, { ...realPayment, domain: { ...realPayment.domain, verifyingContract: thief } }, `E_DEPLOYMENT: profile x402-exact-permit2 describes ${PERMIT2} on chains ${EXACT_CHAINS}, not ${thief} on chain 84532`],
    // the `upto` proxy settles another witness: as the spender of an `exact` message it is just another spender
    ["x402's upto proxy as the spender", x402, { ...realPayment, message: { ...realPayment.message, spender: UPTO } }, `E_FIXED: PermitWitnessTransferFrom(0).spender is ${UPTO}, but the profile describes PermitWitnessTransferFrom only with ${PROXY} there, so this request gets no text`],
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

// x402's `upto` payment (D-059): the payer signs a maximum, and the facilitator its witness names settles once, for up to it.
const UPTO_TYPES = { ...WITNESS_TYPES, Witness: [{ name: "to", type: "address" }, { name: "facilitator", type: "address" }, { name: "validAfter", type: "uint256" }] };
const uptoRequest = (chainId, message) => ({ types: UPTO_TYPES, primaryType: "PermitWitnessTransferFrom", domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 }, message: { spender: UPTO, ...message } });
const UPTO_TYPE_HASH = "0x51dff6974ad4388c499e7fcfe838d2bd767162553a144098ce20ea661d70c2ee";
/** Real `upto` payments, as their settle calls carried them; the settled amount in each comment. */
const OPG_PAYMENT = uptoRequest(8453, {
  // transaction 0x31a3462c…6ce1 on Base: 1.623078490035223204 OPG settled; facilitator 0xA71c…13Bb
  permitted: { token: OPG, amount: "5000000000000000000" },
  nonce: "91804064418598571178323270408709541119576526275516763268525086074812825340502",
  deadline: "1793524470",
  witness: { to: "0x9deEBB5D1b22e4a6e027977CeAd13893A7E4cC1a", facilitator: "0xA71c98C0d28c63DBf7ca36f878d6e8De6Bd213Bb", validAfter: "1793520270" },
});
const SELF_SETTLED = uptoRequest(8453, {
  // transaction 0x25c8fbcb…5797 on Base: 0.005809 USDC settled by the payee itself
  permitted: { token: USDC_BASE, amount: "12288" },
  nonce: "3365275116029128009042892425096481779512263621001254706244357686076557360514",
  deadline: "1793521409",
  witness: { to: "0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2", facilitator: "0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2", validAfter: "0" },
});
const SEARCH_API = "0xA9dd7CC9CBF0e05551332209289f04bE36bc2315";
const FACILITATOR = "0xa32cCda98ba7529705a059Bd2d213Da8de10d101";
const WITH_PERMIT = uptoRequest(8453, {
  // transaction 0x0f3a20b0…e416 on Base, settleWithPermit: 0.008164 USDC settled
  permitted: { token: USDC_BASE, amount: "40880" },
  nonce: "45683107745615768306071119239521134110482688231919278329468116869571806058431",
  deadline: "1793522055",
  witness: { to: SEARCH_API, facilitator: FACILITATOR, validAfter: "0" },
});
const SEPOLIA_UPTO = uptoRequest(84532, {
  // transaction 0xd9aafc67…30f6 on Base Sepolia, settleWithPermit: 0.00255 USDC settled
  permitted: { token: USDC_SEPOLIA, amount: "3225" },
  nonce: "33025773047518042687964972423279648961451523405799956615957467036502929771011",
  deadline: "1793522072",
  witness: { to: "0x691CE830c4c2478F2a2F65085E89F3d0aAac5e02", facilitator: FACILITATOR, validAfter: "0" },
});
const PERMIT_TYPE = [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }];
const permitRequest = (domain, message) => ({ types: { Permit: PERMIT_TYPE }, primaryType: "Permit", domain, message });
/** The USDC permits for Permit2 that came with the last two payments, their value each payment's maximum. */
const BASE_PERMIT = permitRequest(BASE, { owner: "0x245210f69216a7716Fa3AEcF126A610F7cF4760C", spender: PERMIT2, value: "40880", nonce: "4108", deadline: "1793522055" });
const SEPOLIA_PERMIT = permitRequest({ name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA }, { owner: "0x2cFA1D4a51710bd9AB2D688095d6f33a9fBd718d", spender: PERMIT2, value: "3225", nonce: "0", deadline: "1793522072" });
const UPTO_TOKENS = { [OPG]: { decimals: 18, symbol: "OPG" }, [USDC_BASE]: { decimals: 6, symbol: "USDC" }, [USDC_SEPOLIA]: { decimals: 6, symbol: "USDC" } };

test("x402's upto payment: at most its maximum to the witness's `to`, once, settled only by the facilitator it names", () => {
  const r = eip712Consent({ resolved: upto, typedData: OPG_PAYMENT, chainId: 8453, tokens: UPTO_TOKENS });
  const digest = "0x1991e6d3699dec22bbd4c65f3ef3a180bdf42aefc69e5071b9df54ad13c9ab5a";
  assert.equal(
    r.message,
    [
      "# Pay by x402 up to a maximum, through Permit2",
      "",
      `Send at most \`5 OPG (${OPG})\` to \`0x9deEBB5D1b22e4a6e027977CeAd13893A7E4cC1a\`, once, through x402's usage-based payment contract. Only \`0xA71c98C0d28c63DBf7ca36f878d6e8De6Bd213Bb\` can settle it, and it chooses the amount. Usable from \`2026-11-01 08:04:30 UTC\`. Signature expires: \`2026-11-01 09:14:30 UTC\`.`,
      "",
      `- **Maximum amount:** \`5 OPG (${OPG})\``,
      "- **To:** `0x9deEBB5D1b22e4a6e027977CeAd13893A7E4cC1a`",
      "- **Settled by:** `0xA71c98C0d28c63DBf7ca36f878d6e8De6Bd213Bb`",
      "- **Usable from:** `2026-11-01 08:04:30 UTC`",
      "- **Signature expires:** `2026-11-01 09:14:30 UTC`",
      "",
      `**Contract:** \`${PERMIT2}\` on chain 8453`,
      "",
      `**EIP-712 digest:** \`${digest}\``,
      "",
      NOTE,
    ].join("\n"),
  );
  assert.deepEqual([r.typeHash, r.digest], [UPTO_TYPE_HASH, digest]);
  // the grant is the maximum: the payer bears the risk of all of it being charged
  assert.deepEqual(r.grant, { kind: "transfer", to: "0x9deEBB5D1b22e4a6e027977CeAd13893A7E4cC1a", token: OPG, amount: { units: "5000000000000000000", unlimited: false }, ends: { at: "1793524470" } });
  // a payee that settles its own payments
  const self = eip712Consent({ resolved: upto, typedData: SELF_SETTLED, chainId: 8453, tokens: UPTO_TOKENS, form: "fields" });
  assert.deepEqual(self.message, {
    intent: `Pay by x402 up to a maximum, through Permit2: Send at most 0.012288 USDC (${USDC_BASE}) to 0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2, once, through x402's usage-based payment contract. Only 0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2 can settle it, and it chooses the amount. Usable from now. Signature expires: 2026-11-01T08:23:29Z.`,
    fields: [
      ["Maximum amount", `0.012288 USDC (${USDC_BASE})`],
      ["To", "0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2"],
      ["Settled by", "0x0F99fc0CBD7A114b2DA171FDa5A0167858f7afC2"],
      ["Usable from", "now"],
      ["Signature expires", "2026-11-01T08:23:29Z"],
      ["Contract", `${PERMIT2} on chain 8453`],
      ["Signature", NOTE.slice(0, -1)],
      ["EIP-712 digest", "0xb144a403c843dde575b0427f2bc63a5fa4edfb605161c88f690e989463869a8b"],
    ],
  });
  // the two that came with a USDC permit, on Base and on Base Sepolia
  const base = eip712Consent({ resolved: upto, typedData: WITH_PERMIT, chainId: 8453, tokens: UPTO_TOKENS });
  assert.equal(base.message.split("\n")[2], `Send at most \`0.04088 USDC (${USDC_BASE})\` to \`${SEARCH_API}\`, once, through x402's usage-based payment contract. Only \`${FACILITATOR}\` can settle it, and it chooses the amount. Usable from \`now\`. Signature expires: \`2026-11-01 08:34:15 UTC\`.`);
  assert.deepEqual([base.digest, base.grant], ["0x6586b37030fe585642b7edec54b6e4618394d279d0df0a1ba90192ce7af07ede", { kind: "transfer", to: SEARCH_API, token: USDC_BASE, amount: { units: "40880", unlimited: false }, ends: { at: "1793522055" } }]);
  const sepoliaPayment = eip712Consent({ resolved: upto, typedData: SEPOLIA_UPTO, chainId: 84532, tokens: UPTO_TOKENS });
  assert.deepEqual([sepoliaPayment.digest, sepoliaPayment.grant.amount], ["0x66c55b9f3afd85a7277708a09d74934f2894095b67650887358196f96a6e0340", { units: "3225", unlimited: false }]);
  // on Avalanche, a network 0.5.0 did not list
  const avalanche = eip712Consent({ resolved: upto, chainId: 43114, tokens: { [USDC_AVALANCHE]: { decimals: 6, symbol: "USDC" } }, typedData: uptoRequest(43114, { permitted: { token: USDC_AVALANCHE, amount: "2500000" }, nonce: "8", deadline: "1793318600", witness: { to: BOB, facilitator: ALICE, validAfter: "0" } }) });
  assert.deepEqual([avalanche.digest, avalanche.grant.to, avalanche.grant.token], ["0x1b91d631016d191563be45ebbb862694054ff5da616401469fbedfdc0084716b", BOB, USDC_AVALANCHE]);
});

test("x402's upto message with any other spender, witness, chain or domain gets no text", () => {
  const thief = "0x1111111111111111111111111111111111111111";
  const fixedFor = (spender) => `E_FIXED: PermitWitnessTransferFrom(0).spender is ${spender}, but the profile describes PermitWitnessTransferFrom only with ${UPTO} there, so this request gets no text`;
  for (const [label, resolved, typedData, chainId, want] of [
    // Permit2 lets the spender pick where the tokens go: with another spender the witness binds nothing
    ["another spender", upto, { ...WITH_PERMIT, message: { ...WITH_PERMIT.message, spender: thief } }, 8453, fixedFor(thief)],
    ["x402's exact proxy, which reads another witness", upto, { ...WITH_PERMIT, message: { ...WITH_PERMIT.message, spender: PROXY } }, 8453, fixedFor(PROXY)],
    ["x402's exact witness", upto, realPayment, 84532, "E_TYPE_HASH: no message of the resolved form has the type hash 0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7 (PermitWitnessTransferFrom); a request is matched by its type hash, never by its name"],
    ["x402's upto witness in the exact profile", x402, WITH_PERMIT, 8453, `E_TYPE_HASH: no message of the resolved form has the type hash ${UPTO_TYPE_HASH} (PermitWitnessTransferFrom); a request is matched by its type hash, never by its name`],
    ["Permit2's own profile, which leaves witnesses out (O9)", permit2, WITH_PERMIT, 8453, `E_TYPE_HASH: no message of the resolved form has the type hash ${UPTO_TYPE_HASH} (PermitWitnessTransferFrom); a request is matched by its type hash, never by its name`],
    // Celo has Permit2 and x402's exact proxy, not its upto proxy (docs/proposals/w0-x402-upto-networks.md §2)
    ["Celo, which has no upto proxy", upto, { ...WITH_PERMIT, domain: { ...WITH_PERMIT.domain, chainId: 42220 } }, 42220, `E_DEPLOYMENT: profile x402-upto-permit2 describes ${PERMIT2} on chains ${UPTO_CHAINS}, not ${PERMIT2} on chain 42220`],
    ["a look-alike Permit2", upto, { ...WITH_PERMIT, domain: { ...WITH_PERMIT.domain, verifyingContract: thief } }, 8453, `E_DEPLOYMENT: profile x402-upto-permit2 describes ${PERMIT2} on chains ${UPTO_CHAINS}, not ${thief} on chain 8453`],
    ["a domain with a version", upto, { ...WITH_PERMIT, domain: { ...WITH_PERMIT.domain, version: "1" } }, 8453, 'E_DOMAIN: profile x402-upto-permit2 describes a domain without a version, not one whose version is "1"'],
  ]) {
    assert.equal(codeOf(() => eip712Consent({ resolved, typedData, chainId, tokens: UPTO_TOKENS })), want, label);
  }
  // the pin is checked before the token table
  assert.equal(codeOf(() => eip712Consent({ resolved: upto, typedData: { ...WITH_PERMIT, message: { ...WITH_PERMIT.message, spender: thief } }, chainId: 8453 })), fixedFor(thief));
  // while x402's exact payment is read on Celo
  const celo = eip712Consent({
    resolved: x402,
    chainId: 42220,
    tokens: { "0xcebA9300f2b948710d2653dD7B07f33A8B32118C": { decimals: 6, symbol: "USDC" } },
    typedData: { types: WITNESS_TYPES, primaryType: "PermitWitnessTransferFrom", domain: { name: "Permit2", chainId: 42220, verifyingContract: PERMIT2 }, message: { permitted: { token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", amount: "1000000" }, spender: PROXY, nonce: "9", deadline: "1793318600", witness: { to: BOB, validAfter: "0" } } },
  });
  assert.deepEqual([celo.digest, celo.grant.amount], ["0x5a12c5045e39d5bc32281db6a19903cc72ad18aaf354470e03978299d200559a", { units: "1000000", unlimited: false }]);
});

test("the USDC permit an upto payment carries: Permit2 may spend the maximum, and the allowance never ends", () => {
  const r = eip712Consent({ resolved: usdc, typedData: BASE_PERMIT, chainId: 8453, form: "fields" });
  assert.deepEqual(r.message, {
    intent: `Permit USDC spending: Allow ${PERMIT2} to spend up to 0.04088 USDC from 0x245210f69216a7716Fa3AEcF126A610F7cF4760C. Signature expires: 2026-11-01T08:34:15Z.`,
    fields: [
      ["Spender", PERMIT2],
      ["Amount", "0.04088 USDC"],
      ["Owner", "0x245210f69216a7716Fa3AEcF126A610F7cF4760C"],
      ["Signature expires", "2026-11-01T08:34:15Z"],
      ["Contract", `${USDC_BASE} on chain 8453`],
      ["Signature", NOTE.slice(0, -1)],
      ["EIP-712 digest", "0x7f6350eb1c24f51070881b873857e8bd476c99ddf5c6845b809998eb802f2c8b"],
    ],
  });
  assert.equal(r.typeHash, "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9");
  // the allowance is the payment's maximum, to Permit2, not to the payee, and outlives the signature's deadline
  assert.equal(BASE_PERMIT.message.value, WITH_PERMIT.message.permitted.amount);
  assert.deepEqual(r.grant, { kind: "approve", spender: PERMIT2, token: USDC_BASE, amount: { units: "40880", unlimited: false }, ends: { never: true } });
  assert.equal(r.model.effect, "approve");
  // Base Sepolia's, through the profile for the chains where USDC signs as USDC
  const s = eip712Consent({ resolved: usdcNamed, typedData: SEPOLIA_PERMIT, chainId: 84532 });
  assert.deepEqual([s.digest, s.grant], ["0x4c94c02d8c56904cb4aade69280dca1d0880e9a409fd09880586a04819194dbb", { kind: "approve", spender: PERMIT2, token: USDC_SEPOLIA, amount: { units: "3225", unlimited: false }, ends: { never: true } }]);
  // usdc-base-sepolia stays as 0.5.0 published it, without the permit
  assert.equal(codeOf(() => eip712Consent({ resolved: sepolia, typedData: SEPOLIA_PERMIT, chainId: 84532 })), "E_TYPE_HASH: no message of the resolved form has the type hash 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9 (Permit); a request is matched by its type hash, never by its name");
  // uint256 max reads as unlimited, and a deadline of uint256 max never expires
  const unlimited = eip712Consent({ resolved: usdc, chainId: 137, typedData: permitRequest({ ...BASE, chainId: 137, verifyingContract: USDC_POLYGON }, { owner: ALICE, spender: PERMIT2, value: MAX256, nonce: "0", deadline: MAX256 }) });
  assert.equal(unlimited.message.split("\n")[2], `Allow \`${PERMIT2}\` to spend up to \`Unlimited USDC\` from \`${ALICE}\`. Signature expires: \`Never\`.`);
  assert.deepEqual([unlimited.digest, unlimited.grant.amount, unlimited.grant.ends], ["0x0ecfbb3c9271576e028da0ab514f6b168ee58b45a3ea039d20cca3834e6acb9f", { units: MAX256, unlimited: true }, { never: true }]);
});

test("x402's networks: USDC by its own domain name on each chain, with the same words", () => {
  const MONAD = { name: "USDC", version: "2", chainId: 143, verifyingContract: USDC_MONAD };
  const polygon = eip712Consent({ resolved: usdc, chainId: 137, typedData: authorization("TransferWithAuthorization", { ...BASE, chainId: 137, verifyingContract: USDC_POLYGON }, PAY) });
  const monad = eip712Consent({ resolved: usdcNamed, chainId: 143, typedData: authorization("TransferWithAuthorization", MONAD, PAY) });
  assert.deepEqual([polygon.digest, monad.digest], ["0x13767c16840cadee41349d8786940013bd7a33d64406989da0bfe69172ce7372", "0x0033fb9e01188457c00e0e81411924364f6a9d0455a2d083bafc4800cfcdb53d"]);
  assert.equal(monad.message.split("\n")[2], `Send \`2.5 USDC\` from \`${ALICE}\` to \`${BOB}\`, once. Valid after \`2026-10-29 23:53:20 UTC\`. Expires: \`2026-10-30 00:03:20 UTC\`.`);
  assert.equal(polygon.message.split("\n")[2], monad.message.split("\n")[2]);
  assert.deepEqual([polygon.grant.token, monad.grant.token], [USDC_POLYGON, USDC_MONAD]);
  const permit = eip712Consent({ resolved: usdcNamed, chainId: 143, typedData: permitRequest(MONAD, { owner: ALICE, spender: PERMIT2, value: "2500000", nonce: "1", deadline: "1793318600" }) });
  assert.deepEqual([permit.digest, permit.grant.amount], ["0xa170b1d039dffd57dc46c8358264c50a1bcbfbb273bab7acb7927cf563d07fd1", { units: "2500000", unlimited: false }]);
  // each chain's name and contract, and no other
  for (const [label, resolved, typedData, chainId, want] of [
    ["the mainnets' name on Monad", usdcNamed, authorization("TransferWithAuthorization", { ...MONAD, name: "USD Coin" }, PAY), 143, 'E_DOMAIN: profile usdc-domain-usdc describes the domain whose name is "USDC", not "USD Coin"'],
    ["Monad's name on Polygon", usdc, authorization("TransferWithAuthorization", { ...BASE, name: "USDC", chainId: 137, verifyingContract: USDC_POLYGON }, PAY), 137, 'E_DOMAIN: profile usdc describes the domain whose name is "USD Coin", not "USDC"'],
    ["Polygon's USDC in the profile for the other name", usdcNamed, authorization("TransferWithAuthorization", { ...MONAD, chainId: 137, verifyingContract: USDC_POLYGON }, PAY), 137, `E_DEPLOYMENT: profile usdc-domain-usdc describes 0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1 on chain 50; 0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4 on chain 51; ${USDC_MONAD} on chain 143; 0x4fCF1784B31630811181f670Aea7A7bEF803eaED on chain 1328; 0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392 on chain 1329; 0x534b2f3A21130d7a60830c2Df862319e593943A3 on chain 10143; 0xcebA9300f2b948710d2653dD7B07f33A8B32118C on chain 42220; 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582 on chain 80002; ${USDC_SEPOLIA} on chain 84532; 0x3600000000000000000000000000000000000000 on chain 5042002; 0x01C5C0122039549AD1493B8220cABEdD739BC44E on chain 11142220, not ${USDC_POLYGON} on chain 137`],
  ]) {
    assert.equal(codeOf(() => eip712Consent({ resolved, typedData, chainId })), want, label);
  }
  // x402's exact payment through Permit2 on Avalanche
  const exact = eip712Consent({
    resolved: x402,
    chainId: 43114,
    tokens: { [USDC_AVALANCHE]: { decimals: 6, symbol: "USDC" } },
    typedData: { types: WITNESS_TYPES, primaryType: "PermitWitnessTransferFrom", domain: { name: "Permit2", chainId: 43114, verifyingContract: PERMIT2 }, message: { permitted: { token: USDC_AVALANCHE, amount: "2500000" }, spender: PROXY, nonce: "7", deadline: "1793318600", witness: { to: BOB, validAfter: "1793318000" } } },
  });
  assert.deepEqual([exact.digest, exact.grant.to], ["0xe320bf6e8f4d1b2ad71660d148519ab83df72c14d546a7f3f3b80b669e9fcf12", BOB]);
});

test("usdc-domain-usdc reads Base Sepolia's EIP-3009 messages with the words of usdc-base-sepolia, as 0.5.0 published it", () => {
  const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA };
  const cancel = { types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", domain, message: { authorizer: ALICE, nonce: NONCE } };
  for (const typedData of [authorization("TransferWithAuthorization", domain, PAY), authorization("ReceiveWithAuthorization", domain, PAY), cancel]) {
    const [a, b] = [usdcNamed, sepolia].map((resolved) => eip712Consent({ resolved, typedData, chainId: 84532 }));
    assert.deepEqual([a.message, a.digest, a.grant, a.model.effect], [b.message, b.digest, b.grant, b.model.effect], typedData.primaryType);
  }
});

test("terms cover an x402 upto payment up to its maximum, to the payee they name; its permit only under terms for Permit2 that never end", () => {
  const wallet = {
    tokens: { USDC: { address: USDC_BASE, decimals: 6 } },
    apps: { "Search API": SEARCH_API, Permit2: PERMIT2 },
    now: 1793521200n * 1_000_000_000n, // 2026-11-01 08:20:00 UTC
  };
  const terms = confirmTerms(readTerms({ token: "USDC", to: "Search API", max_amount: "0.05", expires_by: "1 day" }, wallet));
  assert.equal(termsText(terms), `Search API (${SEARCH_API}) may be sent at most 0.05 USDC, until the end of 2 November 2026 (UTC).`);
  const { grant } = eip712Consent({ resolved: upto, typedData: WITH_PERMIT, chainId: 8453, tokens: UPTO_TOKENS });
  assert.deepEqual(checkGrant(terms, grant, wallet), { fits: true, reasons: [] });
  // what the facilitator settles later does not matter: a maximum above the terms is refused
  const larger = eip712Consent({ resolved: upto, typedData: { ...WITH_PERMIT, message: { ...WITH_PERMIT.message, permitted: { token: USDC_BASE, amount: "60000" } } }, chainId: 8453, tokens: UPTO_TOKENS });
  assert.deepEqual(checkGrant(terms, larger.grant, wallet), { fits: false, reasons: ["the request allows 0.06 USDC, the terms say at most 0.05 USDC"] });
  assert.deepEqual(checkGrant(terms, { ...grant, to: BOB }, wallet), { fits: false, reasons: [`the recipient is ${BOB}, the terms say Search API (${SEARCH_API})`] });
  // the permit lets Permit2 spend, for good: terms for the payee never cover it, nor do terms that end
  const permit = eip712Consent({ resolved: usdc, typedData: BASE_PERMIT, chainId: 8453 });
  assert.deepEqual(checkGrant(terms, permit.grant, wallet), {
    fits: false,
    reasons: [`the request lets Permit2 (${PERMIT2}) spend, the terms pay Search API (${SEARCH_API}) directly`, "the permission never ends, the terms say until the end of 2 November 2026 (UTC)"],
  });
  const permit2Terms = confirmTerms(readTerms({ token: "USDC", spender: "Permit2", max_amount: "0.05", expires_by: "1 day" }, wallet));
  assert.deepEqual(checkGrant(permit2Terms, permit.grant, wallet), { fits: false, reasons: ["the permission never ends, the terms say until the end of 2 November 2026 (UTC)"] });
  // only terms that name Permit2 and plainly never end cover it, and their words say so
  const standing = confirmTerms(readTerms({ token: "USDC", spender: "Permit2", max_amount: "0.05", expires_by: "never" }, wallet));
  assert.equal(termsText(standing), `Permit2 (${PERMIT2}) may spend at most 0.05 USDC, and this permission never ends.`);
  assert.deepEqual(checkGrant(standing, permit.grant, wallet), { fits: true, reasons: [] });
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
