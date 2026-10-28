# Performance benchmarks

The benchmark suite quantifies the cost of projecting checked Candid into a canonical Contract. It is not a contest between independent parsers: `candid-core` delegates parsing and type checking to the exact official `candid_parser` version pinned in `Cargo.toml`.

The direct comparison is therefore:

1. official `IDLProg` parsing plus `check_prog` or `check_file`;
2. the same semantic work plus `candid-core` lowering, structural validation, graph canonicalization, identity hashing, and optional source provenance.

Official checker and core outputs provide different guarantees. Ratios only describe the additional Contract projection work for this corpus and build.

## Run the suite

The statistical suite uses Criterion 0.5.1, pinned because benchmarks must continue to compile on the declared Rust 1.78 MSRV:

```sh
cargo bench --bench compilation --locked -- --noplot
```

Run the one-shot allocation probe separately so allocator instrumentation does not affect latency measurements:

```sh
cargo bench --bench allocation --locked
```

The probe emits JSON with allocation count, cumulative allocated bytes, and peak live bytes observed by its counting system allocator. Peak live bytes are not resident set size (RSS): allocator metadata, mapped-but-unused pages, stacks, shared libraries, and the executable are outside that counter. For a process-level observation, run the allocation probe under the platform's `time` or memory profiler and record the exact command and environment.

To exercise fixture validity and every benchmark path without collecting statistics:

```sh
cargo bench --benches --locked -- --test
```

## Groups and boundaries

`compile/<case>` uses identical import-free source bytes for all three paths:

- `official_parse_check` creates a fresh `IDLProg`, `TypeEnv`, and checked actor in every iteration;
- `core_minimal` disables `SourceInfo` while retaining the canonical Contract;
- `core_full` includes the source/provenance sidecar.

Fixture construction, validation of the fixture itself, and Criterion setup occur outside timed loops. Returned values pass through `black_box`. A fresh mutable checker environment is required because reusing it would give the official baseline an invalid cache advantage.

`compile/imported_bundle` is separate because it includes file access and import processing. `official_check_file` reads the checked-in bundle directly. `core_compile_with_resolver` reads the same bundle through `WorkspaceResolver` — which is why the group still declares `filesystem-compiler` — and then compiles it entirely in memory: since issue #21 the resolved bundle is merged into one virtual program and type-checked in place rather than materialized for the official file checker. The comparison therefore no longer runs the same checker on both sides; it is an end-to-end comparison of the two ways to get from a bundle on disk to a checked result, not a parser microbench. Nothing in this document claims a speedup from that change: the benchmark numbers on file were recorded against the materializing implementation and have not been re-recorded.

`artifact/ledger` isolates operations on one already compiled Contract — this group is entirely base-feature work, so its costs are what a `default-features = false` consumer pays:

- structural/identity validation;
- canonicalization;
- compact serde serialization;
- the validated, canonicalized pretty-JSON convenience path;
- JSON parse, validation, and canonicalization.

The final parse group uses today's `Contract::from_json` boundary. Issue #22's future incremental/context-aware decoding should be added as a distinct path, not silently substituted for the historical result.

## Corpus

The suite deliberately combines:

- small fixtures from `tests/fixtures/conformance`;
- the repository-authored ledger-style interface documented in `benches/corpus/README.md`;
- deterministic generated record-width, method-count, and recursive-depth cases;
- a three-file imported ledger/archive bundle.

The generated wide and long-chain cases provide performance signals relevant to Issue #6. They do not replace its deterministic work-accounting regression test and should not drive an optimization until repeated measurements identify a bottleneck. Issue #24 split the build surface with Cargo features rather than into separate crates, so the corpus and the comparison boundaries are unchanged; only the `required-features` declarations noted above were added.

Fixture contents and generator sizes are part of the benchmark definition. Changing them requires an explicit note because results before and after the change are not directly comparable.

## Compare a branch with `main`

Build both revisions with the same Rust toolchain, Cargo lockfile, feature set, target CPU settings, power mode, and allocator. Minimize other host activity and use the same checkout path when practical.

On `main`, save a named Criterion baseline:

```sh
cargo bench --bench compilation --locked -- --noplot --save-baseline main
```

On the candidate branch, compare against it:

```sh
cargo bench --bench compilation --locked -- --noplot --baseline main
```

Treat one result as evidence to investigate, not proof of a regression. Hardware, thermals, OS scheduling, filesystem caches, compiler version, target features, and allocator all affect results. Repeat suspected changes and inspect absolute time, throughput, confidence intervals, and the allocation probe—not only a percentage.

### A checked comparison

Criterion's named baselines above are convenient but say nothing about *what* was measured: they will happily compare two runs over different corpora, feature sets, or toolchains and report a confident percentage. `tests/fixtures/benchmarks/compare.py` exists to make that precondition checkable, and it is built to refuse rather than guess — a missing or incompatible baseline reports that no comparison was made and exits non-zero, never a delta it cannot stand behind.

A run's identity has two halves. `cargo bench --bench manifest` emits what only the Rust side knows: the corpus fingerprints, generator sizes, feature set, and metric units. The script records what only it can observe: toolchain, target, host, and the resolved dependency graph of the bench binary.

That last item is a projection, deliberately not a hash of the whole `Cargo.lock`: the root package's own version stanza and sibling workspace members' dev-dependency lists change the lockfile's bytes without changing the program `cargo bench` builds, so a whole-file digest would report every release version bump as a change to the program measured ([issue #132]). The identity is instead the closure of packages reachable from the root package's lockfile stanza (normal, build, and dev dependencies — dev included because benches compile against them), excluding the root package itself. The graph is stored in the baseline alongside its digest, so when it *does* drift the report names the packages that moved rather than showing two opaque digests.

The script also records advisory machine identity — CPU model, core count, and runner image — and renders both sides in the report. It is deliberately not a drift key: hosted-runner machinery varies run to run as the common case, so flagging it would mark essentially every comparison while changing nothing. It exists so a reader can *see* that a uniform shift came with a machine change instead of inferring it.

Compare two revisions on one machine, as the `Benchmark comparison` workflow does for a pull request ([issue #289]). Copy the head's `compare.py` aside first, so one version of the rules judges both sides. Then, in one checkout, run the suite at the base with Criterion's results in a directory of their own, and capture it, naming the checkout so the recorded dependency graph is the base's own:

```sh
cp tests/fixtures/benchmarks/compare.py /tmp/compare.py
git checkout --detach "$BASE"
mkdir -p /tmp/base /tmp/head
cargo bench --bench manifest --locked > /tmp/base/manifest.json
CRITERION_HOME=/tmp/base/criterion cargo bench --bench compilation --locked -- --noplot
cargo bench --bench allocation --locked > /tmp/base/allocations.json
python3 /tmp/compare.py capture --repo-root . \
  --manifest /tmp/base/manifest.json --criterion /tmp/base/criterion \
  --allocations /tmp/base/allocations.json --out /tmp/base.json
```

Then the same three commands at the head, into `/tmp/head/`, and compare:

```sh
git checkout --detach "$HEAD"
cargo bench --bench manifest --locked > /tmp/head/manifest.json
CRITERION_HOME=/tmp/head/criterion cargo bench --bench compilation --locked -- --noplot
cargo bench --bench allocation --locked > /tmp/head/allocations.json
python3 /tmp/compare.py compare --repo-root . \
  --baseline /tmp/base.json --manifest /tmp/head/manifest.json \
  --criterion /tmp/head/criterion --allocations /tmp/head/allocations.json \
  --markdown /tmp/report.md
```

One checkout rather than two: both binaries are built from the same path into the same target directory and run with the same arguments and environment, so the code is the only thing that differs between them.

**Emit the manifest before running the suite.** That ordering is load-bearing, not stylistic: Criterion never deletes a `new/` directory, so a benchmark you renamed or removed keeps its result from whatever ran last in the same `target/criterion`. The manifest file's timestamp is the run's epoch, and any estimate older than it is treated as left over from a previous run — excluded from the comparison and reported, rather than imported as if this run had produced it.

What it refuses, and why:

| Situation | Behaviour |
| --- | --- |
| Baseline missing or unreadable | No comparison; exit 2 |
| Corpus (including the imported bundle), generator sizes, feature set, or metric units differ | No comparison; exit 2. The two runs did not measure the same thing, so no delta between them is interpretable. A pull request that changes the corpus gets this report instead of a delta |
| Toolchain, effective target, `RUSTFLAGS`, host, or the bench binary's resolved dependency graph differ | No comparison unless `--allow-environment-drift`, which renders the report marked **informational only** and refuses to gate on it. A graph drift is attributed by name — `serde: 1.0.150 → 1.0.152` — from the graphs stored on both sides |
| Stored baseline's `baseline_schema_version` differs from the one this tool writes | No comparison; exit 2 — recapture the baseline with the current tool |
| `--fail-on-regression` requested and a control benchmark moved more than `PCT` in either direction, or no control is comparable on both sides | No gate verdict; exit 2 before any report is printed ([issue #135]) |
| No Criterion estimates newer than the manifest | No comparison; exit 2 — the suite was not run after the manifest was emitted |
| Compatible | Renders Markdown and, with `--json`, machine-readable output |

Codegen flags are part of the identity because they change the binary without changing the toolchain: `RUSTFLAGS='-C target-cpu=native'` on one run and not the other produces two materially different programs on one machine, which would otherwise look like no drift at all.

All three allocation metrics are compared — `allocations`, `allocated_bytes`, and `peak_live_bytes`. A change that holds the allocation count constant while growing cumulative or peak bytes is a real memory regression, and comparing only the count would render it as a reassuring 0%.

The report leads with its verdict, what moved ([below](#what-counts-as-moved)), and keeps every case in a collapsed section under it. There the timing table is headed by the **controls**: the `official_*` cases execute only upstream `candid_parser` code, which no change in this repository can alter. Their median shift is printed above the timing table and the control rows are marked in it, because a shift the controls share with the rest of the table measures the machinery, not the candidate — exactly the signature that once made drifted comparisons read as uniform +8–35% regressions ([issue #132]).

`--fail-on-regression PCT` exits 1 when any non-control median regresses by more than `PCT`. It is opt-in with no default threshold, because a calibrated threshold needs repeated controlled-runner data that does not exist yet ([issue #39]); and it produces no verdict at all — exit 2, before any report is printed — when the comparison is environment-drifted, when a control benchmark moved by more than `PCT` in either direction, or when no control is comparable on both sides ([issue #135]). A control past the threshold means the machinery shifted more than the gate tolerates: a slower machine fabricates regressions and a faster one masks them; and with no comparable control at all, nothing vouches for the machinery — in every case neither exit 0 nor exit 1 would be evidence.

No baseline is stored in the repository ([issue #289]). One captured once on one runner compared every later pull request with that runner's machine and toolchain as much as with its code, and went stale with each toolchain release; a pull request now measures its own base. A baseline captured for local work is a JSON file, which nothing in the `include` allowlist in `Cargo.toml` matches, so it never ships to a consumer wherever it is kept.

[issue #39]: https://github.com/b3hr4d/candid-core/issues/39
[issue #256]: https://github.com/b3hr4d/candid-core/issues/256
[issue #132]: https://github.com/b3hr4d/candid-core/issues/132
[issue #135]: https://github.com/b3hr4d/candid-core/issues/135

## CI policy

**No timing measurement ever fails a workflow in this repository.** That is a recorded decision on [issue #39], not an unfinished feature: GitHub-hosted runners are shared and thermally variable, and a threshold calibrated from their noise would produce a red check maintainers learn to ignore. Detection without enforcement — a regression is surfaced with absolute values, intervals, and raw data, and a human decides. The comparison's allocation deltas are reported the same way.

One kind of measurement is different, and does fail CI: a deterministic allocation *test*. The bytes a counting global allocator sees are fixed for given code and dependencies, so a test that runs a stage at two input sizes and asserts the ratio of those bytes fails only when the stage's allocation changes shape, never because of the machine. It bounds allocation, not work: a stage that turned quadratic while allocating linearly, through a nested scan or repeated lookups, would pass. Per-item cloning, which is how #252 went quadratic, cannot. The rule was narrowed to timing on 2026-10-12 to say so ([issue #256]). `tests/stage_scaling_cost.rs` holds every stage after parsing to linear allocation growth, `tests/source_info_cost.rs` does the same for source-info collection, and `tests/type_preflight_memory.rs` pins an invariance of the depth guards' work counter. These are ordinary tests, not benchmarks: they assert a ratio, never a number of bytes. The `--fail-on-regression` flag exists for deliberate local pre-release checks on a machine the operator controls; it is never wired into CI.

Three tiers:

| Tier | When | What |
| --- | --- | --- |
| Smoke | Every pull request (`Verify`) | Compiles and exercises every benchmark once, including the allocation probe's measurement path. Correctness of the harness, no timing claims |
| Comparison | A pull request that changes what the benchmarks build or read (`Benchmark comparison`) | Runs the full suite on the pull request's base and then on its test merge, in one job on one runner, and compares the two with `compare.py`. A job summary on every run; a comment only when something moved, which every later run then updates in place. Informational, never a gate; two runs that did not measure the same thing are reported as "no comparison was made" |
| Capture | Weekly schedule or manual dispatch (`Verify`) | Runs the full suite and uploads Criterion's raw estimates, allocation JSON, environment metadata, and `compare.py`'s record of the run as `capture.json`, retained 90 days: `main` on the hosted runner, kept for investigation and compared with nothing |

The comparison workflow lives in its own file because commenting needs `pull-requests: write`, and `Verify` and `Release candidate` deliberately hold nothing beyond `contents: read`.

### What counts as moved

A pull request's comparison leads with a verdict, and the workflow comments only when the verdict names something ([issue #289], which refines the plan on [issue #256]):

- **An allocation metric that differs at all.** Counts and bytes are fixed for given code and dependencies, so a difference is the pull request's own. The verdict lists each changed case and metric with both values.
- **A timing case past the noise of two runs:** its two 95% intervals apart, *and* its delta, net of the controls' median shift, beyond `TIMING_MOVED_PCT` (20%) in either direction. Neither alone is enough: each process settles on its own timing for a case, so two runs of one binary minutes apart often fail to overlap, and a delta without its intervals is one noisy sample. The controls are never counted, since no change here alters what they run, unless the pull request changes the bench binary's dependency graph. Then they may run different upstream code, so no shift is taken out and they are judged like every other case.
- **A case added or removed.**

The threshold is measured, not chosen. On 2026-10-28, [pull request #290], which changes nothing the benchmarks build, was compared four times as it stands and once with two planted faults, on three runner types: an AMD EPYC 9V74 in three of the runs, an Intel Xeon Platinum 8573C and an Intel Xeon Platinum 8370C. Across the cases no fault touched, net timing deltas reached 9.6%. `artifact/ledger/serialize_compact`, about 6 µs, came out anywhere from 9.6% faster to 3.1% slower net; in one run it was 7.7% faster on the head although each side's interval was about 0.1% wide. `host_value/validate/vec_variant/256`, about 450 µs, reached 6.5% once, and every other case stayed within 3.6%. At 5%, the first value tried, three of the five runs would call an untouched case moved, and one posted a comment on unchanged code. 20% is about twice the largest delta seen, and the planted slowdown of `artifact/ledger/validate` (about 50 µs added to 194 µs) read +25.9% net and moved. If a pull request that changes nothing measured reports timing as moved, raise the threshold, with that run as the evidence.

Timing stays advisory either way: the verdict reports it, and nothing fails ([issue #39]). With nothing moved the verdict is one line, the workflow posts no comment, and a comment left by an earlier push is updated to say so; the job summary carries the report on every run. `compare.py compare --moved-pct` sets another threshold for a local run.

A pull request that changes nothing the benchmarks build or read gets no run at all. The workflow's `paths:` list names the crate, its manifest and lockfile, the benches and their corpus, the two conformance fixtures the corpus includes, and the comparison's own tooling. `tests/fixtures/benchmarks/test_compare.py` pins these rules on synthetic runs, and fails when a bench or the crate includes a file that list misses or the list names a file that does not exist.

[issue #289]: https://github.com/B3Pay/Meant/issues/289
[pull request #290]: https://github.com/B3Pay/Meant/pull/290

## Initial baseline

The first checked-in local measurement is recorded in [`benchmarks/baseline-2026-07-14.md`](benchmarks/baseline-2026-07-14.md). It is a reproducibility example and historical reference, not a portable performance promise.
