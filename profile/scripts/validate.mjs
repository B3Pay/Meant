#!/usr/bin/env node
/**
 * Candid Profile validator: a thin CLI over @meantjs/profile (packages/resolver).
 *
 *   node scripts/validate.mjs                         # every packs/*.profile.json
 *   node scripts/validate.mjs path/to/x.profile.json --did path/to/service.did
 *   node scripts/validate.mjs packs/icrc1.profile.json --resolved   # print resolved form
 *   node scripts/validate.mjs --json                  # machine-readable report
 *
 * Layer 1: JSON Schema (spec/profile-v0.schema.json).
 * Layer 2: semantic checks against the Candid interface, compiled to a canonical candid-core Contract
 *          (packs: `binds.requires`; canister profiles: the --did file). All of it lives in packages/resolver.
 *
 * One profile at a time. Several profiles, pack matching and layer merging (docs/profile-v0.md section 8) are
 * `candid-profile resolve` (packages/resolver/bin/candid-profile.mjs).
 *
 * The package is imported by relative path so that this script keeps working in a checkout that has not been
 * re-installed since the workspace was added.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSchemaValidator, validateProfile } from "../packages/resolver/src/index.mjs";

export { idlHash, jcs, parseAddress } from "../packages/resolver/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function validateFile(file, opts, validateSchema) {
  const doc = JSON.parse(await readFile(file, "utf8"));
  const did = opts.did && doc.kind === "canister" ? await readFile(opts.did, "utf8") : null;
  const r = await validateProfile(doc, { validateSchema, did, didLabel: opts.did, resolved: opts.resolved });
  return { file, ...r };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { did: null, json: false, resolved: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--did") opts.did = argv[++i];
    else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--resolved") opts.resolved = true;
    else files.push(argv[i]);
  }
  if (!files.length) {
    const dir = path.join(ROOT, "packs");
    for (const f of (await readdir(dir)).sort()) if (f.endsWith(".profile.json")) files.push(path.join(dir, f));
  }
  const validateSchema = await createSchemaValidator(path.join(ROOT, "spec/profile-v0.schema.json"));

  const results = [];
  for (const f of files) results.push(await validateFile(f, opts, validateSchema));

  if (opts.resolved) {
    if (results.length !== 1) throw new Error("--resolved takes exactly one profile");
    if (!results[0].resolved) throw new Error(`no resolved form: ${JSON.stringify(results[0].diagnostics)}`);
    process.stdout.write(`${JSON.stringify(results[0].resolved, null, 2)}\n`);
  } else if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      const rel = path.relative(process.cwd(), r.file);
      const counts = ["error", "warning", "info"].map((s) => `${r.diagnostics.filter((d) => d.severity === s).length} ${s}`).join(", ");
      console.log(`${r.ok ? "PASS" : "FAIL"} ${rel}  (${counts})`);
      if (r.profile_id) console.log(`     profile_id   ${r.profile_id}`);
      if (r.interface_id) console.log(`     interface_id ${r.interface_id}  [${r.methods} methods, ${r.annotations} annotations]`);
      for (const d of r.diagnostics) console.log(`     ${d.severity.padEnd(7)} ${d.code.padEnd(24)} ${d.at}  ${d.message}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
