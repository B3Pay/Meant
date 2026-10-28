// The one manual publish per package name (docs/releasing.md, "First publish of a new name"). npm can attach a trusted
// publisher only to a package that already exists, so the owner publishes a placeholder once, by hand, under the
// `bootstrap` dist-tag. This writes that placeholder: a package.json, a README and the LICENSE, no code and no
// dependencies, at version 0.0.0-bootstrap, so the name holds nothing anyone could install by accident. It publishes
// nothing; it prints the commands for the owner to run.
//
//   node scripts/package-check/bootstrap.mjs <format|resolver|consent|tools|reconcile> [out-dir]
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_DIRS } from "./packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BOOTSTRAP_VERSION = "0.0.0-bootstrap";

/** Write the placeholder of the library package in packages/<dir> into `out` (empty or missing); returns its manifest. */
export function writePlaceholder(dir, out, { root = ROOT } = {}) {
  if (!LIBRARY_DIRS.includes(dir)) throw new Error(`${dir} is not a library package (${LIBRARY_DIRS.join(", ")})`);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) throw new Error(`${out} is not empty`);
  const real = JSON.parse(readFileSync(path.join(root, "packages", dir, "package.json"), "utf8"));
  const manifest = {
    name: real.name,
    version: BOOTSTRAP_VERSION,
    description: `Placeholder that registers the name for trusted publishing. Install a released version of ${real.name} instead.`,
    license: real.license,
    repository: real.repository,
    homepage: real.homepage,
    files: ["README.md", "LICENSE"],
  };
  writeFileSync(path.join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    path.join(out, "README.md"),
    `# ${real.name} ${BOOTSTRAP_VERSION}\n\nThis version is a placeholder with no code. It exists because npm can attach a trusted publisher only to a\npackage that is already on the registry. Every real version is published by the repository's release workflow.\nInstall \`${real.name}\` without a tag to get the latest released version.\n`,
  );
  writeFileSync(path.join(out, "LICENSE"), readFileSync(path.join(root, "packages", dir, "LICENSE")));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, outArg] = process.argv.slice(2);
  if (!LIBRARY_DIRS.includes(dir ?? "")) {
    console.error(`usage: node scripts/package-check/bootstrap.mjs <${LIBRARY_DIRS.join("|")}> [out-dir]`);
    process.exit(2);
  }
  const out = outArg ? path.resolve(outArg) : mkdtempSync(path.join(os.tmpdir(), `bootstrap-${dir}-`));
  const { name } = writePlaceholder(dir, out);
  console.log(`placeholder for ${name}@${BOOTSTRAP_VERSION} written to ${out}

Review it, then publish it once, by hand (docs/releasing.md):

  cd ${out}
  npm pack --dry-run          # package.json, README.md and LICENSE, nothing else
  npm login                   # interactive, 2FA
  npm publish --access public --tag bootstrap
  npm logout                  # invalidates the token npm login wrote`);
}
