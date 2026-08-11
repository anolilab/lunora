"""Fails if this run did not exercise every case in the shared manifest.

``unittest discover`` loads test modules in sorted order, so the ``zz`` in the
name is load-bearing: this module must run after the ones that record coverage.
Running it first would report every case missing — a false red, never a false
green, which is the safe direction for an ordering dependency.

Nothing here enumerates case names. The recorded set comes from the cases that
ran; the expected set comes from ``protocol/conformance-cases.json``.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests._manifest import COVERED, required


class TestManifestCoverage(unittest.TestCase):
    def test_every_required_case_ran(self):
        expected = required()

        self.assertTrue(expected, "the manifest must list at least one required case")

        missing = sorted(set(expected) - COVERED)

        self.assertEqual(
            missing,
            [],
            "protocol/conformance-cases.json requires cases this suite did not run: "
            + ", ".join(missing)
            + " (add a test that calls tests._manifest.covers() with that name)",
        )


if __name__ == "__main__":
    unittest.main()
