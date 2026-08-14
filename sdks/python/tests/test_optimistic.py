"""The cursor-gated optimistic-layer engine, against the shared golden scenarios.

Every expectation is read from ``protocol/fixtures/offline-optimistic.json`` so
this port and the other six assert the same values rather than each documenting
its own behaviour.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.optimistic import (
    OptimisticLayer,
    OptimisticLocalStore,
    apply_optimistic_layer,
    drop_confirmed_layers,
    fold_optimistic,
)
from tests._fixtures import load
from tests._manifest import covers

FIXTURES = load("offline-optimistic.json")["optimistic"]


class _Sub:
    """The minimal subscription shape the engine folds over."""

    def __init__(self, base=None):
        self.server_base = base
        self.server_cursor = None
        self.last_value = base
        self.optimistic_layers = []
        self.callbacks = []
        self.args = {}


def _appender(item):
    """The one transform primitive the fixtures use: push onto a COPY of the list.

    A copy, not an in-place append: a transform is re-run on every rebase, so one
    that mutated its input would compound its own effect on each server frame.
    """

    return lambda current: [*(current or []), item]


def _run(deferred):
    for call in deferred:
        call()


def _frame(sub, frame, deferred):
    """Apply one server ``data`` frame the way ``LunoraClient._handle_data`` does."""

    sub.server_base = frame["data"]
    sub.server_cursor = frame["cursor"]
    drop_confirmed_layers(sub, sub.server_cursor)
    sub.last_value = fold_optimistic(sub.server_base, sub.optimistic_layers)
    for callback in sub.callbacks:
        deferred.append(lambda cb=callback, value=sub.last_value: cb(value))


class TestOptimisticRebase(unittest.TestCase):
    def test_layer_rebases_onto_a_later_server_frame(self):
        covers("optimistic_layer_rebases_onto_server_frame")
        case = FIXTURES["rebase"]
        seen = []
        sub = _Sub(case["base"])
        sub.callbacks.append(seen.append)

        deferred = []
        apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        _run(deferred)

        self.assertEqual(sub.last_value, case["displayedAfterApply"])
        self.assertEqual(seen, [case["displayedAfterApply"]])

        deferred = []
        _frame(sub, case["frame"], deferred)
        _run(deferred)

        # The overlay survived the frame and was RE-FOLDED onto the new base,
        # rather than being clobbered by it.
        self.assertEqual(sub.last_value, case["displayedAfterFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterFrame"])
        self.assertEqual(seen[-1], case["displayedAfterFrame"])

    def test_a_throwing_layer_is_skipped_not_fatal(self):
        covers("optimistic_layer_rebases_onto_server_frame")
        case = FIXTURES["throwingLayerSkipped"]
        sub = _Sub(case["base"])

        deferred = []

        def explode(_current):
            raise RuntimeError("buggy optimistic update")

        # Registered directly rather than through apply_optimistic_layer, which
        # refuses a transform that raises on the value it is first handed. This
        # is the other case: a layer that worked once and raises on a later
        # rebase, which the fold must survive.
        sub.optimistic_layers.append(OptimisticLayer(explode))
        apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        _run(deferred)

        self.assertEqual(len(sub.optimistic_layers), case["layers"])
        self.assertEqual(fold_optimistic(sub.server_base, sub.optimistic_layers), case["displayed"])


class TestOptimisticCommitCursor(unittest.TestCase):
    def test_layer_drops_only_once_a_frame_reaches_the_commit_cursor(self):
        covers("optimistic_layer_drops_on_commit_cursor")
        case = FIXTURES["commitCursorDrop"]
        sub = _Sub(case["base"])

        deferred = []
        handle = apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        handle.confirm(case["commitCursor"], deferred)
        _run(deferred)

        deferred = []
        _frame(sub, case["belowFrame"], deferred)
        _run(deferred)

        # Below the commit cursor: the write is NOT in the server base yet, so
        # dropping the overlay here would blink the value away and back.
        self.assertEqual(sub.last_value, case["displayedAfterBelowFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterBelowFrame"])

        deferred = []
        _frame(sub, case["atFrame"], deferred)
        _run(deferred)

        # The frame reached the commit cursor: the effect is in the base, so the
        # overlay drops without the value ever double-counting it.
        self.assertEqual(sub.last_value, case["displayedAfterAtFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterAtFrame"])

    def test_confirm_without_a_cursor_drops_without_reverting(self):
        covers("optimistic_layer_drops_on_commit_cursor")
        case = FIXTURES["confirmWithoutCursor"]
        sub = _Sub(case["base"])

        deferred = []
        handle = apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        handle.confirm(None, deferred)
        _run(deferred)

        # CDC is off on this shard, so there is no cursor to gate on. The layer
        # goes, but the display does not revert: the write DID commit.
        self.assertEqual(sub.last_value, case["displayedAfterConfirm"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterConfirm"])

    def test_a_confirmed_cursor_already_passed_drops_immediately(self):
        covers("optimistic_layer_drops_on_commit_cursor")
        case = FIXTURES["commitCursorDrop"]
        sub = _Sub(case["atFrame"]["data"])
        sub.server_cursor = case["atFrame"]["cursor"]

        deferred = []
        handle = apply_optimistic_layer(sub, _appender("x"), deferred)
        handle.confirm(case["commitCursor"], deferred)
        _run(deferred)

        # The confirming frame beat the RPC response — the common race. The
        # overlay must drop on confirm rather than linger until the next frame.
        self.assertEqual(sub.optimistic_layers, [])
        self.assertEqual(sub.last_value, case["atFrame"]["data"])


class TestOptimisticRollback(unittest.TestCase):
    def test_rollback_restores_the_server_value(self):
        covers("optimistic_layer_rolls_back_on_failure")
        case = FIXTURES["rollback"]
        seen = []
        sub = _Sub(case["base"])
        sub.callbacks.append(seen.append)

        deferred = []
        handle = apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        handle.rollback(deferred)
        _run(deferred)

        self.assertEqual(sub.last_value, case["displayedAfterRollback"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterRollback"])
        self.assertEqual(seen[-1], case["displayedAfterRollback"])

    def test_a_constant_layer_masks_concurrent_server_changes(self):
        covers("optimistic_layer_rolls_back_on_failure")
        case = FIXTURES["constantMask"]
        sub = _Sub(case["base"])
        deferred = []
        store = OptimisticLocalStore(lambda _path, _args: [sub], lambda _path: [sub], deferred)

        store.set_query("messages:list", {}, case["value"])
        _run(deferred)

        self.assertEqual(sub.last_value, case["displayedAfterApply"])
        self.assertEqual(store.get_query("messages:list", {}), case["displayedAfterApply"])

        deferred = []
        _frame(sub, case["frame"], deferred)
        _run(deferred)

        # An absolute override: while pending it re-clamps and HIDES the
        # concurrent server change rather than merging with it.
        self.assertEqual(sub.last_value, case["displayedAfterFrame"])

        deferred = []
        for rollback in store.rollbacks:
            rollback(deferred)
        _run(deferred)

        self.assertEqual(sub.last_value, case["displayedAfterRollback"])

    def test_get_all_queries_pairs_args_with_values(self):
        covers("optimistic_layer_rolls_back_on_failure")
        sub = _Sub(["a"])
        sub.args = {"channel": "general"}
        store = OptimisticLocalStore(lambda _path, _args: [sub], lambda _path: [sub], [])

        self.assertEqual(store.get_all_queries("messages:list"), [({"channel": "general"}, ["a"])])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
