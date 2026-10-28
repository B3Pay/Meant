// The packaged-consumer check for the library packages. It packs each one exactly as `npm publish` would, and proves
// the artifact stands up on its own, outside this repository:
//
// - the tarball holds exactly the files manifest.json lists (a positive list: a new file is outside the package until
//   it is named there, and a test or script that slips in fails here), and its exports are the ones listed;
// - the packages share one version (they release in lockstep), and a dependency on another package of this repository
//   names one of the packages checked here, at that exact version;
// - each ships the Apache-2.0 LICENSE (byte-identical to apache.org's text), declares `license: "Apache-2.0"`, and
//   ships a CHANGELOG.md with an entry for the version packed;
// - installed from the tarballs into a scratch project (no workspace links, no spec/ or packs/ next to it), every
//   export loads and the resolver, its CLI, format, consent, tools and reconcile work (smoke.mjs), with eval and
//   `new Function` disabled, as under a Content-Security-Policy with no 'unsafe-eval';
// - the strict TypeScript consumer programs in types/ compile against the installed declarations (no skipLibCheck)
//   and run there, so a declaration that does not compile or does not describe the value fails before npm;
// - each browser entry, bundled by esbuild for the browser from that install, pulls in no node:* module.
//
//   node scripts/package-check/check.mjs            check (CI's `package` job; npm run pack:check)
//   node scripts/package-check/check.mjs --update   rewrite manifest.json from what is packed now, then check
//   node scripts/package-check/check.mjs --keep     keep the scratch directory and print where it is
//
// The install reaches the npm registry for the third-party dependencies (ajv, @candid-core/cli, @candid-core/schema).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { APACHE_2_0_SHA256, LIBRARY_DIRS } from "./packages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const MANIFEST = path.join(HERE, "manifest.json");
const { values: opts } = parseArgs({ options: { update: { type: "boolean" }, keep: { type: "boolean" } } });

const DIRS = LIBRARY_DIRS;
/** Browser entries, and what each bundle may leave out (the cli is its own package and loads its wasm itself). */
const BROWSER = [
  ["@meantjs/profile/browser", ["@candid-core/cli"]],
  ["@meantjs/profile/address", []],
  ["@meantjs/profile/evm", []],
  ["@meantjs/format", []],
  ["@meantjs/consent", []],
  ["@meantjs/consent/evm", []],
  ["@meantjs/consent/erc7730", []],
  ["@meantjs/tools", []],
  ["@meantjs/reconcile", []],
];

const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const scratch = mkdtempSync(path.join(tmpdir(), "candid-profile-pack-"));
const tarballs = path.join(scratch, "tarballs");
const consumer = path.join(scratch, "consumer");
mkdirSync(tarballs);
mkdirSync(consumer);

try {
  // 1. Pack, and compare each tarball with the manifest.
  const packed = DIRS.map((dir) => {
    const [info] = JSON.parse(npm(["pack", "--json", "--pack-destination", tarballs], path.join(ROOT, "packages", dir)));
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8"));
    return { dir, pkg, info, files: info.files.map((f) => f.path).sort() };
  });
  const actual = Object.fromEntries(packed.map(({ pkg, files }) => [pkg.name, { exports: Object.keys(pkg.exports), files }]));
  if (opts.update) writeFileSync(MANIFEST, JSON.stringify(actual, null, 2) + "\n");
  const expected = JSON.parse(readFileSync(MANIFEST, "utf8"));
  assert.deepEqual(Object.keys(actual), Object.keys(expected), "the packages checked are not the ones manifest.json lists");
  const versions = new Map(packed.map(({ pkg }) => [pkg.name, pkg.version]));
  assert.equal(new Set(versions.values()).size, 1, `the library packages release in lockstep, but their versions differ: ${JSON.stringify(Object.fromEntries(versions))}`);
  for (const { pkg, info, files } of packed) {
    assert.deepEqual(files, expected[pkg.name].files, `${pkg.name}: the tarball's files differ from manifest.json (run with --update after reviewing them)`);
    assert.deepEqual(Object.keys(pkg.exports), expected[pkg.name].exports, `${pkg.name}: the exports differ from manifest.json`);
    for (const f of files) assert.doesNotMatch(f, /(^|\/)(test|tests|scripts|__tests__)\/|\.test\.m?js$/, `${pkg.name} ships ${f}`);
    for (const target of exportTargets(pkg.exports)) {
      if (target.includes("*")) continue;
      assert.ok(files.includes(target.replace(/^\.\//, "")), `${pkg.name}: export target ${target} is not in the tarball`);
    }
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@meantjs/")) continue;
      assert.ok(versions.has(dep), `${pkg.name} depends on ${dep}, which is not one of the published packages`);
      assert.equal(range, versions.get(dep), `${pkg.name} must pin ${dep} at its exact version ${versions.get(dep)}`);
    }
    const dirOf = path.join(ROOT, "packages", packed.find((p) => p.pkg === pkg).dir);
    assert.equal(pkg.license, "Apache-2.0", `${pkg.name}: license`);
    assert.equal(createHash("sha256").update(readFileSync(path.join(dirOf, "LICENSE"))).digest("hex"), APACHE_2_0_SHA256, `${pkg.name}: LICENSE is not the Apache-2.0 text`);
    const changelog = readFileSync(path.join(dirOf, "CHANGELOG.md"), "utf8");
    assert.match(changelog, new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}(?: |$)`, "m"), `${pkg.name}: CHANGELOG.md has no entry for ${pkg.version}`);
    console.log(`ok ${pkg.name}@${pkg.version}: ${files.length} files, ${kb(info.size)} packed, ${kb(info.unpackedSize)} unpacked`);
  }

  // 2. Install the tarballs into a scratch consumer. `overrides` makes the packages' dependencies on each other
  // resolve to these tarballs too, never to a registry copy.
  const deps = Object.fromEntries(packed.map(({ pkg, info }) => [pkg.name, `file:../tarballs/${info.filename}`]));
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: deps, overrides: deps }, null, 2));
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], consumer);
  for (const { pkg } of packed) {
    const installed = JSON.parse(readFileSync(path.join(consumer, "node_modules", pkg.name, "package.json"), "utf8"));
    assert.equal(installed.version, pkg.version, `${pkg.name} installed at ${installed.version}`);
  }
  console.log(`ok installed ${packed.length} tarballs in ${consumer}`);

  // 3. Use them, from the consumer's node_modules.
  copyFileSync(path.join(HERE, "smoke.mjs"), path.join(consumer, "smoke.mjs"));
  copyFileSync(path.join(ROOT, "packages/resolver/test/fixtures/ledger.did"), path.join(consumer, "ledger.did"));
  copyFileSync(path.join(ROOT, "packages/consent/test/golden/transfer-tka-basic.json"), path.join(consumer, "transfer-tka-basic.json"));
  writeFileSync(path.join(consumer, "packages.json"), JSON.stringify(packed.map(({ pkg }) => pkg.name)));
  execFileSync(process.execPath, ["--disallow-code-generation-from-strings", "smoke.mjs"], { cwd: consumer, stdio: "inherit" });

  // 4. The types: compile the consumer programs against the installed declarations, then run them.
  const types = path.join(consumer, "types");
  mkdirSync(types);
  const programs = readdirSync(path.join(HERE, "types")).filter((f) => f.endsWith(".mts") || f === "tsconfig.json");
  for (const f of programs) copyFileSync(path.join(HERE, "types", f), path.join(types, f));
  const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc"); // the root's exact pin; its exports do not name the bin
  execFileSync(process.execPath, [tsc, "-p", path.join(types, "tsconfig.json")], { cwd: types, stdio: "inherit" });
  console.log(`ok the consumer programs compile against the installed types (strict, no skipLibCheck)`);
  for (const f of programs.filter((f) => f.endsWith(".mts") && f !== "check.mts")) {
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", f], { cwd: types, stdio: "inherit" });
    console.log(`  ok types/${f} runs`);
  }

  // 5. Bundle each browser entry for the browser from the install.
  for (const [spec, external] of BROWSER) {
    const result = await build({
      stdin: { contents: `export * from ${JSON.stringify(spec)};`, resolveDir: consumer, loader: "js" },
      absWorkingDir: consumer,
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
      external,
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(inputs.filter((p) => p.startsWith("node:") || p.includes("(disabled):")), [], `${spec} pulls in a Node built-in`);
    const imports = [...new Set(Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path)))];
    assert.deepEqual(imports, external, `${spec} leaves out more than ${external.join(", ") || "nothing"}`);
    console.log(`ok ${spec} bundles for the browser (${kb(result.outputFiles[0].contents.length)}, ${inputs.length} modules)`);
  }
  console.log(opts.update ? `ok manifest.json rewritten and checked` : "ok every package check passed");
} finally {
  if (opts.keep) console.log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

function* exportTargets(exports) {
  for (const value of Object.values(exports)) {
    if (typeof value === "string") yield value;
    else yield* exportTargets(value);
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
