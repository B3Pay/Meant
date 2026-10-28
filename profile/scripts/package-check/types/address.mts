// @meantjs/profile/address: the address grammar with no dependency.
import { U32_MAX, idlHash, parseAddress, parseRelPath, type Address } from "@meantjs/profile/address";
import { check } from "./check.mts";

const a: Address | null = parseAddress("icrc1_transfer(0).to.owner");
check(a !== null && a.kind === "arg" && a.method === "icrc1_transfer" && a.segs.length === 2, "parseAddress");
const rel = parseRelPath("Err.InsufficientFunds");
check(rel !== null && rel.index === null && rel.segs[0]?.id === idlHash("Err"), "parseRelPath");
check(U32_MAX === 4294967295, "U32_MAX");
