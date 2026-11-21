"""A reconnect re-sends its query subscriptions a few at a time, as the reference client does.

``RESUBSCRIBE_CONCURRENCY`` in ``packages/client/src/client-tuning.ts`` is the width: a
re-sent ``subscribe`` holds a slot until any frame bearing its id arrives, it is
unsubscribed, or ``RESUBSCRIBE_ACK_TIMEOUT`` passes with no reply. The timer that pulls
that deadline on a live socket is covered in ``test_connect_and_run.py``.
"""

from __future__ import annotations

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import RESUBSCRIBE_ACK_TIMEOUT, RESUBSCRIBE_CONCURRENCY, LunoraClient

SUBSCRIPTIONS = 7


def _subscribes(sent: list) -> list:
    return [frame["id"] for frame in sent if frame.get("type") == "subscribe"]


def _reconnected(count: int = SUBSCRIPTIONS):
    """A client holding ``count`` query subscriptions, re-attached to a fresh socket and resent."""

    client = LunoraClient("https://app.example", client_id="client-test")
    client.attach_socket(lambda _frame: None)
    for index in range(count):
        client.subscribe("messages:list", {"channel": f"c{index}"}, lambda _value: None, lambda _error: None)
    sent: list = []
    client.attach_socket(sent.append)
    sent.clear()
    client.resend_subscriptions()
    return client, sent


class TestResubscribePacing(unittest.TestCase):
    def test_only_the_window_goes_out_until_a_reply_arrives(self):
        self.assertEqual(RESUBSCRIBE_CONCURRENCY, 3, "the reference client's width")
        _client, sent = _reconnected()

        self.assertEqual(len(_subscribes(sent)), RESUBSCRIBE_CONCURRENCY)

    def test_any_frame_bearing_the_id_lets_the_next_one_out(self):
        client, sent = _reconnected()
        first, second, third = _subscribes(sent)

        client.handle_frame({"id": first, "type": "ack"})
        self.assertEqual(len(_subscribes(sent)), 4, "an ack frees its slot")

        client.handle_frame({"cursor": 1, "data": [], "id": second, "type": "data"})
        self.assertEqual(len(_subscribes(sent)), 5, "a data frame that overtakes the ack frees it too")

        client.handle_frame({"error": {"code": "FORBIDDEN", "message": "no"}, "id": third, "type": "error"})
        self.assertEqual(len(_subscribes(sent)), 6, "so does the error that refuses it")

        client.handle_frame({"id": first, "type": "ack"})
        self.assertEqual(len(_subscribes(sent)), 6, "a second frame for a released id frees nothing")

    def test_every_subscription_goes_out_exactly_once(self):
        client, sent = _reconnected()

        answered = 0
        while answered < len(_subscribes(sent)):
            client.handle_frame({"id": _subscribes(sent)[answered], "type": "ack"})
            answered += 1

        ids = _subscribes(sent)
        self.assertEqual(len(ids), SUBSCRIPTIONS)
        self.assertEqual(len(set(ids)), SUBSCRIPTIONS)

    def test_an_unsubscribe_skips_a_queued_one_and_frees_an_outstanding_one(self):
        client = LunoraClient("https://app.example", client_id="client-test")
        client.attach_socket(lambda _frame: None)
        unsubscribes = [client.subscribe("messages:list", {"channel": f"c{index}"}, lambda _value: None) for index in range(5)]
        sent: list = []
        client.attach_socket(sent.append)
        sent.clear()
        client.resend_subscriptions()
        outstanding = _subscribes(sent)

        unsubscribes[4]()
        self.assertEqual(len(_subscribes(sent)), 3, "a queued one is dropped, and frees no slot")

        unsubscribes[0]()
        self.assertEqual(len(_subscribes(sent)), 4, "an outstanding one will never be answered, so its slot goes on")
        self.assertNotIn("sub_5", _subscribes(sent))

        client.handle_frame({"id": outstanding[1], "type": "ack"})
        self.assertEqual(len(_subscribes(sent)), 4, "nothing is left to send")

    def test_an_unanswered_one_stops_holding_its_slot_after_the_timeout(self):
        before = time.monotonic()
        client, sent = _reconnected()
        after = time.monotonic()

        deadline = client.next_subscription_retry_at()
        self.assertIsNotNone(deadline)
        self.assertTrue(before + RESUBSCRIBE_ACK_TIMEOUT <= deadline <= after + RESUBSCRIBE_ACK_TIMEOUT)

        self.assertEqual(client.retry_due_subscriptions(deadline - 0.001), 0)
        self.assertEqual(len(_subscribes(sent)), 3)

        self.assertEqual(client.retry_due_subscriptions(deadline), RESUBSCRIBE_CONCURRENCY)
        self.assertEqual(len(_subscribes(sent)), 6)

    def test_a_reconnect_mid_drain_starts_a_fresh_window(self):
        client, sent = _reconnected()
        client.detach_socket()
        self.assertIsNone(client.next_subscription_retry_at(), "a dropped socket's slots are gone")

        resent: list = []
        client.attach_socket(resent.append)
        resent.clear()
        client.resend_subscriptions()

        self.assertEqual(len(_subscribes(resent)), RESUBSCRIBE_CONCURRENCY)
        client.handle_frame({"id": _subscribes(sent)[0], "type": "ack"})
        self.assertEqual(len(_subscribes(resent)), 4)

    def test_a_queued_one_carries_the_cursor_it_has_when_it_goes_out(self):
        client = LunoraClient("https://app.example", client_id="client-test", identity="alice")
        client.attach_socket(lambda _frame: None)
        for index in range(4):
            client.subscribe("messages:list", {"channel": f"c{index}"}, lambda _value: None)
            client.handle_frame({"cursor": 9, "data": [], "id": f"sub_{index + 1}", "type": "data"})
        sent: list = []
        client.attach_socket(sent.append)
        sent.clear()
        client.resend_subscriptions()
        client.identity = "bob"

        client.handle_frame({"id": "sub_1", "type": "ack"})
        late = next(frame for frame in sent if frame.get("id") == "sub_4")
        self.assertNotIn("sinceSeq", late["query"], "the new identity must not resume the old one's position")

    def test_shape_subscriptions_are_not_paced(self):
        client = LunoraClient("https://app.example", client_id="client-test")
        client.attach_socket(lambda _frame: None)
        for index in range(5):
            client.subscribe_shape("roomMessages", {"room": f"r{index}"}, lambda _rows: None)
        sent: list = []
        client.attach_socket(sent.append)
        sent.clear()
        client.resend_subscriptions()

        self.assertEqual(len([frame for frame in sent if frame.get("type") == "shape_subscribe"]), 5)


if __name__ == "__main__":
    unittest.main()
