// Set the version of the five library packages, which release in lockstep, and every exact pin on them across the
// workspaces (the private packages included), then refresh the lockfile. Release prep runs it in the version-bump PR
// (docs/releasing.md); `npm run pack:check` then refuses packages whose versions or pins disagree.
//
//   node scripts/package-check/set-version.mjs 0.2.0
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_DIRS } from "./packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/package-check/set-version.mjs <semver>");
  process.exit(2);
}

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const names = new Set(LIBRARY_DIRS.map((dir) => read(path.join(ROOT, "packages", dir, "package.json")).name));
for (const dir of readdirSync(path.join(ROOT, "packages"))) {
  const file = path.join(ROOT, "packages", dir, "package.json");
  let pkg;
  try {
    pkg = read(file);
  } catch {
    continue; // not an npm workspace (profile-router)
  }
  let changed = false;
  if (names.has(pkg.name) && pkg.version !== version) {
    pkg.version = version;
    changed = true;
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (names.has(dep) && pkg[field][dep] !== version) {
        pkg[field][dep] = version;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`updated packages/${dir}/package.json`);
  }
}
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
console.log(`the library packages are at ${version}; review the diff and the CHANGELOG.md of each`);
