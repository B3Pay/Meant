#!/usr/bin/env node
// Writes test/golden/<case>.json and test/golden/REVIEW.md from test/golden/cases.mjs, and test/sns-golden/<case>.json
// and test/sns-golden/REVIEW.md from test/sns-golden/cases.mjs, with the dapp's resolved forms the Rust tests read
// (test/sns-golden/resolved/), and the differential corpus of the Rust port (test/differential/corpus.json).
//
//   npm run golden -w packages/consent
//
// The JSON files are the expected outputs the golden tests compare against; REVIEW.md shows every message in
// reading order, for review by eye. After any change to the generator, the profile packs or the renderer, run this,
// read the diff of both REVIEW.md files, and commit them. The golden tests also check the hand-worked `expect` of each
// case against the same output, so a bug cannot be recorded silently.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { buildGolden, renderReview } from "../test/golden/build.mjs";
import { CASES } from "../test/golden/cases.mjs";
import { RESOLVED_FOR_RUST, buildSnsGolden, renderSnsReview, resolvedJson } from "../test/sns-golden/build.mjs";
import { CASES as SNS_CASES } from "../test/sns-golden/cases.mjs";
import { buildCorpus, corpusJson } from "../test/differential/build.mjs";

async function write(dirName, cases, build, review) {
  const dir = new URL(`../test/${dirName}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (f.endsWith(".json")) await rm(new URL(f, dir));
  for (const c of cases) await writeFile(new URL(`${c.id}.json`, dir), `${JSON.stringify(build(c), null, 2)}\n`);
  await writeFile(new URL("REVIEW.md", dir), review(cases));
  console.log(`wrote ${cases.length} golden files and REVIEW.md in test/${dirName}`);
}

await write("golden", CASES, buildGolden, renderReview);
await write("sns-golden", SNS_CASES, buildSnsGolden, renderSnsReview);

const resolvedDir = new URL("../test/sns-golden/resolved/", import.meta.url);
await mkdir(resolvedDir, { recursive: true });
for (const name of Object.keys(RESOLVED_FOR_RUST)) await writeFile(new URL(`${name}.resolved.json`, resolvedDir), resolvedJson(name));
console.log(`wrote ${Object.keys(RESOLVED_FOR_RUST).length} resolved forms in test/sns-golden/resolved`);

const corpus = buildCorpus();
await writeFile(new URL("../test/differential/corpus.json", import.meta.url), corpusJson(corpus));
console.log(`wrote ${corpus.vectors.length} vectors in test/differential/corpus.json`);
