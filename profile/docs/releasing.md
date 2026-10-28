# Releasing the library packages to npm

The procedure of record for publishing `@meantjs/profile`, `@meantjs/format`,
`@meantjs/consent`, `@meantjs/tools` and `@meantjs/reconcile`
(`packages/resolver`, `format`, `consent`, `tools`, `reconcile`). npm names and versions are permanent: a published
version can never be replaced, and an unpublished name or version cannot be reused. So the irreversible step needs the
owner's approval in GitHub, and everything before it is checked.

**Status (2026-10-28): 0.2.0 is published.** `@meantjs/profile`, `@meantjs/format`, `@meantjs/consent`,
`@meantjs/tools` and `@meantjs/reconcile` 0.2.0 are on npm under `latest`, each with signed provenance. They were
published from the public repository `B3Pay/Meant`, where the spec and the packages sit under `profile/` as a reviewed
copy of this one that `scripts/public-copy/` builds (D-051, D-052), never from this private repository: its merge
commit 4e016b8 (the 0.2.0 sync, B3Pay/Meant#295), `npm release (profile)` run 40757959363, approved by the owner. An
empty project that installs the five 0.2.0 packages from the registry passes `scripts/package-check/smoke.mjs`, and
`npm audit signatures` verifies their signatures and attestations (fact: run 2026-10-28, 12 packages with verified
signatures, 8 with verified attestations). 0.1.0, the first release, was published the same way from 57afdae
(B3Pay/Meant#292) by run 40692299884. The one-time prerequisites below are done: the `npm-publish` environment, the
bootstrap of the five names, their trusted publishers and, after the first publish, the hardening (two-factor
authentication, tokens disallowed). The next release starts at step 1 of "Releasing a version".

## What is released

- **Five packages, one version.** They release together and pin each other exactly (`"0.1.0"`, not `"^0.1.0"`), so
  an install never mixes versions that were not tested together. A release bumps all five even when only one changed.
  `scripts/package-check/packages.mjs` lists them; `npm run pack:check` refuses a tree whose versions or pins disagree.
- **Everything else stays private:** `mcp-adapters` (the eval's arms, frozen texts and hashes), `command-model`,
  `demo-browser` and `profile-router`. They depend on the library packages by the same exact pin.
- **What each tarball holds** is `scripts/package-check/manifest.json`: source, hand-written `.d.mts` types,
  `CHANGELOG.md`, `LICENSE` (Apache-2.0, D-043), and for `@meantjs/profile` the schema and the standard packs.
  No tests, no fixtures, no eval files.

## Versioning

Semantic versioning, read the 0.x way: while the major is 0, **the minor is the breaking digit**.

| Bump | When |
|---|---|
| minor (0.1.0 to 0.2.0) | Anything a consumer could notice breaking: an export removed or renamed, a type narrowed, an input refused that was accepted, an output shape changed, a diagnostic or error code renamed or reused, a new spec or schema version, a dependency's major (or 0.x minor) bump. **Any change to text the packages generate**: consent messages, SNS renderings, tool names, descriptions and input schemas. Consumers review and hash that text (arm C pins it), so a reworded message is a breaking change even when it is better. New features also take a minor. |
| patch (0.1.0 to 0.1.1) | A fix that changes no generated text and no accepted input, docs, and dependency patches. |
| prerelease (0.2.0-beta.1) | A version for trying before the stable one, published under its own dist-tag (`beta`), never `latest`. |

1.0.0 waits until the spec leaves v0 and the owner says the API is stable. The packages implement Candid Profile v0
(`docs/profile-v0.md`, `spec/profile-v0.schema.json`); a spec change follows AGENTS.md rule 1 and is at least a minor.

## Changelogs

Each package has a `CHANGELOG.md`. Work in progress goes under `## <next version> (unreleased)`. The release PR
renames that heading to `## <version> — YYYY-MM-DD` (the date of the release PR), the form `release-check.mjs`
requires. In lockstep, a package that did not change still gets an entry that says so ("No changes in this package").

## Releasing a version

1. **Release PR.** On a branch from `main`:
   ```sh
   node scripts/package-check/set-version.mjs 0.2.0    # the five versions, every exact pin on them, the lockfile
   ```
   Date each `CHANGELOG.md` entry. For the very first release only, remove `"private": true` from the five
   `package.json` files and the sentence "Not on npm yet: ..." from their READMEs, and update `packages/README.md`,
   which says they stay private. Then:
   ```sh
   node scripts/package-check/release-check.mjs 0.2.0  # versions, no private, dated entries, nothing unreleased
   npm run validate && npm test && npm run types && npm run pack:check
   ```
   `pack:check` rewrites nothing; if a file list changed on purpose, review the tarball and run
   `node scripts/package-check/check.mjs --update`. Merge the PR into `main`.
2. **Sync** the public copy (`scripts/public-copy/README.md`): build it from the merge commit, open a pull request to
   `B3Pay/Meant` that replaces `profile/` and the two profile workflows, let its CI pass and merge it. Every step from
   here runs in that repository.
3. **Dispatch** the `npm release (profile)` workflow from `main` of `B3Pay/Meant`, naming the merged sync commit by
   its full SHA:
   ```sh
   # A stable version: it becomes what a plain `npm i` installs.
   gh workflow run npm-release-profile.yml --repo B3Pay/Meant \
     --field commit=<40-character SHA> --field version=0.2.0 --field dist-tag=latest

   # A prerelease: consumers opt in with `npm i @meantjs/profile@beta`; `latest` does not move.
   gh workflow run npm-release-profile.yml --repo B3Pay/Meant \
     --field commit=<40-character SHA> --field version=0.2.0-beta.1 --field dist-tag=beta
   ```
   (Or Actions, "npm release (profile)", "Run workflow".) A stable version under another tag, a backport that must not
   move `latest`, needs `--field stable-off-latest=true` too. The repository's other release workflows (the crates,
   `@candid-core/schema`, `@candid-core/cli`) are separate and unaffected.
4. **The verify job** (no secrets, read-only) refuses input that is not a full SHA, semver and a lowercase dist-tag;
   refuses a prerelease under `latest` and a stable version under any other tag unless `stable-off-latest` says so;
   refuses to go on unless the `npm-publish` environment exists with required reviewers (GitHub silently creates a
   missing environment with no protection, so this check is what makes the gate fail closed); refuses a commit that
   is not reachable from `origin/main`; runs `release-check.mjs`; and runs the whole battery of `profile/` on that
   commit: `npm ci`, `validate`, `test`, `types`, `pack:check`.
5. **Approve** the `publish` job when GitHub asks (the `npm-publish` environment's required reviewer). That approval
   is the authorization for the irreversible step.
6. **The publish job** publishes in dependency order: `format`, `resolver`, `reconcile`, `tools`, `consent`. A package
   already on the registry at that version is skipped only when its published tarball has the same integrity as the
   one this commit packs, and the job fails if the bytes differ. So a re-dispatch after a partial failure finishes the
   set and never tries to overwrite anything.
7. **Check** each package: `npm view @meantjs/format@0.2.0 dist.integrity dist-tags`, and install the set
   in an empty project.

## One-time prerequisites

All of these come before the first dispatch, and only the owner can do them.

1. **The names.** The packages publish under the `@meantjs` scope, the owner's npm organization (D-051; fact:
   `https://registry.npmjs.org/-/org/meantjs/package` answered `{}` on 2026-10-27, an organization with no packages
   yet, where a missing one answers 404). `@candid-core/cli` and `@candid-core/schema` stay dependencies under their
   own scope.
2. **The repository must be public.** Three facts, each a reason:
   - "If you are on a GitHub Free, GitHub Pro, or GitHub Team plan, required reviewers are only available for
     public repositories" (GitHub Docs, "Deployments and environments", read 2026-10-24). Without them there is no
     approval gate, and the verify job refuses to run the publish.
   - npm attaches provenance (the signed link from a version to the commit and workflow that built it)
     automatically when a public repository publishes a public package through trusted publishing; not from a
     private repository.
   - The READMEs on npm link to the spec in this repository; readers of a private repository's links get a 404.
   Making this repository public would also publish the eval's tasks (`eval/tasks-v0.json`, `docs/task-review/`) and
   their history, so the owner chose to publish from the public `B3Pay/Meant`, the compiler's repository, which holds
   a copy of the spec and the packages under `profile/`, built from this one by `scripts/public-copy/` (D-051,
   D-052). The `repository` fields of the five packages name it as GitHub spells it,
   `git+https://github.com/B3Pay/Meant.git`, with `directory: profile/packages/<name>`, and the environment, the
   bootstrap and the trusted publisher below all belong to it. The spelling matters. Fact (the `npm/provenance`
   README, read 2026-10-28): the registry checks that `repository.url` matches the source repository named in the
   provenance's signing certificate, which is the repository the workflow runs in. Assumption: the match is
   case-sensitive, since nothing documents it as case-insensitive.
3. **The `npm-publish` environment** (`B3Pay/Meant`, Settings, Environments). The releases of `@candid-core/schema`
   and `@candid-core/cli` already use it (fact: both passed its required-reviewer check on 2026-10-27, when the
   repository was still `b3hr4d/candid-core`). The environments moved with the repository (fact, observed on
   2026-10-28: `B3Pay/Meant` lists the deployments of `npm-publish` from 2026-10-27; who reviews shows only to an
   admin). Check that the environment still has the owner as its required reviewer, and that no other branch than
   `main` may deploy, if the plan offers deployment branch rules. Without it the verify job refuses to go on.
4. **First publish of a new name, by hand, once per name.** npm can attach a trusted publisher only to a package that
   already exists on the registry, so the workflow cannot do a name's first publish (it fails with an auth or 404
   error). For each of the five:
   ```sh
   node scripts/package-check/bootstrap.mjs format     # writes the placeholder and prints the commands below
   cd <the directory it printed>
   npm pack --dry-run                                  # package.json, README.md and LICENSE, nothing else
   npm login                                           # interactive, 2FA
   npm publish --access public --tag bootstrap
   npm logout                                          # invalidates the token npm login wrote
   ```
   The placeholder is `0.0.0-bootstrap` with no code and no dependency, under the `bootstrap` dist-tag. A prerelease,
   it never satisfies a version range such as `^0.1.0`. npm still points `latest` at it until the first real version
   moves `latest` (observed 2026-10-28), so until then `npm i <name>` with no version installs the empty placeholder:
   dispatch the first release soon after. Publish all five in one sitting, so the `npm login` token lives only for
   those commands. Observed on 2026-10-28, with the cause open: each name also holds a `0.0.0-stage` version, "Temporary
   package placeholder for staged publishing", two files and no code, published by the owner a minute before the
   bootstrap.
5. **Configure the trusted publisher** for each package (npmjs.com, the package, Settings, Trusted publishing, GitHub
   Actions). npm does not check these values when they are saved; a typo shows only as a failed publish.

   | Field | Value |
   |---|---|
   | Organization or user | `B3Pay` |
   | Repository | `Meant` |
   | Workflow filename | `npm-release-profile.yml` |
   | Environment | `npm-publish` |
   | Allowed actions | publish |

6. **After the first workflow publish,** harden each package: Settings, Publishing access, require two-factor
   authentication and disallow tokens. That setting affects tokens only; trusted publishing keeps working, because
   OIDC is not a token.

The workflow holds no npm token at any point: the publish job gets `id-token: write` and npm exchanges the GitHub OIDC
token for a short-lived publish credential. The pinned Node 24.22.1 ships npm 11.19.1 (fact: `npm --version` in that
release), above 11.5.1, the first npm that publishes through OIDC.

## Gates and how they were proven

Each gate failed on an injected fault and passed again after the revert (docs/status/W0.md, 2026-10-24 rows):
the manifest check (a `test/` path added to `files`), the export targets, the browser bundles (a `node:crypto`
import), the declaration names (a declaration removed), the strict consumer programs (an unknown type, a wrong
assignment), the LICENSE hash (one byte changed), the changelog entry (removed), lockstep (one version changed), and
`release-check.mjs` (`scripts/release.test.mjs`; the version's dots unescaped). The same test file runs the
workflow's own input step under bash with 3 accepted and 12 refused inputs; it caught that `grep -qE`, as first
copied from candid-core's workflows, matches line by line and passed a two-line version, so the step now matches with
`[[ =~ ]]`. The environment check and the publish loop run only in the workflow. Both ran for the first time in the
0.1.0 release (run 40692299884, 2026-10-28): the check found a required reviewer, and the loop published the five in
dependency order. Its skip of a version already published with the same bytes, and its refusal when the bytes
differ, have not run yet (open).
