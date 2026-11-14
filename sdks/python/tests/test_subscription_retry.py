"""A subscription error's ``retryAfterMs`` schedules one cold re-subscribe, pulled by the caller.

Driven through the port's own calls against ``subscriptionRetry`` in
``protocol/fixtures/ws-frames.json``. The timer that calls
``retry_due_subscriptions`` on a live socket is covered in ``test_connect_and_run.py``.
"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient, SubscriptionError
from lunora.wire import TAG
from tests._fixtures import load

RETRY = load("ws-frames.json")["subscriptionRetry"]
FAR_FUTURE = 3600.0


def _open():
    """An attached client holding one live ``messages:list`` subscription that has received ``seedFrame``."""

    sent: list = []
    errors: list = []
    client = LunoraClient("https://app.example", client_id="client-test")
    client.attach_socket(sent.append)
    unsubscribe = client.subscribe("messages:list", {"channel": "general"}, lambda _value: None, errors.append)
    client.handle_frame(RETRY["seedFrame"])
    sent.clear()
    return client, sent, errors, unsubscribe


def _subscribes(sent: list) -> list:
    return [frame for frame in sent if frame.get("type") == "subscribe"]


class TestSubscriptionRetry(unittest.TestCase):
    def test_re_subscribes_once_cold_at_the_hint(self):
        client, sent, _errors, _unsubscribe = _open()

        t0 = time.monotonic()
        client.handle_frame(RETRY["hintFrame"])
        t1 = time.monotonic()
        d = client.next_subscription_retry_at()

        self.assertIsNotNone(d)
        self.assertTrue(t0 + 5 <= d <= t1 + 5)
        self.assertEqual(client.retry_due_subscriptions(d - 0.001), 0)
        self.assertEqual(sent, [], "nothing is sent before the hint has elapsed")

        self.assertEqual(client.retry_due_subscriptions(d), 1)
        self.assertEqual(sent, [RETRY["retryFrame"]])

        self.assertEqual(client.retry_due_subscriptions(d + 60), 0, "the retry fires once")
        self.assertIsNone(client.next_subscription_retry_at())

    def test_the_error_still_reaches_the_callback_and_reports_the_hint(self):
        client, _sent, errors, _unsubscribe = _open()

        descriptor = client.handle_frame(RETRY["hintFrame"])

        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], SubscriptionError)
        self.assertEqual(errors[0].code, "SUBSCRIPTION_REFRESH_FAILED")
        self.assertEqual(descriptor["retryAfterMs"], RETRY["retryAfterMs"])

    def test_a_later_hint_replaces_the_pending_one(self):
        client, sent, _errors, _unsubscribe = _open()

        client.handle_frame(RETRY["hintFrame"])
        d1 = client.next_subscription_retry_at()
        client.handle_frame(RETRY["laterHintFrame"])
        d2 = client.next_subscription_retry_at()

        self.assertGreater(d2, d1)
        self.assertEqual(client.retry_due_subscriptions(d1), 0, "the earlier deadline was replaced")
        self.assertEqual(client.retry_due_subscriptions(d2), 1)
        self.assertEqual(sent, [RETRY["retryFrame"]])

    def test_each_cancel_frame_cancels(self):
        for case in RETRY["cancelFrames"]:
            with self.subTest(case=case["name"]):
                client, sent, _errors, _unsubscribe = _open()
                client.handle_frame(RETRY["hintFrame"])

                client.handle_frame(case["frame"])

                self.assertIsNone(client.next_subscription_retry_at())
                self.assertEqual(client.retry_due_subscriptions(time.monotonic() + FAR_FUTURE), 0)
                self.assertEqual(_subscribes(sent), [])

    def test_no_retry_frames_schedule_nothing(self):
        for case in RETRY["noRetryFrames"]:
            with self.subTest(case=case["name"]):
                client, sent, _errors, _unsubscribe = _open()

                client.handle_frame(case["frame"])

                self.assertIsNone(client.next_subscription_retry_at())
                self.assertEqual(client.retry_due_subscriptions(time.monotonic() + FAR_FUTURE), 0)
                self.assertEqual(_subscribes(sent), [])

    def test_unsubscribe_cancels(self):
        client, sent, _errors, unsubscribe = _open()
        client.handle_frame(RETRY["hintFrame"])

        unsubscribe()

        self.assertIsNone(client.next_subscription_retry_at())
        self.assertEqual(client.retry_due_subscriptions(time.monotonic() + FAR_FUTURE), 0)
        self.assertEqual(_subscribes(sent), [])

    def test_detach_cancels(self):
        client, _sent, _errors, _unsubscribe = _open()
        client.handle_frame(RETRY["hintFrame"])

        client.detach_socket()

        self.assertIsNone(client.next_subscription_retry_at())

    def test_attach_cancels(self):
        client, _sent, _errors, _unsubscribe = _open()
        client.handle_frame(RETRY["hintFrame"])
        second: list = []

        client.attach_socket(second.append)

        self.assertIsNone(client.next_subscription_retry_at())
        self.assertEqual(client.retry_due_subscriptions(time.monotonic() + FAR_FUTURE), 0)
        self.assertEqual(_subscribes(second), [])

    def test_close_cancels(self):
        client, _sent, _errors, _unsubscribe = _open()
        client.handle_frame(RETRY["hintFrame"])

        client.close()

        self.assertIsNone(client.next_subscription_retry_at())

    def test_a_shape_error_never_schedules(self):
        client, _sent, _errors, _unsubscribe = _open()
        client.subscribe_shape("messages", {}, lambda _rows: None)
        shape_error = {"id": "shape_1", "type": "error", "error": {"code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 5000}}

        client.handle_frame(shape_error)

        self.assertIsNone(client.next_subscription_retry_at())

    def test_the_hint_is_clamped(self):
        client, _sent, _errors, _unsubscribe = _open()
        frame = json.loads(json.dumps(RETRY["hintFrame"]))
        frame["error"]["retryAfterMs"] = 3600000

        client.handle_frame(frame)
        t1 = time.monotonic()
        d = client.next_subscription_retry_at()

        self.assertLessEqual(d, t1 + 60)

    def test_an_oversized_integer_hint_still_reports_the_error(self):
        client, _sent, errors, _unsubscribe = _open()
        frame = json.loads(json.dumps(RETRY["hintFrame"]))
        frame["error"]["retryAfterMs"] = 10**400

        client.handle_frame(frame)
        t1 = time.monotonic()

        self.assertEqual(len(errors), 1)
        self.assertLessEqual(client.next_subscription_retry_at(), t1 + 60)

    def test_a_data_frame_that_cannot_be_applied_keeps_the_retry(self):
        client, _sent, _errors, _unsubscribe = _open()
        client.handle_frame(RETRY["hintFrame"])

        client.handle_frame({"id": RETRY["subscriptionId"], "type": "data", "cursor": 13, "data": [TAG, "bigint", "not-a-number"]})

        self.assertIsNotNone(client.next_subscription_retry_at())

    def test_an_unsubscribe_that_overtakes_the_retry_is_followed_by_another(self):
        sent: list = []
        client = LunoraClient("https://app.example", client_id="client-test")
        unsubscribe_ref: list = []

        def sender(frame: dict) -> None:
            # Another thread unsubscribes after the retry was selected but before its frame is written.
            if frame.get("type") == "subscribe" and unsubscribe_ref:
                unsubscribe_ref.pop()()
            sent.append(frame)

        client.attach_socket(sender)
        unsubscribe_ref.append(client.subscribe("messages:list", {"channel": "general"}, lambda _value: None))
        client.handle_frame(RETRY["seedFrame"])
        unsubscribe = unsubscribe_ref.pop()
        client.handle_frame(RETRY["hintFrame"])
        d = client.next_subscription_retry_at()
        sent.clear()
        unsubscribe_ref.append(unsubscribe)

        client.retry_due_subscriptions(d)

        self.assertEqual([frame["type"] for frame in sent], ["unsubscribe", "subscribe", "unsubscribe"])


if __name__ == "__main__":
    unittest.main()
