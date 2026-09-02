"""The durable offline write queue, against the shared golden scenarios.

Every ordering and every code is read from
``protocol/fixtures/offline-optimistic.json``, so a port that disagrees with the
other six fails rather than quietly documenting a second behaviour.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient
from lunora.errors import LunoraError
from lunora.offline import (
    ABSENT_IDENTITY,
    OfflineQueue,
    QueuedMutation,
    identity_allows_replay,
    is_stale_version,
    random_id,
)
from lunora.submit import SubmitOptions
from lunora.wire import WireBigInt, WireBytes, WireDate
from tests._fixtures import load
from tests._manifest import covers

FIXTURES = load("offline-optimistic.json")["offlineQueue"]


class _Store:
    """An in-memory persistence adapter that records every call.

    It JSON round-trips every record, which an adapter holding the objects by
    reference does not — and that is the whole point: a file, a SQLite text
    column or a preferences store all serialise, so a record carrying the codec's
    native wrappers either raises here or is written as something that does not
    read back. Holding references made this suite blind to both.
    """

    def __init__(self, records=None):
        self.records = [json.loads(json.dumps(record)) for record in (records or [])]
        self.appended = []
        self.removed = []
        self.cleared = 0

    def append(self, record):
        serialised = json.loads(json.dumps(record))
        self.appended.append(serialised)
        self.records.append(serialised)

    def load(self):
        return [json.loads(json.dumps(record)) for record in self.records]

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
        covers("offline_queue_fifo_replay_order")
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
        covers("offline_queue_drains_only_the_named_shard")
        case = FIXTURES["shardDrain"]
        queue = OfflineQueue()

        for spec in case["entries"]:
            queue.enqueue(_entry(spec["id"], shard_key=spec["shardKey"]))

        key = case["drainShardKey"] or ""
        drained = queue.drain(lambda item: (item.shard_key or "") == key)

        self.assertEqual(_ids(drained), case["drained"])
        self.assertEqual(_ids(queue.items()), case["remaining"])

    def test_requeue_returns_writes_to_the_front_without_re_persisting(self):
        covers("offline_queue_fifo_replay_order")
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

    def test_a_zero_capacity_is_clamped_to_one(self):
        covers("offline_queue_overflow_evicts_oldest")
        queue = OfflineQueue(max_items=0)

        # Taken literally, a cap of zero accepts a write and evicts it in the
        # same call: every submit reports "queued" and then settles OVERFLOW.
        self.assertEqual(queue.enqueue(_entry("m1")), [])
        self.assertEqual(_ids(queue.items()), ["m1"])

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

        # The client evaluates the consumer's predicates with its lock RELEASED
        # and hands the queue only the ids that failed, so no consumer code runs
        # inside the critical section the queue is mutated from.
        stale = {item.id for item in queue.items() if item.precondition is not None and not item.precondition()}
        conflicted = queue.drain_conflict(stale)

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

    def test_a_hydrated_write_the_cap_evicts_is_reported_to_the_client(self):
        covers("offline_queue_hydrate_overflow_settles_discarded")
        case = FIXTURES["hydrateOverflow"]
        store = _Store(
            [
                {"args": {}, "functionPath": "messages:send", "id": spec["id"], "shardKey": spec["shardKey"], "version": spec["version"]}
                for spec in case["persisted"]
            ]
        )
        settled = []
        # Driven through the CLIENT, not the queue: a restored entry has no
        # settle handler of its own, so a client that reported discards only
        # through one would un-persist this write and report it to nobody.
        client = LunoraClient("https://app.example")
        client.offline_queue = OfflineQueue(max_items=case["maxItems"], persistence=store, version=case["version"])
        client.on_mutation_settled(settled.append)

        shard_keys = client.hydrate_offline_queue()

        self.assertEqual(_ids(client.offline_queue.items()), case["queuedAfterHydrate"])
        self.assertEqual(sorted(shard_keys, key=str), sorted(case["shardKeys"], key=str))
        self.assertEqual([event.mutation_id for event in settled], case["settledFromClient"])
        self.assertEqual(settled[0].status, "rejected")
        self.assertEqual(settled[0].error.code, case["settledCode"])
        # Read from the entry's own live_awaiter, which is what tells a consumer
        # this is a restored write's ONLY report rather than a second one.
        self.assertEqual(settled[0].had_awaiter, case["settledHadAwaiter"])

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
                shard_key=None,
            )
        )

        report = asyncio.run(client.flush_offline_queue())

        self.assertEqual(report.rejected, ["m1"])
        self.assertEqual(report.committed, [])
        # Nothing reached the wire: a restart must not push the previous user's
        # queued writes as the current one.
        self.assertEqual(posts, [])
        self.assertEqual(settled[0].error.code, case["code"])


class TestFlushIntegration(unittest.TestCase):
    def test_a_flush_replays_in_order_and_confirms_the_optimistic_overlay(self):
        covers("offline_flush_replays_and_confirms_optimistic")
        case = FIXTURES["flushReplay"]
        seen_ids = []

        # The three fixture outcomes, as this transport now expresses them. Three
        # queued writes coalesce into ONE batch hop, so `ok` and `coded-error`
        # are slots and `transport-error` is an ABSENT slot: a per-entry
        # transport failure is the server not answering for that entry, and an
        # unanswered write is retried under its original idempotency key exactly
        # as an uncoded throw re-queues on the single-call path.
        def post(_url, _headers, body):
            calls = json.loads(body)["calls"]
            seen_ids.extend(call["mutationId"] for call in calls)
            results = []

            for index, spec in enumerate(case["responses"]):
                if spec["outcome"] == "coded-error":
                    results.append({"body": {"error": {"code": spec["code"], "message": "gone"}}, "id": index})
                elif spec["outcome"] == "ok":
                    results.append({"body": {"commitCursor": spec["commitCursor"], "result": {"ok": True}}, "id": index})

            return 200, {"results": results}

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
                    # The layer handles ride on the entry as DATA; the settle
                    # site confirms them against the echoed cursor.
                    confirms=[lambda cursor, _deferred, mid=mutation_id: confirmed.append((mid, cursor))],
                    function_path="messages:send",
                    mutation_id=mutation_id,
                )
            )

        report = asyncio.run(client.flush_offline_queue())

        # Replayed in FIFO order, each under its own idempotency key so a write
        # the server already committed is de-duplicated rather than re-applied.
        self.assertEqual(seen_ids, case["mutationIdHeaders"])
        self.assertEqual(report.committed, case["committed"])
        # A coded verdict is terminal: replaying it would only re-trigger the
        # same failure. A transport failure is not, so that write stays queued.
        self.assertEqual(report.rejected, case["rejected"])
        self.assertEqual(_ids(client.offline_queue.items()), case["queuedAfterFlush"])
        self.assertEqual(report.requeued, case["queuedAfterFlush"])
        self.assertEqual(store.removed, case["persistRemoveCalls"])
        self.assertEqual(confirmed, [(case["committed"][0], case["confirmedCommitCursor"])])

    def test_two_or_more_writes_coalesce_into_one_batch_round_trip(self):
        covers("offline_flush_batches_multiple_writes")
        case = FIXTURES["batchReplay"]
        urls = []
        calls = []

        def post(url, _headers, body):
            urls.append(url)
            calls.extend(json.loads(body)["calls"])
            results = []

            for slot in case["slots"]:
                if slot["outcome"] == "ok":
                    results.append({"body": {"commitCursor": slot["commitCursor"], "result": None}, "id": slot["id"]})
                else:
                    results.append({"body": {"error": {"code": slot["code"], "message": "slot failed"}}, "id": slot["id"]})

            return 200, {"results": results}

        store = _Store()
        client = LunoraClient("https://app.example", client_id="c-1", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)

        confirmed = []
        for mutation_id in case["queued"]:
            client.offline_queue.enqueue(
                QueuedMutation(
                    args={},
                    confirms=[lambda cursor, _deferred, mid=mutation_id: confirmed.append((mid, cursor))],
                    function_path="messages:send",
                    mutation_id=mutation_id,
                )
            )

        report = asyncio.run(client.flush_offline_queue())

        self.assertEqual(len(urls), case["requests"])
        self.assertTrue(urls[0].endswith(case["path"]))
        # The idempotency key and the client id ride in the ENTRY, not in a
        # request header: a batch is one hop carrying independent calls, and a
        # single outer header would de-duplicate the whole chunk against one id.
        self.assertEqual(
            [{"clientId": c["clientId"], "functionPath": c["functionPath"], "id": c["id"], "mutationId": c["mutationId"]} for c in calls],
            case["calls"],
        )
        self.assertEqual(report.committed, case["committed"])
        # A transient shard code in a slot is not a verdict, so that write goes
        # back on the queue instead of being reported as failed — and so does the
        # slot the server never returned at all.
        self.assertEqual(report.rejected, case["rejected"])
        self.assertEqual(_ids(client.offline_queue.items()), case["queuedAfterFlush"])
        self.assertEqual(store.removed, case["persistRemoveCalls"])
        self.assertEqual(confirmed, [(case["committed"][0], case["confirmedCommitCursor"])])

    def test_an_unencodable_write_settles_terminally_instead_of_looping(self):
        covers("offline_flush_unencodable_write_settles_terminal")
        case = FIXTURES["unencodableWrite"]
        seen_headers = []

        def post(_url, headers, _body):
            seen_headers.append(headers["x-lunora-mutation-id"])
            return 200, {"commitCursor": 7, "result": {"ok": True}}

        store = _Store()
        settled = []
        client = LunoraClient("https://app.example", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)
        client.on_mutation_settled(settled.append)

        unencodable = set(case["unencodable"])
        for mutation_id in case["queued"]:
            client.offline_queue.enqueue(
                QueuedMutation(
                    # `object()` has no wire representation, so encode_wire raises
                    # a TypeError — which carries no code and would therefore be
                    # classified transient and re-queued at the FRONT forever.
                    args={"payload": object()} if mutation_id in unencodable else {},
                    function_path="messages:send",
                    mutation_id=mutation_id,
                )
            )

        report = asyncio.run(client.flush_offline_queue())

        # Never sent, so it cannot block the writes behind it in the FIFO.
        self.assertEqual(seen_headers, case["mutationIdHeaders"])
        self.assertEqual(report.rejected, case["rejected"])
        self.assertEqual(report.committed, case["committed"])
        self.assertEqual(report.requeued, [])
        self.assertEqual(_ids(client.offline_queue.items()), case["queuedAfterFlush"])
        self.assertEqual(store.removed, case["persistRemoveCalls"])
        self.assertEqual([event.mutation_id for event in settled], case["unencodable"] + case["committed"])
        self.assertEqual(settled[0].error.code, case["code"])

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
                SubmitOptions(
                    args={"channel": "general"},
                    function_path="messages:list",
                    optimistic=lambda current: [*(current or []), "c"],
                )
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
        # The replay is namespaced under the id that ISSUED the write, which is
        # this instance's minted one rather than a per-language constant.
        self.assertEqual(posts[0]["x-lunora-client-id"], client.client_id)
        self.assertEqual(client.pending_mutation_count, 0)
        # Still displayed: the overlay is confirmed at cursor 4 and drops only
        # once a frame reaches it.
        self.assertEqual(seen[-1], ["a", "c"])

        client.handle_frame({"cursor": 4, "data": ["a", "c"], "id": "sub_1", "type": "data"})

        self.assertEqual(seen[-1], ["a", "c"])

    def test_an_empty_shard_key_never_reaches_the_wire(self):
        covers("offline_flush_replays_and_confirms_optimistic")
        posts = []

        def post(_url, headers, body):
            posts.append((headers, json.loads(body.decode("utf-8"))))
            return 200, {"result": None}

        client = LunoraClient("https://app.example", http_post=post)
        client.attach_socket(lambda _frame: None)
        client.detach_socket()

        outcome = asyncio.run(client.submit(SubmitOptions(args={}, function_path="messages:send", shard_key="")))

        self.assertTrue(outcome.queued)

        client.attach_socket(lambda _frame: None)
        report = asyncio.run(client.flush_offline_queue())

        # `""` and None are ONE shard to this client — it drains on the default
        # shard's flush — but the runtime takes any string as a NAMED shard and
        # routes `""` to its own Durable Object. Sending it would replay the
        # write against a different shard than the subscription it updated,
        # which is worse than the missed flush the normalisation replaced.
        self.assertEqual(report.committed, [outcome.mutation_id])
        self.assertNotIn("shardKey", posts[0][1])
        self.assertNotIn("shard=", client.ws_url_for("", None))

        # A shard genuinely NAMED "0" is truthy and still goes out.
        asyncio.run(client.mutation("messages:send", {}, shard_key="0"))

        self.assertEqual(posts[-1][1]["shardKey"], "0")
        self.assertIn("shard=0", client.ws_url_for("0", None))

    def test_a_write_before_the_first_connect_fails_fast_by_default(self):
        covers("offline_flush_replays_and_confirms_optimistic")

        def post(_url, _headers, _body):
            raise OSError("no route to host")

        client = LunoraClient("https://app.example", http_post=post)

        # Never connected and the opt-in is off, so a misconfigured endpoint
        # surfaces on the first write rather than silently filling a queue that
        # will never flush.
        with self.assertRaises(OSError):
            asyncio.run(client.submit(SubmitOptions(args={"text": "hi"}, function_path="messages:send")))

        self.assertEqual(client.pending_mutation_count, 0)

        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        outcome = asyncio.run(client.submit(SubmitOptions(args={"text": "hi"}, function_path="messages:send")))

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
            asyncio.run(client.submit(SubmitOptions(args={}, function_path="messages:send")))

        # The queue evicts while the client holds its own lock, and settling the
        # evicted write rolls optimistic layers back — which re-acquires it. The
        # queue therefore RETURNS what it dropped rather than rejecting in place;
        # doing the latter self-deadlocked the Go port and had the Ruby one
        # swallow the verdict entirely.
        self.assertEqual([event.status for event in settled], ["rejected"])
        self.assertEqual(getattr(settled[0].error, "code", None), case["code"])
        self.assertEqual(client.pending_mutation_count, case["maxItems"])

    def test_a_queued_write_with_typed_args_survives_a_serialising_store(self):
        covers("offline_queue_hydrates_persisted_writes")

        # Every one of these is a native wrapper the codec understands and
        # `json.dumps` does not. Persisting the native form reported the write
        # "queued" while the adapter raised and nothing durable was written.
        args = {"amount": WireBigInt(7), "blob": WireBytes(b"\x01\x02\x03\x04", "Int32Array"), "when": WireDate(1700000000000)}
        store = _Store()
        queue = OfflineQueue(persistence=store)
        errors = []
        queue.on_persistence_error = lambda operation, _error, mutation_id: errors.append((operation, mutation_id))

        queue.enqueue(QueuedMutation(args=args, function_path="ledger:add", mutation_id="m-typed"))

        self.assertEqual(errors, [], "the record must serialise, so nothing is reported as a failed append")
        self.assertEqual(store.appended[0]["args"]["amount"], ["$lunora.wire$", "bigint", "7"])

        restored = OfflineQueue(persistence=store)
        restored.hydrate()

        self.assertEqual(_ids(restored.items()), ["m-typed"])
        # Decoded back to the SAME native values, so the replay sends the write
        # that was made rather than whatever the adapter's stringification left.
        self.assertEqual(restored.items()[0].args, args)

    def test_a_persisted_record_that_cannot_be_decoded_settles_rejected(self):
        covers("offline_queue_hydrates_persisted_writes")

        # A wire tag with no payload: the store was corrupted, or written by an
        # incompatible build. Replaying it with substitute args would commit a
        # DIFFERENT write than the caller made, which is corruption rather than
        # failure.
        store = _Store([{"args": {"amount": ["$lunora.wire$", "bigint", "not-a-number"]}, "functionPath": "ledger:add", "id": "m-bad"}])
        settled = []
        client = LunoraClient("https://app.example")
        client.offline_queue = OfflineQueue(persistence=store)
        client.on_mutation_settled(settled.append)

        client.hydrate_offline_queue()

        self.assertEqual(_ids(client.offline_queue.items()), [])
        self.assertEqual([(event.mutation_id, event.status, event.error.code) for event in settled], [("m-bad", "rejected", "OFFLINE_WRITE_UNDECODABLE")])
        self.assertEqual(store.removed, ["m-bad"], "the unreadable record is purged, not left to fail every restart")

    def test_a_batch_the_worker_refuses_for_size_is_split_and_retried(self):
        covers("offline_flush_batch_splits_on_payload_too_large")

        # The worker reads a batch body under a 1 MiB budget
        # (packages/runtime/src/body-readers.ts) and answers 413
        # PAYLOAD_TOO_LARGE past it. A whole-batch coded envelope is a verdict on
        # every entry, so a count-only chunker settled the lot `rejected`.
        budget = 400
        bodies = []

        def post(_url, _headers, body):
            bodies.append(len(body))

            if len(body) > budget:
                return 413, {"error": {"code": "PAYLOAD_TOO_LARGE", "message": "Body too large"}}

            calls = json.loads(body)["calls"]

            return 200, {"results": [{"body": {"commitCursor": 1, "result": None}, "id": call["id"]} for call in calls]}

        store = _Store()
        client = LunoraClient("https://app.example", client_id="c-1", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)

        queued = [f"m-{index}" for index in range(4)]
        for mutation_id in queued:
            client.offline_queue.enqueue(QueuedMutation(args={"text": "x" * 120}, function_path="messages:send", mutation_id=mutation_id))

        report = asyncio.run(client.flush_offline_queue())

        self.assertEqual(report.committed, queued, "every write commits; none is dropped for the size of the batch it shared")
        self.assertEqual(report.rejected, [])
        self.assertEqual(_ids(client.offline_queue.items()), [])
        self.assertTrue(max(bodies) > budget, "the first attempt has to be the over-budget one, or nothing was split")

    def test_a_lone_queued_write_survives_an_envelope_less_502(self):
        covers("non_2xx_without_error_envelope_fails")

        # The same response on the batch path (two or more writes) was already
        # classified transient, so whether a gateway blip LOST a durable write
        # depended on the queue's depth.
        def post(_url, _headers, _body):
            return 502, {"message": "bad gateway"}

        store = _Store()
        settled = []
        client = LunoraClient("https://app.example", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)
        client.on_mutation_settled(settled.append)
        client.offline_queue.enqueue(QueuedMutation(args={}, function_path="messages:send", mutation_id="m-502"))

        report = asyncio.run(client.flush_offline_queue())

        self.assertEqual(report.rejected, [])
        self.assertEqual(report.requeued, ["m-502"])
        self.assertEqual(_ids(client.offline_queue.items()), ["m-502"])
        self.assertEqual(settled, [], "nothing settled: no verdict was ever reached")
        self.assertEqual(store.removed, [], "the durable record stays, because the write is still good")

    def test_a_rate_limited_replay_requeues_and_defers_the_next_flush(self):
        covers("offline_flush_replays_and_confirms_optimistic")

        posts = []

        def post(_url, _headers, _body):
            posts.append(1)

            return 429, {"error": {"code": "TOO_MANY_REQUESTS", "data": {"retryAfterMs": 60000}, "message": "slow down"}}

        client = LunoraClient("https://app.example", http_post=post)
        client.offline_queue = OfflineQueue(persistence=_Store())
        client.offline_queue.enqueue(QueuedMutation(args={}, function_path="messages:send", mutation_id="m-429"))

        report = asyncio.run(client.flush_offline_queue())

        # "Not now", not "no": the write is valid and the server asked for it
        # later, so dropping it loses data for being punctual.
        self.assertEqual(report.rejected, [])
        self.assertEqual(report.requeued, ["m-429"])
        self.assertEqual(report.retry_after_ms, 60000)

        again = asyncio.run(client.flush_offline_queue())

        self.assertEqual(len(posts), 1, "the second flush must wait out the delay rather than earn the same 429")
        self.assertTrue(again.retry_after_ms > 0)
        self.assertEqual(_ids(client.offline_queue.items()), ["m-429"])

    def test_a_rate_limited_batch_slot_requeues_and_clamps_the_delay(self):
        covers("offline_flush_batches_multiple_writes")

        def post(_url, _headers, body):
            calls = json.loads(body)["calls"]

            return 200, {
                "results": [
                    {"body": {"error": {"code": "TOO_MANY_REQUESTS", "data": {"retryAfterMs": 900000}, "message": "slow down"}}, "id": calls[0]["id"]},
                    {"body": {"commitCursor": 3, "result": None}, "id": calls[1]["id"]},
                ]
            }

        store = _Store()
        client = LunoraClient("https://app.example", client_id="c-1", http_post=post)
        client.offline_queue = OfflineQueue(persistence=store)

        for mutation_id in ("m-a", "m-b"):
            client.offline_queue.enqueue(QueuedMutation(args={}, function_path="messages:send", mutation_id=mutation_id))

        report = asyncio.run(client.flush_offline_queue())

        # A slot the limiter refused to look at is not a verdict on that write —
        # the per-slot rule is the same predicate the single-call path uses.
        self.assertEqual(report.rejected, [])
        self.assertEqual(report.committed, ["m-b"])
        self.assertEqual(report.requeued, ["m-a"])
        # Clamped: a server (or a proxy) can name minutes, and a durable queue
        # that sleeps that long has stopped being a queue.
        self.assertEqual(report.retry_after_ms, 60000)

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
            asyncio.run(client.submit(SubmitOptions(args={}, function_path="messages:list", optimistic=lambda current: [*(current or []), "c"])))

        self.assertEqual(seen[-1], ["a"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
