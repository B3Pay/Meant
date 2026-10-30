// Downloads the pinned PocketIC server and ICRC ledger into .cache/ and checks every sha256.
// Files that already match are left alone. Nothing downloaded is run here.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { manifest, paths, platformKey, sha256 } from "../src/artifacts.mjs";

async function ensure(dest, url, expected, label) {
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) return console.log(`ok     ${label} (cached)`);
  console.log(`fetch  ${label} <- ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${url}: sha256 ${got}, pinned ${expected}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(`${dest}.partial`, bytes, { mode: 0o600 });
  renameSync(`${dest}.partial`, dest);
  console.log(`ok     ${label}`);
}

await ensure(paths.ledgerWasm, manifest.ledger.wasm.url, manifest.ledger.wasm.sha256, "ICRC ledger wasm");
await ensure(paths.ledgerDid, manifest.ledger.did.url, manifest.ledger.did.sha256, "ICRC ledger .did");

const plat = manifest.pocket_ic.platforms[platformKey()];
if (!plat) throw new Error(`no PocketIC build is pinned for ${platformKey()} (pinned: ${Object.keys(manifest.pocket_ic.platforms).join(", ")})`);
if (existsSync(paths.pocketIc) && sha256(readFileSync(paths.pocketIc)) === plat.sha256) {
  console.log(`ok     PocketIC ${manifest.pocket_ic.version} (cached)`);
} else {
  await ensure(paths.pocketIcGz, plat.url, plat.gz_sha256, `PocketIC ${manifest.pocket_ic.version} (.gz)`);
  const bin = gunzipSync(readFileSync(paths.pocketIcGz));
  if (sha256(bin) !== plat.sha256) throw new Error(`PocketIC unpacked sha256 ${sha256(bin)}, pinned ${plat.sha256}`);
  mkdirSync(path.dirname(paths.pocketIc), { recursive: true });
  writeFileSync(`${paths.pocketIc}.partial`, bin, { mode: 0o700 });
  renameSync(`${paths.pocketIc}.partial`, paths.pocketIc);
  chmodSync(paths.pocketIc, 0o700);
  console.log(`ok     PocketIC ${manifest.pocket_ic.version} (unpacked)`);
}
