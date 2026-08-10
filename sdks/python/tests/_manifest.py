"""Records which ``protocol/conformance-cases.json`` cases this run exercised.

The manifest claims every suite asserts it ran every required name. Nothing read
the file, so the claim was prose and the coverage it exists to hold could drift
again in silence.

The evidence is produced by the case itself: each test calls ``covers()`` as it
runs, and ``test_zz_manifest.py`` compares what was recorded against the
manifest. A suite cannot satisfy the check by listing names it claims to cover —
only by executing something under each of them.
"""

from __future__ import annotations

import json
import os

from tests._fixtures import FIXTURES_DIR

# Names recorded by the cases that actually ran, in this process.
COVERED: set[str] = set()


def covers(name: str) -> None:
    """Record that the calling test exercises the manifest case ``name``."""
    COVERED.add(name)


def required() -> list[str]:
    """The case names every SDK suite must exercise."""
    path = os.path.join(os.path.dirname(FIXTURES_DIR), "conformance-cases.json")

    with open(path, encoding="utf-8") as handle:
        return json.load(handle)["required"]
