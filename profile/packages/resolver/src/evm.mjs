/**
 * `@meantjs/profile/evm`: the EVM helpers of spec section 15 (D-054), browser-safe and without dependencies.
 * Keccak-256, ABI fragments (reading, canonical text, selectors, the interface identity), a strict ABI codec, EIP-55
 * addresses, EIP-712 types (section 15.9: reading them, encodeType, type hashes) and digests. The consent package
 * builds calldata display, typed-message display and the ERC-7730 export on them.
 *
 * test/evm.test.mjs checks the vectors; test/address-entry.test.mjs keeps this entry free of node:* imports.
 */
export { keccak256, keccak256Hex } from "./keccak.mjs";
export {
  AbiError,
  DEFAULT_ABI_LIMITS,
  abiInterfaceId,
  canonicalFragment,
  componentKey,
  decodeParams,
  eip712TypeHash,
  encodeCall,
  encodeParams,
  encodeType,
  namedSignature,
  parseAbi,
  parseEip712Types,
  parseSignature,
  readAddress,
  selectorOf,
  toChecksumAddress,
  typeSignature,
  typeString,
  typedDataDigest,
} from "./abi.mjs";
export { jcs } from "./util.mjs";
