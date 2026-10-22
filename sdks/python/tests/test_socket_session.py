"""Socket session behaviour: the connect frame, the close codes, whispers and rooms.

Driven through the port's own calls (``attach_socket``, ``detach_socket``,
``handle_frame``, ``whisper_subscribe``) against the shared goldens in
``protocol/fixtures/ws-frames.json``. The live loop that reads a close frame off a
real socket is covered in ``test_connect_and_run.py``.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from functools import partial
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import (
    LunoraClient,
    build_connect_frame,
    build_whisper_frame,
    build_whisper_subscribe_frame,
    build_whisper_unsubscribe_frame,
)
from lunora.wire import encode_wire
from tests._fixtures import load
from tests._manifest import covers

FRAMES = load("ws-frames.json")
CLIENT_FRAMES = FRAMES["clientFrames"]


def _client(**options) -> LunoraClient:
    return LunoraClient("https://app.example", client_id="client-test", **options)


class TestSocketSession(unittest.TestCase):
    def test_connect_frame_first_and_carries_session_token(self):
        covers("connect_frame_first_and_carries_session_token")

        client = _client(ws_token="session-token", auth_token="rpc-bearer")
        client.subscribe("messages:list", {"channel": "general"}, lambda _value: None)
        client.whisper_subscribe("room:general", lambda _value: None)
        sent: list = []
        client.attach_socket(sent.append)

        self.assertEqual(sent[0], CLIENT_FRAMES["connect-with-token"])
        self.assertEqual(sent[1], CLIENT_FRAMES["whisper-subscribe"])
        self.assertEqual(build_connect_frame("client-test", None, "session-token"), CLIENT_FRAMES["connect-with-token"])
        # The RPC bearer is never a socket credential, and neither credential rides the URL.
        self.assertNotIn("rpc-bearer", json.dumps(sent[0]))
        self.assertNotIn("session-token", client.ws_url_for(None, None))
        self.assertNotIn("rpc-bearer", client.ws_url_for(None, None))

        bare: list = []
        _client().attach_socket(bare.append)
        self.assertEqual(bare[0], CLIENT_FRAMES["connect"])
        self.assertNotIn("token", bare[0])

    def test_ws_url_carries_only_the_admin_ticket(self):
        covers("ws_url_carries_only_the_admin_ticket")

        client = _client(ws_token="session-token", auth_token="rpc-bearer")
        self.assertEqual(client.ws_url_for(None, None), client.ws_url)
        self.assertNotIn("token", parse_qs(urlsplit(client.ws_url_for("shard-a", None)).query))
        self.assertEqual(parse_qs(urlsplit(client.ws_url_for(None, "ticket-1")).query), {"token": ["ticket-1"]})
        for url in (client.ws_url_for(None, "ticket-1"), client.ws_url_for("shard-a", None)):
            self.assertNotIn("session-token", url)
            self.assertNotIn("rpc-bearer", url)

    def test_attach_socket_carries_connection_context(self):
        covers("attach_socket_carries_connection_context")
        context = {"roomId": "general"}

        sent: list = []
        _client(ws_token="session-token").attach_socket(sent.append, context=context)
        self.assertEqual(sent[0], FRAMES["clientFrames"]["connect-with-token-and-context"])

        bare: list = []
        _client().attach_socket(bare.append, context=context)
        self.assertEqual(bare[0], CLIENT_FRAMES["connect-with-context"])

        omitted: list = []
        _client().attach_socket(omitted.append)
        self.assertNotIn("context", omitted[0])
        self.assertEqual(omitted[0], CLIENT_FRAMES["connect"])

    def test_close_codes_drive_token_expiry(self):
        covers("close_codes_drive_token_expiry")
        cases = FRAMES["closeSequences"]["cases"]
        self.assertIn("superseded_socket_refusal_is_not_notified", [case["name"] for case in cases])

        for case in cases:
            with self.subTest(case=case["name"]):
                client = _client(ws_token="session-0")
                notified: list = []
                client.on_token_expired(partial(notified.append, None))
                errors: list = []
                client.subscribe("messages:list", {}, lambda _value: None, errors.append)
                self.assertEqual(list(client._subs), ["sub_1"])

                credential = 0
                for step in case["steps"]:
                    if "attach" in step:
                        client.attach_socket(lambda _frame: None)
                    elif "close" in step:
                        client.detach_socket(step["close"]["code"], step["close"]["reason"])
                        self.assertFalse(client.online)
                    elif "frame" in step:
                        client.handle_frame(step["frame"])
                    elif "credentialChange" in step:
                        credential += 1
                        client.ws_token = f"session-{credential}"
                    else:
                        self.fail(f"unknown closeSequences step: {step}")

                self.assertEqual(len(notified), case["tokenExpiredNotifications"])
                if "subscriptionErrors" in case:
                    self.assertEqual(len(errors), case["subscriptionErrors"])

    def test_whisper_frames_join_send_and_deliver(self):
        covers("whisper_frames_join_send_and_deliver")
        whisper = FRAMES["whisperFrames"]

        self.assertEqual(build_whisper_subscribe_frame("room:general"), CLIENT_FRAMES["whisper-subscribe"])
        self.assertEqual(build_whisper_unsubscribe_frame("room:general"), CLIENT_FRAMES["whisper-unsubscribe"])
        self.assertEqual(build_whisper_frame("room:general", encode_wire({"text": "hi"})), CLIENT_FRAMES["whisper-send"])

        sent: list = []
        client = _client()
        client.attach_socket(sent.append)
        leave = client.whisper_subscribe("room:general", lambda _value: None)
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-subscribe"])
        self.assertTrue(client.whisper("room:general", {"text": "hi"}))
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-send"])
        leave()
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-unsubscribe"])

        for case in whisper["serverFrames"]:
            with self.subTest(case=case["name"]):
                delivered: list = []
                receiver = _client()
                receiver.whisper_subscribe("room:general", delivered.append)
                receiver.handle_frame(case["frame"])
                expected = [item["value"] for item in case["delivered"] if item["topic"] == "room:general"]
                self.assertEqual(delivered, expected)

    def test_whisper_topics_rejoin_after_reconnect(self):
        covers("whisper_topics_rejoin_after_reconnect")
        rejoin = FRAMES["whisperFrames"]["rejoinOnReconnect"]

        client = _client(ws_token="session-token")
        for topic in rejoin:
            client.whisper_subscribe(topic, lambda _value: None)

        for attach in range(2):
            with self.subTest(attach=attach):
                sent: list = []
                client.attach_socket(sent.append)
                self.assertEqual(sent[0]["type"], "connect")
                self.assertEqual(sent[1:], [{"topic": topic, "type": "whisper_subscribe"} for topic in rejoin])
                client.detach_socket()


class TestSocketSessionBehaviour(unittest.TestCase):
    def test_a_whisper_sent_while_detached_is_refused_not_queued(self):
        client = _client()
        self.assertFalse(client.whisper("room:general", {"text": "hi"}))

        sent: list = []
        client.attach_socket(sent.append)
        self.assertEqual([frame["type"] for frame in sent], ["connect"])

    def test_one_join_per_topic_and_the_last_leave_sends_unsubscribe(self):
        sent: list = []
        client = _client()
        client.attach_socket(sent.append)

        first = client.whisper_subscribe("room:general", lambda _value: None)
        second = client.whisper_subscribe("room:general", lambda _value: None)
        self.assertEqual(sum(frame["type"] == "whisper_subscribe" for frame in sent), 1)

        first()
        self.assertNotIn(CLIENT_FRAMES["whisper-unsubscribe"], sent)
        second()
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-unsubscribe"])
        first()  # an unsubscribe is idempotent: it removes its own registration only
        self.assertEqual(sum(frame["type"] == "whisper_unsubscribe" for frame in sent), 1)

    def test_connect_room_joins_relays_and_leaves(self):
        sent: list = []
        client = _client()
        client.attach_socket(sent.append)

        room = client.connect_room("general", lambda _value: None)
        self.assertEqual(sent[-1], {"topic": "room:general", "type": "whisper_subscribe"})
        self.assertTrue(room.send({"text": "hi"}))
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-send"])
        room.close()
        self.assertEqual(sent[-1], CLIENT_FRAMES["whisper-unsubscribe"])

    def test_a_raising_token_expiry_listener_does_not_break_detach(self):
        ran: list = []

        def boom() -> None:
            raise RuntimeError("listener bug")

        client = _client(ws_token="session")
        client.on_token_expired(boom)
        client.on_token_expired(lambda: ran.append(1))
        client.attach_socket(lambda _frame: None)

        with self.assertLogs("lunora", level="ERROR"):
            client.detach_socket(4001, "")
        self.assertEqual(ran, [1])
        self.assertFalse(client.online)

    def test_a_raising_whisper_listener_does_not_break_the_frame_handler(self):
        def boom(_value) -> None:
            raise RuntimeError("listener bug")

        delivered: list = []
        client = _client()
        client.whisper_subscribe("room:general", boom)
        client.whisper_subscribe("room:general", delivered.append)

        with self.assertLogs("lunora", level="ERROR"):
            client.handle_frame({"type": "whisper", "topic": "room:general", "data": {"text": "x"}})
        self.assertEqual(delivered, [{"text": "x"}])

    def test_malformed_whispers_are_ignored_and_never_raise(self):
        delivered: list = []
        client = _client()
        client.whisper_subscribe("room:general", delivered.append)

        for frame in (
            {"type": "whisper", "topic": ""},
            {"type": "whisper", "topic": None, "data": 1},
            {"type": "whisper", "topic": 7, "data": 1},
            ["whisper"],
        ):
            with self.subTest(frame=frame):
                client.handle_frame(frame)
        self.assertEqual(delivered, [])


if __name__ == "__main__":
    unittest.main()
