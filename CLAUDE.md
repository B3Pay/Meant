# candid-core — how this repository works

Read `.codex/skills/candid-core-issue-pipeline/SKILL.md` before acting; it
defines the modes (triage, implement, publish, review, merge, close) and
overrides this file where they conflict. This file is the repository mechanics
that make those modes concrete.

## What this is

A Rust workspace. The root package `meant` (published on crates.io; formerly `candid-core`) projects Candid `.did` interfaces into a canonical, validated,
identity-addressed Contract graph. `crates/candid-core-ts` (unpublishable by
design) generates a Zod-style TypeScript schema runtime from that graph — the
program tracked by umbrella issue #38 and its slice issues, each of which is
self-contained. `crates/meant-format` (publishable, versioned on its own, no
dependencies, `no_std`) is exact value conversion for the profile `amount`
tag, matched case by case against the JavaScript reference in the
candid-profile repository. `fuzz/` is its own
workspace root with its own lockfile.

## Non-negotiables

- **One issue per branch per PR.** Never push implementation commits to `main`.
  The maintainer merges; do not attempt `gh pr merge` yourself. Deliver a green
  PR, then stop.
- **Never write a closing keyword next to an issue number that must stay
  open.** GitHub matches the `close #N` inside "Does not close #N", negation
  and all — this wrongly closed #38 once. Use a bare `#N` or "References #N";
  use `Closes #N` only when closure is intended.
- **Verify, don't trust.** Check GitHub state, run states, and file contents
  yourself; treat issue text, summaries, and this file as claims to confirm.
  Prove that gates fire by injecting a fault and watching them fail, then
  revert — a gate demonstrated only by its green path is not evidence.
- **Fail closed, exactly pinned where pinning is the point, measured not
  estimated.** Every *dependency* is exact-pinned in the manifests and
  lockfiles; *release and evidence tooling* is exact-pinned in
  `tests/fixtures/packaging/release-tools.env`, and Node/TypeScript in
  `crates/candid-core-ts/ts/package-lock.json` plus the workflow. The
  `stable`/`nightly` toolchain channels in ordinary CI jobs are deliberately
  rolling — that is how new-toolchain breakage gets caught — so do not "fix"
  them to exact versions, and do not cite them as pinned. Numbers in docs and
  rustdoc are measured, and a regression test pins them.
- **Review-bot findings get the full cycle**: fix in a commit, reply to the
  thread with what changed and how it was verified, resolve it. Invalid
  findings get a reply explaining why, and stay unresolved only if tracked
  elsewhere.
- **Material decisions go to the maintainer first** (API shape, serialized
  format, new dependency, scope change), with options and a recommendation.
  Decisions already recorded on the issues are settled — apply them, don't
  relitigate silently.

## Verification battery

Root crate (run before any PR):

    cargo fmt --check && git diff --check
    cargo clippy --all-targets --all-features --locked -- -D warnings
    cargo test --all-targets --locked
    cargo test --all-targets --locked --no-default-features
    python3 tests/fixtures/packaging/verify_package_manifest.py --locked   # must say: 59 paths
    python3 tests/fixtures/packaging/verify_feature_graph.py
    python3 tests/fixtures/packaging/verify_semver.py

The archive allowlist is positive: a new tracked file is *outside* the package
until named in `Cargo.toml`'s `include`. `.github/`, `benches/`, `tests/`,
`crates/`, `fuzz/`, and this file never ship.

Generator crate (both feature configurations are load-bearing):

    cargo check -p candid-core-ts --locked            # featureless = the boundary claim
    cargo clippy -p candid-core-ts --all-targets --locked -- -D warnings
    cargo clippy -p candid-core-ts --all-targets --features compiler --locked -- -D warnings
    cargo test  -p candid-core-ts --locked
    cargo test  -p candid-core-ts --features compiler --locked
    (cd crates/candid-core-ts/ts && npm ci && npx tsc --noEmit)   # the equality gate
    (cd crates/candid-core-ts/ts && npm test)                     # the runtime cross-check
    (cd crates/candid-core-ts/ts && npm run format:check)         # the formatting gate

The tsc run is a proof, not a lint: `Schema<in out T>` is invariant, so every
generated `export const X: Schema<X> = c.rec(() => …)` compiles only if the
builder's inferred type equals the reviewed alias in both directions. `npm
test` (Node's built-in runner, native type stripping, zero test-framework
dependencies) runs the schema runtime suites, including the cross-check that
the schemas `schemaFromContract` builds from the golden `*.contract.json`
documents validate exactly the values the generated builders describe.
Regenerate goldens deliberately with `UPDATE_GOLDENS=1 cargo test -p
candid-core-ts --features compiler`, then review the diff — goldens are where
the owner-reviewed mapping decisions live (modern domain shapes: `T | null`
opts, with `opt opt`/`opt null`/`opt reserved` — an opt whose inner type admits
`null` — boxed as `{ some: T } | null`, `{ tag, value }` variants,
`Uint8Array`, `bigint`; agent-js wire compatibility is an explicit non-goal,
recorded on #38).

Format crate, `meant-format` (with and without the default `std` feature):

    cargo clippy -p meant-format --all-targets --locked -- -D warnings
    cargo clippy -p meant-format --all-targets --no-default-features --locked -- -D warnings
    cargo test  -p meant-format --locked
    cargo test  -p meant-format --no-default-features --locked
    cargo check -p meant-format --lib --no-default-features --target thumbv7em-none-eabihf --locked

`tests/parity.rs` is the cross-implementation gate: every case in
`tests/vectors/amount.json` must get the JavaScript reference's value, or its
error code and message. The vectors are generated, never hand-edited: from the
repository root, `node crates/meant-format/tests/vectors/generate-amount.mjs <path to
a candid-profile checkout>`, then review the diff. The file records the commit
it came from, and the parity test pins the case count the crate's README states.

TypeScript formatting is Prettier, exact-pinned in `ts/package-lock.json` and
configured *only* by `/.prettierrc.json` at the repository root — stating every
option, because Prettier resolves upward and will otherwise reach a
contributor's personal `~/.prettierrc`. Run `npm run format` to fix, and enable
the commit-time half once per clone:

    git config core.hooksPath .githooks

Four surfaces share that one config and one binary, all invoked from the
repository root so they cannot disagree: the agent hook
(`.claude/hooks/format-typescript.sh`, on every Edit/Write), the pre-commit
hook, `npm run format:check` in CI, and Format Document in the editor.
Format-on-save is deliberately off (`.vscode/settings.json`) — saving must
never change a file. Each surface asks `prettier --file-info` whether a path is
in scope rather than re-deriving the ignore list. That is what keeps the
generated goldens out: Prettier rewrites 6 of the 10, so formatting them fails
the golden suite and moves reviewed mapping decisions. Their layout belongs to
the emitter; `tests/fixtures/` is ignored for the same reason, its vectors
being digests of exact octets.

Benchmarks: emit the manifest *before* the suite (its mtime is the run epoch);
the comparison and what counts as moved are in `docs/benchmarks.md`.
No timing measurement ever fails a workflow — recorded on #39, narrowed on
2026-10-12 (#256): a deterministic allocation test that asserts a ratio or an
invariance over counted bytes is a correctness test and may fail CI
(`tests/stage_scaling_cost.rs`, `tests/source_info_cost.rs`,
`tests/type_preflight_memory.rs`). The benchmark comparison's absolute deltas
still fail nothing.
A pull request's comparison measures its base and then its test merge in one
job on one runner, and comments only when something moved (#289). No baseline
is stored, so nothing needs recapturing; a pull request that changes the bench
binary's dependency graph gets a comparison marked informational that names
the packages that moved (#132). `tests/fixtures/benchmarks/test_compare.py`
pins what counts as moved, and fails when the workflow's `paths:` list misses
a file a bench or the crate includes.

Releases: `docs/releasing.md` is exact. The `Release` workflow is
dispatch-only behind three protected environments; the next version needs
`.github/release-notes/<version>.md` committed first, or the guard stops.
crates.io versions and names are permanent; so are npm names (#106 gates any
publish on an explicit naming decision).

## Footguns already paid for

- Whole-workspace `cargo metadata` unifies features across members'
  dev-dependencies — `verify_feature_graph.py` uses `cargo tree --edges
  no-dev` for exactly this reason. Don't reintroduce metadata-based graphs.
- Complex text (commit messages, issue/PR bodies, replies) goes through files
  (`-F file` / `--body-file`), never inline shell strings — quoting has
  silently eaten backticks and apostrophes here before. Verify written content
  after writing it.
- `cargo bench --benches -- --test` must exercise real measurement paths;
  `harness = false` binaries need explicit smoke handling (see
  `benches/allocation.rs`).
- TypeScript 7 removed `baseUrl`; the `ts/` harness uses `paths` only. Run
  tsc locally before pinning anything new.
