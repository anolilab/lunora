"""Protocol-conformance tests: drive the Python SDK against the shared golden
fixtures in ``protocol/fixtures/`` (the same files the TypeScript client is
tested against)."""

from __future__ import annotations

import asyncio
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
from lunora.wire import decode_wire, encode_wire, stable_wire_key
from tests._fixtures import load
from tests._manifest import covers


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
                self.assertEqual(encode_wire(decode_wire(encoded)), case.get("reencoded", encoded))


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


class TestWsFrameBuilders(unittest.TestCase):
    def test_client_frames(self):
        covers("client_frame_builders")

        frames = load("ws-frames.json")["clientFrames"]
        self.assertEqual(build_connect_frame("client-test"), frames["connect"])
        self.assertEqual(build_connect_frame("client-test", {"roomId": "general"}), frames["connect-with-context"])
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

        for case in load("ws-frames.json")["serverFrames"]:
            with self.subTest(case=case["name"]):
                client = LunoraClient("https://app.example")
                client._send = lambda _frame: None  # avoid needing a socket
                seen: list = []
                errors: list = []
                client.subscribe("messages:list", {"channel": "general"}, seen.append, errors.append)

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
