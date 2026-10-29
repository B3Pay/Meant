// @meantjs/consent/evm and @meantjs/consent/erc7730 as a TypeScript consumer uses them: the consent text of an ERC-20
// call, the contract's ERC-7730 file, the unsigned ERC-8176 attestation of that file, and an EIP-712 signing request.
import { createSchemaValidator, loadPacks, resolveService, validateProfile } from "@meantjs/profile";
import permit2Doc from "@meantjs/profile/packs/permit2.profile.json" with { type: "json" };
import { decodeCalldata, eip712Consent, evmConsent, type TypedData } from "@meantjs/consent/evm";
import { ERC8176_SCHEMA_UID, erc7730Descriptor, erc8176Attestation, type Erc7730Descriptor } from "@meantjs/consent/erc7730";
import { check } from "./check.mts";

// Every function of the ERC-20 pack, which applies only when the contract has them all.
const ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
];
const r = await resolveService({ abi: ABI, validateSchema: await createSchemaValidator(), packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
check(r.ok && r.resolved !== null && r.profiles.some((p) => p.name === "erc20" && p.status === "applied"), "resolved with the ERC-20 pack");
const resolved = r.resolved;
const to = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const word = (hex: string): string => hex.padStart(64, "0");
const calldata = `0xa9059cbb${word("fb6916095ca1df60bb79ce92ce3ea74c37c5d359")}${word((15n * 10n ** 17n).toString(16))}`;

check(decodeCalldata(resolved, calldata).values["value"] === "1500000000000000000", "decodeCalldata");
const text = evmConsent({ resolved, calldata, to, refs: { "query:decimals": 18, "query:symbol": "WETH" } });
check(typeof text.message === "string" && text.message.includes("1.5 WETH") && text.message.includes(to), "the generic message");
const fields = evmConsent({ resolved, calldata, to, chainId: 1, refs: { "query:decimals": 18, "query:symbol": "WETH" }, form: "fields" });
check(typeof fields.message !== "string" && fields.message.fields.some(([label]) => label === "Contract"), "the fields form");

const { descriptor, descriptorHash } = erc7730Descriptor(resolved, { deployments: [{ chainId: 1, address: to }] });
const file: Erc7730Descriptor = descriptor;
check(file.display.formats["transfer(address to,uint256 value)"]?.interpolatedIntent === "Send {value} to {to}", "the ERC-7730 file");
const { typedData, digest } = erc8176Attestation({ descriptorHash, time: 1777630591, expirationTime: 0, salt: `0x${"11".repeat(32)}` });
check(typedData.message.schema === ERC8176_SCHEMA_UID && typedData.message.data === descriptorHash && /^0x[0-9a-f]{64}$/.test(digest), "the attestation");

// An EIP-712 signing request (spec section 15.9): Permit2's PermitSingle, its standard contract profile, and the
// decimals and symbol of the token the message names.
const p2 = await validateProfile(permit2Doc, { validateSchema: await createSchemaValidator(), resolved: true });
check(p2.ok && p2.resolved !== undefined && p2.resolved !== null, "the Permit2 profile");
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const permitSingle: TypedData = {
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
  domain: { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  message: { details: { token: USDC, amount: "1500000", expiration: 0, nonce: 0 }, spender: to, sigDeadline: "1767225600" },
};
const signed = eip712Consent({ resolved: p2.resolved!, typedData: permitSingle, chainId: 1, tokens: { [USDC]: { decimals: 6, symbol: "USDC" } }, form: "fields" });
check(typeof signed.message !== "string" && signed.message.intent.includes("1.5 USDC") && signed.message.intent.includes("Only in the block it is used"), "the EIP-712 consent text");
check(/^0x[0-9a-f]{64}$/.test(signed.digest) && signed.typeHash === "0xf3841cd1ff0085026a6327b620b67997ce40f282c88a8e905a7a5626e310f3d0", "the type hash");
const exported = erc7730Descriptor(p2.resolved!, { context: "eip712" });
check("eip712" in exported.descriptor.context && exported.notes.length > 0, "the ERC-7730 file of the messages");
