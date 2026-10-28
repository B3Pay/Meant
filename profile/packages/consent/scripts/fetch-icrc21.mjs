#!/usr/bin/env node
// Re-checks test/upstream/icrc21 against the commit recorded in its SOURCE.json. Needs network.
//
//   node scripts/fetch-icrc21.mjs --out <empty directory>
//
// Downloads every file of SOURCE.json into <empty directory> (which must not exist or be empty, and should be
// outside the repository: the files are untrusted data) and compares sha256 with the record. It never writes into
// test/upstream and never executes anything it downloads. To move to another commit, edit SOURCE.json (commit and
// URLs), run this script, review the diff of the downloaded files, then copy them in by hand and update the hashes.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const out = process.argv[process.argv.indexOf("--out") + 1];
if (!out || out.startsWith("--")) {
  console.error("usage: node scripts/fetch-icrc21.mjs --out <empty directory>");
  process.exit(2);
}
await mkdir(out, { recursive: true });
if ((await readdir(out)).length > 0) {
  console.error(`${out} is not empty; use a new directory (downloaded files are untrusted data)`);
  process.exit(2);
}
const source = JSON.parse(await readFile(new URL("../test/upstream/icrc21/SOURCE.json", import.meta.url), "utf8"));
let mismatches = 0;
for (const [name, meta] of Object.entries(source.files)) {
  const res = await fetch(meta.url);
  if (!res.ok) {
    console.error(`${name}: HTTP ${res.status}`);
    mismatches++;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  await mkdir(path.dirname(path.join(out, name)), { recursive: true });
  await writeFile(path.join(out, name), bytes);
  const same = sha === meta.sha256;
  if (!same) mismatches++;
  console.log(`${same ? "ok      " : "MISMATCH"} ${name} ${sha}`);
}
process.exit(mismatches === 0 ? 0 : 1);
