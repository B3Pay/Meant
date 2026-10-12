# Reviewed benchmark baselines

`main.json` is the reference the `Benchmark comparison` workflow compares every
pull request against. It is captured on CI — a baseline captured on a
maintainer's machine can never be environment-compatible with the runner class
pull requests run on, and `compare.py` refuses such a comparison by
construction. Capture and comparison both run on `BENCH_TOOLCHAIN` from
`tests/fixtures/packaging/release-tools.env`, which must equal the `rustc`
version recorded in `main.json`; move the two together.

Updating it is a reviewed change, never an automated one: dispatch the `Verify`
workflow, review the `baseline.json` inside the `benchmarks-<sha>` artifact,
and commit it here with a message recording why the baseline moved. The full
procedure is in [docs/benchmarks.md](../../docs/benchmarks.md).

This directory is outside the package `include` allowlist in `Cargo.toml`, so
nothing here ships to a consumer.

Until a first baseline is committed, the comparison workflow reports "no
comparison was made" on every pull request. That is the designed fail-closed
behaviour, not an error. The same refusal appears when the stored baseline's
schema differs from the one `compare.py` writes — a schema bump deliberately
stales every existing baseline, and the fix is the recapture procedure above.
