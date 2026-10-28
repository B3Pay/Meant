#!/usr/bin/env node
// Fetch the ICRC-1 textual-encoding standard and turn its examples into test vectors.
//
//   node scripts/fetch-icrc1-vectors.mjs                  # the pinned commit below
//   node scripts/fetch-icrc1-vectors.mjs --commit <sha>   # another commit (then update PINNED)
//
// The downloaded files are untrusted data. They go into upstream/icrc1/ and nothing from there is
// ever imported, evaluated or executed: this script only reads them as text and extracts the
// examples with fixed regular expressions, aborting if the shape is not what it expects. The tests
// read test/vectors/icrc1-textual-encoding.json, which is committed, never the download.
//
// Source: https://github.com/dfinity/ICRC-1 (Apache-2.0), standards/ICRC-1/TextualEncoding.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const REPO = "dfinity/ICRC-1";
const DOC_PATH = "standards/ICRC-1/TextualEncoding.md";
/** Head of `main` when this was written (2026-10-09). */
const PINNED = "5d670e54d9a58fbf472bf0a25f33743d60cfd0e6";
const MAX_BYTES = 1024 * 1024;

const args = process.argv.slice(2);
const ci = args.indexOf("--commit");
const commit = ci >= 0 ? args[ci + 1] : PINNED;
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("--commit needs a full 40-character lowercase hex commit sha (a branch name is not a pin)");
  process.exit(2);
}

async function download(rel) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${rel}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${url}: larger than ${MAX_BYTES} bytes`);
  return { url, buf, sha256: createHash("sha256").update(buf).digest("hex") };
}

const doc = await download(DOC_PATH);
const license = await download("LICENSE");
const outDir = path.join(PKG, "upstream", "icrc1");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "TextualEncoding.md"), doc.buf);
await writeFile(path.join(outDir, "LICENSE"), license.buf);
await writeFile(
  path.join(outDir, "SOURCE.json"),
  JSON.stringify(
    {
      note: "Untrusted download. Read as text by scripts/fetch-icrc1-vectors.mjs only; never imported or executed.",
      repo: `https://github.com/${REPO}`,
      commit,
      files: {
        "TextualEncoding.md": { path: DOC_PATH, url: doc.url, sha256: doc.sha256, bytes: doc.buf.length },
        LICENSE: { path: "LICENSE", url: license.url, sha256: license.sha256, bytes: license.buf.length, license: "Apache-2.0" },
      },
      fetched: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  ) + "\n",
);

// ---------------------------------------------------------------- extraction (text in, data out)

const text = doc.buf.toString("utf8");
const fail = (msg) => {
  throw new Error(`unexpected TextualEncoding.md shape: ${msg}`);
};

/** `"\01\02..."` -> hex. Only `\xx` escapes are accepted. */
function blobHex(escaped) {
  if (!/^(?:\\[0-9a-fA-F]{2})+$/.test(escaped)) fail(`blob literal ${escaped}`);
  const hex = [...escaped.matchAll(/\\([0-9a-fA-F]{2})/g)].map((m) => m[1].toLowerCase()).join("");
  if (hex.length !== 64) fail(`blob literal of ${hex.length / 2} bytes`);
  return hex;
}

/** `opt vec {1;2;3}` -> hex */
function vecHex(list) {
  const nums = list.split(";").map((s) => s.trim()).filter(Boolean);
  if (!nums.every((n) => /^[0-9]{1,3}$/.test(n) && Number(n) < 256)) fail(`vec literal ${list}`);
  return nums.map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

// 1. The Examples table: | `text` | OK: `{ owner = "…"; subaccount = … }` or Error | comment |
const examplesSection = text.split(/^## Examples\s*$/m)[1]?.split(/^## /m)[0];
if (!examplesSection) fail("no Examples section");
const parse = [];
for (const line of examplesSection.split("\n")) {
  if (!line.startsWith("| `")) continue;
  const cells = line.split("|").map((c) => c.trim());
  const input = /^`([^`]*)`$/.exec(cells[1] ?? "")?.[1] ?? fail(`text cell ${cells[1]}`);
  const comment = cells[3] ?? "";
  if (/^Error$/.test(cells[2])) {
    parse.push({ text: input, ok: false, comment });
    continue;
  }
  const m = /^OK: `\{ owner = "([a-z0-9-]+)"[;,] subaccount = (null|opt blob "([^"]*)") \}`$/.exec(cells[2]) ?? fail(`result cell ${cells[2]}`);
  parse.push({ text: input, ok: true, owner: m[1], subaccount: m[3] === undefined ? null : blobHex(m[3]), comment });
}

// 2. The Account.toText code blocks: record { owner = principal "…"[,;] subaccount = null | opt vec {…}; }) = "…"
const display = [];
const re = /Account\.toText\(record \{\s*owner = principal "([a-z0-9-]+)"[;,]\s*subaccount = (null|opt vec \{([0-9;\s]*)\})[;,]?\s*\}\) = "([^"]*)"/g;
for (const m of text.matchAll(re)) {
  display.push({ owner: m[1], subaccount: m[3] === undefined ? null : vecHex(m[3]), text: m[4] });
}

if (parse.length < 7) fail(`only ${parse.length} table rows`);
if (display.length < 3) fail(`only ${display.length} toText examples`);

const vectors = {
  source: {
    repo: `https://github.com/${REPO}`,
    commit,
    path: DOC_PATH,
    sha256: doc.sha256,
    note: "Extracted by scripts/fetch-icrc1-vectors.mjs; `parse` is the Examples table, `display` the Account.toText code blocks.",
  },
  parse,
  display,
};
await mkdir(path.join(PKG, "test", "vectors"), { recursive: true });
await writeFile(path.join(PKG, "test", "vectors", "icrc1-textual-encoding.json"), JSON.stringify(vectors, null, 2) + "\n");
console.log(`commit ${commit}\nTextualEncoding.md sha256 ${doc.sha256}\n${parse.length} parse vectors, ${display.length} display vectors`);
