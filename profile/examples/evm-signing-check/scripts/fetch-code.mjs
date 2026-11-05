// `npm run fetch`: reads the code of the six contracts from a Base Sepolia node (read-only calls: eth_chainId,
// eth_getCode, eth_getStorageAt, eth_call) into artifacts/, and keeps it only when every pin in artifacts.json holds:
// each code's keccak-256, the USDC proxy's implementation, and the two EIP-712 domain separators. Nothing is signed or
// sent. Another node: `npm run fetch -- --rpc <url>` or BASE_SEPOLIA_RPC=<url>.
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, keccak256 } from "viem";
import { manifest, paths } from "../src/artifacts.mjs";

const flag = process.argv.indexOf("--rpc");
const rpc = flag > 0 ? process.argv[flag + 1] : process.env.BASE_SEPOLIA_RPC || manifest.rpc;
if (!rpc) throw new Error("--rpc needs a URL");

let id = 0;
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (!res.ok) throw new Error(`${rpc} answered ${res.status} to ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const chainId = Number(await call("eth_chainId", []));
if (chainId !== manifest.chain_id) throw new Error(`${rpc} is chain ${chainId}, not Base Sepolia (${manifest.chain_id})`);

const slot = await call("eth_getStorageAt", [manifest.contracts.usdc.address, manifest.usdc_proxy_slots.implementation, "latest"]);
const implementation = getAddress(`0x${slot.slice(-40)}`);
if (implementation !== manifest.contracts.usdc_implementation.address) {
  throw new Error(`Base Sepolia's USDC now delegates to ${implementation}, not the pinned ${manifest.contracts.usdc_implementation.address}: pin the new implementation in artifacts.json after reading it`);
}

mkdirSync(paths.dir, { recursive: true });
for (const [name, c] of Object.entries(manifest.contracts)) {
  if (getAddress(c.address) !== c.address) throw new Error(`${name}: ${c.address} is not in its EIP-55 form, ${getAddress(c.address)}`);
  const code = await call("eth_getCode", [c.address, "latest"]);
  const hash = keccak256(code);
  if (hash !== c.keccak256) throw new Error(`${name} (${c.address}): code keccak-256 is ${hash}, the pin is ${c.keccak256}`);
  if ((code.length - 2) / 2 !== c.bytes) throw new Error(`${name}: ${(code.length - 2) / 2} bytes, the pin says ${c.bytes}`);
  writeFileSync(paths.code(name), `${code}\n`);
  console.log(`${name.padEnd(23)} ${c.address}  ${String(c.bytes).padStart(5)} bytes  keccak-256 ok`);
}

const DOMAIN_SEPARATOR = "0x3644e515";
for (const name of ["usdc", "permit2"]) {
  const separator = await call("eth_call", [{ to: manifest.contracts[name].address, data: DOMAIN_SEPARATOR }, "latest"]);
  if (separator !== manifest.domain_separators[name]) throw new Error(`${name}: DOMAIN_SEPARATOR is ${separator}, the pin is ${manifest.domain_separators[name]}`);
  console.log(`${name.padEnd(23)} DOMAIN_SEPARATOR ${separator} ok`);
}
console.log(`artifacts/ holds the code of ${Object.keys(manifest.contracts).length} contracts from ${rpc}`);
