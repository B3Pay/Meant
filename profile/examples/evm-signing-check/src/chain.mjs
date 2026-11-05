// A local chain: an in-process EVM (@ethereumjs/vm 10.1.3) with Base Sepolia's chain id, running the code that Base
// Sepolia runs at the same addresses (artifacts.json): Circle's USDC, Uniswap's Permit2 and x402's two Permit2
// proxies. The USDC is minted here and exists only in this process. No node and no network: a call runs in this
// process as the address that makes it, so there are no transactions and no gas fees, and the clock is the run's.
import { createBlock } from "@ethereumjs/block";
import { createCustomCommon, Hardfork, Mainnet } from "@ethereumjs/common";
import { bytesToHex, createAddressFromString, hexToBytes, setLengthLeft } from "@ethereumjs/util";
import { createVM } from "@ethereumjs/vm";
import { eip3009ABI, x402ExactPermit2ProxyABI, x402UptoPermit2ProxyABI } from "@x402/evm";
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { manifest, readCode } from "./artifacts.mjs";

export const CHAIN_ID = manifest.chain_id;
export const USDC = manifest.contracts.usdc.address;
export const PERMIT2 = manifest.contracts.permit2.address;
export const X402_EXACT_PROXY = manifest.contracts.x402_exact_proxy.address;
export const X402_UPTO_PROXY = manifest.contracts.x402_upto_proxy.address;

export const usdcAbi = parseAbi([
  "function initialize(string tokenName, string tokenSymbol, string tokenCurrency, uint8 tokenDecimals, address newMasterMinter, address newPauser, address newBlacklister, address newOwner)",
  "function initializeV2(string newName)",
  "function initializeV2_1(address lostAndFound)",
  "function initializeV2_2(address[] accountsToBlacklist, string newSymbol)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
export const permit2Abi = parseAbi([
  "struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }",
  "struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }",
  "function permit(address owner, PermitSingle permitSingle, bytes signature)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
  "error InvalidAmount(uint256 maxAmount)",
  "error InvalidContractSignature()",
  "error InvalidNonce()",
  "error InvalidSignature()",
  "error InvalidSignatureLength()",
  "error InvalidSigner()",
  "error SignatureExpired(uint256 signatureDeadline)",
]);
const errorsAbi = [...permit2Abi, ...x402ExactPermit2ProxyABI, ...x402UptoPermit2ProxyABI].filter((x) => x.type === "error");
export { eip3009ABI, x402ExactPermit2ProxyABI, x402UptoPermit2ProxyABI };

/** A call the chain reverted: `reason` is the contract's own error, decoded when the ABIs know it. */
export class Reverted extends Error {
  constructor(functionName, reason) {
    super(`${functionName} reverted: ${reason}`);
    this.name = "Reverted";
    this.reason = reason;
  }
}

function revertReason(data) {
  if (data === "0x") return "no reason given";
  try {
    const { errorName, args } = decodeErrorResult({ abi: errorsAbi, data });
    return args?.length ? `${errorName}(${args.join(", ")})` : errorName;
  } catch {
    return data;
  }
}

const address = (a) => createAddressFromString(a);
// The token's own roles on this chain: Circle's on Base Sepolia, a made-up address here. The proxy's admin may not
// call the token through the proxy, so it is an address of its own.
const PROXY_ADMIN = "0x00000000000000000000000000000000000A0001";
const TOKEN_OWNER = "0x00000000000000000000000000000000000A0002";

/**
 * @param {{ time: bigint, holders: Record<string, bigint> }} options  the block time of every call (seconds), and
 *   the USDC (base units) each address starts with
 */
export async function localChain({ time, holders }) {
  const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Prague });
  const vm = await createVM({ common });
  for (const [name, pin] of Object.entries(manifest.contracts)) await vm.stateManager.putCode(address(pin.address), hexToBytes(readCode(name)));
  const word = (a) => setLengthLeft(hexToBytes(a), 32);
  await vm.stateManager.putStorage(address(USDC), hexToBytes(manifest.usdc_proxy_slots.implementation), word(manifest.contracts.usdc_implementation.address));
  await vm.stateManager.putStorage(address(USDC), hexToBytes(manifest.usdc_proxy_slots.admin), word(PROXY_ADMIN));

  const blockAt = (seconds) => createBlock({ header: { number: 1n, timestamp: seconds, gasLimit: 30_000_000n, baseFeePerGas: 1n } }, { common });
  async function run(from, to, abi, functionName, args, { at, isStatic }) {
    const data = encodeFunctionData({ abi, functionName, args });
    const { execResult } = await vm.evm.runCall({
      caller: address(from), origin: address(from), to: address(to), data: hexToBytes(data), gasLimit: 5_000_000n, block: blockAt(at), skipBalance: true, isStatic,
    });
    const out = bytesToHex(execResult.returnValue);
    if (execResult.exceptionError) throw new Reverted(functionName, execResult.exceptionError.error === "revert" ? revertReason(out) : execResult.exceptionError.error);
    const fn = abi.find((x) => x.type === "function" && x.name === functionName && x.inputs.length === args.length);
    return fn?.outputs?.length ? decodeFunctionResult({ abi, functionName, args, data: out }) : undefined;
  }

  const chain = {
    chainId: CHAIN_ID,
    /** The EVM itself, for a test that needs it. */
    vm,
    /** The block time of every call, in seconds; a scenario may move it. */
    time,
    /** Runs a call as `from`, keeping what it changes. Throws `Reverted` with the contract's reason. */
    call: (from, to, abi, functionName, args = [], { at = chain.time } = {}) => run(from, to, abi, functionName, args, { at, isStatic: false }),
    /** A view call: nothing it does is kept. */
    read: (to, abi, functionName, args = []) => run(TOKEN_OWNER, to, abi, functionName, args, { at: chain.time, isStatic: true }),
    /** USDC held, in base units. */
    balance: (owner) => chain.read(USDC, usdcAbi, "balanceOf", [owner]),
    /** Runs `fn`, then puts the chain back as it was before, the clock included. */
    async isolated(fn) {
      const saved = chain.time;
      await vm.stateManager.checkpoint();
      try {
        return await fn();
      } finally {
        await vm.stateManager.revert();
        chain.time = saved;
      }
    },
  };

  // USDC as Base Sepolia has it: name and symbol "USDC", 6 decimals, EIP-712 version "2".
  await chain.call(TOKEN_OWNER, USDC, usdcAbi, "initialize", ["USDC", "USDC", "USD", 6, TOKEN_OWNER, TOKEN_OWNER, TOKEN_OWNER, TOKEN_OWNER]);
  await chain.call(TOKEN_OWNER, USDC, usdcAbi, "initializeV2", ["USDC"]);
  await chain.call(TOKEN_OWNER, USDC, usdcAbi, "initializeV2_1", [TOKEN_OWNER]);
  await chain.call(TOKEN_OWNER, USDC, usdcAbi, "initializeV2_2", [[], "USDC"]);
  // The domain separators are Base Sepolia's: a signature made for Base Sepolia's USDC or Permit2 verifies here.
  for (const [name, at] of [["usdc", USDC], ["permit2", PERMIT2]]) {
    const separator = await chain.read(at, usdcAbi, "DOMAIN_SEPARATOR");
    if (separator !== manifest.domain_separators[name]) throw new Error(`local ${name} DOMAIN_SEPARATOR ${separator} is not Base Sepolia's ${manifest.domain_separators[name]}`);
  }
  const total = Object.values(holders).reduce((a, b) => a + b, 0n);
  await chain.call(TOKEN_OWNER, USDC, usdcAbi, "configureMinter", [TOKEN_OWNER, total]);
  for (const [holder, units] of Object.entries(holders)) await chain.call(TOKEN_OWNER, USDC, usdcAbi, "mint", [holder, units]);
  return chain;
}
