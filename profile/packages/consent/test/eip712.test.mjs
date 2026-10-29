// The consent text of an EIP-712 signing request (spec section 15.9, D-055) for the three standard files: Permit2,
// EIP-2612 and DAI's permit. Each digest pinned below was computed by an independent Python EIP-712 from the EIP's text
// (the phase 1 cross-check tool), not by this package; Permit2's domain separator on chain 1 is the one its contract
// returns. Also: an EVM call whose amount is in the token a parameter names. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchemaValidator, resolveService, validateProfile } from "@meantjs/profile";
import { keccak256Hex, typedDataDigest } from "@meantjs/profile/evm";
import { eip712Consent, evmConsent } from "../src/evm.mjs";
import { CODES } from "../src/index.mjs";

const validateSchema = await createSchemaValidator();
const doc = (name) => JSON.parse(readFileSync(new URL(`../../../packs/${name}.profile.json`, import.meta.url), "utf8"));
const resolvedOf = async (name) => {
  const v = await validateProfile(doc(name), { validateSchema, resolved: true });
  assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
  return v.resolved;
};
const permit2 = await resolvedOf("permit2");
const dai = await resolvedOf("dai-permit");
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return `${e.code}: ${e.message}`;
  }
  return null;
};

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SPENDER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const ALICE = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const MAX160 = (2n ** 160n - 1n).toString();
const MAX256 = (2n ** 256n - 1n).toString();
const TOKENS = { [USDC]: { decimals: 6, symbol: "USDC" }, [WETH.toLowerCase()]: { decimals: 18, symbol: "WETH" } };
const NOTE = "This is a signature, not a transaction: whoever holds it can submit it";

const DETAILS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint160" },
  { name: "expiration", type: "uint48" },
  { name: "nonce", type: "uint48" },
];
const single = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: DETAILS,
  },
  primaryType: "PermitSingle",
  domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
  message: { details: { token: USDC, amount: MAX160, expiration: 1798761600, nonce: 0 }, spender: SPENDER, sigDeadline: "1767225600" },
};
const batch = {
  types: {
    PermitBatch: [
      { name: "details", type: "PermitDetails[]" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: DETAILS,
  },
  primaryType: "PermitBatch",
  domain: single.domain,
  message: {
    details: [
      { token: USDC, amount: "1500000", expiration: 0, nonce: 1 },
      { token: WETH, amount: MAX160, expiration: (2 ** 48 - 1).toString(), nonce: 0 },
    ],
    spender: SPENDER,
    sigDeadline: MAX256,
  },
};

test("Permit2 PermitSingle: an unlimited allowance in the token the message names, its address beside its symbol", () => {
  const r = eip712Consent({ resolved: permit2, typedData: single, chainId: 1, tokens: TOKENS });
  const digest = "0x9ef37dd326b6b0f5d27ef466345f06060599f032c7dfd8c6645543d7025f56f9";
  assert.equal(
    r.message,
    [
      "# Permit2: allow token spending",
      "",
      `Let \`${SPENDER}\` spend up to \`Unlimited USDC (${USDC})\`. Allowance expires: \`2027-01-01 00:00:00 UTC\`. Signature expires: \`2026-01-01 00:00:00 UTC\`.`,
      "",
      `- **Spender:** \`${SPENDER}\``,
      `- **Amount:** \`Unlimited USDC (${USDC})\``,
      "- **Allowance expires:** `2027-01-01 00:00:00 UTC`",
      "- **Signature expires:** `2026-01-01 00:00:00 UTC`",
      "",
      `**Contract:** \`${PERMIT2}\` on chain 1`,
      "",
      `**EIP-712 digest:** \`${digest}\``,
      "",
      `${NOTE}.`,
    ].join("\n"),
  );
  assert.deepEqual([r.primaryType, r.typeHash, r.digest, r.verifyingContract, r.chainId], ["PermitSingle", "0xf3841cd1ff0085026a6327b620b67997ce40f282c88a8e905a7a5626e310f3d0", digest, PERMIT2, "1"]);
  assert.equal(r.digest, typedDataDigest(single));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.provenance.intent, { origin: "third_party", profile: "permit2" });
  // the domain separator is Permit2's own on chain 1 (its DOMAIN_SEPARATOR())
  const sep = keccak256Hex(new Uint8Array([...Buffer.from(keccak256Hex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), "hex"), ...Buffer.from(keccak256Hex("Permit2"), "hex"), ...new Uint8Array(31), 1, ...new Uint8Array(12), ...Buffer.from(PERMIT2.slice(2), "hex")]));
  assert.equal(sep, "866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28");
  // types.EIP712Domain may be left out; the same request gives the same digest
  const { EIP712Domain, ...types } = single.types;
  assert.equal(eip712Consent({ resolved: permit2, typedData: { ...single, types }, chainId: "1", tokens: TOKENS }).digest, digest);
  // and so may its members' JSON keys come in another order
  const flipped = single.types.EIP712Domain.map(({ name, type }) => ({ type, name }));
  assert.equal(eip712Consent({ resolved: permit2, typedData: { ...single, types: { ...types, EIP712Domain: flipped } }, chainId: "1", tokens: TOKENS }).digest, digest);
});

test("Permit2 PermitBatch: every element in its own token, an expiration of 0 and of uint48 max in words", () => {
  const r = eip712Consent({ resolved: permit2, typedData: batch, chainId: 1n, tokens: TOKENS, form: "fields" });
  assert.deepEqual(r.message, {
    intent: `Permit2: allow spending of several tokens: Let ${SPENDER} spend up to 1.5 USDC (${USDC}), Unlimited WETH (${WETH}). Allowances expire, in the same order: Only in the block it is used, Never. Signature expires: Never.`,
    fields: [
      ["Spender", SPENDER],
      ["Amount", `1.5 USDC (${USDC}), Unlimited WETH (${WETH})`],
      ["Allowance expires", "Only in the block it is used, Never"],
      ["Signature expires", "Never"],
      ["Contract", `${PERMIT2} on chain 1`],
      ["Signature", NOTE],
      ["EIP-712 digest", "0xd612330f07ad19e33c589712a85d09a00e512854848e6ae84d89c877f5fe06ad"],
    ],
  });
  // one more below the threshold is a number again
  const almost = structuredClone(batch);
  almost.message.details[1].amount = (2n ** 160n - 2n).toString();
  assert.match(eip712Consent({ resolved: permit2, typedData: almost, chainId: 1, tokens: TOKENS, form: "fields" }).message.fields[1][1], /, 1461501637330902918203684832716\.283019655932542974 WETH \(0xC02a/);
});

test("Permit2 SignatureTransfer: a one-time transfer, a transfer effect", () => {
  const typedData = {
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    domain: { name: "Permit2", chainId: 42161, verifyingContract: PERMIT2 },
    message: { permitted: { token: USDC, amount: "250000000" }, spender: SPENDER, nonce: "7", deadline: "1767225600" },
  };
  const r = eip712Consent({ resolved: permit2, typedData, chainId: 42161, tokens: TOKENS, form: "fields" });
  assert.equal(r.message.intent, `Permit2: allow one transfer: Let ${SPENDER} transfer up to 250 USDC (${USDC}) from you, once. Signature expires: 2026-01-01T00:00:00Z.`);
  assert.equal(r.model.effect, "transfer");
  assert.equal(eip712Consent({ resolved: permit2, typedData: single, chainId: 1, tokens: TOKENS }).model.effect, "approve");
});

const daiRequest = {
  types: {
    Permit: [
      { name: "holder", type: "address" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "allowed", type: "bool" },
    ],
  },
  primaryType: "Permit",
  domain: { name: "Dai Stablecoin", version: "1", chainId: 1, verifyingContract: DAI },
  message: { holder: ALICE, spender: BOB, nonce: 0, expiry: 0, allowed: true },
};

test("DAI's permit: an expiry of 0 never expires, and allowed sets all or none", () => {
  const r = eip712Consent({ resolved: dai, typedData: daiRequest, chainId: 1, form: "fields" });
  assert.deepEqual(r.message, {
    intent: `Permit DAI spending: Set the DAI allowance ${ALICE} gives ${BOB} to all of it if allowed is true, to none if false (allowed: true). Signature expires: Never.`,
    fields: [
      ["Holder", ALICE],
      ["Spender", BOB],
      ["Allowed (true: all, false: none)", "true"],
      ["Signature expires", "Never"],
      ["Contract", `${DAI} on chain 1`],
      ["Signature", NOTE],
      ["EIP-712 digest", "0x330bddc49dc0b0aae68316c3cd61921e5b47e9d1e6f226cb6115f408cacdb749"],
    ],
  });
  assert.equal(r.typeHash, "0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb"); // dai.sol's PERMIT_TYPEHASH
  const dated = eip712Consent({ resolved: dai, typedData: { ...daiRequest, message: { ...daiRequest.message, expiry: 1798761600, allowed: false } }, chainId: 1, form: "fields" });
  assert.equal(dated.message.fields[3][1], "2027-01-01T00:00:00Z");
  assert.equal(dated.message.fields[2][1], "false");
});

const USDC_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
];

test("EIP-2612 on a token the packs match: the token's own decimals and symbol, its own domain", async () => {
  const r = await resolveService({ abi: USDC_ABI, validateSchema, packs: [{ doc: doc("erc20") }, { doc: doc("erc2612") }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const typedData = {
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
    message: { owner: ALICE, spender: BOB, value: "2500000", nonce: "3", deadline: "1798761600" },
  };
  const refs = { "query:decimals": 6, "query:symbol": "USDC" };
  const c = eip712Consent({ resolved: r.resolved, typedData, chainId: 1, refs });
  assert.match(c.message, /^# Permit token spending\n\nAllow `0xbBbB[^`]+` to spend up to `2\.5 USDC` from `0xCD2a[^`]+`\. Signature expires: `2027-01-01 00:00:00 UTC`\./);
  assert.equal(c.digest, "0x0fd917e02cc2ea2719ff6e8c9e2e53eef8e49fcfae9e96e7c2a0f373be841ce3");
  assert.deepEqual(c.provenance.intent, { origin: "pack", profile: "erc2612" });
  // an unlimited permit with a deadline of uint256 max
  const forever = eip712Consent({ resolved: r.resolved, typedData: { ...typedData, message: { ...typedData.message, value: MAX256, deadline: MAX256 } }, chainId: 1, refs, form: "fields" });
  assert.equal(forever.message.intent, `Permit token spending: Allow ${BOB} to spend up to Unlimited USDC from ${ALICE}. Signature expires: Never.`);
  // DAI's Permit has the same name and other members: its type hash matches nothing here, and EIP-2612's nothing in DAI's
  assert.match(codeOf(() => eip712Consent({ resolved: r.resolved, typedData: { ...daiRequest, domain: { ...daiRequest.domain, verifyingContract: USDC } }, chainId: 1, refs })), /^E_TYPE_HASH: no message of the resolved form has the type hash 0xea2aa0a1/);
  assert.match(codeOf(() => eip712Consent({ resolved: dai, typedData: { ...typedData, domain: daiRequest.domain }, chainId: 1 })), /^E_TYPE_HASH: .*0x6e71edae/);
});

test("a request that does not match is refused before anything is shown", () => {
  const with_ = (patch) => ({ ...single, ...patch });
  const { EIP712Domain, ...types } = single.types;
  const domain = (d) => with_({ types, domain: d });
  const message = (m) => with_({ message: { ...single.message, ...m } });
  const details = (d) => message({ details: { ...single.message.details, ...d } });
  for (const [typedData, chainId, why] of [
    [single, 10, /^E_DOMAIN: the domain is for chain 1, the wallet is on chain 10$/],
    [single, undefined, /^E_REQUEST: give the wallet's active chainId/],
    [domain({ name: "Permit2", verifyingContract: PERMIT2 }), 1, /^E_DOMAIN: the domain has no chainId, so the signature is valid on every chain/],
    [domain({ name: "Permit2", chainId: 1 }), 1, /^E_DOMAIN: the domain has no verifyingContract/],
    [domain({ ...single.domain, salt: `0x${"00".repeat(32)}` }), 1, /^E_DOMAIN: a domain with a salt is not supported yet \(spec section 15\.9, O3\)/],
    [domain({ ...single.domain, owner: ALICE }), 1, /^E_DOMAIN: the domain has a field "owner"/],
    [domain({ ...single.domain, verifyingContract: WETH }), 1, /^E_DEPLOYMENT: profile permit2 describes .* not 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on chain 1/],
    [domain({ ...single.domain, name: "Permit3" }), 1, /^E_DOMAIN: profile permit2 describes the domain whose name is "Permit2", not "Permit3"/],
    [domain({ ...single.domain, version: "1" }), 1, /^E_DOMAIN: profile permit2 describes a domain without a version, not one whose version is "1"/],
    [with_({ types: { ...single.types, EIP712Domain: [...single.types.EIP712Domain].reverse() } }), 1, /^E_DOMAIN: types\.EIP712Domain must list the domain's fields in EIP-712 order/],
    [with_({ types: { ...single.types, EIP712Domain: single.types.EIP712Domain.slice(1) } }), 1, /^E_DOMAIN: types\.EIP712Domain must list the domain's fields in EIP-712 order/],
    [with_({ types: { ...single.types, EIP712Domain: [{ ...single.types.EIP712Domain[0], type: "bytes32" }, ...single.types.EIP712Domain.slice(1)] } }), 1, /^E_DOMAIN: types\.EIP712Domain must list the domain's fields in EIP-712 order/],
    [with_({ types: { ...single.types, EIP712Domain: {} } }), 1, /^E_DOMAIN: types\.EIP712Domain must list the domain's fields in EIP-712 order/],
    [with_({ types: { ...single.types, PermitDetails: [...DETAILS, { name: "extra", type: "uint8" }] } }), 1, /^E_TYPE_HASH: no message of the resolved form has the type hash/],
    [with_({ primaryType: "Mail", types: { ...single.types, Mail: [{ name: "contents", type: "string" }] } }), 1, /^E_TYPE_HASH: .*\(Mail\)/],
    [with_({ primaryType: "Nope" }), 1, /^E_REQUEST: typedData\.types has no "Nope"/],
    [with_({ types: { ...single.types, PermitDetails: [{ name: "token", type: "uint" }] } }), 1, /^E_REQUEST: typedData\.types\.PermitDetails\[0\]: write uint256, not uint/],
    [message({ extra: 1 }), 1, /^E_DECODE: message: PermitSingle has no member "extra"/],
    [with_({ message: { details: single.message.details, spender: SPENDER } }), 1, /^E_DECODE: .*sigDeadline/],
    [details({ amount: "01" }), 1, /^E_DECODE: message\.details\.amount/],
    [details({ amount: (2n ** 160n).toString() }), 1, /^E_DECODE: message\.details\.amount/],
    [details({ amount: 1.5 }), 1, /^E_DECODE: message\.details\.amount/],
    [details({ expiration: 2 ** 53 }), 1, /^E_DECODE: message\.details\.expiration/],
    [details({ token: USDC.replace("A0b8", "a0B8") }), 1, /^E_DECODE: message\.details\.token/],
    [message({ spender: true }), 1, /^E_DECODE: message\.spender/],
  ]) {
    assert.match(codeOf(() => eip712Consent({ resolved: permit2, typedData, chainId, tokens: TOKENS })) ?? "no refusal", why, JSON.stringify(typedData.domain));
  }
  // a token whose decimals and symbol are not given has no text, never base units read as tokens
  assert.match(codeOf(() => eip712Consent({ resolved: permit2, typedData: single, chainId: 1, tokens: {} })), /^E_REF_UNRESOLVED: PermitSingle\(0\)\.details\.amount is an amount of the token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, whose decimals and symbol were not given/);
  assert.match(codeOf(() => eip712Consent({ resolved: permit2, typedData: single, chainId: 1, tokens: { "0x1234": { decimals: 6 } } })), /^E_REQUEST/);
  // a resolved form without messages
  const { messages, ...functionsOnly } = dai;
  assert.match(codeOf(() => eip712Consent({ resolved: functionsOnly, typedData: daiRequest, chainId: 1 })), /^E_TYPE_HASH: the resolved form describes no EIP-712 message/);
  assert.match(codeOf(() => eip712Consent({ resolved: dai, typedData: { ...daiRequest, domain: { ...daiRequest.domain, version: "2" } }, chainId: 1 })), /^E_DOMAIN: profile dai-permit describes the domain whose version is "1", not "2"/);
  const { version, ...unversioned } = daiRequest.domain;
  assert.match(codeOf(() => eip712Consent({ resolved: dai, typedData: { ...daiRequest, domain: unversioned }, chainId: 1 })), /^E_DOMAIN: .*version is "1", not a domain without one/);
  // a resolved form whose entry does not hash to its type hash is not trusted
  const forged = structuredClone(dai);
  forged.messages.Permit.encode_type = forged.messages.Permit.encode_type.replace("bool allowed", "bool approved");
  assert.match(codeOf(() => eip712Consent({ resolved: forged, typedData: daiRequest, chainId: 1 })), /^E_RESOLVED_FORM: messages\.Permit/);
  // arrays are bounded before they are read
  const many = structuredClone(batch);
  many.message.details = Array.from({ length: 5 }, () => batch.message.details[0]);
  assert.match(codeOf(() => eip712Consent({ resolved: permit2, typedData: many, chainId: 1, tokens: TOKENS, limits: { maxElements: 4 } })), /^E_DECODE: /);
});

test("an EVM call whose amount is in the token a parameter names: the caller passes each token's metadata", async () => {
  const PAY = ["function pay(address token, uint256 amount, address to)"];
  const contract = {
    format: "candid-profile",
    format_version: 0,
    kind: "contract",
    name: "payer",
    origin: "author",
    binds: { abi: PAY },
    annotations: [
      { at: "pay", tag: "intent", args: { title: "Pay", template: "Pay {amount} to {to}" } },
      { at: "pay", tag: "effect", args: { kind: "transfer", irreversible: true } },
      { at: "pay(0).amount", tag: "amount", args: { token: "token" } },
    ],
  };
  const resolved = (await validateProfile(contract, { validateSchema, resolved: true })).resolved;
  const word = (hex) => hex.padStart(64, "0");
  const calldata = `0x${keccak256Hex("pay(address,uint256,address)").slice(0, 8)}${word(USDC.slice(2).toLowerCase())}${word((1500000).toString(16))}${word(BOB.slice(2).toLowerCase())}`;
  const r = evmConsent({ resolved, calldata, to: ALICE, tokens: TOKENS, form: "fields" });
  assert.equal(r.message.intent, `Pay: Pay 1.5 USDC (${USDC}) to ${BOB}`);
  assert.match(codeOf(() => evmConsent({ resolved, calldata, to: ALICE })), /^E_REF_UNRESOLVED: pay\(0\)\.amount is an amount of the token 0xA0b8/);
});
