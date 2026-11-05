// The pinned contract code (artifacts.json) and where `npm run fetch` keeps it. A code file is used only when its
// keccak-256 is the pinned one, so the local chain runs exactly the code Base Sepolia runs at those addresses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const manifest = JSON.parse(readFileSync(join(root, "artifacts.json"), "utf8"));
export const paths = { dir: join(root, "artifacts"), code: (name) => join(root, "artifacts", `${name}.hex`) };

/** The runtime code of one pinned contract, as 0x-hex, after checking its hash. */
export function readCode(name) {
  const pin = manifest.contracts[name];
  if (!pin) throw new Error(`no contract named ${name} in artifacts.json`);
  let code;
  try {
    code = readFileSync(paths.code(name), "utf8").trim();
  } catch {
    throw new Error(`artifacts/${name}.hex is missing: run \`npm run fetch\` first`);
  }
  const hash = keccak256(code);
  if (hash !== pin.keccak256) throw new Error(`artifacts/${name}.hex has keccak-256 ${hash}, the pin is ${pin.keccak256}: run \`npm run fetch\` again`);
  return code;
}
