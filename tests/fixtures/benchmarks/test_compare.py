#!/usr/bin/env python3
"""What `compare.py` reports as moved, and what the comparison runs on.

Issue #289: the `Benchmark comparison` workflow measures a pull request's base
and head on one runner and comments only when something moved. These tests pin
the rules that decide it, on synthetic results, so a change to them is a
reviewed change rather than a quieter or noisier comment nobody traced:

- an allocation metric that differs at all has moved;
- a timing case has moved when its two 95% intervals are apart and its delta,
  net of the controls' median shift, is beyond the threshold;
- the controls move nothing while both sides run the same dependency graph,
  and are judged like any other case when the graph differs;
- an added or removed case has moved.

The report's shape is pinned too, as issue #256 set it out: with nothing
moved, one line above the collapsed tables; otherwise the changed allocation
rows first, with both values, then timing. So is the threshold
`docs/benchmarks.md` states.

They also pin the workflow's trigger against what the benchmarks actually
read: every file a bench or the crate includes at compile time must be named
by the workflow's `paths:` list, and every entry of that list must name a
tracked file, so the list can neither miss an input nor rot. Runtime reads are
outside that check; the benches read files only under `benches/`, which the
list names whole.

Run with:
    python3 tests/fixtures/benchmarks/test_compare.py
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SCRIPT = HERE / "compare.py"
WORKFLOW = REPO / ".github" / "workflows" / "benchmark-compare.yml"
spec = importlib.util.spec_from_file_location("compare", SCRIPT)
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)

PCT = compare.TIMING_MOVED_PCT
CONTROL = "compile/ledger/official_parse_check/1604"
CASE = "compile/ledger/core_full/1604"
OTHER = "artifact/ledger/validate"


def timing(median: float, spread: float = 0.005) -> dict:
    """A Criterion median with a 95% interval of +/- `spread` around it."""
    return {
        "median_ns": median,
        "lower_ns": median * (1 - spread),
        "upper_ns": median * (1 + spread),
        "throughput_bytes": None,
    }


def allocation(count: int, allocated: int = 1000, peak: int = 500) -> dict:
    return {"allocations": count, "allocated_bytes": allocated, "peak_live_bytes": peak}


def report(
    base_timing: dict,
    head_timing: dict,
    base_allocations: "dict | None" = None,
    head_allocations: "dict | None" = None,
    drift: "list | None" = None,
) -> dict:
    """The parts of `compare.py`'s report that `what_moved` reads."""
    base_allocations = base_allocations or {"ledger/core_full": allocation(10)}
    head_allocations = head_allocations or {"ledger/core_full": allocation(10)}
    rows = compare.delta_rows(base_timing, head_timing, "median_ns")
    return {
        "timing": rows,
        "control_shift": compare.control_summary(rows),
        "environment_drift": drift or [],
        "allocations": {
            metric: compare.delta_rows(base_allocations, head_allocations, metric)
            for metric in compare.ALLOCATION_METRICS
        },
    }


def scaled(results: dict, factors: dict) -> dict:
    return {
        name: timing(entry["median_ns"] * factors.get(name, 1.0))
        for name, entry in results.items()
    }


BASE = {CONTROL: timing(80_000.0), CASE: timing(640_000.0), OTHER: timing(210_000.0)}


class TimingTests(unittest.TestCase):
    def moved(self, head: dict, **kwargs) -> list:
        changes = compare.what_moved(report(BASE, head, **kwargs), PCT)
        return [entry["name"] for entry in changes["timing"]]

    def test_identical_runs_move_nothing(self):
        changes = compare.what_moved(report(BASE, BASE), PCT)
        self.assertFalse(changes["any"])

    def test_a_slowdown_past_the_threshold_moves(self):
        self.assertEqual(self.moved(scaled(BASE, {CASE: 1 + 2 * PCT / 100})), [CASE])

    def test_a_speedup_past_the_threshold_moves(self):
        self.assertEqual(self.moved(scaled(BASE, {CASE: 1 - 2 * PCT / 100})), [CASE])

    def test_a_delta_within_the_threshold_does_not_move(self):
        self.assertEqual(self.moved(scaled(BASE, {CASE: 1 + PCT / 200})), [])

    def test_the_threshold_itself_does_not_move(self):
        head = dict(BASE)
        head[CASE] = timing(BASE[CASE]["median_ns"] * (1 + PCT / 100), spread=0.0)
        base = dict(BASE)
        base[CASE] = timing(BASE[CASE]["median_ns"], spread=0.0)
        changes = compare.what_moved(report(base, head), PCT)
        self.assertEqual(changes["timing"], [])

    def test_overlapping_intervals_do_not_move(self):
        head = dict(BASE)
        head[CASE] = timing(BASE[CASE]["median_ns"] * (1 + 2 * PCT / 100), spread=0.5)
        self.assertEqual(self.moved(head), [])

    def test_missing_intervals_leave_the_delta_to_decide(self):
        head = scaled(BASE, {CASE: 1 + 2 * PCT / 100})
        head[CASE]["lower_ns"] = None
        self.assertEqual(self.moved(head), [CASE])

    def test_a_machine_wide_shift_moves_nothing(self):
        factor = 1 + 2 * PCT / 100
        head = scaled(BASE, {CONTROL: factor, CASE: factor, OTHER: factor})
        self.assertEqual(self.moved(head), [])

    def test_a_slowdown_on_a_shifted_machine_still_moves(self):
        shift = 1 + 2 * PCT / 100
        head = scaled(BASE, {CONTROL: shift, CASE: shift + 2 * PCT / 100, OTHER: shift})
        changes = compare.what_moved(report(BASE, head), PCT)
        self.assertEqual([entry["name"] for entry in changes["timing"]], [CASE])
        self.assertAlmostEqual(changes["timing"][0]["net_pct"], 2 * PCT, places=6)

    def test_a_control_never_moves_on_the_same_graph(self):
        # Three controls, so the one that jumps leaves the median shift at
        # zero: judged as a case, it would move by four thresholds.
        steady = {
            "compile/basic/official_parse_check/98": timing(4_900.0),
            "compile/recursive/official_parse_check/89": timing(5_900.0),
        }
        base = {**BASE, **steady}
        head = {**scaled(BASE, {CONTROL: 1 + 4 * PCT / 100}), **steady}
        changes = compare.what_moved(report(base, head), PCT)
        self.assertEqual(changes["control_shift_pct"], 0.0)
        self.assertEqual(changes["timing"], [])

    def test_a_changed_graph_judges_the_controls_and_takes_no_shift(self):
        drift = [("bench_graph_digest", "aaaa", "bbbb")]
        factor = 1 + 2 * PCT / 100
        head = scaled(BASE, {CONTROL: factor, CASE: factor})
        changes = compare.what_moved(report(BASE, head, drift=drift), PCT)
        self.assertEqual(changes["control_shift_pct"], 0.0)
        moved = sorted(entry["name"] for entry in changes["timing"])
        self.assertEqual(moved, [CASE, CONTROL])

    def test_an_added_or_removed_case_moves(self):
        head = dict(BASE)
        del head[OTHER]
        head["artifact/ledger/new_case"] = timing(1_000.0)
        changes = compare.what_moved(report(BASE, head), PCT)
        self.assertTrue(changes["any"])
        self.assertEqual(
            changes["added"], [{"kind": "timing", "name": "artifact/ledger/new_case"}]
        )
        self.assertEqual(changes["removed"], [{"kind": "timing", "name": OTHER}])


class AllocationTests(unittest.TestCase):
    def changes(self, base: dict, head: dict) -> dict:
        return compare.what_moved(report(BASE, BASE, base, head), PCT)

    def test_one_allocation_moves(self):
        changes = self.changes(
            {"ledger/core_full": allocation(5980)},
            {"ledger/core_full": allocation(5981)},
        )
        self.assertTrue(changes["any"])
        self.assertEqual(
            changes["allocations"],
            [
                {
                    "name": "ledger/core_full",
                    "metric": "allocations",
                    "before": 5980,
                    "after": 5981,
                }
            ],
        )

    def test_bytes_move_with_the_count_unchanged(self):
        changes = self.changes(
            {"ledger/core_full": allocation(10, allocated=1000, peak=500)},
            {"ledger/core_full": allocation(10, allocated=1000, peak=501)},
        )
        metrics = [entry["metric"] for entry in changes["allocations"]]
        self.assertEqual(metrics, ["peak_live_bytes"])

    def test_identical_counts_move_nothing(self):
        same = {"ledger/core_full": allocation(5980, 486272, 129357)}
        self.assertFalse(self.changes(same, dict(same))["any"])

    def test_an_added_case_is_named_once(self):
        changes = self.changes(
            {"ledger/core_full": allocation(10)},
            {"ledger/core_full": allocation(10), "ledger/new": allocation(3)},
        )
        self.assertEqual(
            changes["added"], [{"kind": "allocations", "name": "ledger/new"}]
        )


def write_run(
    root: Path, results: dict, allocations: dict
) -> "tuple[Path, Path, Path]":
    """A manifest, a Criterion tree newer than it, and probe output."""
    root.mkdir(parents=True)
    manifest = root / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "corpus_id": "0123456789abcdef",
                "generator_sizes": {"wide_record_fields": 256},
                "features": ["compiler", "filesystem-compiler", "host-value"],
                "metric_units": {"time": "nanoseconds"},
            }
        )
    )
    epoch = manifest.stat().st_mtime
    criterion = root / "criterion"
    for name, entry in results.items():
        case = criterion / name.replace("/", "_") / "new"
        case.mkdir(parents=True)
        (case / "benchmark.json").write_text(json.dumps({"full_id": name}))
        estimates = case / "estimates.json"
        estimates.write_text(
            json.dumps(
                {
                    "median": {
                        "point_estimate": entry["median_ns"],
                        "confidence_interval": {
                            "lower_bound": entry["lower_ns"],
                            "upper_bound": entry["upper_ns"],
                        },
                    }
                }
            )
        )
        os.utime(estimates, (epoch + 1, epoch + 1))
    probe = root / "allocations.json"
    probe.write_text(
        json.dumps(
            [
                {"case": name.split("/")[0], "operation": name.split("/")[1], **values}
                for name, values in allocations.items()
            ]
        )
    )
    return manifest, criterion, probe


class CommandTests(unittest.TestCase):
    """`capture` then `compare --json`, the way the workflow runs them."""

    def run_pair(self, head_results: dict, head_allocations: dict) -> dict:
        allocations = {"ledger/core_full": allocation(5980, 486272, 129357)}
        with tempfile.TemporaryDirectory() as scratch:
            scratch = Path(scratch)
            base = write_run(scratch / "base", BASE, allocations)
            head = write_run(scratch / "head", head_results, head_allocations)
            common = ["--repo-root", str(REPO)]
            subprocess.run(
                [sys.executable, str(SCRIPT), "capture", *common,
                 "--manifest", str(base[0]), "--criterion", str(base[1]),
                 "--allocations", str(base[2]), "--out", str(scratch / "base.json")],
                check=True, capture_output=True, text=True,
            )
            subprocess.run(
                [sys.executable, str(SCRIPT), "compare", *common,
                 "--baseline", str(scratch / "base.json"),
                 "--manifest", str(head[0]), "--criterion", str(head[1]),
                 "--allocations", str(head[2]), "--allow-environment-drift",
                 "--markdown", str(scratch / "report.md"),
                 "--json", str(scratch / "report.json")],
                check=True, capture_output=True, text=True,
            )
            result = json.loads((scratch / "report.json").read_text())
            result["markdown"] = (scratch / "report.md").read_text()
            return result

    def test_a_no_op_pair_reports_nothing_moved_in_one_line(self):
        result = self.run_pair(
            BASE, {"ledger/core_full": allocation(5980, 486272, 129357)}
        )
        self.assertFalse(result["changes"]["any"])
        self.assertFalse(result["environment_drift"])
        # Issue #256: with no change, all a reader sees above the collapsed
        # tables is the title and one line.
        above = result["markdown"].split("<details>")[0]
        visible = [line for line in above.splitlines() if line]
        self.assertEqual(len(visible), 2, visible)
        self.assertTrue(
            visible[1].startswith("**Nothing moved.** No allocation change in 1 case,")
        )

    def test_a_slowdown_and_an_allocation_are_reported(self):
        result = self.run_pair(
            scaled(BASE, {CASE: 1 + 3 * PCT / 100}),
            {"ledger/core_full": allocation(5981, 486272, 129357)},
        )
        self.assertTrue(result["changes"]["any"])
        moved = [entry["name"] for entry in result["changes"]["timing"]]
        self.assertEqual(moved, [CASE])
        self.assertEqual(len(result["changes"]["allocations"]), 1)
        visible = result["markdown"].split("<details>")[0]
        self.assertIn("**Moved:**", visible)
        # Allocations first, with both absolute values (issue #256), then timing.
        row = "| `ledger/core_full` | allocations | 5,980 | 5,981 | +1 |"
        self.assertIn(row, visible)
        self.assertLess(visible.index(row), visible.index(f"`{CASE}`"))


def glob_regex(pattern: str) -> "re.Pattern":
    """GitHub's filter globs: `**` crosses `/`, `*` and `?` do not."""
    out = []
    index = 0
    while index < len(pattern):
        if pattern.startswith("**", index):
            out.append(".*")
            index += 2
        elif pattern[index] == "*":
            out.append("[^/]*")
            index += 1
        elif pattern[index] == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(pattern[index]))
            index += 1
    return re.compile("".join(out) + r"\Z")


def trigger_paths() -> list:
    """The `paths:` list under `pull_request:` in the workflow, in order."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    paths = []
    inside = False
    for line in lines:
        stripped = line.strip()
        if stripped == "paths:":
            inside = True
            continue
        if inside:
            if not stripped or stripped.startswith("#"):
                continue
            item = re.fullmatch(r'-\s+"([^"]+)"', stripped)
            if not item:
                break
            paths.append(item.group(1))
    return paths


INCLUDE = re.compile(r'include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)')
INCLUDE_FROM_MANIFEST = re.compile(
    r'include_(?:str|bytes)!\(\s*concat!\(\s*env!\(\s*"CARGO_MANIFEST_DIR"\s*\)'
    r'\s*,\s*"([^"]+)"\s*\)\s*\)'
)


def compile_time_inputs() -> list:
    """Every file `src/` and `benches/` include at compile time, repo-relative."""
    inputs = []
    for directory in ("src", "benches"):
        for source in sorted((REPO / directory).rglob("*.rs")):
            text = source.read_text(encoding="utf-8")
            plain = INCLUDE.findall(text)
            from_manifest = INCLUDE_FROM_MANIFEST.findall(text)
            mentions = len(re.findall(r"include_(?:str|bytes)!\(", text))
            if mentions != len(plain) + len(from_manifest):
                raise AssertionError(
                    f"{source.relative_to(REPO)}: an include this test cannot "
                    "resolve; teach it the new form rather than skip the file"
                )
            for relative in plain:
                target = (source.parent / relative).resolve()
                inputs.append(target.relative_to(REPO).as_posix())
            for relative in from_manifest:
                target = (REPO / relative.lstrip("/")).resolve()
                inputs.append(target.relative_to(REPO).as_posix())
    return inputs


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.paths = trigger_paths()
        self.assertTrue(self.paths, "the workflow names no paths: the parser lost them")
        tracked = subprocess.run(
            ["git", "ls-files"], cwd=REPO, check=True, capture_output=True, text=True
        ).stdout.splitlines()
        self.tracked = tracked

    def test_every_compile_time_input_triggers_the_workflow(self):
        inputs = compile_time_inputs()
        self.assertTrue(inputs, "found no include at all: the scan is broken")
        patterns = [glob_regex(path) for path in self.paths]
        missed = [path for path in inputs if not any(p.match(path) for p in patterns)]
        self.assertEqual(missed, [], f"not in the workflow's paths: {missed}")

    def test_every_entry_names_a_tracked_file(self):
        dead = [
            path
            for path in self.paths
            if not any(glob_regex(path).match(file) for file in self.tracked)
        ]
        self.assertEqual(dead, [], f"paths that match no tracked file: {dead}")


class DocsTests(unittest.TestCase):
    def test_the_docs_state_the_threshold_the_tool_applies(self):
        docs = (REPO / "docs" / "benchmarks.md").read_text(encoding="utf-8")
        stated = re.findall(r"`TIMING_MOVED_PCT` \((\d+(?:\.\d+)?)%\)", docs)
        self.assertEqual(
            stated, [f"{PCT:g}"], "docs/benchmarks.md must state the threshold once"
        )


if __name__ == "__main__":
    unittest.main()
