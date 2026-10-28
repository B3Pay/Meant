// Types for @meantjs/consent/erc7730: ERC-7730 clear-signing files from an EVM contract's resolved form, and the
// ERC-8176 attestation a reviewer signs for one (spec section 15, D-054). Hand-written; the source is src/erc7730.mjs.
// scripts/types.test.mjs keeps the declared names equal to the runtime exports.
import type { ResolvedForm } from "./index.mjs";

/** The exact-version ERC-7730 schema every exported file names in `$schema`. */
export const ERC7730_SCHEMA_URL: "https://eips.ethereum.org/assets/eip-7730/erc7730-v2.1.0.schema.json";
/** ERC-8176's canonical EAS schema UID (`bytes32 descriptorHash`). */
export const ERC8176_SCHEMA_UID: "0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2";
/** The canonical EAS contract on Ethereum mainnet. */
export const EAS_ADDRESS: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587";

export interface Erc7730Deployment {
  chainId: number;
  /** EIP-55 text. */
  address: string;
}
export interface Erc7730Field {
  path: string;
  label: string;
  format: "tokenAmount" | "amount" | "date" | "duration" | "addressName" | "raw";
  params?: Record<string, unknown>;
}
export interface Erc7730Descriptor {
  $schema: typeof ERC7730_SCHEMA_URL;
  context: { contract: { deployments: Erc7730Deployment[] } };
  metadata?: {
    owner?: string;
    contractName?: string;
    info?: { url: string; deploymentDate?: string };
    token?: { name: string; ticker: string; decimals: number };
  };
  display: { formats: Record<string, { intent: string; interpolatedIntent?: string; fields?: Erc7730Field[] }> };
}
export interface Erc7730Options {
  /** Default: the deployments every profile that lists deployments lists. Given, each must be listed by those profiles. */
  deployments?: Erc7730Deployment[];
  owner?: string;
  contractName?: string;
  info?: { url: string; deploymentDate?: string };
  /** Say that the contract is the token its literal amounts are in: written as `metadata.token`. */
  token?: { name: string };
}
/**
 * The ERC-7730 file of an EVM contract's resolved form and its ERC-8176 `descriptorHash`. What the profile says that an
 * ERC-7730 file cannot say is refused (E_EXPORT); no deployments is E_DEPLOYMENT.
 */
export function erc7730Descriptor(resolved: ResolvedForm, options?: Erc7730Options): { descriptor: Erc7730Descriptor; descriptorHash: string };
/** ERC-8176 `descriptorHash`: `0x` and the Keccak-256 of the RFC 8785 (JCS) form, for a descriptor without `includes`. */
export function descriptorHash(descriptor: object): string;

export interface Erc8176Input {
  descriptorHash: string;
  /** Unix seconds. */
  time: bigint | number | string;
  /** Unix seconds; 0 never expires (ERC-8176 advises a bound). */
  expirationTime: bigint | number | string;
  /** 32 random bytes as 0x hex, chosen by the caller. */
  salt: string;
  /** Default 32 zero bytes. */
  refUID?: string;
}
export interface Erc8176TypedData {
  domain: { name: "EAS Attestation"; version: "0.26"; chainId: 1; verifyingContract: typeof EAS_ADDRESS };
  primaryType: "Attest";
  types: { Attest: { name: string; type: string }[] };
  message: {
    version: 2;
    schema: typeof ERC8176_SCHEMA_UID;
    recipient: string;
    time: string;
    expirationTime: string;
    revocable: true;
    refUID: string;
    /** abi.encode(descriptorHash): the 32 bytes. */
    data: string;
    salt: string;
  };
}
/** The unsigned ERC-8176 offchain attestation (EAS offchain v2 typed data) and its EIP-712 digest. Nothing is signed. */
export function erc8176Attestation(input: Erc8176Input): { typedData: Erc8176TypedData; digest: string };
