// The release gates of docs/releasing.md: release-check.mjs (the verify job's manifest gate) and the bootstrap
// placeholder. Both run on a scratch copy of the five packages' manifests and changelogs, so the tests hold before and
// after a release PR changes the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_DIRS } from "./package-check/packages.mjs";
import { NOT_ON_NPM, releaseProblems } from "./package-check/release-check.mjs";
import { BOOTSTRAP_VERSION, writePlaceholder } from "./package-check/bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A scratch root holding each library package's package.json, CHANGELOG.md and LICENSE, edited by `edit`. */
function scratchRoot(t, edit = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of LIBRARY_DIRS) {
    const to = path.join(root, "packages", dir);
    mkdirSync(to, { recursive: true });
    for (const file of ["package.json", "CHANGELOG.md", "README.md", "LICENSE"]) cpSync(path.join(ROOT, "packages", dir, file), path.join(to, file));
    const pkg = JSON.parse(readFileSync(path.join(to, "package.json"), "utf8"));
    const changelog = readFileSync(path.join(to, "CHANGELOG.md"), "utf8");
    const readme = readFileSync(path.join(to, "README.md"), "utf8");
    const edited = edit(dir, { pkg, changelog, readme }) ?? { pkg, changelog, readme };
    writeFileSync(path.join(to, "package.json"), JSON.stringify(edited.pkg, null, 2) + "\n");
    writeFileSync(path.join(to, "CHANGELOG.md"), edited.changelog);
    writeFileSync(path.join(to, "README.md"), edited.readme);
  }
  return root;
}

/** What the release PR does: one version, no `private`, the entry dated, the "not on npm" sentence gone. */
function released(version) {
  return (_dir, { pkg, changelog, readme }) => {
    const { private: _private, ...rest } = pkg;
    return {
      pkg: { ...rest, version },
      changelog: changelog.replace(/^## \S+ \(unreleased\)$/m, `## ${version} — 2026-10-24`),
      readme: readme.replaceAll(NOT_ON_NPM, "On npm"),
    };
  };
}

test("release-check passes a tree the release PR prepared", (t) => {
  const version = JSON.parse(readFileSync(path.join(ROOT, "packages/format/package.json"), "utf8")).version;
  assert.deepEqual(releaseProblems(version, { root: scratchRoot(t, released(version)) }), []);
});

test("release-check names every reason a tree is not ready, at once", (t) => {
  const root = scratchRoot(t, (dir, state) => {
    const r = released("0.1.0")(dir, state);
    if (dir === "format") r.pkg.version = "0.1.1";
    if (dir === "consent") r.pkg.private = true;
    if (dir === "tools") r.changelog = r.changelog.replace(/^## 0\.1\.0 — \d{4}-\d{2}-\d{2}$/m, "## 0.1.0 (unreleased)"); // no date
    if (dir === "reconcile") r.changelog += "\n## Unreleased\n";
    if (dir === "resolver") r.readme += `\n${NOT_ON_NPM}: the first release waits on the owner's go.\n`;
    return r;
  });
  assert.deepEqual(releaseProblems("0.1.0", { root }), [
    '@meantjs/profile: README.md still says "Not on npm yet" (the first release PR removes that sentence)',
    "@meantjs/format is at 0.1.1, not 0.1.0",
    '@meantjs/consent still says "private": true (the release PR removes it)',
    '@meantjs/tools: CHANGELOG.md has no dated entry "## 0.1.0 — YYYY-MM-DD"',
    "@meantjs/tools: CHANGELOG.md still has an unreleased section",
    "@meantjs/reconcile: CHANGELOG.md still has an unreleased section",
  ]);
});

test("release-check reads the version literally: 0.1.0 is not dated by an entry for 0x1x0", (t) => {
  const root = scratchRoot(t, (dir, state) => {
    const r = released("0.1.0")(dir, state);
    r.changelog = r.changelog.replace("## 0.1.0 — ", "## 0x1x0 — ");
    return r;
  });
  assert.equal(releaseProblems("0.1.0", { root }).length, LIBRARY_DIRS.length);
});

test("the bootstrap placeholder holds no code, no dependency and no installable version", (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const dir of LIBRARY_DIRS) {
    const target = path.join(out, dir);
    const manifest = writePlaceholder(dir, target);
    const real = JSON.parse(readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8"));
    assert.equal(manifest.name, real.name);
    assert.equal(manifest.version, BOOTSTRAP_VERSION);
    assert.match(BOOTSTRAP_VERSION, /-/, "a prerelease: npm never resolves a plain range to it");
    assert.deepEqual(manifest.repository, real.repository, "the trusted publisher and provenance match this field");
    assert.deepEqual(readdirSync(target).sort(), ["LICENSE", "README.md", "package.json"]);
    for (const key of ["main", "exports", "bin", "dependencies", "scripts", "private"]) assert.equal(key in manifest, false, key);
    assert.deepEqual(readFileSync(path.join(target, "LICENSE")), readFileSync(path.join(ROOT, "packages", dir, "LICENSE")));
  }
  assert.throws(() => writePlaceholder("format", path.join(out, "format")), /not empty/);
  assert.throws(() => writePlaceholder("mcp-adapters", path.join(out, "x")), /not a library package/);
});

// The release workflow runs in B3Pay/Meant, at the root beside profile/ (D-052); in the project's working repository
// it is kept with the files written for that copy.
const RELEASE_WORKFLOW = [
  "scripts/public-copy/overlay/.github/workflows/npm-release-profile.yml",
  "../.github/workflows/npm-release-profile.yml",
]
  .map((p) => path.join(ROOT, p))
  .find((p) => existsSync(p));

/** The `run:` script of a step of the release workflow, by the step's name, de-indented. */
function workflowStep(name) {
  assert.ok(RELEASE_WORKFLOW, "no npm-release-profile.yml beside profile/ or in scripts/public-copy/overlay/");
  const lines = readFileSync(RELEASE_WORKFLOW, "utf8").split("\n");
  const at = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(at, -1, `no step named ${name}`);
  const run = lines.indexOf("        run: |", at);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

test("the release workflow refuses bad inputs and a dist-tag that does not fit the version", () => {
  const script = workflowStep("Validate the input shapes");
  const sha = "a".repeat(40);
  const run = (inputs) =>
    spawnSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH, COMMIT: sha, STABLE_OFF_LATEST: "false", ...inputs },
      encoding: "utf8",
    });
  const accepted = [
    { VERSION: "0.1.0", DIST_TAG: "latest" },
    { VERSION: "0.2.0-beta.1", DIST_TAG: "beta" },
    { VERSION: "0.1.1", DIST_TAG: "v0-1", STABLE_OFF_LATEST: "true" },
  ];
  for (const inputs of accepted) assert.equal(run(inputs).status, 0, JSON.stringify(inputs) + run(inputs).stderr);
  const refused = [
    [{ VERSION: "0.2.0-beta.1", DIST_TAG: "latest" }, /prerelease; it must not be published as latest/],
    [{ VERSION: "0.1.0", DIST_TAG: "beta" }, /must be published as latest/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest", STABLE_OFF_LATEST: "true" }, /drop one of them/],
    [{ VERSION: "0.2.0-beta.1", DIST_TAG: "beta", STABLE_OFF_LATEST: "true" }, /stable version only/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest", STABLE_OFF_LATEST: "yes" }, /true or false/],
    [{ VERSION: "0.1", DIST_TAG: "latest" }, /version must be semver/],
    [{ VERSION: "0.1.0", DIST_TAG: "Latest" }, /dist-tag must be lowercase/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest", COMMIT: "main" }, /full 40-character/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest", COMMIT: sha.toUpperCase() }, /full 40-character/],
    // grep matches line by line, so it passed these; the workflow's [[ =~ ]] matches the whole string
    [{ VERSION: "0.1.0\n0.2.0", DIST_TAG: "latest" }, /version must be semver/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest", COMMIT: `${sha}\nmain` }, /full 40-character/],
    [{ VERSION: "0.1.0", DIST_TAG: "latest\nbeta" }, /dist-tag must be lowercase/],
  ];
  for (const [inputs, reason] of refused) {
    const r = run(inputs);
    assert.equal(r.status, 1, JSON.stringify(inputs));
    assert.match(r.stderr, reason, JSON.stringify(inputs));
  }
});
