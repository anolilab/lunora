"""Replay classification, frame robustness and session lifecycle, against the shared fixtures.

Every expectation is read from ``protocol/fixtures/`` so this port cannot pass by
asserting a behaviour of its own; the port-local cases at the bottom pin what no
fixture can reach (an unexpected exception inside a flush, a raising callback,
the live socket's close).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient, LunoraError
from lunora.offline import OfflineQueue, QueuedMutation
from tests._fixtures import load
from tests._manifest import covers

OFFLINE = load("offline-optimistic.json")["offlineQueue"]
FRAMES = load("ws-frames.json")


def _parsed(case: dict):
    """The body an injected poster hands back: the JSON, or ``None`` when it is not JSON.

    That is what the default ``urllib`` transport returns for an unreadable body,
    so these cases drive the SDK with exactly what it receives in production.
    """

    if "body" in case:
        return case["body"]

    try:
        return json.loads(case["rawBody"])
    except ValueError:
        return None


class _Store:
    """A persistence adapter that records ``remove`` calls."""

    def __init__(self):
        self.removed = []

    def append(self, record):
        pass

    def load(self):
        return []

    def remove(self, mutation_id):
        self.removed.append(mutation_id)

    def clear(self):
        pass


class _Run:
    """One flush scenario: a client over ``post``, a durable store, and every settle."""

    def __init__(self, post, queued, shard_keys=None):
        self.store = _Store()
        self.settled = []
        self.confirmed = []
        self.client = LunoraClient("https://app.example", client_id="c-1", http_post=post)
        self.client.offline_queue = OfflineQueue(persistence=self.store)
        self.client.on_mutation_settled(self.settled.append)

        for index, mutation_id in enumerate(queued):
            self.client.offline_queue.enqueue(
                QueuedMutation(
                    args={"n": index},
                    confirms=[lambda cursor, _deferred, mid=mutation_id: self.confirmed.append((mid, cursor))],
                    function_path="messages:send",
                    mutation_id=mutation_id,
                    shard_key=(shard_keys or {}).get(mutation_id),
                )
            )

    def flush(self, shard_key=None):
        return asyncio.run(self.client.flush_offline_queue(shard_key))

    def queued(self):
        return [item.id for item in self.client.offline_queue.items()]


def _ok_batch(calls, cursor_base=1):
    return {"results": [{"body": {"commitCursor": cursor_base + call["id"], "result": "ok"}, "id": call["id"]} for call in calls]}


class TestReplayManifestCases(unittest.TestCase):
    def test_empty_shard_key_routes_to_default_on_both_paths(self):
        covers("offline_flush_empty_shard_key_routes_to_default")
        case = OFFLINE["emptyShardKey"]

        for path in ("batch", "lone"):
            with self.subTest(path=path):
                spec = case[path]
                bodies = []

                def post(url, _headers, body, bodies=bodies):
                    parsed = json.loads(body)
                    if url.endswith("/_lunora/rpc-batch"):
                        bodies.extend(parsed["calls"])
                        return 200, _ok_batch(parsed["calls"])
                    bodies.append(parsed)
                    return 200, {"commitCursor": 1, "result": "ok"}

                run = _Run(post, [q["id"] for q in spec["queued"]], {q["id"]: q["shardKey"] for q in spec["queued"]})
                report = run.flush(spec["flushShardKey"])

                self.assertEqual(report.committed, spec["committed"])
                self.assertEqual(len(bodies), len(spec["queued"]))
                for body in bodies:
                    self.assertNotIn("shardKey", body)

    def test_undecodable_result_settles_committed(self):
        covers("offline_flush_undecodable_result_settles_committed")
        case = OFFLINE["undecodableResult"]

        # Batch: the bad slot neither aborts the loop nor is retried.
        spec = case["batch"]

        def post_batch(_url, _headers, body):
            calls = json.loads(body)["calls"]
            reply = _ok_batch(calls)
            reply["results"][spec["undecodableSlot"]]["body"]["result"] = case["rawResult"]
            return 200, reply

        run = _Run(post_batch, spec["queued"])
        report = run.flush()

        self.assertEqual(report.committed, spec["committed"])
        self.assertEqual(report.rejected, spec["rejected"])
        self.assertEqual(run.queued(), spec["queuedAfterFlush"])
        self.assertEqual(run.store.removed, spec["persistRemoveCalls"])
        self.assertEqual([e.mutation_id for e in run.settled if e.error is not None], spec["decodeFailed"])
        for event in run.settled:
            self.assertEqual(event.status, "committed")
            if event.mutation_id in spec["decodeFailed"]:
                self.assertIsInstance(event.error, LunoraError)
                self.assertEqual(event.error.code, case["code"])
                self.assertIsNone(event.value)
        # Every overlay confirmed against its echoed cursor, the undecodable one included.
        self.assertEqual(run.confirmed, [(mid, 1 + index) for index, mid in enumerate(spec["queued"])])

        # Lone: the single-call path settles it the same way, and never replays it.
        spec = case["lone"]
        requests = []

        def post_lone(_url, _headers, body):
            requests.append(body)
            return 200, {"commitCursor": 7, "result": case["rawResult"]}

        run = _Run(post_lone, spec["queued"])
        report = run.flush()

        self.assertEqual(report.committed, spec["committed"])
        self.assertEqual(report.rejected, spec["rejected"])
        self.assertEqual(run.queued(), spec["queuedAfterFlush"])
        self.assertEqual(run.store.removed, spec["persistRemoveCalls"])
        self.assertEqual([(e.mutation_id, e.status, e.error.code, e.value) for e in run.settled], [(spec["decodeFailed"][0], "committed", case["code"], None)])
        self.assertEqual(run.confirmed, [(spec["queued"][0], 7)])

        run.flush()
        self.assertEqual(len(requests), spec["requestsAfterSecondFlush"])

    def test_single_and_batch_classify_alike(self):
        covers("offline_flush_classifies_single_and_batch_alike")
        case = OFFLINE["replayClassification"]

        for scenario in case["cases"]:
            for path, queued in case["paths"].items():
                with self.subTest(case=scenario["name"], path=path):
                    run = _Run(lambda _u, _h, _b, s=scenario: (s["status"], _parsed(s)), queued)
                    report = run.flush()

                    if scenario["outcome"] == "rejected":
                        self.assertEqual(report.rejected, queued)
                        self.assertEqual(run.queued(), [])
                        self.assertEqual([(e.status, e.error.code) for e in run.settled], [("rejected", scenario["code"])] * len(queued))
                    else:
                        self.assertEqual(report.requeued, queued)
                        self.assertEqual(run.queued(), queued)
                        self.assertEqual(run.settled, [])

    def test_batch_splits_on_envelope_less_413(self):
        covers("offline_flush_batch_splits_on_envelopeless_413")
        case = OFFLINE["envelopelessPayloadTooLarge"]
        refused = (413, _parsed(case))

        def split_post(_url, _headers, body):
            calls = json.loads(body)["calls"]
            return refused if len(calls) > case["split"]["refuseCallsAbove"] else (200, _ok_batch(calls))

        posts = {"split": split_post, "alwaysRefused": lambda *_: refused, "lone": lambda *_: refused}

        for name, post in posts.items():
            with self.subTest(scenario=name):
                spec = case[name]
                run = _Run(post, spec["queued"])
                report = run.flush()

                self.assertEqual(report.committed, spec["committed"])
                self.assertEqual(report.rejected, spec["rejected"])
                self.assertEqual(run.queued(), spec["queuedAfterFlush"])
                for event in run.settled:
                    if event.status == "rejected":
                        self.assertEqual(event.error.code, case["code"])


class TestRpcManifestCases(unittest.TestCase):
    def test_unreadable_success_body_raises_sdk_error(self):
        covers("rpc_unreadable_success_body_raises_sdk_error")

        for case in load("rpc.json")["unreadableSuccessBody"]:
            client = LunoraClient("https://app.example", http_post=lambda _u, _h, _b, c=case: (c["status"], _parsed(c)))

            for method in (client.query, client.mutation, client.action):
                with self.subTest(case=case["name"], method=method.__name__):
                    with self.assertRaises(LunoraError) as caught:
                        asyncio.run(method("messages:list", {}))

                    self.assertEqual(caught.exception.code, case["code"])

        # `{}` is how a function returning nothing is answered.
        client = LunoraClient("https://app.example", http_post=lambda *_: (200, {}))
        self.assertIsNone(asyncio.run(client.query("messages:list", {})))

    def test_auth_token_redacted_when_printed(self):
        covers("auth_token_redacted_when_printed")
        token = "lunora-secret-7f3a9c"
        client = LunoraClient("https://app.example", auth_token=token)

        for rendered in (repr(client), str(client), f"{client}", f"{client!r}", format(client)):
            self.assertNotIn(token, rendered)


class TestFrameManifestCases(unittest.TestCase):
    def _subscribed(self, frame):
        client = LunoraClient("https://app.example")
        client.attach_socket(lambda _frame: None)
        seen = []
        client.subscribe("messages:list", {}, seen.append, seen.append)
        client.handle_frame(frame)
        seen.clear()
        return client, seen

    def _resend(self, client):
        sent = []
        client.attach_socket(sent.append)
        client.resend_subscriptions()
        return [frame for frame in sent if frame["type"] == "subscribe"]

    def test_malformed_frames_are_ignored_without_raising(self):
        covers("malformed_frames_are_ignored_without_raising")
        case = FRAMES["malformedFrames"]

        for frame in case["frames"]:
            with self.subTest(frame=json.dumps(frame)):
                client, seen = self._subscribed(case["setupFrame"])
                # The read loop's own path: the text is parsed, then handed over.
                client.handle_frame(json.loads(json.dumps(frame)))

                self.assertEqual(seen, [])
                resent = self._resend(client)
                self.assertEqual(resent[0]["query"]["sinceSeq"], case["resendSinceSeq"])
                self.assertEqual(resent[0]["query"]["sinceEpoch"], case["resendSinceEpoch"])

    def test_shape_poke_with_undecodable_row_is_refused_whole(self):
        covers("shape_poke_with_undecodable_row_is_refused_whole")
        shape = FRAMES["shape"]
        client = LunoraClient("https://app.example")
        client.attach_socket(lambda _frame: None)
        rows, errors, other_rows = [], [], []
        client.subscribe_shape("roomMessages", {"room": "general"}, rows.append, errors.append)
        client.subscribe_shape("other", {}, other_rows.append)

        for frame in shape["pokeSequence"]:
            client.handle_frame(frame)
        self.assertEqual(rows[-1], shape["expectedRows"])
        rows.clear()

        # A second shape rides the same poke with a good row: it still applies.
        sequence = [dict(frame) for frame in shape["undecodableRowPokeSequence"]]
        good = {
            "pokeId": sequence[0]["pokeId"],
            "rowsPatch": [{"key": "k", "op": "insert", "table": "t", "value": {"v": 1}}],
            "shapeId": "shape_2",
            "type": "pokePart",
        }
        for frame in [*sequence[:-1], good, sequence[-1]]:
            client.handle_frame(frame)

        self.assertEqual(rows, [], "no rows callback for the refused shape")
        self.assertEqual(list(client._shapes["shape_1"].rows.values()), shape["expectedRows"], "the view is untouched")
        self.assertEqual([error.code for error in errors], [shape["undecodableRowErrorCode"]])
        self.assertEqual(other_rows, [[{"v": 1}]])

        sent = []
        client.attach_socket(sent.append)
        client.resend_subscriptions()
        resend = next(frame for frame in sent if frame.get("id") == "shape_1")
        self.assertEqual(resend["sinceCheckpoint"], shape["undecodableRowResendCheckpoint"])
        self.assertEqual(resend["sinceEpoch"], "e1")

        # The server's next poke is based on the checkpoint it believes it
        # delivered: the view is not there, so it re-seeds cold instead of splicing.
        sent.clear()
        for frame in shape["gapPokeSequence"]:
            client.handle_frame(frame)

        self.assertEqual(list(client._shapes["shape_1"].rows.values()), shape["gapExpectedRows"])
        self.assertEqual(rows, [[]])
        cold = [frame for frame in sent if frame.get("type") == "shape_subscribe" and frame.get("id") == "shape_1"]
        self.assertEqual(len(cold), 1)
        self.assertNotIn("sinceCheckpoint", cold[0])
        self.assertNotIn("sinceEpoch", cold[0])
        sent.clear()
        client.resend_subscriptions()
        resend = next(frame for frame in sent if frame.get("id") == "shape_1")
        self.assertNotIn("sinceCheckpoint", resend)
        self.assertNotIn("sinceEpoch", resend)

    def test_contiguous_based_poke_applies(self):
        covers("shape_poke_with_undecodable_row_is_refused_whole")
        shape = FRAMES["shape"]
        client = LunoraClient("https://app.example")
        sent = []
        client.attach_socket(sent.append)
        rows = []
        client.subscribe_shape("roomMessages", {"room": "general"}, rows.append)

        for frame in [*shape["pokeSequence"], *shape["contiguousPokeSequence"]]:
            client.handle_frame(frame)

        self.assertEqual(rows[-1], shape["contiguousExpectedRows"])
        self.assertEqual([frame["type"] for frame in sent], ["shape_subscribe"], "no re-seed")

    def test_identity_change_evicts_previous_session(self):
        covers("identity_change_evicts_previous_session")
        case = FRAMES["identityChange"]

        for transition in case["transitions"]:
            with self.subTest(transition=transition):
                client = LunoraClient("https://app.example", identity=transition["from"])
                client.attach_socket(lambda _frame: None)
                shape_rows = []
                client.subscribe("messages:list", {}, lambda _value: None)
                client.subscribe_shape("roomMessages", {"room": "general"}, shape_rows.append)
                client.handle_frame(case["queryFrame"])
                for frame in FRAMES["shape"]["pokeSequence"]:
                    client.handle_frame(frame)
                shape_rows.clear()

                client.identity = transition["to"]

                resent = self._resend_all(client)
                query, shape = resent["subscribe"], resent["shape_subscribe"]
                if transition["evicts"]:
                    self.assertNotIn("sinceSeq", query["query"])
                    self.assertNotIn("sinceEpoch", query["query"])
                    self.assertNotIn("sinceCheckpoint", shape)
                    self.assertNotIn("sinceEpoch", shape)
                    self.assertEqual(list(client._shapes["shape_1"].rows.values()), case["evicted"]["shapeRows"])
                    self.assertEqual(shape_rows, [case["evicted"]["shapeCallbackRows"]])
                else:
                    retained = case["retained"]
                    self.assertEqual(query["query"]["sinceSeq"], retained["sinceSeq"])
                    self.assertEqual(query["query"]["sinceEpoch"], retained["sinceEpoch"])
                    self.assertEqual(shape["sinceCheckpoint"], retained["sinceCheckpoint"])
                    self.assertEqual(len(client._shapes["shape_1"].rows), retained["shapeRowCount"])
                    self.assertEqual(shape_rows, [])

    def _resend_all(self, client):
        sent = []
        client.attach_socket(sent.append)
        client.resend_subscriptions()
        return {frame["type"]: frame for frame in sent}

    def test_subscription_stream_ends_on_close(self):
        covers("subscription_stream_ends_on_close")
        frame = FRAMES["stream"]["frames"][0]
        expected = FRAMES["stream"]["yielded"][0]

        async def run():
            client = LunoraClient("https://app.example")
            client.attach_socket(lambda _frame: None)
            values = client.stream("messages:list", {"channel": "general"})
            client.handle_frame(frame)
            client.close()

            async def drain():
                return [value async for value in values]

            return await asyncio.wait_for(drain(), 2.0)

        self.assertEqual(asyncio.run(run()), [expected])


class TestPortLocal(unittest.TestCase):
    def test_a_stream_never_iterated_leaves_no_close_hook(self):
        async def run():
            client = LunoraClient("https://app.example")
            client.attach_socket(lambda _frame: None)
            client.stream("messages:list", {})
            return client._close_hooks

        self.assertEqual(asyncio.run(run()), [])

    def test_a_lone_surrogate_object_key_sorts_by_code_unit(self):
        from lunora.wire import stable_stringify

        self.assertEqual(stable_stringify({"\ud800": 1, "a": 2}), '{"a":2,"\\ud800":1}')

    def test_an_unexpected_failure_mid_flush_requeues_the_unsettled_writes(self):
        """A flush must never lose drained writes to an exception it did not expect."""

        calls_seen = []

        def post(_url, _headers, body):
            calls = json.loads(body)["calls"]
            calls_seen.append(len(calls))
            return 200, _ok_batch(calls)

        run = _Run(post, ["f1", "f2", "f3"])
        real = __import__("lunora.submit", fromlist=["decode_wire"]).decode_wire
        seen = []

        def decode_then_fail(value, *args):
            seen.append(value)
            if len(seen) > 1:
                raise RuntimeError("unexpected")
            return real(value, *args)

        with mock.patch("lunora.submit.decode_wire", side_effect=decode_then_fail), self.assertRaises(RuntimeError):
            run.flush()

        self.assertEqual([e.mutation_id for e in run.settled], ["f1"])
        self.assertEqual(run.queued(), ["f2", "f3"], "the unsettled writes are back, in order, at the front")
        self.assertEqual(run.store.removed, ["f1"], "their durable records were never removed")

    def test_an_error_envelope_whose_data_does_not_decode_keeps_its_verdict(self):
        """The code is the server's verdict; an unreadable ``data`` must not turn it into a codec crash."""

        bad = {"code": "CONFLICT", "data": ["$lunora.wire$", "bigint", "not-a-number"], "message": "stale"}

        def post(_url, _headers, body):
            calls = json.loads(body)["calls"]
            reply = _ok_batch(calls)
            reply["results"][0]["body"] = {"error": bad}
            return 200, reply

        run = _Run(post, ["d1", "d2"])
        report = run.flush()

        self.assertEqual((report.rejected, report.committed, run.queued()), (["d1"], ["d2"], []))
        self.assertEqual(run.settled[0].error.code, "CONFLICT")

        client = LunoraClient("https://app.example", http_post=lambda *_: (409, {"error": bad}))
        with self.assertRaises(LunoraError) as caught:
            asyncio.run(client.query("messages:list", {}))
        self.assertEqual(caught.exception.code, "CONFLICT")

    def test_a_raising_callback_does_not_starve_the_next(self):
        client = LunoraClient("https://app.example")
        client.attach_socket(lambda _frame: None)
        seen = []

        def boom(_value):
            raise RuntimeError("consumer bug")

        client.subscribe("messages:list", {}, boom)
        client.subscribe("messages:list", {}, seen.append)
        client.handle_frame({"data": 1, "id": "sub_1", "type": "data"})
        client.handle_frame({"data": 2, "id": "sub_2", "type": "data"})

        shape_seen = []
        client.subscribe_shape("a", {}, boom)
        client.subscribe_shape("b", {}, shape_seen.append)
        client.handle_frame({"pokeId": "p", "type": "pokeStart"})
        for shape_id in ("shape_1", "shape_2"):
            client.handle_frame({"pokeId": "p", "rowsPatch": [{"key": "k", "op": "insert", "value": 1}], "shapeId": shape_id, "type": "pokePart"})
        client.handle_frame({"pokeId": "p", "type": "pokeEnd"})

        self.assertEqual(seen, [2])
        self.assertEqual(shape_seen, [[1]])

    def test_a_default_transport_html_success_is_an_sdk_error(self):
        import http.server
        import threading

        from lunora.client import _urllib_post, parse_rpc_response

        class Portal(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # BaseHTTPRequestHandler's own naming
                body = b"<html><body>ok</body></html>"
                self.send_response(200)
                self.send_header("content-type", "text/html")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        origin = http.server.HTTPServer(("127.0.0.1", 0), Portal)
        threading.Thread(target=origin.serve_forever, daemon=True).start()
        self.addCleanup(origin.server_close)
        self.addCleanup(origin.shutdown)

        status, parsed = _urllib_post(f"http://127.0.0.1:{origin.server_address[1]}/_lunora/rpc", {}, b"{}")

        with self.assertRaises(LunoraError) as caught:
            parse_rpc_response(parsed, status)

        self.assertEqual(caught.exception.code, "INTERNAL")


if __name__ == "__main__":
    unittest.main()
