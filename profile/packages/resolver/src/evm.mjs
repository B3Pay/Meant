/**
 * `@meantjs/profile/evm`: the EVM helpers of spec section 15 (D-054), browser-safe and without dependencies.
 * Keccak-256, ABI fragments (reading, canonical text, selectors, the interface identity), a strict ABI codec, EIP-55
 * addresses and EIP-712 digests. The consent package builds calldata display and the ERC-7730 export on them.
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
  encodeCall,
  encodeParams,
  namedSignature,
  parseAbi,
  parseSignature,
  readAddress,
  selectorOf,
  toChecksumAddress,
  typeSignature,
  typeString,
  typedDataDigest,
} from "./abi.mjs";
export { jcs } from "./util.mjs";
