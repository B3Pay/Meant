// Types for @meantjs/profile/evm: the EVM helpers of spec section 15 (experimental), with no dependency, for a
// browser bundle. Hand-written; the source is src/evm.mjs, src/abi.mjs and src/keccak.mjs.
// test/types.test.mjs keeps the declared names equal to the runtime exports.

/** An ABI type: `kind` is uint, int, address, bool, string, bytes, fixedbytes, array or tuple. */
export type AbiType =
  | { kind: "uint" | "int"; bits: number }
  | { kind: "address" | "bool" | "string" | "bytes" }
  | { kind: "fixedbytes"; size: number }
  | { kind: "array"; element: AbiType; length: number | null }
  | { kind: "tuple"; components: AbiParam[] };
/** A parameter, output or tuple component; `name` is null when it has none. */
export interface AbiParam {
  name: string | null;
  type: AbiType;
}
/** A function read from an ABI. */
export interface AbiFunction {
  name: string;
  inputs: AbiParam[];
  outputs: AbiParam[];
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
  /** `transfer(address to,uint256 value)`: the ERC-7730 key, and a resolved form's `signature`. */
  signature: string;
  /** `transfer(address,uint256)`: what the selector hashes. */
  typeSignature: string;
  /** `0xa9059cbb` */
  selector: string;
  /** `function transfer(address to,uint256 value) returns (bool)` */
  canonical: string;
  /** Where it was read (`abi[3]`); parseSignature leaves it out. */
  at?: string;
}
/** A decoded or encodable value: decimal strings (or bigints) for integers, EIP-55 text for addresses, Uint8Array for bytes. */
export type AbiValue = string | bigint | boolean | Uint8Array | AbiValue[] | { [key: string]: AbiValue };
export interface AbiLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxElements?: number;
}
/** Every failure of the ABI helpers: E_ABI (a fragment), E_ABI_ENCODE, E_ABI_DECODE, E_EIP712, E_ADDRESS or E_ADDRESS_CHECKSUM. */
export declare class AbiError extends Error {
  constructor(code: string, message: string);
  name: "AbiError";
  code: string;
}
export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Keccak-256 (Ethereum's, not NIST SHA3-256) of bytes or of a string's UTF-8 bytes. */
export function keccak256(input: Uint8Array | string): Uint8Array;
/** Keccak-256 as 64 lowercase hex digits, without `0x`. */
export function keccak256Hex(input: Uint8Array | string): string;
/** RFC 8785 canonical JSON. */
export function jcs(value: unknown): string;
export const DEFAULT_ABI_LIMITS: Readonly<Required<AbiLimits>>;
/** Read an ABI (human-readable fragments or JSON ABI entries); only functions are read. Problems are listed, not thrown. */
export function parseAbi(entries: unknown, label?: string): { functions: AbiFunction[]; errors: { at: string; message: string }[] };
/** One function from its named signature, as a resolved form carries it. Throws AbiError. */
export function parseSignature(signature: string, where?: string): AbiFunction;
/**
 * `candid-profile:evm-abi:v0:sha256:…`: SHA-256 over the JCS array of the canonical fragments and, when given EIP-712
 * types, one `struct Name(type member,…)` line per type, sorted.
 */
export function abiInterfaceId(functions: readonly AbiFunction[], types?: Eip712Types): string;
export function canonicalFragment(f: Pick<AbiFunction, "name" | "inputs" | "outputs" | "stateMutability">): string;
export function namedSignature(f: Pick<AbiFunction, "name" | "inputs">): string;
export function typeSignature(f: Pick<AbiFunction, "name" | "inputs">): string;
export function selectorOf(f: Pick<AbiFunction, "name" | "inputs">): string;
/** Canonical type text; with `names`, tuple components keep their names. */
export function typeString(type: AbiType, names?: boolean): string;
/** A tuple component's key in values and resolved forms: its name, else `#` and its position. */
export function componentKey(param: AbiParam, index: number): string;
/** ABI-encode a parameter list's values, keyed like a tuple. Throws AbiError (E_ABI_ENCODE). */
export function encodeParams(params: readonly AbiParam[], values: Record<string, AbiValue>): Uint8Array;
/** The selector followed by the encoded parameters. */
export function encodeCall(f: AbiFunction, values: Record<string, AbiValue>): Uint8Array;
/** Decode strictly: the bytes must be the canonical encoding of the values read. Throws AbiError (E_ABI_DECODE). */
export function decodeParams(params: readonly AbiParam[], data: Uint8Array, limits?: AbiLimits): Record<string, AbiValue>;
/** The EIP-55 checksummed form of `0x` and 40 hex digits. */
export function toChecksumAddress(address: string): string;
/** Read an address: mixed case must match its EIP-55 checksum. Returns the checksummed form. */
export function readAddress(text: string): string;
/** The EIP-712 digest a signer signs, as `0x` and 64 hex digits. */
export function typedDataDigest(typed: TypedData): string;
/** EIP-712 struct types: struct name to its members, in order. */
export type Eip712Types = Record<string, { name: string; type: string }[]>;
/**
 * Read EIP-712 struct types (spec section 15.9): identifier names that are not ABI types, unique member names,
 * canonical member types (`uint256`, never `uint`) or structs of the same map, and no struct that contains itself.
 * Problems are listed, not thrown; `types` keeps the structs that read.
 */
export function parseEip712Types(types: unknown, label?: string): { types: Eip712Types; errors: { at: string; message: string }[] };
/** EIP-712 `encodeType`: the struct with its members, then the structs it refers to, sorted by name. Throws AbiError (E_EIP712). */
export function encodeType(types: Eip712Types, primary: string): string;
/** EIP-712 `typeHash`: the Keccak-256 of `encodeType`, as `0x` and 64 hex digits. */
export function eip712TypeHash(types: Eip712Types, primary: string): string;
