"""The cursor-gated optimistic-layer engine, against the shared golden scenarios.

Every expectation is read from ``protocol/fixtures/offline-optimistic.json`` so
this port and the other six assert the same values rather than each documenting
its own behaviour.

Server frames are fed to the REAL ``LunoraClient.handle_frame``. This suite used
to fold them through a hand-copied transcription of the client's ``data`` branch,
which meant every one of these cases passed whatever the production handler did —
and a cursor bug in exactly that handler is what the ``cursorlessFrame`` case
below exists for. The client needs no network to be driven: the sender and the
HTTP poster are both injectable.
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient
from lunora.optimistic import OptimisticLayer, OptimisticLocalStore, apply_optimistic_layer
from lunora.submit import SubmitOptions
from tests._fixtures import load
from tests._manifest import covers

FIXTURES = load("offline-optimistic.json")["optimistic"]

PATH = "messages:list"
ARGS = {"channel": "general"}


def _appender(item):
    """The one transform primitive the fixtures use: push onto a COPY of the list.

    A copy, not an in-place append: a transform is re-run on every rebase, so one
    that mutated its input would compound its own effect on each server frame.
    """

    return lambda current: [*(current or []), item]


def _run(deferred):
    for call in deferred:
        call()


def _live(base, cursor=None):
    """A real client with one subscription, primed with a server value.

    Returns ``(client, subscription, seen)``. The priming frame goes through
    ``handle_frame`` like any other, so the subscription's cursor is whatever the
    production handler decided it should be.
    """

    client = LunoraClient("https://app.example")
    seen: list = []
    client.attach_socket(lambda _frame: None)
    client.subscribe(PATH, ARGS, seen.append)
    _frame(client, {"data": base} if cursor is None else {"cursor": cursor, "data": base})

    return client, client._subs["sub_1"], seen


def _frame(client, frame):
    """Feed one ``data`` frame for ``sub_1`` to the client's real dispatcher."""

    return client.handle_frame({**frame, "id": "sub_1", "type": "data"})


class TestOptimisticRebase(unittest.TestCase):
    def test_layer_rebases_onto_a_later_server_frame(self):
        covers("optimistic_layer_rebases_onto_server_frame")
        case = FIXTURES["rebase"]
        client, sub, seen = _live(case["base"])

        deferred = []
        apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        _run(deferred)

        self.assertEqual(sub.last_value, case["displayedAfterApply"])
        self.assertEqual(seen[-1], case["displayedAfterApply"])

        _frame(client, case["frame"])

        # The overlay survived the frame and was RE-FOLDED onto the new base,
        # rather than being clobbered by it.
        self.assertEqual(sub.last_value, case["displayedAfterFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterFrame"])
        self.assertEqual(seen[-1], case["displayedAfterFrame"])

    def test_a_throwing_layer_is_skipped_not_fatal(self):
        covers("optimistic_layer_rebases_onto_server_frame")
        case = FIXTURES["throwingLayerSkipped"]
        client, sub, seen = _live(case["base"])

        def explode(_current):
            raise RuntimeError("buggy optimistic update")

        # Registered directly rather than through apply_optimistic_layer, which
        # refuses a transform that raises on the value it is first handed. This
        # is the other case: a layer that worked once and raises on a later
        # rebase, which the fold must survive.
        sub.optimistic_layers.append(OptimisticLayer(explode))

        deferred = []
        apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        _run(deferred)

        _frame(client, {"data": case["base"]})

        self.assertEqual(len(sub.optimistic_layers), case["layers"])
        self.assertEqual(seen[-1], case["displayed"])


class TestOptimisticCommitCursor(unittest.TestCase):
    def test_layer_drops_only_once_a_frame_reaches_the_commit_cursor(self):
        covers("optimistic_layer_drops_on_commit_cursor")
        case = FIXTURES["commitCursorDrop"]
        client, sub, _seen = _live(case["base"])

        deferred = []
        handle = apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        handle.confirm(case["commitCursor"], deferred)
        _run(deferred)

        _frame(client, case["belowFrame"])

        # Below the commit cursor: the write is NOT in the server base yet, so
        # dropping the overlay here would blink the value away and back.
        self.assertEqual(sub.last_value, case["displayedAfterBelowFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterBelowFrame"])

        _frame(client, case["atFrame"])

        # The frame reached the commit cursor: the effect is in the base, so the
        # overlay drops without the value ever double-counting it.
        self.assertEqual(sub.last_value, case["displayedAfterAtFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterAtFrame"])

    def test_confirm_without_a_cursor_drops_without_reverting(self):
        covers("optimistic_layer_drops_on_commit_cursor")
        case = FIXTURES["confirmWithoutCursor"]
        _client, sub, _seen = _live(case["base"])

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
        _client, sub, _seen = _live(case["atFrame"]["data"], cursor=case["atFrame"]["cursor"])

        deferred = []
        handle = apply_optimistic_layer(sub, _appender("x"), deferred)
        handle.confirm(case["commitCursor"], deferred)
        _run(deferred)

        # The confirming frame beat the RPC response — the common race. The
        # overlay must drop on confirm rather than linger until the next frame.
        self.assertEqual(sub.optimistic_layers, [])
        self.assertEqual(sub.last_value, case["atFrame"]["data"])

    def test_a_cursorless_frame_leaves_the_tracked_cursor_alone(self):
        covers("optimistic_cursorless_frame_preserves_cursor")
        case = FIXTURES["cursorlessFrame"]
        client, sub, seen = _live(case["base"])

        deferred = []
        handle = apply_optimistic_layer(sub, _appender(case["appended"]), deferred)
        _run(deferred)

        _frame(client, case["cursoredFrame"])
        _frame(client, case["cursorlessFrame"])

        # `cursor` is OPTIONAL on a data frame. Nulling the tracked cursor here
        # strands the layer: the confirm below compares against it, so the
        # overlay would survive its own commit and render the write twice.
        self.assertEqual(sub.server_cursor, case["cursorAfterCursorlessFrame"])
        self.assertEqual(sub.last_value, case["displayedAfterCursorlessFrame"])
        self.assertEqual(seen[-1], case["displayedAfterCursorlessFrame"])
        self.assertEqual(len(sub.optimistic_layers), case["layersAfterCursorlessFrame"])

        deferred = []
        handle.confirm(case["commitCursor"], deferred)
        _run(deferred)

        self.assertEqual(len(sub.optimistic_layers), case["layersAfterConfirm"])


class TestOptimisticRollback(unittest.TestCase):
    def test_rollback_restores_the_server_value(self):
        covers("optimistic_layer_rolls_back_on_failure")
        case = FIXTURES["rollback"]
        _client, sub, seen = _live(case["base"])

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
        client, sub, seen = _live(case["base"])
        client.detach_socket()

        # Driven through the real write path: the local store records the
        # override with the client's lock RELEASED and the client installs it.
        outcome = asyncio.run(
            client.submit(
                SubmitOptions(
                    args=ARGS,
                    function_path=PATH,
                    optimistic_update=lambda store, _args: store.set_query(PATH, ARGS, case["value"]),
                )
            )
        )

        self.assertTrue(outcome.queued)
        self.assertEqual(sub.last_value, case["displayedAfterApply"])

        _frame(client, case["frame"])

        # An absolute override: while pending it re-clamps and HIDES the
        # concurrent server change rather than merging with it.
        self.assertEqual(sub.last_value, case["displayedAfterFrame"])

        # Closing hands every queued write back, which rolls its layers off.
        client.close()

        self.assertEqual(sub.last_value, case["displayedAfterRollback"])
        self.assertEqual(seen[-1], case["displayedAfterRollback"])

    def test_the_store_reads_back_what_this_batch_wrote(self):
        covers("optimistic_layer_rolls_back_on_failure")
        _client, sub, _seen = _live(["a"])
        sub.args = ARGS
        store = OptimisticLocalStore(lambda _path, _args: [sub], lambda _path: [sub])

        self.assertEqual(store.get_all_queries(PATH), [(ARGS, ["a"])])

        store.set_query(PATH, ARGS, ["z"])

        # Recorded, not installed — but a second read in the same callback must
        # still see it, or a multi-step update composes onto a stale value.
        self.assertEqual(store.get_query(PATH, ARGS), ["z"])
        self.assertEqual(store.get_all_queries(PATH), [(ARGS, ["z"])])
        self.assertEqual(sub.last_value, ["a"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
