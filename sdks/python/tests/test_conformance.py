"""Protocol-conformance tests: drive the Python SDK against the shared golden
fixtures in ``protocol/fixtures/`` (the same files the TypeScript client is
tested against)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import (
    MAX_PENDING_POKES,
    LunoraClient,
    LunoraError,
    build_connect_frame,
    build_rpc_body,
    build_shape_subscribe_frame,
    build_subscribe_frame,
    build_unsubscribe_frame,
    parse_rpc_response,
)
from lunora.wire import decode_wire, encode_wire, stable_stringify, stable_wire_key
from tests._fixtures import load
from tests._manifest import covers


def wire_text(value):
    """Render a value the way ``client.py`` puts it on the socket, with ``json.dumps``.

    Separate from ``stable_stringify``, which is free to normalise: it spells every number the
    ECMAScript way, so ``1.0`` and ``1`` compare EQUAL through it — the divergence a round-trip case
    exists to catch. Dart's dates went out as ``1700000000000.0`` for exactly that reason, on a
    green suite.
    """
    return json.dumps(value)


class TestWireCodecFixtures(unittest.TestCase):
    def test_round_trip_stability(self):
        covers("wire_codec_round_trip")

        cases = load("wire-codec.json")["cases"]
        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case=case["name"]):
                encoded = case["encoded"]
                # A handful of shapes are legitimately not fixed points — a bare
                # [TAG] array is escaped on the way out, an `undefined` object
                # field is dropped — and carry the expected re-encoding.
                expected = case.get("reencoded", encoded)
                round_tripped = encode_wire(decode_wire(encoded))

                self.assertEqual(stable_stringify(round_tripped), stable_stringify(expected))
                # And again as the BYTES the transport sends: a round-trip
                # assertion measured on a string the transport never sends
                # cannot see the divergence it exists to catch.
                self.assertEqual(wire_text(round_tripped), wire_text(expected))


class TestStableKeyFixtures(unittest.TestCase):
    def test_pure_json_cases(self):
        covers("stable_wire_key_fixtures")

        data = load("stable-wire-key.json")
        for case in data["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(stable_wire_key(case["args"]), case["key"])

    def test_typed_cases(self):
        covers("stable_wire_key_fixtures")

        data = load("stable-wire-key.json")
        for case in data["typed"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(stable_wire_key(decode_wire(case["wireArgs"])), case["key"])


class TestShardKey(unittest.TestCase):
    def test_empty_shard_key_is_omitted(self):
        covers("empty_shard_key_is_omitted")

        # `""` is ABSENT on the wire, not "the shard named empty string". The
        # runtime takes any string as a named shard and gives `""` its own
        # Durable Object, while this client treats `""` and None as one shard
        # everywhere it matches a subscription or drains the queue. A port that
        # sent it replayed a single queued write to one Durable Object and a
        # BATCHED replay of that same write to another, with the optimistic
        # overlay tracking neither.
        for absent in (None, ""):
            with self.subTest(shard_key=absent):
                self.assertNotIn("shardKey", build_rpc_body("messages:list", {}, absent))

        self.assertEqual(build_rpc_body("messages:list", {}, "tenant_a")["shardKey"], "tenant_a")

        client = LunoraClient("https://app.example")

        for absent in (None, ""):
            with self.subTest(ws_shard_key=absent):
                self.assertNotIn("shard=", client.ws_url_for(absent, None))

        self.assertIn("shard=tenant_a", client.ws_url_for("tenant_a", None))


class TestRpcFixtures(unittest.TestCase):
    def test_request_bodies(self):
        covers("rpc_request_bodies")

        rpc = load("rpc.json")["request"]
        for case in rpc["cases"]:
            with self.subTest(case=case["name"]):
                args = case["args"] if "args" in case else decode_wire(case["argsWire"])
                body = build_rpc_body(case["functionPath"], args, case.get("shardKey"))
                self.assertEqual(body, case["body"])

    def test_response_ok(self):
        covers("rpc_responses")

        for case in load("rpc.json")["responseOk"]:
            with self.subTest(case=case["name"]):
                value = parse_rpc_response(case["response"], 200)
                self.assertEqual(encode_wire(value), case["response"]["result"])

    def test_response_error(self):
        covers("rpc_responses")

        for case in load("rpc.json")["responseError"]:
            with self.subTest(case=case["name"]):
                with self.assertRaises(LunoraError) as ctx:
                    parse_rpc_response(case["response"], 400)
                self.assertEqual(ctx.exception.code, case["code"])
                self.assertEqual(ctx.exception.message, case["message"])
                if "dataWire" in case:
                    self.assertEqual(encode_wire(ctx.exception.data), case["dataWire"])
                if case.get("dataDropped"):
                    self.assertIsNone(ctx.exception.data)


class TestWsFrameBuilders(unittest.TestCase):
    def test_client_frames(self):
        covers("client_frame_builders")

        frames = load("ws-frames.json")["clientFrames"]
        # This port announces `pageDelta` (and only that), so its connect frame is the
        # plain golden plus the token; `connect-with-page-delta-caps` is the same frame.
        caps = {"caps": ["pageDelta"]}
        self.assertEqual(build_connect_frame("client-test"), frames["connect-with-page-delta-caps"])
        self.assertEqual(build_connect_frame("client-test"), {**frames["connect"], **caps})
        self.assertEqual(build_connect_frame("client-test", {"roomId": "general"}), {**frames["connect-with-context"], **caps})
        self.assertEqual(build_subscribe_frame("sub_1", "messages:list", {"channel": "general"}), frames["subscribe-cold"])
        self.assertEqual(
            build_subscribe_frame("sub_1", "messages:list", {"channel": "general"}, since_seq=12, since_epoch="e1"),
            frames["subscribe-resume"],
        )
        self.assertEqual(build_unsubscribe_frame("sub_1"), frames["unsubscribe"])

    def test_shape_subscribe_frame(self):
        covers("shape_subscribe_frame")

        shape = load("ws-frames.json")["shape"]
        self.assertEqual(build_shape_subscribe_frame("shape_1", "roomMessages", {"room": "general"}), shape["shape-subscribe-cold"])

    def test_shape_subscriptions_resend_after_reconnect(self):
        covers("shape_subscriptions_resend_after_reconnect")

        client = LunoraClient("https://app.example")
        client.attach_socket(lambda _frame: None)
        client.subscribe("messages:list", {"channel": "general"}, lambda _rows: None)
        client.subscribe_shape("roomMessages", {"room": "general"}, lambda _rows: None)

        # The cursors a resume carries are written by the frame handler, so they
        # have to exist before the resend is built.
        client.handle_frame({"cursor": 9, "data": [], "epoch": "e1", "id": "sub_1", "type": "data"})
        client.handle_frame({"epoch": "e1", "pokeId": "poke-1", "type": "pokeStart"})
        client.handle_frame({"pokeId": "poke-1", "reset": True, "rowsPatch": [], "shapeId": "shape_1", "type": "pokePart"})
        client.handle_frame({"checkpoint": 5, "epoch": "e1", "pokeId": "poke-1", "type": "pokeEnd"})

        resent: list = []
        client.attach_socket(resent.append)
        # Attaching sends `connect` first; the resend below is what follows it.
        self.assertEqual(resent[0]["type"], "connect")
        resent.clear()
        client.resend_subscriptions()

        # BOTH registries. A resend that walks only the queries leaves every
        # shape view subscribed to a socket that no longer exists — silently, and
        # for the rest of the process's life.
        self.assertEqual([frame["type"] for frame in resent], ["subscribe", "shape_subscribe"])
        self.assertEqual(resent[0]["query"]["sinceSeq"], 9)
        self.assertEqual(resent[1]["id"], "shape_1")
        self.assertEqual(resent[1]["shape"]["name"], "roomMessages")
        self.assertEqual(resent[1]["shape"]["args"], {"room": "general"})
        self.assertEqual(resent[1]["sinceCheckpoint"], 5)
        self.assertEqual(resent[1]["sinceEpoch"], "e1")


class TestWsFrameConsumer(unittest.TestCase):
    def test_server_frames(self):
        covers("server_frame_consumer")
        covers("complete_frame_cancels_without_dropping_the_subscription")
        cancellations = 0

        for case in load("ws-frames.json")["serverFrames"]:
            with self.subTest(case=case["name"]):
                client = LunoraClient("https://app.example")
                sent: list = []
                client.attach_socket(sent.append)
                seen: list = []
                errors: list = []
                client.subscribe("messages:list", {"channel": "general"}, seen.append, errors.append)
                sent.clear()

                descriptor = client.handle_frame(case["frame"])
                expect = case["expect"]
                self.assertEqual(descriptor["kind"], expect["kind"])
                self.assertEqual(descriptor.get("id"), expect.get("id"))

                if "valueWire" in expect:
                    self.assertEqual(encode_wire(descriptor["value"]), expect["valueWire"])
                    self.assertEqual(len(seen), 1)
                    self.assertEqual(encode_wire(seen[0]), expect["valueWire"])
                if "cursor" in expect:
                    self.assertEqual(descriptor.get("cursor"), expect["cursor"])
                if "lastMutationId" in expect:
                    self.assertEqual(descriptor.get("lastMutationId"), expect["lastMutationId"])
                if expect["kind"] == "error":
                    self.assertEqual(descriptor["code"], expect["code"])
                    self.assertEqual(descriptor["message"], expect["message"])
                    self.assertEqual(len(errors), 1)
                    self.assertEqual(errors[0].code, expect["code"])
                if expect.get("resendsAfterReconnect"):
                    cancellations += 1
                    # Cancelled AND kept. Dropping the registration takes it out
                    # of the set ``resend_subscriptions`` walks, which froze the
                    # query across every future reconnect with nothing reported.
                    self.assertEqual([error.code for error in errors], [expect["code"]])
                    self.assertEqual([error.message for error in errors], [expect["message"]])
                    client.resend_subscriptions()
                    self.assertEqual([frame["id"] for frame in sent if frame["type"] == "subscribe"], [expect["id"]])

        # A conditional assertion that never runs is worse than none: without this,
        # renaming the fixture key would leave every suite green.
        self.assertEqual(cancellations, 1, "serverFrames must carry one cancelling case")

    def test_page_delta_frames_merge_into_the_server_base(self):
        cases = load("ws-frames.json")["pageDeltaFrames"]
        self.assertTrue(cases, "pageDeltaFrames must carry cases")

        for case in cases:
            with self.subTest(case=case["name"]):
                client = LunoraClient("https://app.example")
                client.attach_socket(lambda _frame: None)
                seen: list = []
                client.subscribe("messages:list", {"channel": "general"}, seen.append)
                client.handle_frame({"data": case["baseWire"], "id": case["frame"]["id"], "type": "data"})
                seen.clear()

                descriptor = client.handle_frame(case["frame"])
                expect = case["expect"]
                self.assertEqual(descriptor["kind"], expect["kind"])
                self.assertEqual(descriptor.get("id"), expect["id"])
                self.assertEqual(encode_wire(descriptor["value"]), expect["valueWire"])
                self.assertEqual([encode_wire(value) for value in seen], [expect["valueWire"]])
                if "cursor" in expect:
                    self.assertEqual(descriptor.get("cursor"), expect["cursor"])
                if "epoch" in expect:
                    self.assertEqual(descriptor.get("epoch"), expect["epoch"])

    def _replay_delta_cases(self, key):
        """Drive every case under ``key`` through one client, checking each step's publishes, resend query and errors."""

        cases = load("ws-frames.json")[key]
        self.assertTrue(cases, f"{key} must carry cases")

        for case in cases:
            with self.subTest(case=case["name"]):
                sent: list = []
                # An identity of None is "unset": the constructor sets it directly, so a first identity evicts nothing.
                client = LunoraClient("https://app.example", identity=case.get("identityChange", {}).get("from"))
                client.attach_socket(sent.append)
                seen: list = []
                errors: list = []
                client.subscribe("messages:list", {"channel": "general"}, seen.append, errors.append)
                client.handle_frame(case["seedFrame"])

                if "freezeFrame" in case:
                    client.handle_frame(case["freezeFrame"])
                    self.assertEqual([error.code for error in errors], case["freezeErrors"])
                    errors.clear()
                if "identityChange" in case:
                    client.identity = case["identityChange"]["to"]
                    seen.clear()

                for step in case["steps"]:
                    if "resume" in step:
                        sent.clear()
                        client.resend_subscriptions()
                        subscribes = [frame for frame in sent if frame["type"] == "subscribe"]
                        self.assertEqual(len(subscribes), 1)
                        self.assertEqual(subscribes[0]["query"].get("sinceSeq"), step["resume"]["sinceSeq"])
                        self.assertEqual(subscribes[0]["query"].get("sinceEpoch"), step["resume"]["sinceEpoch"])
                        continue

                    seen.clear()
                    errors.clear()
                    client.handle_frame(step["frame"])
                    self.assertEqual(len(seen), step["publishes"])
                    if "valueWire" in step:
                        self.assertEqual(encode_wire(seen[-1]), step["valueWire"])
                    # Only a step that names its errors is checked: a held row change also notifies, and the
                    # fixture pins the notice where it matters rather than on every held step.
                    if "errors" in step:
                        self.assertEqual([error.code for error in errors], step["errors"])

    def test_an_unmergeable_row_change_freezes_the_resume_cursor(self):
        self._replay_delta_cases("pageDeltaPoisonCases")

    def test_an_identity_change_evicts_the_cached_base_and_the_poison(self):
        self._replay_delta_cases("identityChangeEvictionCases")
        self.assertEqual(len(load("ws-frames.json")["identityChangeEvictionCases"]), 2)

    def test_row_delta_without_a_mergeable_base_never_publishes_the_envelope(self):
        delta = {"key": "m1", "op": "update", "row": {"_id": "m1"}, "table": "messages"}

        def run(base_wire):
            client = LunoraClient("https://app.example")
            client.attach_socket(lambda _frame: None)
            seen: list = []
            client.subscribe("messages:list", {}, seen.append)
            if base_wire is not None:
                client.handle_frame({"data": base_wire, "id": "sub_1", "type": "data"})
            seen.clear()
            client.handle_frame({"delta": delta, "id": "sub_1", "type": "delta"})
            return seen

        # No base: the row change is held, never published as the envelope.
        self.assertEqual(run(None), [])
        # A base that is not a row list (or whose rows lack `_id`): keep the previous value.
        self.assertEqual(run("scalar"), [])
        self.assertEqual(run([{"text": "no id"}]), [])

    def test_a_subscription_streams_its_frame_values_in_order(self):
        covers("subscription_stream_yields_frame_values_in_order")

        case = load("ws-frames.json")["stream"]

        async def collect() -> list:
            client = LunoraClient("https://app.example")
            client._send = lambda _frame: None
            seen: list = []
            values = client.stream("messages:list", {"channel": "general"})

            for frame in case["frames"]:
                client.handle_frame(frame)
                seen.append(await values.__anext__())

            # Closing the generator tears its subscription down, so nothing is
            # left registered against a client the consumer has finished with.
            await values.aclose()

            return seen

        seen = asyncio.run(collect())

        self.assertEqual(seen, case["yielded"])

    def test_poke_sequence_materialises_rows(self):
        covers("poke_sequence_materialises_rows")

        shape = load("ws-frames.json")["shape"]
        client = LunoraClient("https://app.example")
        client._send = lambda _frame: None
        rows_seen: list = []
        client.subscribe_shape("roomMessages", {"room": "general"}, rows_seen.append)

        for frame in shape["pokeSequence"]:
            client.handle_frame(frame)

        self.assertTrue(rows_seen, "on_rows should fire at pokeEnd")
        self.assertEqual(rows_seen[-1], shape["expectedRows"])

    # A manifest case: every port asserts it against the shared fixture's
    # ``resetPokeSequence``. It starts from the cold-seed state on purpose — a
    # re-seed is inserts-only, so ``m1`` leaves the shape with no delete op behind
    # it, and a client that merges renders it for the rest of its life.
    def test_reset_poke_replaces_the_view(self):
        covers("shape_reset_poke_replaces_membership")
        shape = load("ws-frames.json")["shape"]
        client = LunoraClient("https://app.example")
        client._send = lambda _frame: None
        rows_seen: list = []
        client.subscribe_shape("roomMessages", {"room": "general"}, rows_seen.append)

        for frame in shape["pokeSequence"]:
            client.handle_frame(frame)

        self.assertEqual(rows_seen[-1], shape["expectedRows"])

        for frame in shape["resetPokeSequence"]:
            client.handle_frame(frame)

        # m1 left the shape while this client was away and the re-seed says so by
        # omission — it carries no delete, only the rows that are still members.
        self.assertEqual(rows_seen[-1], shape["resetExpectedRows"])

    def test_pending_poke_buffers_are_bounded(self):
        covers("pending_poke_buffers_are_bounded")

        # A buffer is only released at its ``pokeEnd``. A socket that drops
        # mid-poke never sends one, so its buffer would otherwise be retained for
        # the life of the client — one leak per reconnect, and unbounded against
        # a peer that opens pokes it never closes.
        client = LunoraClient("https://app.example")
        client._send = lambda _frame: None
        rows_seen: list = []
        client.subscribe_shape("roomMessages", {"room": "general"}, rows_seen.append)
        shape_id = "shape_1"  # the first shape on a fresh client, as every fixture assumes

        # A poke opened, part-filled, and then abandoned when the socket dropped.
        client.handle_frame({"type": "pokeStart", "pokeId": "stale"})
        client.handle_frame(
            {
                "type": "pokePart",
                "pokeId": "stale",
                "shapeId": shape_id,
                "rowsPatch": [{"op": "insert", "key": "ghost", "value": "ghost-row"}],
            }
        )

        # Enough fresh pokes to push it past the cap.
        for index in range(MAX_PENDING_POKES):
            client.handle_frame({"type": "pokeStart", "pokeId": f"filler-{index}"})

        # The abandoned buffer is gone, so its late pokeEnd is a no-op: an evicted
        # poke behaves exactly like one that was never opened.
        descriptor = client.handle_frame({"type": "pokeEnd", "pokeId": "stale"})

        self.assertEqual(descriptor["shapes"], [], "the evicted buffer must touch no shape")
        self.assertEqual(rows_seen, [], "the ghost row must never reach the view")

        # ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
        newest = f"filler-{MAX_PENDING_POKES - 1}"
        client.handle_frame(
            {
                "type": "pokePart",
                "pokeId": newest,
                "shapeId": shape_id,
                "rowsPatch": [{"op": "insert", "key": "m1", "value": "kept"}],
            }
        )
        client.handle_frame({"type": "pokeEnd", "pokeId": newest})

        self.assertEqual(rows_seen, [["kept"]], "the newest buffer must survive and apply")


if __name__ == "__main__":
    unittest.main()
