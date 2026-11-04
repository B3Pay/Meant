#!/usr/bin/env python3
"""When `runner-retry.yml` re-runs a failed run, and when it must not.

The rule is `runner_retry.py`: re-run a failed run's failed jobs only when
not one of them ever started, that is, no runner was assigned and no step ran.
These tests replay the job lists of six real failed runs, written down from
the Actions API:

- Verify #502 (run 41475112592) and #504 (run 41865537536), and Release
  candidate #407 (run 41865537652): the macOS job had no runner and no steps,
  and GitHub cancelled it about fifteen minutes after it was queued. Every
  other job passed. These must be re-run.
- Verify #463 (run 41101288169), #489 (run 41423516315) and #491 (run
  41425360341): the macOS job got a runner and its Test step failed. These
  must be left alone, even though a re-run passed for #489 and #491: a retry
  that turns an intermittent failure green hides it.

They also pin the edges around those cases, and that the workflow listens to
workflows that exist, so renaming Verify or Release candidate cannot switch
the retry off without a red test.

Run with:
    python3 tests/fixtures/ci/test_runner_retry.py
"""

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SCRIPT = HERE / "runner_retry.py"
WORKFLOWS = REPO / ".github" / "workflows"
RETRY_WORKFLOW = WORKFLOWS / "runner-retry.yml"
spec = importlib.util.spec_from_file_location("runner_retry", SCRIPT)
runner_retry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner_retry)

# The jobs of one Verify run before this change, as the API names them. The
# two scheduled jobs are skipped on a push or a pull request.
VERIFY = [
    "Rust 1.78",
    "Stable (ubuntu-latest)",
    "Stable (macos-latest)",
    "Stable (windows-latest)",
    "Feature matrix",
    "Feature dependency boundaries",
    "Independent conformance reference",
    "Independent artifact identity reference",
    "Stable WASM",
    "Browser runtime (headless Chrome)",
    "Generator crate",
    "Meant format crate",
    "Benchmark smoke test",
    "Scheduled benchmarks",
    "Fuzz targets build and replay",
    "Scheduled fuzzing",
]
VERIFY_SKIPPED = {"Scheduled benchmarks", "Scheduled fuzzing"}
VERIFY_MACOS = "Stable (macos-latest)"

RELEASE_CANDIDATE = [
    "Package and inspect the archive",
    "Consumers from the archive (ubuntu-latest)",
    "Consumers from the archive (macos-latest)",
    "Rustdoc from the archive",
    "Package and inspect the meant-format archive",
    "Semver compatibility",
    "Public API inventory",
    "Advisories, licenses, sources, bans",
]
RELEASE_CANDIDATE_MACOS = "Consumers from the archive (macos-latest)"


def ran(name: str, conclusion: str = "success", failed_step: str = "") -> dict:
    """A job a runner took: a runner id and at least "Set up job"."""
    steps = [
        {"name": "Set up job", "status": "completed", "conclusion": "success", "number": 1}
    ]
    if failed_step:
        steps.append(
            {"name": failed_step, "status": "completed", "conclusion": "failure", "number": 6}
        )
    return {
        "name": name,
        "status": "completed",
        "conclusion": conclusion,
        "runner_id": 1000021516,
        "runner_name": "GitHub Actions 1000021516",
        "steps": steps,
    }


def never_started(name: str, conclusion: str = "cancelled") -> dict:
    """A job no runner took, as the API writes it: null runner, no steps."""
    return {
        "name": name,
        "status": "completed",
        "conclusion": conclusion,
        "runner_id": None,
        "runner_name": None,
        "steps": [],
    }


def skipped(name: str) -> dict:
    return {
        "name": name,
        "status": "completed",
        "conclusion": "skipped",
        "runner_id": None,
        "runner_name": None,
        "steps": [],
    }


def response(jobs: list) -> dict:
    return {"total_count": len(jobs), "jobs": jobs}


def verify_run(macos: dict) -> dict:
    """A Verify attempt in which every job but the macOS one passed."""
    jobs = []
    for name in VERIFY:
        if name == VERIFY_MACOS:
            jobs.append(macos)
        elif name in VERIFY_SKIPPED:
            jobs.append(skipped(name))
        else:
            jobs.append(ran(name))
    return response(jobs)


def release_candidate_run(macos: dict) -> dict:
    jobs = [macos if name == RELEASE_CANDIDATE_MACOS else ran(name) for name in RELEASE_CANDIDATE]
    return response(jobs)


# The recorded attempts.
NO_RUNNER = {
    "Verify #502, attempt 1": verify_run(never_started(VERIFY_MACOS)),
    "Verify #504, attempt 1": verify_run(never_started(VERIFY_MACOS)),
    "Release candidate #407, attempt 1": release_candidate_run(
        never_started(RELEASE_CANDIDATE_MACOS)
    ),
}
RAN_AND_FAILED = {
    f"Verify #{number}, attempt 1": verify_run(ran(VERIFY_MACOS, "failure", "Test"))
    for number in (463, 489, 491)
}


class RecordedRunTests(unittest.TestCase):
    def test_a_job_no_runner_took_is_re_run(self):
        for label, run in NO_RUNNER.items():
            with self.subTest(label):
                rerun, reasons = runner_retry.decide(run)
                self.assertTrue(rerun, reasons)
                self.assertEqual(len(reasons), 1, reasons)
                self.assertIn("(macos-latest)", reasons[0])
                self.assertIn("no runner took it", reasons[0])

    def test_a_job_that_ran_and_failed_is_left(self):
        for label, run in RAN_AND_FAILED.items():
            with self.subTest(label):
                rerun, reasons = runner_retry.decide(run)
                self.assertFalse(rerun, reasons)
                self.assertEqual(reasons, [f"ran and ended failure: {VERIFY_MACOS}"])


class EdgeTests(unittest.TestCase):
    def test_one_that_ran_beside_one_that_never_started_is_left(self):
        run = verify_run(never_started(VERIFY_MACOS))
        windows = VERIFY.index("Stable (windows-latest)")
        run["jobs"][windows] = ran("Stable (windows-latest)", "failure", "Test")
        rerun, reasons = runner_retry.decide(run)
        self.assertFalse(rerun)
        self.assertEqual(reasons, ["ran and ended failure: Stable (windows-latest)"])

    def test_a_cancelled_or_timed_out_job_that_ran_is_left(self):
        for conclusion in ("cancelled", "timed_out"):
            with self.subTest(conclusion):
                run = verify_run(ran(VERIFY_MACOS, conclusion))
                rerun, _ = runner_retry.decide(run)
                self.assertFalse(rerun)

    def test_a_failure_that_never_started_is_re_run_too(self):
        # GitHub has ended such a job `cancelled` every time so far; the rule
        # looks at the runner and the steps, not at which of the two it was.
        run = verify_run(never_started(VERIFY_MACOS, "failure"))
        rerun, _ = runner_retry.decide(run)
        self.assertTrue(rerun)

    def test_skipped_jobs_are_not_failures(self):
        run = verify_run(ran(VERIFY_MACOS))
        rerun, reasons = runner_retry.decide(run)
        self.assertFalse(rerun)
        self.assertEqual(reasons, ["no job failed"])

    def test_no_runner_reads_the_same_null_absent_or_zero(self):
        # The API writes null; a connector that drops null fields omits it.
        for runner in ({"runner_id": None}, {}, {"runner_id": 0}):
            for steps in ({"steps": []}, {}, {"steps": None}):
                job = {"name": VERIFY_MACOS, "status": "completed", "conclusion": "cancelled"}
                job.update(runner)
                job.update(steps)
                with self.subTest(runner=runner, steps=steps):
                    self.assertTrue(runner_retry.never_started(job))
                    rerun, _ = runner_retry.decide(verify_run(job))
                    self.assertTrue(rerun)

    def test_a_runner_without_steps_counts_as_started(self):
        # A runner that took the job and then lost contact may report no
        # steps. Something may have run, so a person decides.
        job = ran(VERIFY_MACOS, "failure")
        job["steps"] = []
        rerun, _ = runner_retry.decide(verify_run(job))
        self.assertFalse(rerun)

    def test_steps_without_a_runner_count_as_started(self):
        job = ran(VERIFY_MACOS, "failure", "Test")
        job["runner_id"] = None
        rerun, _ = runner_retry.decide(verify_run(job))
        self.assertFalse(rerun)

    def test_an_unfinished_attempt_is_left(self):
        run = verify_run(never_started(VERIFY_MACOS))
        run["jobs"][0]["status"] = "in_progress"
        rerun, reasons = runner_retry.decide(run)
        self.assertFalse(rerun)
        self.assertEqual(reasons, ["not finished yet: Rust 1.78"])

    def test_a_partial_list_is_refused(self):
        run = verify_run(never_started(VERIFY_MACOS))
        run["total_count"] += 1
        with self.assertRaises(ValueError):
            runner_retry.decide(run)


class CommandLineTests(unittest.TestCase):
    def run_script(self, payload) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPT), str(path)],
                capture_output=True,
                text=True,
                check=False,
            )

    def test_exit_zero_means_re_run(self):
        result = self.run_script(NO_RUNNER["Verify #504, attempt 1"])
        self.assertEqual(result.returncode, runner_retry.RERUN, result.stderr)
        self.assertIn("Decision: re-run the failed jobs.", result.stdout)

    def test_exit_two_means_leave(self):
        result = self.run_script(RAN_AND_FAILED["Verify #489, attempt 1"])
        self.assertEqual(result.returncode, runner_retry.LEAVE, result.stderr)
        self.assertIn("Decision: leave the run as it is.", result.stdout)

    def test_a_broken_input_is_neither(self):
        partial = NO_RUNNER["Verify #504, attempt 1"] | {"total_count": 17}
        for payload in (partial, {"message": "Not Found"}):
            with self.subTest(payload=list(payload)):
                result = self.run_script(payload)
                self.assertNotIn(
                    result.returncode, (runner_retry.RERUN, runner_retry.LEAVE), result.stdout
                )


class WorkflowTests(unittest.TestCase):
    def test_the_retry_listens_to_workflows_that_exist(self):
        text = RETRY_WORKFLOW.read_text(encoding="utf-8")
        listed = re.findall(r"^\s+workflows: \[(.+)\]$", text, re.MULTILINE)
        self.assertEqual(len(listed), 1, "runner-retry.yml must name its workflows on one line")
        names = [name.strip() for name in listed[0].split(",")]
        self.assertEqual(names, ["Verify", "Release candidate"])
        existing = set()
        for path in WORKFLOWS.glob("*.yml"):
            match = re.search(r"^name: (.+)$", path.read_text(encoding="utf-8"), re.MULTILINE)
            if match:
                existing.add(match.group(1).strip())
        self.assertEqual([name for name in names if name not in existing], [])

    def test_the_rule_is_tested_where_it_runs_and_where_it_changes(self):
        # The retry runs only on main, after a run fails, so Verify is where a
        # pull request that changes the rule gets these tests.
        command = "python3 tests/fixtures/ci/test_runner_retry.py"
        for workflow in ("runner-retry.yml", "msrv.yml"):
            with self.subTest(workflow):
                self.assertIn(command, (WORKFLOWS / workflow).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
