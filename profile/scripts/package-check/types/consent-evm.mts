// @meantjs/consent/evm and @meantjs/consent/erc7730 as a TypeScript consumer uses them: the consent text of an ERC-20
// call, the contract's ERC-7730 file, and the unsigned ERC-8176 attestation of that file.
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { decodeCalldata, evmConsent } from "@meantjs/consent/evm";
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
