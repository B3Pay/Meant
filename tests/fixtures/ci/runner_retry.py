#!/usr/bin/env python3
"""Whether a failed run failed only because no runner ever took a job.

When GitHub finds no hosted runner for a job, it gives up after about fifteen
minutes: the job ends cancelled, the run fails, and the job's page says "The
job was not acquired by Runner of type hosted even after multiple attempts".
Verify #502 (2026-11-02), Verify #504 and Release candidate #407 (both
2026-11-04) failed that way, each on its one macOS job, while GitHub reported
"capacity constraints" for macOS arm64 runners. Every other job in them
passed. Nothing of the commit ran on the macOS job, so its failure says
nothing about the commit.

The REST API shows such a job plainly: no runner (`runner_id` stays null until
a runner is assigned) and no steps. A job that got a runner has at least its
"Set up job" step.

`runner-retry.yml` asks this script about every failed run of Verify and
Release candidate, and re-runs the run's failed jobs only when it says yes:

- at least one job failed or was cancelled, and
- not one of them ever started.

A job that ran and failed makes the answer no, for any reason and even beside
a job that never started. Re-running it could turn an intermittent failure
green, and that is a person's call, never this workflow's: the macOS job of
Verify #463, #489 and #491 ran its tests and failed, and those runs are the
ones the retry must leave alone. A skipped job never starts either, but it is
not a failure, so it counts as neither.

Usage:
    python3 tests/fixtures/ci/runner_retry.py JOBS_JSON

JOBS_JSON is the response of
GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs
for one attempt, on one page; the script refuses a partial list.

Exit status: 0, re-run the failed jobs; 2, leave the run as it is; anything
else, this tool broke and decided nothing.

Standard library only, like every other verifier in this repository.
"""

import json
import sys

RERUN = 0
LEAVE = 2

# Conclusions that are not a failure. A skipped job has no runner and no steps
# either, so it must not be mistaken for one no runner took.
NOT_FAILED = frozenset({"success", "skipped", "neutral"})


def never_started(job: dict) -> bool:
    """No runner was assigned and no step ran.

    The API writes a missing runner as null; a missing, null or zero
    `runner_id` all mean the same here, and so do missing, null or empty
    `steps`.
    """
    return not job.get("runner_id") and not job.get("steps")


def decide(response: dict) -> tuple:
    """`(rerun, reasons)` for one attempt's job list."""
    jobs = response["jobs"]
    total = response.get("total_count")
    if total != len(jobs):
        raise ValueError(
            f"the response holds {len(jobs)} of {total} jobs: "
            "ask for one attempt with per_page=100"
        )
    unfinished = [job for job in jobs if job.get("status") != "completed"]
    if unfinished:
        return False, [f"not finished yet: {job['name']}" for job in unfinished]
    failed = [job for job in jobs if job.get("conclusion") not in NOT_FAILED]
    if not failed:
        return False, ["no job failed"]
    ran = [job for job in failed if not never_started(job)]
    if ran:
        return False, [
            f"ran and ended {job.get('conclusion')}: {job['name']}" for job in ran
        ]
    return True, [
        f"no runner took it, ended {job.get('conclusion')}: {job['name']}"
        for job in failed
    ]


def main(argv: list) -> int:
    if len(argv) != 2:
        print("usage: runner_retry.py JOBS_JSON", file=sys.stderr)
        return 64
    with open(argv[1], encoding="utf-8") as handle:
        response = json.load(handle)
    rerun, reasons = decide(response)
    for reason in reasons:
        print(f"- {reason}")
    if rerun:
        print("Decision: re-run the failed jobs.")
        return RERUN
    print("Decision: leave the run as it is.")
    return LEAVE


if __name__ == "__main__":
    sys.exit(main(sys.argv))
