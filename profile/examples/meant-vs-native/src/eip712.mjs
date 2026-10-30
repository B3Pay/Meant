// Section 3: an EIP-712 signing request (eth_signTypedData_v4), the way viem and ethers handle it and the way Meant does.
// Pure code, no chain. The keys are made here and thrown away: they hold nothing on any network.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createSchemaValidator, validateProfile } from "@meantjs/profile";
import { eip712Consent } from "@meantjs/consent/evm";
import { erc7730Descriptor } from "@meantjs/consent/erc7730";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { TypedDataEncoder, Wallet } from "ethers";

const require = createRequire(import.meta.url);
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const LOOKALIKE = "0x000000000022d473030f116ddee9f6b43AC78bA4"; // one digit off Permit2, checksummed
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
export const SPENDER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
export const HOLDER = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
export const TOKENS = { [USDC]: { decimals: 6, symbol: "USDC" } };
export const WALLET_CHAIN = 1;

const DETAILS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint160" },
  { name: "expiration", type: "uint48" },
  { name: "nonce", type: "uint48" },
];
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
/** Permit2's PermitSingle: let SPENDER move all of the holder's USDC (uint160 max) until 2027-01-01, signature valid until 2026-12-31. */
const permitSingle = {
  types: {
    EIP712Domain: DOMAIN_TYPE,
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: DETAILS,
  },
  primaryType: "PermitSingle",
  domain: { name: "Permit2", chainId: "1", verifyingContract: PERMIT2 },
  message: { details: { token: USDC, amount: (2n ** 160n - 1n).toString(), expiration: "1798761600", nonce: "0" }, spender: SPENDER, sigDeadline: "1798675200" },
};
/** DAI's own permit: allowed true is all of the holder's DAI, expiry 0 is a signature that never expires. */
const daiPermit = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Permit: [
      { name: "holder", type: "address" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "allowed", type: "bool" },
    ],
  },
  primaryType: "Permit",
  domain: { name: "Dai Stablecoin", version: "1", chainId: "1", verifyingContract: DAI },
  message: { holder: HOLDER, spender: SPENDER, nonce: "0", expiry: "0", allowed: true },
};

const variant = (base, change) => {
  const copy = structuredClone(base);
  change(copy);
  return copy;
};
export const REQUESTS = [
  { id: "permit2", label: "Permit2 PermitSingle (an unlimited USDC allowance)", profile: "permit2", expect: "ok", typedData: permitSingle },
  { id: "dai", label: "DAI permit (allowed: true, expiry: 0)", profile: "dai-permit", expect: "ok", typedData: daiPermit },
  { id: "chain", label: "The same Permit2 request for chain 137, while the wallet is on chain 1", profile: "permit2", expect: "E_DOMAIN", typedData: variant(permitSingle, (t) => { t.domain.chainId = "137"; }) },
  { id: "lookalike", label: "The same request, verifying contract one digit off Permit2's", profile: "permit2", expect: "E_DEPLOYMENT", typedData: variant(permitSingle, (t) => { t.domain.verifyingContract = LOOKALIKE; }) },
  { id: "spoof", label: "A struct named PermitSingle with an extra member (another type hash)", profile: "permit2", expect: "E_TYPE_HASH", typedData: variant(permitSingle, (t) => { t.types.PermitSingle.push({ name: "recipient", type: "address" }); t.message.recipient = SPENDER; }) },
];

/** viem wants bigint for integers; the JSON request carries decimal strings. */
export function forViem(td) {
  const ints = (fields, value) => Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const f = fields.find((x) => x.name === k);
    if (f && /^u?int\d*$/.test(f.type)) return [k, BigInt(v)];
    if (f && td.types[f.type]) return [k, ints(td.types[f.type], v)];
    return [k, v];
  }));
  const { EIP712Domain, ...types } = td.types;
  return { domain: ints(EIP712Domain, td.domain), types, primaryType: td.primaryType, message: ints(td.types[td.primaryType], td.message) };
}

/** What a raw field viewer shows: the message as it is, one line per leaf. */
function rawView(td) {
  const lines = [`domain: ${td.domain.name}, chainId ${td.domain.chainId}, ${td.domain.verifyingContract}`];
  const walk = (prefix, value) => {
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === "object") walk(`${prefix}${k}.`, v);
      else lines.push(`${prefix}${k}: ${v}`);
    }
  };
  walk("", td.message);
  return lines.join("\n");
}

/** The resolved forms of the Permit2 and DAI permit profiles that @meantjs/profile ships. */
export async function eip712Profiles() {
  const validateSchema = await createSchemaValidator();
  const profiles = {};
  for (const name of ["permit2", "dai-permit"]) {
    const doc = JSON.parse(readFileSync(require.resolve(`@meantjs/profile/packs/${name}.profile.json`), "utf8"));
    const v = await validateProfile(doc, { validateSchema, resolved: true });
    if (!v.ok) throw new Error(`${name}: ${JSON.stringify(v.diagnostics)}`);
    profiles[name] = v.resolved;
  }
  return profiles;
}

export async function runEip712() {
  const profiles = await eip712Profiles();
  const viemAccount = privateKeyToAccount(generatePrivateKey());
  const ethersWallet = Wallet.createRandom();
  const rows = [];
  for (const req of REQUESTS) {
    const td = req.typedData;
    const viemDigest = hashTypedData(forViem(td));
    const { EIP712Domain, ...ethersTypes } = td.types;
    const ethersDigest = TypedDataEncoder.hash(td.domain, ethersTypes, td.message);
    const viemSigned = Boolean(await viemAccount.signTypedData(forViem(td)));
    const ethersSigned = Boolean(await ethersWallet.signTypedData(td.domain, ethersTypes, td.message));
    let meant;
    try {
      const r = eip712Consent({ resolved: profiles[req.profile], typedData: td, chainId: WALLET_CHAIN, tokens: TOKENS });
      meant = { ok: true, message: r.message, digest: r.digest };
    } catch (e) {
      meant = { ok: false, code: e.code, message: e.message };
    }
    // Each request has one right answer: the two valid ones are shown, each attack is refused with its own code.
    const outcome = meant.ok ? "ok" : meant.code;
    if (outcome !== req.expect) throw new Error(`${req.id}: Meant answered ${outcome}${meant.ok ? "" : ` (${meant.message})`}, expected ${req.expect}`);
    if (meant.ok && meant.digest !== viemDigest) throw new Error(`${req.id}: Meant's digest ${meant.digest} is not viem's ${viemDigest}`);
    if (viemDigest !== ethersDigest) throw new Error(`${req.id}: viem and ethers disagree on the digest`);
    rows.push({ ...req, raw: rawView(td), viemDigest, viemSigned, ethersSigned, meant });
  }
  // The clear-signing file for wallets that read ERC-7730, and the hash an ERC-8176 attestation would carry.
  const { descriptor, descriptorHash } = erc7730Descriptor(profiles.permit2, { context: "eip712" });
  return { rows, erc7730: { descriptorHash, bytes: JSON.stringify(descriptor).length, formats: Object.keys(descriptor.display?.formats ?? {}) } };
}
