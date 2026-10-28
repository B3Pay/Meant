// @meantjs/profile/evm: Keccak-256, ABI fragments and calldata, EIP-55 and EIP-712, with no dependency.
import { decodeParams, encodeCall, keccak256Hex, parseAbi, toChecksumAddress, typedDataDigest, type AbiFunction } from "@meantjs/profile/evm";
import { check } from "./check.mts";

check(keccak256Hex("") === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256Hex");
const { functions, errors } = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
const transfer: AbiFunction | undefined = functions[0];
check(errors.length === 0 && transfer?.selector === "0xa9059cbb", "parseAbi");
if (transfer) {
  const data = encodeCall(transfer, { to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", value: 5n });
  const back = decodeParams(transfer.inputs, data.subarray(4));
  check(back["to"] === toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") && back["value"] === "5", "decodeParams");
}
check(typedDataDigest({ domain: { name: "x" }, types: { T: [{ name: "a", type: "uint8" }] }, primaryType: "T", message: { a: 1 } }).length === 66, "typedDataDigest");
