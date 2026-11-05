#!/usr/bin/env python3
"""Every workflow that can write runs its actions at a commit.

A workflow that grants a job any `write` permission (`id-token: write` for
npm's trusted publishing, `contents: write`, `pages: write`, `actions: write`
and the rest), or `write-all`, or runs a job in an environment, runs the code
its `uses:` references name while holding that. A branch or a tag
(`dtolnay/rust-toolchain@master`, `actions/checkout@v7`) is code its owner can
move under the workflow; a full 40-character commit is not. So in such a
workflow every `uses:`, of a step or of a job, names a full commit, a file of
this repository (`./...`), or a Docker image by its sha256 digest. The rule
holds for every job of the workflow, not only the one with the permission: a
job beside it can hand it a cache or an artifact, and a job added later to the
file is held to it without anyone remembering to. A workflow of this
repository that such a workflow calls (`uses: ./.github/workflows/...`) runs
inside its run, so it is held to the rule too: downstream.yml, which both npm
releases call.

Ordinary CI, which writes nothing, is not checked: it follows tags and
rolling toolchains on purpose, which is how new-toolchain breakage gets caught
(CLAUDE.md). Neither are the profile copy's two workflows,
npm-release-profile.yml and profile-ci.yml: each sync from the profile's
working repository replaces them whole, and Verify does not run on a pull
request that changes only them, so their pins are that repository's to keep.

Run with:
    python3 tests/fixtures/ci/test_pinned_actions.py
"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
WORKFLOWS = REPO / ".github" / "workflows"

# Replaced whole by each profile sync; see the docstring.
PROFILE_COPY = {"npm-release-profile.yml", "profile-ci.yml"}

# A permission that lets a job write (`contents: write`, also in a flow
# mapping), `write-all`, or an environment.
PRIVILEGE = re.compile(r"\b[a-z-]+\s*:\s*write\b|\bwrite-all\b|^\s*environment\s*:")
USES = re.compile(r"^\s*(?:-\s+)?uses\s*:\s*(\S+)")
COMMIT = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^@\s]+)?@[0-9a-f]{40}")
IMAGE = re.compile(r"docker://[^@\s]+@sha256:[0-9a-f]{64}")


def lines(text):
    """(line number, line) for each line that is not a comment."""
    return [
        (number, line)
        for number, line in enumerate(text.splitlines(), start=1)
        if not line.lstrip().startswith("#")
    ]


def privileged(text):
    """Whether a workflow grants a job a write permission or an environment."""
    return any(PRIVILEGE.search(line) for _, line in lines(text))


def references(text):
    """(line number, reference) for each `uses:` of a workflow."""
    found = []
    for number, line in lines(text):
        match = USES.match(line)
        if match:
            found.append((number, match.group(1).strip("'\"")))
    return found


def pinned(reference):
    """Whether a `uses:` reference names code nobody can move."""
    return reference.startswith("./") or bool(
        COMMIT.fullmatch(reference) or IMAGE.fullmatch(reference)
    )


def privileged_workflows():
    """The workflows that can write, and the workflows of this repository they call."""
    checked = {
        path
        for path in WORKFLOWS.glob("*.yml")
        if path.name not in PROFILE_COPY and privileged(path.read_text(encoding="utf-8"))
    }
    pending = sorted(checked)
    while pending:
        for _, reference in references(pending.pop().read_text(encoding="utf-8")):
            if reference.startswith("./.github/workflows/"):
                called = REPO / reference
                if called not in checked:
                    checked.add(called)
                    pending.append(called)
    return sorted(checked)


class RuleTests(unittest.TestCase):
    def test_a_branch_a_tag_or_a_short_commit_is_not_a_pin(self):
        for reference in (
            "dtolnay/rust-toolchain@master",
            "dtolnay/rust-toolchain@stable",
            "dtolnay/rust-toolchain@1.94.1",
            "actions/checkout@v7",
            "actions/checkout@3d3c42e",
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1-x",
            "actions/checkout",
            "docker://alpine:3.20",
            "docker://alpine@sha256:abc",
        ):
            with self.subTest(reference):
                self.assertFalse(pinned(reference))

    def test_a_commit_a_local_file_or_an_image_digest_is_a_pin(self):
        for reference in (
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4",
            "B3Pay/b3pay.net/.github/workflows/publish-module.yml@07de4cdc9dc27c1dcc56d7db44b08d4c9d617c3c",
            "./.github/workflows/downstream.yml",
            "docker://alpine@sha256:" + "0" * 64,
        ):
            with self.subTest(reference):
                self.assertTrue(pinned(reference))

    def test_a_write_permission_or_an_environment_makes_a_workflow_privileged(self):
        for text in (
            "jobs:\n  a:\n    permissions:\n      id-token: write\n",
            "jobs:\n  a:\n    permissions: { contents: read, pages: write }\n",
            "permissions:\n  actions: write\n",
            "permissions: write-all\n",
            "jobs:\n  a:\n    environment: npm-publish\n",
            "jobs:\n  a:\n    environment:\n      name: github-pages\n",
        ):
            with self.subTest(text):
                self.assertTrue(privileged(text))

    def test_read_permissions_and_comments_do_not(self):
        for text in (
            "permissions:\n  contents: read\n",
            "permissions: {}\n",
            "permissions:\n  contents: read\n# a job here could hold id-token: write\n",
            "jobs:\n  a:\n    steps:\n      #   environment: npm-publish\n",
        ):
            with self.subTest(text):
                self.assertFalse(privileged(text))

    def test_a_reference_is_read_from_a_step_or_a_job_and_not_a_comment(self):
        text = (
            "jobs:\n"
            "  a:\n"
            "    uses: ./.github/workflows/downstream.yml\n"
            "  b:\n"
            "    steps:\n"
            "      - uses: actions/checkout@v7 # v7\n"
            "      - name: Toolchain\n"
            "        uses: 'dtolnay/rust-toolchain@master'\n"
            "      # - uses: actions/cache@v4\n"
        )
        self.assertEqual(
            references(text),
            [
                (3, "./.github/workflows/downstream.yml"),
                (6, "actions/checkout@v7"),
                (8, "dtolnay/rust-toolchain@master"),
            ],
        )


class WorkflowTests(unittest.TestCase):
    def test_every_workflow_that_can_write_runs_its_actions_at_a_commit(self):
        unpinned = [
            f"{path.name}:{number}: {reference}"
            for path in privileged_workflows()
            for number, reference in references(path.read_text(encoding="utf-8"))
            if not pinned(reference)
        ]
        self.assertEqual(unpinned, [], "pin each to a full commit, as release.yml does")

    def test_the_workflows_that_publish_push_or_deploy_are_checked(self):
        # A rule that selects nothing passes, so the workflows that hold the
        # credentials today are named.
        checked = {path.name for path in privileged_workflows()}
        for name in (
            "release.yml",
            "npm-release.yml",
            "npm-release-cli.yml",
            "docs.yml",
            "b3pay-site.yml",
            "runner-retry.yml",
            "downstream.yml",
        ):
            with self.subTest(name):
                self.assertIn(name, checked)

    def test_each_checked_workflow_has_references_to_check(self):
        for path in privileged_workflows():
            with self.subTest(path.name):
                self.assertNotEqual(references(path.read_text(encoding="utf-8")), [])

    def test_the_check_runs_in_verify(self):
        command = "python3 tests/fixtures/ci/test_pinned_actions.py"
        self.assertIn(command, (WORKFLOWS / "msrv.yml").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
