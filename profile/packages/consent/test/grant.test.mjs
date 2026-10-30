// What a request grants (spec section 5.3, D-056), as the three consent functions return it beside the text: the eight
// requests of the proposal (docs/proposals/w0-terms-guard.md §1) with real typed data, calldata and Candid arguments,
// both of its traps (an EIP-2612 or DAI deadline is the signature's; a Permit2 expiration of 0 is not 1970), and the
// ways a grant is left out (W_GRANT), which never change the text. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchemaValidator, resolveService, validateProfile } from "@meantjs/profile";
import { encodeCall as encodeAbiCall, parseSignature } from "@meantjs/profile/evm";
import { displayAccount } from "@meantjs/format";
import { eip712Consent, evmConsent } from "../src/evm.mjs";
import { generateConsent, CODES } from "../src/index.mjs";
import { ALICE as ALICE_ICP, BOB as BOB_ICP, SPENDER as SPENDER_ICP, encodeCall, icrc1, icrc2, refsFor, subaccountText, syntheticResolved, tag } from "./helpers.mjs";

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
    return e.code;
  }
  return null;
};

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SPENDER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const ALICE = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const MAX48 = (2n ** 48n - 1n).toString();
const MAX160 = (2n ** 160n - 1n).toString();
const MAX256 = (2n ** 256n - 1n).toString();
const TOKENS = { [USDC]: { decimals: 6, symbol: "USDC" } };
const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";

// ------------------------------------------------------------------------------------------------ Permit2

const single = (details, sigDeadline = "1767225600") => ({
  types: {
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  primaryType: "PermitSingle",
  domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
  message: { details: { token: USDC, amount: MAX160, expiration: 1798761600, nonce: 0, ...details }, spender: SPENDER, sigDeadline },
});
const grantOfSingle = (details, sigDeadline) => eip712Consent({ resolved: permit2, typedData: single(details, sigDeadline), chainId: 1, tokens: TOKENS }).grant;

test("Permit2 PermitSingle: the spender, the token the message names, unlimited at 2^160 - 1, and its values by name", () => {
  const r = eip712Consent({ resolved: permit2, typedData: single({}), chainId: 1, tokens: TOKENS });
  assert.deepEqual(r.grant, { kind: "approve", spender: SPENDER, token: USDC, amount: { units: MAX160, unlimited: true }, ends: { at: "1798761600" } });
  assert.deepEqual(r.values, { details: { token: USDC, amount: MAX160, expiration: "1798761600", nonce: "0" }, spender: SPENDER, sigDeadline: "1767225600" });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(grantOfSingle({ amount: "500000000" }).amount, { units: "500000000", unlimited: false });
});

test("Permit2's trap: an expiration of 0 is spendable up to sigDeadline, so the grant ends at the later of the two", () => {
  // Allowance.sol stores 0 as the block the permit is used in, and AllowanceTransfer.sol takes the permit until sigDeadline.
  assert.deepEqual(grantOfSingle({ expiration: 0 }).ends, { at: "1767225600" });
  assert.deepEqual(grantOfSingle({ expiration: 1700000000 }).ends, { at: "1767225600" }); // earlier than sigDeadline: stricter, never looser
  assert.deepEqual(grantOfSingle({ expiration: MAX48 }).ends, { never: true });
  assert.deepEqual(grantOfSingle({ expiration: 0 }, MAX256).ends, { never: true });
});

test("Permit2 PermitTransferFrom: a transfer its spender takes once, by the deadline", () => {
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
    domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
    message: { permitted: { token: USDC, amount: "25000000" }, spender: SPENDER, nonce: "7", deadline: "1767225600" },
  };
  const r = eip712Consent({ resolved: permit2, typedData, chainId: 1, tokens: TOKENS });
  assert.deepEqual(r.grant, { kind: "transfer", spender: SPENDER, token: USDC, amount: { units: "25000000", unlimited: false }, ends: { at: "1767225600" } });
  const never = eip712Consent({ resolved: permit2, typedData: { ...typedData, message: { ...typedData.message, deadline: MAX256 } }, chainId: 1, tokens: TOKENS });
  assert.deepEqual(never.grant.ends, { never: true });
});

test("a batch grants several tokens, so it has no grant: terms cannot cover it", () => {
  const typedData = {
    types: { PermitBatch: [{ name: "details", type: "PermitDetails[]" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: single({}).types.PermitDetails },
    primaryType: "PermitBatch",
    domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
    message: { details: [{ token: USDC, amount: "1", expiration: 0, nonce: 1 }], spender: SPENDER, sigDeadline: "1767225600" },
  };
  const r = eip712Consent({ resolved: permit2, typedData, chainId: 1, tokens: TOKENS });
  assert.equal(r.grant, null);
  assert.deepEqual(r.diagnostics, []); // no grant to read, so nothing to warn about
});

// ------------------------------------------------------------------------------------------------ EIP-2612 and DAI

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
const usdc = (await resolveService({ abi: USDC_ABI, validateSchema, packs: [{ doc: doc("erc20") }, { doc: doc("erc2612") }] })).resolved;
const usdcRefs = { "query:decimals": 6, "query:symbol": "USDC" };

test("EIP-2612's trap: the deadline is the signature's, so the allowance never ends; the token is the verifying contract", () => {
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
  const r = eip712Consent({ resolved: usdc, typedData, chainId: 1, refs: usdcRefs });
  assert.deepEqual(r.grant, { kind: "approve", spender: BOB, token: USDC, amount: { units: "2500000", unlimited: false }, ends: { never: true } });
  const all = eip712Consent({ resolved: usdc, typedData: { ...typedData, message: { ...typedData.message, value: MAX256 } }, chainId: 1, refs: usdcRefs });
  assert.deepEqual(all.grant.amount, { units: MAX256, unlimited: true });
  // The permit call submits such a signature: the same grant, its values by parameter name.
  const f = parseSignature(usdc.methods.permit.signature);
  const args = { owner: ALICE, spender: BOB, value: "2500000", deadline: "1798761600", v: "27", r: new Uint8Array(32).fill(1), s: new Uint8Array(32).fill(2) };
  const call = evmConsent({ resolved: usdc, calldata: encodeAbiCall(f, args), to: USDC, chainId: 1, refs: usdcRefs });
  assert.deepEqual(call.grant, r.grant);
  assert.deepEqual(Object.keys(call.values), ["owner", "spender", "value", "deadline", "v", "r", "s"]);
  assert.equal(call.values.value, "2500000");
});

test("DAI's permit: allowed true is unlimited, false grants nothing, and the expiry is the signature's", () => {
  const typedData = {
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
    message: { holder: ALICE, spender: SPENDER, nonce: "0", expiry: "0", allowed: true },
  };
  const r = eip712Consent({ resolved: dai, typedData, chainId: 1 });
  assert.deepEqual(r.grant, { kind: "approve", spender: SPENDER, token: DAI, amount: { units: null, unlimited: true }, ends: { never: true } });
  const none = eip712Consent({ resolved: dai, typedData: { ...typedData, message: { ...typedData.message, expiry: "1798761600", allowed: false } }, chainId: 1 });
  assert.deepEqual(none.grant, { kind: "approve", spender: SPENDER, token: DAI, amount: { units: "0", unlimited: false }, ends: { never: true } });
});

// ------------------------------------------------------------------------------------------------ ERC-20

test("ERC-20 approve and transfer: the contract called is the token; a transfer ends when it is made", () => {
  const word = (hex) => hex.padStart(64, "0");
  const call = (selector, address, n) => `${selector}${word(address.slice(2).toLowerCase())}${word(BigInt(n).toString(16))}`;
  const approve = evmConsent({ resolved: usdc, calldata: call("0x095ea7b3", BOB, "1000000"), to: USDC, chainId: 1, refs: usdcRefs });
  assert.deepEqual(approve.grant, { kind: "approve", spender: BOB, token: USDC, amount: { units: "1000000", unlimited: false }, ends: { never: true } });
  assert.deepEqual(approve.values, { spender: BOB, value: "1000000" });
  const unlimited = evmConsent({ resolved: usdc, calldata: call("0x095ea7b3", BOB, MAX256), to: USDC, chainId: 1, refs: usdcRefs });
  assert.deepEqual(unlimited.grant.amount, { units: MAX256, unlimited: true });
  const transfer = evmConsent({ resolved: usdc, calldata: call("0xa9059cbb", BOB, "1500000"), to: USDC.toLowerCase(), chainId: 1, refs: usdcRefs });
  assert.deepEqual(transfer.grant, { kind: "transfer", to: BOB, token: USDC, amount: { units: "1500000", unlimited: false }, ends: { now: true } });
});

// ------------------------------------------------------------------------------------------------ ICRC-1 and ICRC-2

const approveArgs = (expires) =>
  `(record { spender = record { owner = principal "${SPENDER_ICP}"; subaccount = opt ${subaccountText(1)} }; amount = 150_000_000 : nat; expires_at = ${expires} })`;

test("ICRC-2 approve: the spender's ICRC-1 text, the ledger the caller names, and expires_at in exact seconds", () => {
  const consent = (expires, extra = {}) => generateConsent({ resolved: icrc2, method: "icrc2_approve", arg: encodeCall("icrc2_approve", approveArgs(expires)), refs: refsFor({ symbol: "TKA", decimals: 8 }), canisterId: LEDGER, ...extra });
  const spender = displayAccount({ owner: SPENDER_ICP, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)) });
  assert.match(spender, /^un4fu-tqaaa-aaaab-qadjq-cai-[a-z2-7]{7}\.1$/);
  const r = consent("opt 1_767_225_600_123_456_789");
  assert.deepEqual(r.grant, { kind: "approve", spender, token: LEDGER, amount: { units: "150000000", unlimited: false }, ends: { at: "1767225600.123456789" } }); // never rounded
  assert.deepEqual(consent("opt 1_767_225_600_000_000_000").grant.ends, { at: "1767225600" });
  assert.deepEqual(consent("null").grant.ends, { never: true }); // left out: the allowance never ends
  assert.equal(r.values[0].amount, "150000000");
  // The canister id in any valid spelling is its canonical text; anything else is refused.
  assert.equal(consent("null", { canisterId: LEDGER.toUpperCase() }).grant.token, LEDGER);
  assert.equal(codeOf(() => consent("null", { canisterId: "not a principal" })), CODES.REQUEST);
  // Without the canister id nothing asks what the call grants (an ICRC-21 message, say): no grant, no diagnostic, the same text.
  const unasked = generateConsent({ resolved: icrc2, method: "icrc2_approve", arg: encodeCall("icrc2_approve", approveArgs("null")), refs: refsFor({ symbol: "TKA", decimals: 8 }) });
  assert.equal(unasked.grant, null);
  assert.deepEqual(unasked.diagnostics, []);
  assert.deepEqual(unasked.message, consent("null").message);
});

test("ICRC-1 transfer: a transfer to an account, which ends when it is made", () => {
  const arg = encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${BOB_ICP}"; subaccount = null }; amount = 250_000_000 : nat })`);
  const r = generateConsent({ resolved: icrc1, method: "icrc1_transfer", arg, refs: refsFor({ symbol: "TKA", decimals: 8 }), canisterId: LEDGER, form: "fields" });
  assert.deepEqual(r.grant, { kind: "transfer", to: BOB_ICP, token: LEDGER, amount: { units: "250000000", unlimited: false }, ends: { now: true } });
  assert.deepEqual(r.diagnostics, []);
  // An account that is not one (a 2-byte subaccount) is shown raw, and grants nothing: the request needs its confirmation.
  const bad = encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${BOB_ICP}"; subaccount = opt blob "\\01\\02" }; amount = 1 : nat })`);
  const b = generateConsent({ resolved: icrc1, method: "icrc1_transfer", arg: bad, refs: refsFor({ symbol: "TKA", decimals: 8 }), canisterId: LEDGER });
  assert.equal(b.grant, null);
  assert.deepEqual(b.diagnostics.map((d) => d.code), ["W_GRANT", "W_FORMAT_FALLBACK"]);
  assert.match(b.diagnostics[0].message, /^grant to: a subaccount is 32 bytes, got 2;/);
  // A method without a grant (icrc2_transfer_from moves someone else's tokens) has none, and no warning.
  const from = encodeCall("icrc2_transfer_from", `(record { from = record { owner = principal "${ALICE_ICP}"; subaccount = null }; to = record { owner = principal "${BOB_ICP}"; subaccount = null }; amount = 1 : nat })`);
  const t = generateConsent({ resolved: icrc2, method: "icrc2_transfer_from", arg: from, refs: refsFor({ symbol: "TKA", decimals: 8 }), canisterId: LEDGER });
  assert.equal(t.grant, null);
  assert.deepEqual(t.diagnostics, []);
});

// ------------------------------------------------------------------------------------------------ W_GRANT

const ACCOUNT = { candid: "record", fields: { owner: { candid: "principal" }, subaccount: { candid: "blob", optional: true } }, tags: { account: tag({ encoding: "icrc1" }) } };
const ARGS = [{ candid: "record", fields: { to: ACCOUNT, amount: { candid: "nat", tags: { amount: tag({ decimals: 8, symbol: "TOK" }) } }, until: { candid: "nat64", optional: true, tags: { timestamp: tag({ unit: "ns" }) } }, note: { candid: "text" } } }];
const DID = "type Account = record { owner : principal; subaccount : opt blob }; service : { give : (record { to : Account; amount : nat; until : opt nat64; note : text }) -> () }";
const giveArg = encodeCall("give", `(record { to = record { owner = principal "${BOB_ICP}"; subaccount = null }; amount = 5 : nat; until = opt 1_000_000_000 : opt nat64; note = "hi" })`, DID);
const give = (effect) => generateConsent({ resolved: syntheticResolved("give", ARGS, { effect: tag(effect) }), method: "give", arg: giveArg, canisterId: LEDGER });

test("a grant that cannot be read is none, with a W_GRANT that says why, and the text is the same", () => {
  const ok = give({ kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount", ends: ["until"] } });
  assert.deepEqual(ok.grant, { kind: "transfer", to: BOB_ICP, token: LEDGER, amount: { units: "5", unlimited: false }, ends: { at: "1" } });
  for (const [effect, why] of [
    [{ kind: "write", irreversible: true, grant: { to: "to", amount: "amount" } }, /transfer or approve, not write/],
    [{ kind: "transfer", irreversible: true, grant: { to: "to", spender: "to", amount: "amount" } }, /neither or both of spender and to/],
    [{ kind: "transfer", irreversible: true, grant: { to: "nobody", amount: "amount" } }, /grant to "nobody": no field or case/],
    [{ kind: "transfer", irreversible: true, grant: { to: "note", amount: "amount" } }, /grant to "note" is neither an address nor an account/],
    [{ kind: "transfer", irreversible: true, grant: { to: "to", amount: "note" } }, /grant amount "note" is neither an amount nor a bool/],
    [{ kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount", ends: ["note"] } }, /grant ends "note" is not a unix timestamp/],
    [{ kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount", ends: [] } }, /not a list of paths/],
  ]) {
    const r = give(effect);
    assert.equal(r.grant, null, JSON.stringify(effect));
    assert.deepEqual(r.diagnostics.map((d) => d.code), ["W_GRANT"]);
    assert.match(r.diagnostics[0].message, why);
    assert.deepEqual(r.message, ok.message);
  }
});
