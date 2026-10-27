#!/usr/bin/env python3
"""Where `verify_semver.py` looks for a `**BREAKING**` acknowledgement.

Issue #222: the gate read only `## Unreleased`, which release prep renames to
the version being released, so a release carrying an acknowledged break could
not pass on its own release commit. These fixtures pin the rule that replaced
it: `## Unreleased`, plus the section headed by the `Cargo.toml` version when
that version is not the baseline. `cargo semver-checks` and crates.io are
stubbed out; the gate's own verdict and exit code are what is checked.

Run with:
    python3 tests/fixtures/packaging/test_verify_semver.py
"""

import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "verify_semver.py"
spec = importlib.util.spec_from_file_location("verify_semver", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

BASELINE = "0.1.0-beta.3"

PREAMBLE = """# Changelog

The entry describing this gate mentions the `**BREAKING**` marker in prose,
which acknowledges nothing.

"""

PUBLISHED = """## 0.1.0-beta.3 — published 2026-08-24

### Changed

- **BREAKING**: an old break, shipped with this release.
"""

ACKNOWLEDGED = """### Changed

- **BREAKING**: `ContractEnvelope` moved; import it from `meant::envelope`.
"""

UNACKNOWLEDGED = """### Changed

- Nothing a consumer must act on. A `**BREAKING**` mention in prose is not one.
"""


def changelog(*sections: str) -> str:
    return PREAMBLE + "\n".join(sections)


class AcknowledgementTests(unittest.TestCase):
    def count(self, text: str, version: str) -> int:
        return gate.acknowledgements(text, version, BASELINE)

    def test_unreleased_is_read_between_releases(self):
        text = changelog("## Unreleased\n\n" + ACKNOWLEDGED, PUBLISHED)
        self.assertEqual(self.count(text, BASELINE), 1)

    def test_the_release_section_is_read_on_the_release_commit(self):
        text = changelog("## 0.1.0 — published 2026-10-12\n\n" + ACKNOWLEDGED, PUBLISHED)
        self.assertEqual(self.count(text, "0.1.0"), 1)

    def test_a_heading_without_a_date_names_the_section_too(self):
        text = changelog("## 0.1.0\n\n" + ACKNOWLEDGED, PUBLISHED)
        self.assertEqual(self.count(text, "0.1.0"), 1)

    def test_a_release_without_an_acknowledgement_finds_none(self):
        text = changelog("## 0.1.0 — published 2026-10-12\n\n" + UNACKNOWLEDGED, PUBLISHED)
        self.assertEqual(self.count(text, "0.1.0"), 0)

    def test_the_baseline_section_never_acknowledges_a_new_break(self):
        # Between releases `Cargo.toml` carries the published version. Its
        # section's acknowledgement is for a break already shipped.
        text = changelog("## Unreleased\n\n" + UNACKNOWLEDGED, PUBLISHED)
        self.assertEqual(self.count(text, BASELINE), 0)
        self.assertEqual(self.count(changelog(PUBLISHED), BASELINE), 0)

    def test_a_version_does_not_name_a_longer_version_section(self):
        # `0.1.0` is a prefix of `0.1.0-beta.3`; that section is not 0.1.0's.
        text = changelog("## 0.1.0 — published 2026-10-12\n\n" + UNACKNOWLEDGED, PUBLISHED)
        self.assertEqual(gate.section(text, "0.1.0").count("BREAKING**:"), 0)
        self.assertEqual(self.count(changelog(PUBLISHED), "0.1.0"), 0)

    def test_the_last_section_in_the_file_is_read(self):
        text = changelog("## 0.1.0\n\n" + ACKNOWLEDGED)
        self.assertEqual(self.count(text, "0.1.0"), 1)

    def test_a_marker_outside_a_list_item_acknowledges_nothing(self):
        text = changelog("## Unreleased\n\n" + UNACKNOWLEDGED)
        self.assertEqual(self.count(text, "0.1.0"), 0)


class GateTests(unittest.TestCase):
    """The gate's verdict with a reported break, on a fixture repository."""

    def run_gate(self, text: str, version: str) -> tuple:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "CHANGELOG.md").write_text(text)
            (root / "Cargo.toml").write_text(
                f'[package]\nname = "meant"\nversion = "{version}"\n'
            )
            stdout, stderr = io.StringIO(), io.StringIO()
            saved = gate.REPO_ROOT, gate.run_surface, sys.argv
            gate.REPO_ROOT = root
            gate.run_surface = lambda *_: False
            sys.argv = ["verify_semver.py", "--baseline-version", BASELINE]
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = gate.main()
            finally:
                gate.REPO_ROOT, gate.run_surface, sys.argv = saved
            return code, stdout.getvalue() + stderr.getvalue()

    def test_an_acknowledged_break_passes_on_the_release_commit(self):
        text = changelog("## 0.1.0 — published 2026-10-12\n\n" + ACKNOWLEDGED, PUBLISHED)
        code, output = self.run_gate(text, "0.1.0")
        self.assertEqual(code, 0, output)
        self.assertIn("under `## Unreleased` and `## 0.1.0`", output)

    def test_an_unacknowledged_break_fails_on_the_release_commit(self):
        text = changelog("## 0.1.0 — published 2026-10-12\n\n" + UNACKNOWLEDGED, PUBLISHED)
        code, output = self.run_gate(text, "0.1.0")
        self.assertEqual(code, 1, output)
        self.assertIn("no acknowledgement under `## Unreleased` and `## 0.1.0`", output)

    def test_an_acknowledged_break_passes_between_releases(self):
        text = changelog("## Unreleased\n\n" + ACKNOWLEDGED, PUBLISHED)
        code, output = self.run_gate(text, BASELINE)
        self.assertEqual(code, 0, output)

    def test_an_unacknowledged_break_fails_between_releases(self):
        text = changelog("## Unreleased\n\n" + UNACKNOWLEDGED, PUBLISHED)
        code, output = self.run_gate(text, BASELINE)
        self.assertEqual(code, 1, output)
        self.assertIn("no acknowledgement under `## Unreleased` in", output)


if __name__ == "__main__":
    unittest.main()
