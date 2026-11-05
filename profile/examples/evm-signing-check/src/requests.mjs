// The requests the agent is handed, each with what the user asked for. Two tasks:
//
//   x402     an agent pays a paid API (the "Weather API") by x402. The request comes from the API's 402 answer, so
//            the API, or anyone who can change that answer, writes it; x402's own client (@x402/evm 2.28.0) builds
//            and signs it: by EIP-3009 (x402's default), by Permit2 and x402's exact proxy, and by the upto scheme.
//   permit2  a trading agent signs a Permit2 permit so that a swap app's router can spend the user's USDC, through
//            a viem wallet client. The look-alike contract and type are the requests of examples/meant-vs-native, on
//            Base Sepolia instead of Ethereum.
//
// Kinds: `real` is what the user asked for and should be signed; `attack` is one change to a real request that moves
// money the user did not agree to; `tampered` is a request that is not what it claims (another chain, a look-alike
// contract, a look-alike type); `rule` is a second request under terms that cover one. Every settle step is what the
// party named in the request can do with the signature, done on the local chain.
import { createHash } from "node:crypto";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createWalletClient, custom, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { eip3009ABI, PERMIT2, permit2Abi, USDC, X402_EXACT_PROXY, x402ExactPermit2ProxyABI, X402_UPTO_PROXY, x402UptoPermit2ProxyABI } from "./chain.mjs";

const fromText = (text) => getAddress(`0x${createHash("sha256").update(`evm-signing-check: ${text}`).digest("hex").slice(0, 40)}`);
/** The agent's key, made from a fixed text: it holds nothing on any network, only this run's local USDC. */
export const AGENT = privateKeyToAccount(`0x${createHash("sha256").update("evm-signing-check: the agent's throwaway key").digest("hex")}`);
export const PARTIES = Object.freeze({
  agent: AGENT.address,
  "Weather API": fromText("the Weather API's payee address"),
  "Swap router": fromText("the swap app's router"),
  attacker: fromText("the attacker"),
  facilitator: fromText("the x402 facilitator"),
});
export const NAMES = Object.fromEntries(Object.entries(PARTIES).map(([name, address]) => [address, name]));
/** What the agent's wallet holds when each request comes: 1,000 USDC, and Permit2 approved once, as Permit2 needs. */
export const START_UNITS = 1_000_000_000n;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base (chain 8453), a mainnet
const LOOKALIKE_PERMIT2 = "0x000000000022d473030f116ddee9f6b43AC78bA4"; // one digit off Permit2, checksummed
const DAY = 86_400n;

// ------------------------------------------------------------------------------------------------ x402

/** The API's payment requirements (x402 v2), as its 402 answer gives them: 0.01 USDC to the API, on Base Sepolia. */
const requirements = (over = {}) => ({
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC,
  amount: "10000",
  payTo: PARTIES["Weather API"],
  maxTimeoutSeconds: 300,
  ...over,
  extra: { name: "USDC", version: "2", ...over.extra },
});
const exact = (req) => ({ via: "x402 exact", sign: (account) => new ExactEvmScheme(account).createPaymentPayload(2, req) });
const upto = (req, charge) => ({ via: "x402 upto", charge, sign: (account) => new UptoEvmScheme(account).createPaymentPayload(2, req) });

/** What the facilitator does with a signed x402 payment: settle it on chain, for the amount the payload allows. */
async function settleX402(chain, step, { payload }) {
  if (payload.authorization) {
    const a = payload.authorization;
    await chain.call(PARTIES.facilitator, USDC, eip3009ABI, "transferWithAuthorization", [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, payload.signature]);
    return;
  }
  const p = payload.permit2Authorization;
  const permit = { permitted: { token: p.permitted.token, amount: BigInt(p.permitted.amount) }, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) };
  if (p.witness.facilitator) {
    const witness = { to: p.witness.to, facilitator: p.witness.facilitator, validAfter: BigInt(p.witness.validAfter) };
    await chain.call(PARTIES.facilitator, X402_UPTO_PROXY, x402UptoPermit2ProxyABI, "settle", [permit, step.charge, p.from, witness, payload.signature]);
  } else {
    const witness = { to: p.witness.to, validAfter: BigInt(p.witness.validAfter) };
    await chain.call(PARTIES.facilitator, X402_EXACT_PROXY, x402ExactPermit2ProxyABI, "settle", [permit, p.from, witness, payload.signature]);
  }
}

const X402_ASK = "Get today's forecast from the Weather API, and pay it at most 0.05 USDC.";
const X402_TERMS = { token: "USDC", to: "Weather API", max_amount: "0.05", expires_by: "1 day" };
const UPTO = { scheme: "upto", extra: { facilitatorAddress: PARTIES.facilitator } };

// ------------------------------------------------------------------------------------------------ Permit2

const PERMIT_TYPES = {
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
};
/** The swap app's request: let its router spend 100 USDC for 7 days; the signature itself is good for 30 minutes. */
const permitSingle = (now, change = () => {}) => {
  const typedData = {
    domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2 },
    types: structuredClone(PERMIT_TYPES),
    primaryType: "PermitSingle",
    message: { details: { token: USDC, amount: 100_000_000n, expiration: now + 7n * DAY, nonce: 0n }, spender: PARTIES["Swap router"], sigDeadline: now + 1800n },
  };
  change(typedData);
  return typedData;
};
/** The agent signs through a viem wallet client whose account is the key, or the key behind the check. Signing is local: the transport is never called. */
const viaWallet = (typedData) => ({
  via: "viem wallet client",
  typedData,
  sign: (account) => createWalletClient({ account, chain: baseSepolia, transport: custom({ request: async () => { throw new Error("no node: this demo signs locally"); } }) }).signTypedData(typedData),
});

/**
 * What the spender named in the permit can do with the signature: register it with Permit2, then take `take` (or all
 * the agent holds) to itself, `after` seconds from now.
 */
async function settlePermit(chain, step, signature) {
  const { message } = step.typedData;
  await chain.call(message.spender, PERMIT2, permit2Abi, "permit", [PARTIES.agent, message, signature]);
  if (step.after) chain.time += step.after;
  const take = step.take === "all" ? await chain.balance(PARTIES.agent) : step.take;
  await chain.call(message.spender, PERMIT2, permit2Abi, "transferFrom", [PARTIES.agent, message.spender, take, USDC]);
}

const PERMIT_ASK = "Swap 100 USDC on the swap app. Its router may spend at most 100 USDC of mine, for 30 days.";
const PERMIT_TERMS = { token: "USDC", spender: "Swap router", max_amount: "100", expires_by: "30 days" };

// ------------------------------------------------------------------------------------------------ the list

/**
 * The scenarios, for a chain whose clock reads `now` (seconds). Each has the user's ask and terms, the requests in the
 * order the agent gets them (`steps`), how each signed request is used (`settle`, or none: a tampered request is not
 * replayed here), and what the run must observe: the check's answer and who gains what. Every time is relative to
 * `now`, so the run reads the same on any day.
 */
export function scenarios(now) {
  const x402 = { group: "x402", ask: X402_ASK, terms: X402_TERMS, settle: settleX402 };
  const permit = { group: "permit2", ask: PERMIT_ASK, terms: PERMIT_TERMS, settle: settlePermit };
  return [
    { ...x402, id: "x402-pay", kind: "real", title: "Pays the API 0.01 USDC (EIP-3009, x402's default)", steps: [exact(requirements())], expect: { check: "signed", plain: { "Weather API": 10_000n }, guarded: { "Weather API": 10_000n } } },
    { ...x402, id: "x402-overcharge", kind: "attack", title: "The API asks for 25 USDC instead of 0.01", steps: [exact(requirements({ amount: "25000000" }))], expect: { check: "E_GUARD_REFUSED", plain: { "Weather API": 25_000_000n }, guarded: {} } },
    { ...x402, id: "x402-payee", kind: "attack", title: "The 402 answer names another payee", steps: [exact(requirements({ payTo: PARTIES.attacker }))], expect: { check: "E_GUARD_REFUSED", plain: { attacker: 10_000n }, guarded: {} } },
    { ...x402, id: "x402-chain", kind: "tampered", title: "The payment is for Base, a mainnet, and its USDC", note: "a USDC payment valid on Base, a mainnet", unused: "this demo never touches a mainnet", steps: [{ ...exact(requirements({ network: "eip155:8453", asset: BASE_USDC, extra: { name: "USD Coin" } })), replay: false }], expect: { check: "E_GUARD_UNKNOWN", plain: {}, guarded: {} } },
    { ...x402, id: "x402-twice", kind: "rule", title: "A second 0.01 USDC payment for the same task", steps: [exact(requirements()), exact(requirements())], expect: { check: "E_TERMS_ORDER", plain: { "Weather API": 20_000n }, guarded: { "Weather API": 10_000n } } },
    { ...x402, id: "x402-permit2-pay", kind: "real", title: "Pays the API 0.01 USDC by Permit2 (x402's exact proxy)", steps: [exact(requirements({ extra: { assetTransferMethod: "permit2" } }))], expect: { check: "signed", plain: { "Weather API": 10_000n }, guarded: { "Weather API": 10_000n } } },
    { ...x402, id: "x402-permit2-payee", kind: "attack", title: "The same Permit2 payment to another payee", steps: [exact(requirements({ payTo: PARTIES.attacker, extra: { assetTransferMethod: "permit2" } }))], expect: { check: "E_GUARD_REFUSED", plain: { attacker: 10_000n }, guarded: {} } },
    { ...x402, id: "x402-upto-pay", kind: "real", title: "Pays by usage, at most 0.05 USDC; the call costs 0.01 (upto)", steps: [upto(requirements({ ...UPTO, amount: "50000" }), 10_000n)], expect: { check: "signed", plain: { "Weather API": 10_000n }, guarded: { "Weather API": 10_000n } } },
    { ...x402, id: "x402-upto-cap", kind: "attack", title: "The usage cap is 50 USDC, and the facilitator charges all of it", steps: [upto(requirements({ ...UPTO, amount: "50000000" }), 50_000_000n)], expect: { check: "E_GUARD_REFUSED", plain: { "Weather API": 50_000_000n }, guarded: {} } },
    { ...permit, id: "permit", kind: "real", title: "Lets the router spend 100 USDC for 7 days", steps: [{ ...viaWallet(permitSingle(now)), take: 100_000_000n }], expect: { check: "signed", plain: { "Swap router": 100_000_000n }, guarded: { "Swap router": 100_000_000n } } },
    { ...permit, id: "permit-unlimited", kind: "attack", title: "An unlimited allowance (2^160 - 1) instead of 100 USDC", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.message.details.amount = 2n ** 160n - 1n; })), take: "all" }], expect: { check: "E_GUARD_REFUSED", plain: { "Swap router": START_UNITS }, guarded: {} } },
    { ...permit, id: "permit-decimals", kind: "attack", title: "100 USDC written with 18 decimals (100 x 10^18 units)", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.message.details.amount = 100n * 10n ** 18n; })), take: "all" }], expect: { check: "E_GUARD_REFUSED", plain: { "Swap router": START_UNITS }, guarded: {} } },
    { ...permit, id: "permit-spender", kind: "attack", title: "The permit names another spender", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.message.spender = PARTIES.attacker; })), take: 100_000_000n }], expect: { check: "E_GUARD_REFUSED", plain: { attacker: 100_000_000n }, guarded: {} } },
    { ...permit, id: "permit-expiry", kind: "attack", title: "The allowance lasts three years; used two years later", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.message.details.expiration = ((now + 3n * 365n * DAY) / DAY) * DAY; })), take: 100_000_000n, after: 730n * DAY }], expect: { check: "E_GUARD_REFUSED", plain: { "Swap router": 100_000_000n }, guarded: {} } },
    { ...permit, id: "permit-lookalike", kind: "tampered", title: "The verifying contract is one digit off Permit2's", note: "a permit for a contract that is not Permit2", unused: "no contract is at that address on the local chain", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.domain.verifyingContract = LOOKALIKE_PERMIT2; })), replay: false }], expect: { check: "E_GUARD_UNKNOWN", plain: {}, guarded: {} } },
    { ...permit, id: "permit-spoof", kind: "tampered", title: "A struct named PermitSingle with an extra member", note: "a signature over a type that is not Permit2's PermitSingle", unused: "no contract on the local chain checks that type", steps: [{ ...viaWallet(permitSingle(now, (t) => { t.types.PermitSingle.push({ name: "recipient", type: "address" }); t.message.recipient = PARTIES.attacker; })), replay: false }], expect: { check: "E_GUARD_UNKNOWN", plain: {}, guarded: {} } },
  ];
}

export const GROUPS = {
  x402: { title: "An agent pays an API by x402", ask: X402_ASK, terms: X402_TERMS },
  permit2: { title: "A trading agent signs a Permit2 permit for a swap", ask: PERMIT_ASK, terms: PERMIT_TERMS },
};
