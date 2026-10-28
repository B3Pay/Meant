// The release workflow's manifest gate (npm-release-profile.yml in B3Pay/Meant, verify job): the five library packages are
// at the version being released, publishable (no `private`), each CHANGELOG.md dates an entry for it, and no README
// still says the package is not on npm. Release
// prep is in docs/releasing.md. Exit 1 with every reason at once.
//
//   node scripts/package-check/release-check.mjs <version>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_DIRS } from "./packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The words each README carries until the first release. */
export const NOT_ON_NPM = "Not on npm yet";

/** Every reason the tree is not ready to publish `version`; empty when it is. */
export function releaseProblems(version, { root = ROOT } = {}) {
  const problems = [];
  const escaped = version.replaceAll(".", "\\.");
  for (const dir of LIBRARY_DIRS) {
    const pkg = JSON.parse(readFileSync(path.join(root, "packages", dir, "package.json"), "utf8"));
    if (pkg.version !== version) problems.push(`${pkg.name} is at ${pkg.version}, not ${version}`);
    if ("private" in pkg) problems.push(`${pkg.name} still says "private": ${pkg.private} (the release PR removes it)`);
    const changelog = readFileSync(path.join(root, "packages", dir, "CHANGELOG.md"), "utf8");
    if (!new RegExp(`^## ${escaped} — \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
      problems.push(`${pkg.name}: CHANGELOG.md has no dated entry "## ${version} — YYYY-MM-DD"`);
    }
    if (/^## Unreleased/im.test(changelog) || new RegExp(`^## ${escaped} \\(unreleased\\)`, "m").test(changelog)) {
      problems.push(`${pkg.name}: CHANGELOG.md still has an unreleased section`);
    }
    if (readFileSync(path.join(root, "packages", dir, "README.md"), "utf8").includes(NOT_ON_NPM)) {
      problems.push(`${pkg.name}: README.md still says "${NOT_ON_NPM}" (the first release PR removes that sentence)`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    console.error("usage: node scripts/package-check/release-check.mjs <semver>");
    process.exit(2);
  }
  const problems = releaseProblems(version);
  for (const p of problems) console.error(`not ready: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`ok the five library packages are ready to publish ${version}`);
}
