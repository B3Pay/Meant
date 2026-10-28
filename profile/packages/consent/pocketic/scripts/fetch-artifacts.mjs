#!/usr/bin/env node
// Download the pinned PocketIC server and SNS governance wasm and .did into .cache/ and verify their sha256.
// Idempotent: files that already match are left alone. Never executes anything it downloads.
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { manifest, paths, platformKey, sha256File } from "./artifacts.mjs";

async function download(url, dest, sha256) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(tmp, { mode: 0o600 }),
  );
  const got = hash.digest("hex");
  if (got !== sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${url}: pinned ${sha256}, got ${got}`);
  }
  renameSync(tmp, dest);
}

async function ensure(dest, url, sha256, label) {
  if (existsSync(dest) && (await sha256File(dest)) === sha256) {
    console.log(`ok      ${label} (cached)`);
    return;
  }
  console.log(`fetch   ${label} <- ${url}`);
  await download(url, dest, sha256);
  console.log(`ok      ${label} (sha256 ${sha256.slice(0, 12)}...)`);
}

for (const [name, f] of Object.entries(manifest.sns_governance.files)) {
  await ensure(paths.file(name), f.url, f.sha256, name);
}

const plat = manifest.pocket_ic.platforms[platformKey()];
if (!plat?.sha256) throw new Error(`no unpacked pocket-ic ${manifest.pocket_ic.version} pinned for ${platformKey()} in artifacts.json`);
if (existsSync(paths.pocketIc) && (await sha256File(paths.pocketIc)) === plat.sha256) {
  console.log(`ok      pocket-ic ${manifest.pocket_ic.version} (cached)`);
} else {
  await ensure(paths.pocketIcGz, plat.url, plat.gz_sha256, `pocket-ic ${manifest.pocket_ic.version}.gz`);
  mkdirSync(dirname(paths.pocketIc), { recursive: true });
  const tmp = `${paths.pocketIc}.partial`;
  await pipeline(createReadStream(paths.pocketIcGz), createGunzip(), createWriteStream(tmp, { mode: 0o700 }));
  const got = await sha256File(tmp);
  if (got !== plat.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`pocket-ic unpacked sha256 mismatch: pinned ${plat.sha256}, got ${got}`);
  }
  renameSync(tmp, paths.pocketIc);
  chmodSync(paths.pocketIc, 0o700);
  console.log(`ok      pocket-ic ${manifest.pocket_ic.version} unpacked (sha256 ${got.slice(0, 12)}...)`);
}
