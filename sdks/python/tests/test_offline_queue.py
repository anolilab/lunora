"""The durable offline write queue, against the shared golden scenarios.

Every ordering and every code is read from
``protocol/fixtures/offline-optimistic.json``, so a port that disagrees with the
other six fails rather than quietly documenting a second behaviour.
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient, LunoraError
from lunora.offline import (
    ABSENT_IDENTITY,
    OfflineQueue,
    QueuedMutation,
    identity_allows_replay,
    is_stale_version,
    random_id,
)
from tests._fixtures import load
from tests._manifest import covers

FIXTURES = load("offline-optimistic.json")["offlineQueue"]


class _Store:
    """An in-memory persistence adapter that records every call."""

    def __init__(self, records=None):
        self.records = list(records or [])
        self.appended = []
        self.removed = []
        self.cleared = 0

    def append(self, record):
        self.appended.append(record)
        self.records.append(record)

    def load(self):
        return list(self.records)

    def remove(self, mutation_id):
        self.removed.append(mutation_id)
        self.records = [record for record in self.records if record.get("id") != mutation_id]

    def clear(self):
        self.cleared += 1
        self.records = []


def _entry(mutation_id, shard_key=None, precondition=None, identity=ABSENT_IDENTITY):
    return QueuedMutation(
        args={"n": mutation_id},
        function_path="messages:send",
        identity=identity,
        mutation_id=mutation_id,
        precondition=precondition,
        shard_key=shard_key,
    )


def _ids(items):
    return [item.id for item in items]


def _discarded(items):
    """The (id, code) pairs a queue reported letting go of."""

    return [(item.entry.id, item.code) for item in items]


class TestQueueOrdering(unittest.TestCase):
    def test_writes_drain_in_submission_order(self):
        covers("offline_queue_fifo_and_shard_drain")
        case = FIXTURES["fifo"]
        sizes = []
        queue = OfflineQueue(on_size_change=sizes.append)

        for mutation_id in case["enqueue"]:
            queue.enqueue(_entry(mutation_id))

        self.assertEqual(queue.size, case["sizeAfterEnqueue"])
        self.assertEqual(_ids(queue.drain()), case["drained"])
        self.assertEqual(queue.size, case["sizeAfterDrain"])
        self.assertEqual(sizes[-1], case["sizeAfterDrain"])

    def test_a_predicate_drain_flushes_one_shard_and_leaves_the_rest(self):
        covers("offline_queue_fifo_and_shard_drain")
        case = FIXTURES["shardDrain"]
        queue = OfflineQueue()

        for spec in case["entries"]:
            queue.enqueue(_entry(spec["id"], shard_key=spec["shardKey"]))

        key = case["drainShardKey"] or ""
        drained = queue.drain(lambda item: (item.shard_key or "") == key)

        self.assertEqual(_ids(drained), case["drained"])
        self.assertEqual(_ids(queue.items()), case["remaining"])

    def test_requeue_returns_writes_to_the_front_without_re_persisting(self):
        covers("offline_queue_fifo_and_shard_drain")
        case = FIXTURES["requeue"]
        store = _Store()
        queue = OfflineQueue(persistence=store)

        for mutation_id in case["enqueue"]:
            queue.enqueue(_entry(mutation_id))

        drained = queue.drain()
        queue.requeue([item for item in drained if item.id in case["requeued"]])

        self.assertEqual(_ids(queue.items()), case["queuedAfterRequeue"])
        # Durable storage still holds them — they were never un-persisted, so a
        # re-append would duplicate the record.
        self.assertEqual(len(store.appended), case["persistAppendCalls"])


class TestQueueOverflow(unittest.TestCase):
    def test_overflow_evicts_the_oldest_write(self):
        covers("offline_queue_overflow_evicts_oldest")
        case = FIXTURES["overflow"]
        evicted = []
        store = _Store()
        queue = OfflineQueue(max_items=case["maxItems"], persistence=store)

        for mutation_id in case["enqueue"]:
            evicted.extend(queue.enqueue(_entry(mutation_id)))

        self.assertEqual(_ids(queue.items()), case["remaining"])
        # Returned, not rejected in place: the caller settles it once it has
        # released its lock. A hydrated entry has no live caller at all, so this
        # is the only thing standing between an eviction and a durable write
        # disappearing in silence.
        self.assertEqual(_discarded(evicted), [(case["evicted"][0], case["code"])])
        self.assertEqual(store.removed, case["persistRemoveCalls"])

    def test_close_rejects_every_queued_write_but_keeps_the_durable_records(self):
        covers("offline_queue_overflow_evicts_oldest")
        case = FIXTURES["clear"]
        store = _Store()
        queue = OfflineQueue(persistence=store)

        for mutation_id in case["enqueue"]:
            queue.enqueue(_entry(mutation_id))

        discarded = queue.clear()

        self.assertEqual(_discarded(discarded), [(mutation_id, case["code"]) for mutation_id in case["rejected"]])
        self.assertEqual(queue.size, 0)
        # Closing must NOT discard writes the next session will restore.
        self.assertEqual(store.removed, case["persistRemoveCalls"])
        self.assertEqual(len(store.records), len(case["enqueue"]))


class TestQueuePrecondition(unittest.TestCase):
    def test_a_stale_write_is_dropped_before_it_replays(self):
        covers("offline_queue_precondition_drops_stale_write")
        case = FIXTURES["precondition"]
        queue = OfflineQueue()

        for spec in case["entries"]:
            verdict = spec["precondition"]
            queue.enqueue(_entry(spec["id"], precondition=lambda held=verdict: held))

        conflicted = queue.drain_conflict()

        self.assertEqual(_discarded(conflicted), [(mutation_id, case["code"]) for mutation_id in case["conflicted"]])
        self.assertEqual(_ids(queue.items()), case["remaining"])


class TestQueueHydration(unittest.TestCase):
    def test_restored_writes_land_ahead_of_boot_time_writes(self):
        covers("offline_queue_hydrates_persisted_writes")
        case = FIXTURES["hydrate"]
        store = _Store(
            [
                {"args": {}, "functionPath": "messages:send", "id": spec["id"], "shardKey": spec["shardKey"], "version": spec["version"]}
                for spec in case["persisted"]
            ]
        )
        queue = OfflineQueue(persistence=store, version=case["version"])

        # Submitted during the boot window, BEFORE the durable load returns.
        for mutation_id in case["liveEnqueue"]:
            queue.enqueue(_entry(mutation_id))

        shard_keys, evicted = queue.hydrate()

        self.assertEqual(evicted, [], "nothing exceeded the default capacity")
        # The durable store's order is authoritative: a prior-session write is
        # always older, so replaying the boot-time write first would let
        # last-writer-wins clobber newer data with stale.
        self.assertEqual(_ids(queue.items()), case["queuedAfterHydrate"])
        # A record stamped under another app version is dropped AND purged.
        self.assertEqual(store.removed, case["purged"])
        self.assertEqual(sorted(shard_keys, key=str), sorted(case["shardKeys"], key=str))

    def test_hydration_respects_the_capacity_cap(self):
        covers("offline_queue_hydrates_persisted_writes")
        case = FIXTURES["hydrateOverflow"]
        store = _Store(
            [
                {"args": {}, "functionPath": "messages:send", "id": spec["id"], "shardKey": spec["shardKey"], "version": spec["version"]}
                for spec in case["persisted"]
            ]
        )
        queue = OfflineQueue(max_items=case["maxItems"], persistence=store, version=case["version"])

        shard_keys, evicted = queue.hydrate()

        self.assertEqual(_ids(queue.items()), case["queuedAfterHydrate"])
        self.assertEqual([item.entry.id for item in evicted], case["evicted"])
        # Only the shards whose writes SURVIVED — a key gathered before eviction
        # would send the caller to open a socket with nothing queued behind it.
        self.assertEqual(sorted(shard_keys, key=str), sorted(case["shardKeys"], key=str))

    def test_version_gating_is_off_until_a_version_is_configured(self):
        covers("offline_queue_hydrates_persisted_writes")
        self.assertFalse(is_stale_version(None, None))
        self.assertFalse(is_stale_version(None, "v1"))
        self.assertTrue(is_stale_version("v2", None))
        self.assertTrue(is_stale_version("v2", "v1"))
        self.assertFalse(is_stale_version("v2", "v2"))

    def test_ids_do_not_collide(self):
        covers("offline_queue_hydrates_persisted_writes")
        # Two anonymous clients that collided on an id would share one
        # de-duplication namespace server-side, letting one suppress the other.
        self.assertEqual(len({random_id() for _ in range(2000)}), 2000)


class TestIdentityGate(unittest.TestCase):
    def test_a_write_only_replays_under_the_identity_that_made_it(self):
        covers("offline_queue_identity_gate_rejects_replay")
        case = FIXTURES["identityGate"]

        for spec in case["cases"]:
            stamped = ABSENT_IDENTITY if spec["stamped"] == "absent" else spec["stamped"]

            with self.subTest(spec["name"]):
                self.assertEqual(identity_allows_replay(stamped, spec["current"]), spec["replays"])

    def test_flush_rejects_a_write_stamped_under_another_identity(self):
        covers("offline_queue_identity_gate_rejects_replay")
        case = FIXTURES["identityGate"]
        posts = []

        def post(_url, headers, _body):
            posts.append(headers)
            return 200, {"result": None}

        settled = []
        client = LunoraClient("https://app.example", http_post=post, identity="user-b")
        client.on_mutation_settled(settled.append)
        client.offline_queue.enqueue(
            QueuedMutation(
                args={},
                function_path="messages:send",
                identity="user-a",
                mutation_id="m1",
                reject=lambda error: settled.append(error),
                shard_key=None,
            )
        )

        report = asyncio.run(client.flush_offline_queue())

        self.assertEqual(report.rejected, ["m1"])
        self.assertEqual(report.committed, [])
        # Nothing reached the wire: a restart must not push the previous user's
        # queued writes as the current one.
        self.assertEqual(posts, [])
        self.assertEqual(getattr(settled[0], "code", None), case["code"])


class TestFlushIntegration(unittest.TestCase):
    def test_a_flush_replays_in_order_and_confirms_the_optimistic_overlay(self):
        covers("offline_flush_replays_and_confirms_optimistic")
        case = FIXTURES["flushReplay"]
        by_id = {spec["id"]: spec for spec in case["responses"]}
        seen_headers = []

        def post(_url, headers, _body):
            mutation_id = headers["x-lunora-mutation-id"]
            seen_headers.append(mutation_id)
            spec = by_id[mutation_id]

            if spec["outcome"] == "transport-error":
                raise OSError("connection reset")
            if spec["outcome"] == "coded-error":
                return 200, {"error": {"code": spec["code"], "message": "gone"}}

            return 200, {"commitCursor": spec["commitCursor"], "result": {"ok": True}}

        store = _Store()
        settled = []
        client = LunoraClient("https://app.example", client_id="client-1", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)
        client.on_mutation_settled(settled.append)

        confirmed = []
        for mutation_id in case["queued"]:
            client.offline_queue.enqueue(
                QueuedMutation(
                    args={},
                    client_id="client-1",
                    function_path="messages:send",
                    mutation_id=mutation_id,
                    on_commit=lambda cursor, mid=mutation_id: confirmed.append((mid, cursor)),
                    reject=lambda _error: None,
                    resolve=lambda _value: None,
                )
            )

        report = asyncio.run(client.flush_offline_queue())

        # Replayed in FIFO order, each under its own idempotency key so a write
        # the server already committed is de-duplicated rather than re-applied.
        self.assertEqual(seen_headers, case["mutationIdHeaders"])
        self.assertEqual(report.committed, case["committed"])
        # A coded verdict is terminal: replaying it would only re-trigger the
        # same failure. A transport failure is not, so that write stays queued.
        self.assertEqual(report.rejected, case["rejected"])
        self.assertEqual(_ids(client.offline_queue.items()), case["queuedAfterFlush"])
        self.assertEqual(report.requeued, case["queuedAfterFlush"])
        self.assertEqual(store.removed, case["persistRemoveCalls"])
        self.assertEqual(confirmed, [(case["committed"][0], case["confirmedCommitCursor"])])

    def test_a_transient_shard_code_requeues_instead_of_dropping(self):
        covers("offline_flush_replays_and_confirms_optimistic")

        def post(_url, _headers, _body):
            return 200, {"error": {"code": "SHARD_UNAVAILABLE", "message": "restarting"}}

        client = LunoraClient("https://app.example", http_post=post)
        client.offline_queue.enqueue(QueuedMutation(args={}, function_path="messages:send", mutation_id="m1"))

        report = asyncio.run(client.flush_offline_queue())

        # The shard blinked; the identical call is expected to succeed later, so
        # dropping the write here would lose it to a transient condition.
        self.assertEqual(report.requeued, ["m1"])
        self.assertEqual(_ids(client.offline_queue.items()), ["m1"])

    def test_a_write_made_offline_is_queued_with_its_optimistic_overlay(self):
        covers("offline_flush_replays_and_confirms_optimistic")
        posts = []

        def post(_url, headers, _body):
            posts.append(headers)
            return 200, {"commitCursor": 4, "result": {"ok": True}}

        seen = []
        client = LunoraClient("https://app.example", http_post=post)
        client.attach_socket(lambda _frame: None)
        client.subscribe("messages:list", {"channel": "general"}, seen.append)
        # Prime the subscription with a server value, then drop the socket.
        client.handle_frame({"cursor": 1, "data": ["a"], "id": "sub_1", "type": "data"})
        client.detach_socket()

        outcome = asyncio.run(
            client.submit(
                "messages:list",
                {"channel": "general"},
                optimistic=lambda current: [*(current or []), "c"],
            )
        )

        self.assertEqual(outcome.status, "queued")
        self.assertEqual(seen[-1], ["a", "c"])
        self.assertEqual(client.pending_mutation_count, 1)
        # Queued, not sent: nothing may reach the wire while the socket is down.
        self.assertEqual(posts, [])

        client.attach_socket(lambda _frame: None)
        asyncio.run(client.flush_offline_queue())

        self.assertEqual(len(posts), 1)
        self.assertEqual(client.pending_mutation_count, 0)
        # Still displayed: the overlay is confirmed at cursor 4 and drops only
        # once a frame reaches it.
        self.assertEqual(seen[-1], ["a", "c"])

        client.handle_frame({"cursor": 4, "data": ["a", "c"], "id": "sub_1", "type": "data"})

        self.assertEqual(seen[-1], ["a", "c"])

    def test_a_write_before_the_first_connect_fails_fast_by_default(self):
        covers("offline_flush_replays_and_confirms_optimistic")

        def post(_url, _headers, _body):
            raise OSError("no route to host")

        client = LunoraClient("https://app.example", http_post=post)

        # Never connected and the opt-in is off, so a misconfigured endpoint
        # surfaces on the first write rather than silently filling a queue that
        # will never flush.
        with self.assertRaises(OSError):
            asyncio.run(client.submit("messages:send", {"text": "hi"}))

        self.assertEqual(client.pending_mutation_count, 0)

        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        outcome = asyncio.run(client.submit("messages:send", {"text": "hi"}))

        self.assertEqual(outcome.status, "queued")
        self.assertEqual(client.pending_mutation_count, 1)

    def test_an_overflow_during_submit_settles_rather_than_re_entering_the_lock(self):
        covers("offline_flush_replays_and_confirms_optimistic")
        case = FIXTURES["overflow"]
        settled = []

        client = LunoraClient("https://app.example", http_post=lambda _url, _headers, _body: (200, {"result": None}))
        client.offline_queue = OfflineQueue(max_items=case["maxItems"], queue_before_first_connect=True)
        client.on_mutation_settled(settled.append)

        for _ in range(len(case["enqueue"])):
            asyncio.run(client.submit("messages:send", {}))

        # The queue evicts while the client holds its own lock, and settling the
        # evicted write rolls optimistic layers back — which re-acquires it. The
        # queue therefore RETURNS what it dropped rather than rejecting in place;
        # doing the latter self-deadlocked the Go port and had the Ruby one
        # swallow the verdict entirely.
        self.assertEqual([event.status for event in settled], ["rejected"])
        self.assertEqual(getattr(settled[0].error, "code", None), case["code"])
        self.assertEqual(client.pending_mutation_count, case["maxItems"])

    def test_a_failed_online_write_rolls_its_overlay_back(self):
        covers("offline_flush_replays_and_confirms_optimistic")

        def post(_url, _headers, _body):
            return 200, {"error": {"code": "NOT_FOUND", "message": "gone"}}

        seen = []
        client = LunoraClient("https://app.example", http_post=post)
        client.attach_socket(lambda _frame: None)
        client.subscribe("messages:list", {}, seen.append)
        client.handle_frame({"cursor": 1, "data": ["a"], "id": "sub_1", "type": "data"})

        with self.assertRaises(LunoraError):
            asyncio.run(client.submit("messages:list", {}, optimistic=lambda current: [*(current or []), "c"]))

        self.assertEqual(seen[-1], ["a"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
