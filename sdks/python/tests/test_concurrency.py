"""The topology every real consumer has: a socket read loop on one thread and
application code subscribing on others.

``subscribe``, ``subscribe_shape``, ``handle_frame`` and ``resend_subscriptions``
are plain synchronous methods, not coroutines, so this is genuinely several OS
threads and not several tasks on one event loop — which is why the client holds a
``threading.Lock`` and not an ``asyncio.Lock``.

The README used to call this client "safe by virtue of the GIL". The GIL makes
each bytecode atomic, not each statement, and measurement against the
unsynchronised client found two distinct failures here:

1. Walking ``_subs`` to build the reconnect resend while another thread inserts
   raises ``RuntimeError: dictionary changed size during iteration``. This fired
   on 10 of 10 runs at the stock 5ms switch interval, and in the real client that
   walk lives inside ``connect_and_run``, so the raise kills the read loop.
2. ``self._next_sub_id += 1`` followed by a separate read of it hands two threads
   the same id; the second ``self._subs[sub_id] = sub`` then silently forgets a
   live subscription. One unsynchronised run at the stock interval lost 830 of
   16,000 subscriptions.

Both are asserted below, and the COUNT assertion is the one that matches the Go,
Swift, Java, Kotlin and Ruby suites: a lost increment forgets a subscription,
which is checkable, where waiting for a dict to actually corrupt is not.

Two deliberate test conditions, both of which model real behaviour rather than
manufacture a failure:

- The injected sender yields with ``time.sleep(0)``. A real sender writes a frame
  to a socket, which blocks and releases the GIL; without that, CPU-bound threads
  can run start-to-finish inside a single switch interval and never interleave,
  and the test passes with the lock removed — which is to say it tests nothing.
- ``sys.setswitchinterval`` is lowered for the duration. This does not create the
  race — hazard 2 above was observed at the stock interval — it raises how often
  the existing window is sampled, so one 0.3s test run sees it instead of one run
  in several. It is the CPython counterpart of running the Swift suite under TSan,
  and it is restored in ``finally`` so it cannot leak into another test.

No ``tests._manifest.covers`` call: ``protocol/conformance-cases.json`` lists the
cases EVERY language must have, and the concurrency case is per-language by
construction (Go asserts on its race detector, Swift under TSan).
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient
from lunora.offline import CLIENT_CLOSED, OfflineError, OfflineQueue
from lunora.submit import SubmitOptions

THREADS = 4
PER_THREAD = 1000
STRESS_SWITCH_INTERVAL = 1e-6
CALLBACK_TIMEOUT = 5.0


class TestClientConcurrency(unittest.TestCase):
    def test_concurrent_subscribe_and_handle_frame(self):
        client = LunoraClient("https://app.example")
        client._send = lambda _frame: time.sleep(0)

        reader_failures: list[str] = []
        reading = True

        def read() -> None:
            try:
                while reading:
                    client.handle_frame({"cursor": 1, "data": 1, "id": "sub_1", "type": "data"})
                    # Exactly what connect_and_run does on reconnect: walk the
                    # registry and rebuild a resume frame per subscription.
                    client.resend_subscriptions()
            except Exception as exc:
                # Deliberately outside the loop, as in the client: that walk lives
                # inside connect_and_run, so a raise there takes the socket read
                # loop down with it rather than being retried.
                reader_failures.append(f"{type(exc).__name__}: {exc}")

        def work() -> None:
            for _ in range(PER_THREAD):
                client.subscribe("messages:list", None, lambda _value: None)

        previous_interval = sys.getswitchinterval()
        sys.setswitchinterval(STRESS_SWITCH_INTERVAL)
        try:
            reader = threading.Thread(target=read)
            reader.start()
            workers = [threading.Thread(target=work) for _ in range(THREADS)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            reading = False
            reader.join()
        finally:
            sys.setswitchinterval(previous_interval)

        self.assertEqual(reader_failures, [], "reading frames must not raise while other threads subscribe")

        # Counted through a resend rather than off the registry, so this asserts
        # what the socket would actually carry after a reconnect.
        resent: list[dict] = []
        client._send = resent.append
        client.resend_subscriptions()

        self.assertEqual(len(resent), THREADS * PER_THREAD, "every concurrent subscribe survived with a distinct id")


def _finishes(work) -> bool:
    """Whether ``work`` returns at all, rather than blocking forever.

    A deadlock is not an exception, so the assertion has to be a timeout: the
    work runs on its own daemon thread and the test fails if that thread is still
    inside the client when the clock runs out.
    """

    done = threading.Event()

    def run() -> None:
        work()
        done.set()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=CALLBACK_TIMEOUT)

    return done.is_set()


class TestConsumerCallbacksAreNotHeldUnderTheLock(unittest.TestCase):
    """``threading.Lock`` is not reentrant, so a consumer callback invoked inside
    the client's critical section hard-deadlocks the thread that called it the
    moment that callback touches the client it was handed."""

    def _client(self):
        client = LunoraClient("https://app.example", http_post=lambda _url, _headers, _body: (200, {"result": None}))
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)

        return client

    def test_an_optimistic_update_may_read_the_client_back(self):
        client = self._client()
        seen: list = []

        def update(store, _args):
            seen.append((client.pending_mutation_count, client.online))
            store.set_query("messages:list", {}, ["z"])

        submit = client.submit(SubmitOptions(args={}, function_path="messages:send", optimistic_update=update))

        self.assertTrue(_finishes(lambda: asyncio.run(submit)), "optimistic_update must run with the client's lock released")
        self.assertEqual(seen, [(0, False)])

    def test_a_precondition_may_read_the_client_back(self):
        client = self._client()
        seen: list = []

        def precondition() -> bool:
            seen.append(client.pending_mutation_count)

            return True

        asyncio.run(client.submit(SubmitOptions(args={}, function_path="messages:send", precondition=precondition)))
        client.attach_socket(lambda _frame: None)

        self.assertTrue(_finishes(lambda: asyncio.run(client.flush_offline_queue())), "a precondition must run with the client's lock released")
        self.assertEqual(seen, [1])

    def test_a_close_landing_mid_submit_strands_no_write(self):
        """A close racing a submit must not leave the write in the queue it emptied.

        Driven through ``optimistic_update`` because that callback runs in exactly
        the window the race needs — after the write was accepted, with the lock
        released, before the enqueue. Nothing flushes a closed client, so a write
        landing there is never sent, never settled and never rolled back, while
        ``submit`` reported it durably queued.
        """

        client = self._client()

        def update(_store, _args):
            client.close()

        submit = client.submit(SubmitOptions(args={}, function_path="messages:send", optimistic_update=update))

        with self.assertRaises(OfflineError) as raised:
            asyncio.run(submit)

        self.assertEqual(raised.exception.code, CLIENT_CLOSED)
        self.assertEqual(client.pending_mutation_count, 0)


if __name__ == "__main__":
    unittest.main()
