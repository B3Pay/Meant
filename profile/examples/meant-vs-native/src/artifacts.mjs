// Where the pinned PocketIC server and ICRC ledger live once fetched, and their sha256 check.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const manifest = JSON.parse(readFileSync(path.join(ROOT, "artifacts.json"), "utf8"));
const CACHE = path.join(ROOT, ".cache");

export const platformKey = () => `${process.platform}-${process.arch}`;

export const paths = {
  // The server panics at start unless its file is named pocket-ic (observed with 16.0.0), so it gets a versioned folder.
  pocketIc: path.join(CACHE, `pocket-ic-${manifest.pocket_ic.version}`, "pocket-ic"),
  pocketIcGz: path.join(CACHE, `pocket-ic-${manifest.pocket_ic.version}.gz`),
  ledgerWasm: path.join(CACHE, manifest.ledger.release, "ic-icrc1-ledger.wasm.gz"),
  ledgerDid: path.join(CACHE, manifest.ledger.release, "ledger.did"),
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The file's bytes, or a throw when they are not the pinned ones. */
export function readVerified(file, expected) {
  const bytes = readFileSync(file);
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${file}: sha256 ${got}, pinned ${expected}. Run npm run fetch.`);
  return bytes;
}
