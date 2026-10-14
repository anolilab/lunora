"""Locate and load the shared protocol fixtures (``protocol/fixtures/*.json``).

The fixtures are shared verbatim by the TypeScript conformance test and this
Python suite, so both SDKs target byte-identical golden frames.
"""

from __future__ import annotations

import json
import os


def _fixtures_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    current = here
    for _ in range(8):
        candidate = os.path.join(current, "protocol", "fixtures")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    raise FileNotFoundError("could not locate protocol/fixtures from " + here)


FIXTURES_DIR = _fixtures_dir()


def load(name: str) -> dict:
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as handle:
        return json.load(handle)
