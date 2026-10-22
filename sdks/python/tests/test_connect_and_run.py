"""The live socket loop — the one capability no conformance case can reach.

``protocol/conformance-cases.json`` may only require behaviour every port has,
and seven of the eight take their socket from the caller: their suites inject a
sender and never run a read loop at all. Python is the exception (see the
capability matrix's note ⁴ in ``sdks/README.md``), so the loop's own guarantees
are asserted here instead.

The ``websockets`` package is optional, so these tests stand a stub in for it in
``sys.modules``: what is under test is ``connect_and_run``'s own scheduling, not
that library's framing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import threading
import types
import unittest
import unittest.mock
from typing import Optional
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import MAX_WS_FRAME_BYTES, LunoraClient
from lunora.offline import OfflineQueue
from lunora.submit import SubmitOptions

# Generous: every wait below is satisfied in microseconds when the loop is
# correct, and this only bounds how long a REGRESSION hangs the suite.
TIMEOUT = 5.0


class _FakeConnectionClosedError(Exception):
    """Stands in for websockets' ``ConnectionClosedError``: the server's close frame is on ``rcvd``."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(f"closed {code}")
        self.rcvd = types.SimpleNamespace(code=code, reason=reason)


class _UpgradeRefusedError(Exception):
    """Stands in for websockets' ``InvalidStatus``: the upgrade was answered with an HTTP status."""

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.response = types.SimpleNamespace(status_code=status)


class _FakeSocket:
    """A ``websockets`` connection that records sends and is fed inbound frames."""

    def __init__(self, fail_on: int = -1) -> None:
        self.sent: list = []
        self.inbound: asyncio.Queue = asyncio.Queue()
        self._fail_on = fail_on
        self._sent_waiters: list = []

    def sent_at_least(self, count: int) -> asyncio.Event:
        """An event set once ``count`` frames have been written."""

        event = asyncio.Event()
        self._sent_waiters.append((count, event))
        if len(self.sent) >= count:
            event.set()
        return event

    async def send(self, raw: str) -> None:
        if len(self.sent) == self._fail_on:
            raise ConnectionResetError("socket went away mid-write")
        self.sent.append(json.loads(raw))
        for count, event in self._sent_waiters:
            if len(self.sent) >= count:
                event.set()

    def __aiter__(self) -> _FakeSocket:
        return self

    async def __anext__(self) -> str:
        raw = await self.inbound.get()
        if raw is None:
            raise StopAsyncIteration
        if isinstance(raw, BaseException):
            raise raw
        return raw

    def close(self, code: Optional[int] = None, reason: str = "") -> None:
        """End the stream; a ``code`` ends it the way a server close frame does."""
        self.inbound.put_nowait(None if code is None else _FakeConnectionClosedError(code, reason))


class _FakeWebsockets:
    """Stands in for the optional ``websockets`` module."""

    def __init__(self, socket: _FakeSocket) -> None:
        self._socket = socket
        self.urls: list = []
        self.options: list = []

    def connect(self, url: str, **options: object) -> _FakeWebsockets:
        self.urls.append(url)
        self.options.append(options)
        return self

    async def __aenter__(self) -> _FakeSocket:
        return self._socket

    async def __aexit__(self, *_: object) -> bool:
        return False


class _FakeHandle:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class _FakeClock:
    """A monotonic clock plus ``call_later`` that only move when told to."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.timers: list = []
        self.delays: list = []

    def monotonic(self) -> float:
        return self.now

    def call_later(self, delay: float, callback) -> _FakeHandle:
        handle = _FakeHandle()
        self.delays.append(delay)
        self.timers.append((self.now + delay, callback, handle))
        return handle

    def advance(self, seconds: float) -> None:
        self.now += seconds
        due = [timer for timer in self.timers if timer[0] <= self.now + 1e-9 and not timer[2].cancelled]
        self.timers = [timer for timer in self.timers if timer not in due and not timer[2].cancelled]
        for _, callback, _ in due:
            callback()


async def _wait_for(predicate) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), TIMEOUT)


class TestConnectAndRun(unittest.IsolatedAsyncioTestCase):
    def _install(self, socket: _FakeSocket) -> _FakeWebsockets:
        self._saved = sys.modules.get("websockets")
        fake = _FakeWebsockets(socket)
        sys.modules["websockets"] = fake
        self.addCleanup(self._restore)
        return fake

    def _restore(self) -> None:
        if self._saved is None:
            sys.modules.pop("websockets", None)
        else:
            sys.modules["websockets"] = self._saved

    async def test_an_outbound_frame_is_written_while_the_server_is_idle(self):
        """A subscribe issued after connect must not wait on an INBOUND frame.

        Draining the outbox only after each inbound frame starves a client whose
        server has nothing to say — and a server with no subscriptions has
        exactly nothing to say, so the subscribe that would have given it
        something sat in memory forever. Measured against a real ``websockets``
        server before the fix: zero subscribe frames after three idle seconds,
        one the instant an unrelated frame arrived.
        """

        socket = _FakeSocket()
        self._install(socket)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: socket.sent)
        self.assertEqual(socket.sent[0]["type"], "connect")

        client.subscribe("messages:list", {"channel": "general"}, lambda _: None)

        # Nothing is fed to `socket.inbound`: this wait is the assertion.
        await _wait_for(lambda: len(socket.sent) > 1)
        self.assertEqual([frame["type"] for frame in socket.sent], ["connect", "subscribe"])

        # And the order survives a burst, which is what one writer draining one
        # FIFO buys over a task per frame.
        client.subscribe("messages:list", {"channel": "other"}, lambda _: None)
        client.subscribe("messages:list", {"channel": "third"}, lambda _: None)

        await _wait_for(lambda: len(socket.sent) == 4)
        self.assertEqual([frame["id"] for frame in socket.sent[1:]], ["sub_1", "sub_2", "sub_3"])

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

        # The writer does not outlive the socket: the client is offline, and a
        # frame produced now goes nowhere near a closed connection.
        self.assertFalse(client.online)

    async def test_the_session_credential_rides_connect_and_never_the_url(self):
        """The session value goes in the first ``connect`` frame; ``?token=`` is the ticket only.

        Proxies and edge logs record the URL on every open, so the session
        credential must not be part of it. Fails on any build that appends the
        session value to the URL.
        """

        socket = _FakeSocket()
        fake = self._install(socket)

        client = LunoraClient("http://example.invalid", ws_token="sess-SECRET-1", ws_ticket="tkt-1")
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: socket.sent)
        self.assertEqual(socket.sent[0]["type"], "connect")
        self.assertEqual(socket.sent[0]["token"], "sess-SECRET-1")
        self.assertEqual(parse_qs(urlsplit(fake.urls[0]).query), {"token": ["tkt-1"]})
        self.assertNotIn("sess-SECRET-1", fake.urls[0])

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_reconnect_resolves_both_credentials_again_and_keeps_the_session_out_of_the_url(self):
        """Each open re-resolves the session (sync) and the ticket (async), and only the ticket is in the URL."""

        minted = {"n": 0}

        def session() -> str:
            minted["n"] += 1
            return f"sess-SECRET-{minted['n']}"

        async def ticket() -> str:
            return f"tkt-{minted['n']}"

        first = _FakeSocket()
        fake = self._install(first)
        client = LunoraClient("http://example.invalid", ws_token=session, ws_ticket=ticket)

        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: first.sent)
        first.close()
        await asyncio.wait_for(run, TIMEOUT)

        second = _FakeSocket()
        fake._socket = second
        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: second.sent)
        second.close()
        await asyncio.wait_for(run, TIMEOUT)

        self.assertEqual(len(fake.urls), 2)
        self.assertEqual(second.sent[0]["type"], "connect")
        self.assertEqual(second.sent[0]["token"], "sess-SECRET-2")
        self.assertEqual(parse_qs(urlsplit(fake.urls[1]).query), {"token": ["tkt-2"]})
        for url in fake.urls:
            self.assertNotIn("SECRET", url)

    def test_a_stale_token_on_the_configured_url_never_reaches_the_upgrade(self):
        """A ``token`` already on ``ws_url`` is a stale credential; the upgrade carries only the ticket.

        Proxies record the URL on every open, so a session bearer left in
        ``ws_url`` must not ride the upgrade, with or without a ticket.
        """

        client = LunoraClient("http://example.invalid", ws_url="wss://app.example/_lunora/ws?token=old-session&x=1")

        self.assertNotIn("old-session", client.ws_url_for(None, None))
        self.assertNotIn("old-session", client.ws_url_for("room-1", "tkt-1"))
        self.assertEqual(client.ws_url_for(None, None), "wss://app.example/_lunora/ws?x=1")

    async def test_connect_omits_token_when_no_session_credential_is_held(self):
        """With no session credential, ``connect`` carries no ``token`` key and the URL has no query."""

        socket = _FakeSocket()
        fake = self._install(socket)

        client = LunoraClient("http://example.invalid", ws_token=lambda: None)
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: socket.sent)
        self.assertEqual(socket.sent[0]["type"], "connect")
        self.assertNotIn("token", socket.sent[0])
        self.assertEqual(parse_qs(urlsplit(fake.urls[0]).query), {})

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_session_provider_that_raises_fails_the_attempt_without_a_socket(self):
        """A session credential that cannot be resolved fails the attempt: no socket opens and no frame is sent.

        A tokenless socket would be refused with 4003 on a deployment that requires the
        credential, or admitted as anonymous on one that does not. Failing and letting the
        reconnect backoff re-resolve the credential is what the TS client does.
        """

        socket = _FakeSocket()
        fake = self._install(socket)

        def failing_provider():
            raise RuntimeError("mint endpoint down")

        client = LunoraClient("http://example.invalid", ws_token=failing_provider)

        with self.assertRaises(RuntimeError):
            await asyncio.wait_for(client.connect_and_run(), TIMEOUT)

        self.assertEqual(fake.urls, [], "no socket URL is dialed")
        self.assertEqual(socket.sent, [], "no frame, connect included, is sent")
        self.assertFalse(client.online)

    async def test_a_server_close_code_is_classified_on_detach_through_connect_and_run(self):
        """The close frame rides the ``ConnectionClosed`` out of the read loop and reaches detach.

        A 4001 always notifies. A 4003 notifies once per credential, and a rotation re-arms
        it. The connect deadline refuses no credential and notifies nothing.
        """

        fake = self._install(_FakeSocket())
        client = LunoraClient("http://example.invalid", ws_token="session-1")
        notified: list = []
        client.on_token_expired(lambda: notified.append(1))

        steps = [
            ("token-expired", 4001, "", 1),
            ("connect deadline", 4003, "connect deadline", 1),
            ("refused", 4003, "refused", 2),
            ("refused again, same credential", 4003, "refused", 2),
            ("refused after a rotation", None, None, 2),
            ("refused under the new credential", 4003, "refused", 3),
        ]
        for name, code, reason, expected in steps:
            with self.subTest(step=name):
                if code is None:
                    client.ws_token = "session-2"
                    continue
                socket = _FakeSocket()
                fake._socket = socket
                run = asyncio.ensure_future(client.connect_and_run())
                await _wait_for(lambda sock=socket: sock.sent)
                self.assertEqual([frame["type"] for frame in socket.sent], ["connect"])
                socket.close(code, reason)
                with self.assertRaises(_FakeConnectionClosedError):
                    await asyncio.wait_for(run, TIMEOUT)
                self.assertFalse(client.online)
                self.assertEqual(len(notified), expected)

    async def test_a_503_at_upgrade_is_retried_with_backoff_and_refuses_no_credential(self):
        """A 503 is transient (protocol/README.md 6): back off and retry; it is not a credential refusal."""

        socket = _FakeSocket()
        fake = self._install(socket)
        attempts: list = []

        def connect(url, **_options):
            attempts.append(url)
            if len(attempts) == 1:
                raise _UpgradeRefusedError(503)
            return fake

        fake.connect = connect
        notified: list = []
        delays: list = []

        async def sleep(seconds):
            delays.append(seconds)

        client = LunoraClient("http://example.invalid", ws_token="session-1")
        client.on_token_expired(lambda: notified.append(1))
        with self.assertLogs("lunora", level="WARNING"):
            run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep, rand=lambda: 1.0))
            await _wait_for(lambda: socket.sent)

        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(delays), 1)
        self.assertEqual(notified, [])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_failing_send_surfaces_instead_of_stranding_the_writer(self):
        """A lost frame must end the run, not leave a dead writer under a live reader.

        The read loop would otherwise keep dispatching as though the client were
        still connected, while every outbound frame piled up in an outbox nobody
        drains — the starvation this loop was rewritten to remove, restored by a
        single failed write.
        """

        socket = _FakeSocket(fail_on=1)
        self._install(socket)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: socket.sent)
        client.subscribe("messages:list", {"channel": "general"}, lambda _: None)

        with self.assertRaises(ConnectionResetError):
            await asyncio.wait_for(run, TIMEOUT)

        self.assertFalse(client.online)

    async def test_a_deeply_nested_frame_does_not_end_the_read_loop(self):
        """CPython raises ``RecursionError`` on deep nesting; it is a malformed frame."""

        socket = _FakeSocket()
        self._install(socket)

        client = LunoraClient("http://example.invalid")
        values = client.stream("messages:list", {})
        run = asyncio.ensure_future(client.connect_and_run())

        await asyncio.wait_for(socket.sent_at_least(2).wait(), TIMEOUT)
        socket.inbound.put_nowait("[" * 2000)
        socket.inbound.put_nowait(json.dumps({"data": 7, "id": "sub_1", "type": "data"}))
        self.assertEqual(await asyncio.wait_for(values.__anext__(), TIMEOUT), 7)

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_raising_callback_is_logged_and_the_loop_continues(self):
        socket = _FakeSocket()
        self._install(socket)

        client = LunoraClient("http://example.invalid")
        seen = []
        second_seen = asyncio.Event()

        def on_data(value):
            seen.append(value)
            if value == 2:
                second_seen.set()
            if value == 1:
                raise ValueError("consumer bug")

        client.subscribe("messages:list", {}, on_data)
        run = asyncio.ensure_future(client.connect_and_run())

        await asyncio.wait_for(socket.sent_at_least(2).wait(), TIMEOUT)
        with self.assertLogs("lunora", level="ERROR") as logs:
            socket.inbound.put_nowait(json.dumps({"data": 1, "id": "sub_1", "type": "data"}))
            socket.inbound.put_nowait(json.dumps({"data": 2, "id": "sub_1", "type": "data"}))
            await asyncio.wait_for(second_seen.wait(), TIMEOUT)

        self.assertIn("lunora: subscription callback raised", logs.output[0])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_reconnect_forever_backs_off_between_runs(self):
        """A socket that closes twice then stays open is reconnected with growing delays."""

        sockets = [_FakeSocket(), _FakeSocket(), _FakeSocket()]
        fake = self._install(sockets[0])
        opened = []
        third_open = asyncio.Event()

        def connect(url, **_options):
            opened.append(url)
            fake._socket = sockets[len(opened) - 1]
            if len(opened) == 3:
                third_open.set()
            return fake

        fake.connect = connect
        sockets[0].close()
        sockets[1].close()

        delays = []

        async def sleep(seconds):
            delays.append(seconds)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep, rand=lambda: 1.0))

        await asyncio.wait_for(third_open.wait(), TIMEOUT)
        self.assertEqual(delays, [1.0, 2.0])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_reconnect_forever_retries_runtime_errors_and_close_wakes_backoff(self):
        """A ``RuntimeError`` from the socket is retried; ``close()`` ends a pending backoff."""

        fake = self._install(_FakeSocket())
        opened = []

        def connect(url, **_options):
            opened.append(url)
            raise RuntimeError("socket exploded")

        fake.connect = connect
        slept = asyncio.Event()

        async def sleep(_seconds):
            slept.set()
            await asyncio.Event().wait()  # only close() can end this run

        client = LunoraClient("http://example.invalid")
        with self.assertLogs("lunora", level="WARNING"):
            run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep))
            await asyncio.wait_for(slept.wait(), TIMEOUT)
            self.assertEqual(len(opened), 1)
            client.close()
            await asyncio.wait_for(run, TIMEOUT)

    async def test_reconnect_forever_does_not_reset_backoff_on_unrecognised_frames(self):
        """JSON that is not a server frame does not prove a healthy connection."""

        sockets = [_FakeSocket(), _FakeSocket(), _FakeSocket()]
        fake = self._install(sockets[0])
        opened = []
        third_open = asyncio.Event()

        def connect(url, **_options):
            opened.append(url)
            fake._socket = sockets[len(opened) - 1]
            if len(opened) == 3:
                third_open.set()
            return fake

        fake.connect = connect
        for socket in sockets[:2]:
            socket.inbound.put_nowait("null")
            socket.inbound.put_nowait(json.dumps({"type": "nonsense"}))
            socket.close()

        delays = []

        async def sleep(seconds):
            delays.append(seconds)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep, rand=lambda: 1.0))

        await asyncio.wait_for(third_open.wait(), TIMEOUT)
        self.assertEqual(delays, [1.0, 2.0])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_token_expired_frame_does_not_reset_the_backoff(self):
        """TOKEN_EXPIRED arrives just before a 4001 close: counting it as liveness retries at the initial delay forever."""

        sockets = [_FakeSocket(), _FakeSocket(), _FakeSocket()]
        fake = self._install(sockets[0])
        opened = []
        third_open = asyncio.Event()

        def connect(url, **_options):
            opened.append(url)
            fake._socket = sockets[len(opened) - 1]
            if len(opened) == 3:
                third_open.set()
            return fake

        fake.connect = connect
        for socket in sockets[:2]:
            socket.inbound.put_nowait(json.dumps({"type": "error", "error": {"code": "TOKEN_EXPIRED"}}))
            socket.close(4001, "")

        delays = []

        async def sleep(seconds):
            delays.append(seconds)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep, rand=lambda: 1.0))

        await asyncio.wait_for(third_open.wait(), TIMEOUT)
        self.assertEqual(delays, [1.0, 2.0])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_reconnect_forever_propagates_a_failing_sleep(self):
        """A sleeper that raises ends the loop instead of being swallowed."""

        socket = _FakeSocket()
        self._install(socket)
        socket.close()

        async def sleep(_seconds):
            raise ValueError("sleeper broke")

        client = LunoraClient("http://example.invalid")
        with self.assertRaises(ValueError):
            await asyncio.wait_for(client.reconnect_forever(sleep=sleep), TIMEOUT)

    async def test_reconnect_forever_cancellation_finishes_the_sleepers_cleanup(self):
        """Cancelling during backoff awaits the sleeper's own cancellation handler."""

        socket = _FakeSocket()
        self._install(socket)
        socket.close()
        started = asyncio.Event()
        cleaned = []

        async def sleep(_seconds):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.sleep(0)
                cleaned.append(True)
                raise

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.reconnect_forever(sleep=sleep))
        await asyncio.wait_for(started.wait(), TIMEOUT)
        run.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await run
        self.assertEqual(cleaned, [True])

    async def test_overlapping_socket_runs_are_refused(self):
        """A second run must not replace the first run's sender and then clear it."""

        socket = _FakeSocket()
        fake = self._install(socket)
        client = LunoraClient("http://example.invalid")

        first = asyncio.ensure_future(client.connect_and_run())
        # The connect frame is written right after the sender attaches.
        await asyncio.wait_for(socket.sent_at_least(1).wait(), TIMEOUT)

        # Bounded, so a missing guard fails with a timeout instead of hanging the suite.
        with self.assertRaises(RuntimeError):
            await asyncio.wait_for(client.connect_and_run(), TIMEOUT)
        self.assertTrue(client.online, "the refused run must leave the live sender in place")

        socket.close()
        await asyncio.wait_for(first, TIMEOUT)

        # Once the first run has ended, a new run is allowed again.
        second = _FakeSocket()
        fake._socket = second
        second.close()
        await asyncio.wait_for(client.connect_and_run(), TIMEOUT)

    async def test_reconnect_forever_raises_when_a_run_is_already_active(self):
        """Starting a loop over a live run is a caller error, so it is not retried."""
        from lunora.client import SocketRunInProgressError

        socket = _FakeSocket()
        self._install(socket)
        client = LunoraClient("http://example.invalid")

        first = asyncio.ensure_future(client.connect_and_run())
        await asyncio.wait_for(socket.sent_at_least(1).wait(), TIMEOUT)

        with self.assertRaises(SocketRunInProgressError):
            await asyncio.wait_for(client.reconnect_forever(), TIMEOUT)

        socket.close()
        await asyncio.wait_for(first, TIMEOUT)

    async def test_a_failed_connect_frees_the_run_slot(self):
        fake = self._install(_FakeSocket())

        def refuse(_url, **_options):
            raise OSError("connection refused")

        fake.connect = refuse
        client = LunoraClient("http://example.invalid")
        with self.assertRaises(OSError):
            await client.connect_and_run()

        fake.connect = lambda _url, **_options: fake
        socket = _FakeSocket()
        fake._socket = socket
        socket.close()
        await asyncio.wait_for(client.connect_and_run(), TIMEOUT)

    async def test_a_failed_resend_detaches_the_sender(self):
        """Setup that fails after the sender is attached must not leave it attached."""

        socket = _FakeSocket()
        self._install(socket)
        socket.close()

        client = LunoraClient("http://example.invalid")

        def broken_resend():
            raise RuntimeError("resend broke")

        client.resend_subscriptions = broken_resend
        with self.assertRaises(RuntimeError):
            await asyncio.wait_for(client.connect_and_run(), TIMEOUT)
        self.assertFalse(client.online)

    def test_subscribe_refuses_unencodable_args_without_registering(self):
        """A subscription the wire cannot encode fails at subscribe, not on every resend."""

        client = LunoraClient("http://example.invalid")
        with self.assertRaises(TypeError):
            client.subscribe("messages:list", {"when": object()}, lambda _value: None)
        self.assertEqual(client._subs, {})

    def test_subscribe_shape_refuses_unencodable_args_without_registering(self):
        client = LunoraClient("http://example.invalid")
        with self.assertRaises(TypeError):
            client.subscribe_shape("roomMessages", {"when": object()}, lambda _rows: None)
        self.assertEqual(client._shapes, {})

    def test_a_raising_close_hook_is_labelled_as_a_close_hook(self):
        from lunora.client import _run_callbacks

        def boom():
            raise ValueError("hook bug")

        with self.assertLogs("lunora", level="ERROR") as logs:
            _run_callbacks([boom], "close hook")
        self.assertIn("lunora: close hook raised", logs.output[0])

    async def test_reconnect_forever_raises_when_websockets_is_missing(self):
        from lunora.client import WebsocketsMissingError

        with unittest.mock.patch.dict(sys.modules, {"websockets": None}), self.assertRaises(WebsocketsMissingError):
            await LunoraClient("http://example.invalid").reconnect_forever()

    async def test_close_returns_the_run_and_ends_every_stream(self):
        """``close()`` must end the loop, not leave it delivering to a dead client."""

        socket = _FakeSocket()
        self._install(socket)

        client = LunoraClient("http://example.invalid")
        values = client.stream("messages:list", {})
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: len(socket.sent) >= 2)
        socket.inbound.put_nowait(json.dumps({"data": 1, "id": "sub_1", "type": "data"}))
        self.assertEqual(await asyncio.wait_for(values.__anext__(), TIMEOUT), 1)

        client.close()

        # Nothing is fed to `socket.inbound`: returning is the assertion.
        await asyncio.wait_for(run, TIMEOUT)
        with self.assertRaises(StopAsyncIteration):
            await asyncio.wait_for(values.__anext__(), TIMEOUT)
        self.assertFalse(client.online)

    async def test_a_new_token_replays_a_write_held_for_its_credential(self):
        """A write refused ``TOKEN_EXPIRED`` is held; the next token replays it.

        This loop flushes when its socket connects, and a healthy socket never
        connects again, so without a flush on the new token the held write
        waited for a disconnect that might never come.
        """

        socket = _FakeSocket()
        self._install(socket)
        headers = []

        def post(_url, sent, _body):
            headers.append(sent.get("authorization"))
            if sent.get("authorization") == "Bearer stale":
                return 401, {"error": {"code": "TOKEN_EXPIRED", "message": "token expired"}}
            return 200, {"result": None}

        client = LunoraClient("http://example.invalid", auth_token="stale", identity="user-a", http_post=post)
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: headers)
        self.assertEqual(client.pending_mutation_count, 1, "the refused write is held")

        client.auth_token = "fresh"
        with contextlib.suppress(asyncio.TimeoutError):
            await _wait_for(lambda: len(headers) == 2)
        self.assertEqual(headers, ["Bearer stale", "Bearer fresh"])
        await _wait_for(lambda: client.pending_mutation_count == 0)

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_token_set_while_the_stale_request_is_in_flight_is_not_lost(self):
        """The refresh lands while the flush still holds the write it drained.

        A second flush started then finds the queue empty, and the first one
        puts the refused write back after it has finished, so nothing is left
        to replay it. The running flush must run again instead.
        """

        socket = _FakeSocket()
        self._install(socket)
        headers = []
        client = None

        def post(_url, sent, _body):
            headers.append(sent.get("authorization"))
            if sent.get("authorization") == "Bearer stale":
                client.auth_token = "fresh"  # lands mid-request
                return 401, {"error": {"code": "TOKEN_EXPIRED", "message": "token expired"}}
            return 200, {"result": None}

        client = LunoraClient("http://example.invalid", auth_token="stale", identity="user-a", http_post=post)
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())

        with contextlib.suppress(asyncio.TimeoutError):
            await _wait_for(lambda: len(headers) == 2)
        self.assertEqual(headers, ["Bearer stale", "Bearer fresh"])
        await _wait_for(lambda: client.pending_mutation_count == 0)

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_new_token_without_an_identity_rejects_the_held_write(self):
        """With no identity set, the identity is the token's digest.

        So a new token is someone else as far as the gate can tell: the flush it
        starts rejects user A's held write instead of sending it with user B's
        credential, as the reference rejects it.
        """

        socket = _FakeSocket()
        self._install(socket)
        headers = []

        def post(_url, sent, _body):
            headers.append(sent.get("authorization"))
            if sent.get("authorization") == "Bearer token-a":
                return 401, {"error": {"code": "TOKEN_EXPIRED", "message": "token expired"}}
            return 200, {"result": None}

        client = LunoraClient("http://example.invalid", auth_token="token-a", http_post=post)
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        settled = []
        client.on_mutation_settled(settled.append)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: headers)
        client.auth_token = "token-b"
        await _wait_for(lambda: settled)
        self.assertEqual(headers, ["Bearer token-a"], "the held write never travels with another token")
        self.assertEqual(settled[0].error.code, "OFFLINE_IDENTITY_CHANGED")
        self.assertEqual(client.pending_mutation_count, 0)

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_clearing_the_token_does_not_replay_the_held_write(self):
        """A sign-out is not a fresh credential: nothing is sent without one."""

        socket = _FakeSocket()
        self._install(socket)
        headers = []

        def post(_url, sent, _body):
            headers.append(sent.get("authorization"))
            return 401, {"error": {"code": "TOKEN_EXPIRED", "message": "token expired"}}

        client = LunoraClient("http://example.invalid", auth_token="stale", identity="user-a", http_post=post)
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())

        await _wait_for(lambda: headers)
        client.auth_token = None
        await asyncio.sleep(0.2)
        self.assertEqual(headers, ["Bearer stale"])
        self.assertEqual(client.pending_mutation_count, 1)

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_failing_flush_after_a_token_change_is_logged(self):
        """The flush a token change starts has no awaiter, so its failure is logged."""

        socket = _FakeSocket()
        self._install(socket)
        client = LunoraClient("http://example.invalid", auth_token="stale", identity="user-a", http_post=lambda *_: (200, {"result": None}))
        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: socket.sent)

        async def broken(_shard_key=None):
            raise RuntimeError("flush blew up")

        client.flush_offline_queue = broken
        with self.assertLogs("lunora", level="WARNING") as logs:
            client.auth_token = "fresh"
            await asyncio.sleep(0.1)
        self.assertIn("flush blew up", "\n".join(logs.output))

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def _run_refused_once(self, refusals: list, identity="user-a", auth_token=None):
        """Connect with one queued write the server refuses with each of ``refusals``, then accepts.

        Returns ``(client, clock, posts, run, socket, settled)``. Time is a fake clock: the
        client's timer and the rate-limit window both read it, so nothing here
        waits in real time and every scheduled delay is observable.
        """

        socket = _FakeSocket()
        self._install(socket)
        clock = _FakeClock()
        # The module's `time` binding, not `time.monotonic` itself: asyncio's
        # own clock reads the latter, and freezing it freezes the event loop.
        patcher = unittest.mock.patch("lunora.submit.time", types.SimpleNamespace(monotonic=clock.monotonic))
        patcher.start()
        self.addCleanup(patcher.stop)
        posts = []

        def post(_url, headers, _body):
            posts.append(clock.now)
            self.bearers.append(headers.get("authorization"))
            return refusals[len(posts) - 1] if len(posts) <= len(refusals) else (200, {"result": None})

        self.bearers = []
        client = LunoraClient("http://example.invalid", identity=identity, auth_token=auth_token, http_post=post)
        client._call_later = clock.call_later
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        settled = []
        client.on_mutation_settled(settled.append)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: posts and clock.timers)

        return client, clock, posts, run, socket, settled

    async def test_a_hinted_rate_limit_is_retried_on_a_healthy_socket(self):
        """A 429 leaves the socket open, so nothing reconnects to flush again.

        The write must replay once the server's ``retryAfterMs`` has passed —
        not before it, and not never, which is what parking it did.
        """

        limited = (429, {"error": {"code": "TOO_MANY_REQUESTS", "message": "slow down", "data": {"retryAfterMs": 100}}})
        _client, clock, posts, run, socket, settled = await self._run_refused_once([limited])

        self.assertEqual(clock.delays, [0.1])
        clock.advance(0.099)
        await asyncio.sleep(0)
        self.assertEqual(len(posts), 1, "not before the hint")

        clock.advance(0.001)
        await _wait_for(lambda: settled)
        self.assertEqual(settled[0].status, "committed")
        self.assertEqual(len(posts), 2)
        self.assertEqual(clock.timers, [], "a committed write schedules nothing more")

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_retry_flush_is_gated_on_the_token_like_any_other(self):
        """A retry is an ordinary flush pass: it judges the write against the token held NOW.

        With no identity the write is stamped with token-a's digest. The token is
        cleared while the retry is armed (which flushes nothing by itself), so the
        retry cannot tell whose write it is and holds it rather than sending it
        with no bearer; the same token set again replays it with that token.
        """

        unavailable = (503, {"error": {"code": "SHARD_UNAVAILABLE", "message": "try again"}})
        client, clock, posts, run, socket, settled = await self._run_refused_once([unavailable], identity=None, auth_token="token-a")

        client.auth_token = None
        clock.advance(clock.delays[0])
        await asyncio.sleep(0.05)
        self.assertEqual((len(posts), settled), (1, []), "held: the retry sends nothing")
        self.assertEqual(client.pending_mutation_count, 1)

        client.auth_token = "token-a"
        await _wait_for(lambda: settled)
        self.assertEqual(settled[0].status, "committed")
        self.assertEqual(self.bearers, ["Bearer token-a", "Bearer token-a"])

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_hintless_refusal_backs_off_with_jitter(self):
        """No hint still needs a retry: a bounded, jittered, growing backoff."""

        unavailable = (503, {"error": {"code": "SHARD_UNAVAILABLE", "message": "try again"}})
        _client, clock, posts, run, socket, settled = await self._run_refused_once([unavailable, unavailable])

        clock.advance(clock.delays[0])
        await _wait_for(lambda: len(clock.delays) == 2)
        clock.advance(clock.delays[1])
        await _wait_for(lambda: settled)
        self.assertEqual(settled[0].status, "committed")

        self.assertEqual(len(posts), 3)
        self.assertTrue(0.5 <= clock.delays[0] <= 1.0, clock.delays)
        self.assertTrue(1.0 <= clock.delays[1] <= 2.0, clock.delays)

        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

    async def test_a_refusal_never_retries_in_a_hot_loop(self):
        """Every retry waits for its timer: one pending timer, one post per firing."""

        unavailable = (503, {"error": {"code": "SHARD_UNAVAILABLE", "message": "try again"}})
        client, clock, posts, run, _socket, settled = await self._run_refused_once([unavailable] * 50)

        for fired in range(1, 9):
            self.assertEqual(len(clock.timers), 1)
            await asyncio.sleep(0.01)
            self.assertEqual(len(posts), fired, "nothing posts until the timer fires")
            clock.advance(clock.timers[0][0] - clock.now)
            await _wait_for(lambda fired=fired: len(posts) == fired + 1 and clock.timers)

        self.assertLessEqual(max(clock.delays), 60.0, "the backoff is bounded")
        self.assertEqual(settled, [])

        client.close()
        await asyncio.wait_for(run, TIMEOUT)
        self.assertTrue(all(handle.cancelled for _, _, handle in clock.timers), "the timer dies with the socket")

    async def _retry_in_flight_when_the_run_ends(self, end: str):
        """A retry flush still waiting on its post when the run ends.

        The post is answered 503 only AFTER ``connect_and_run`` has returned, so
        whatever that late answer arms has no socket under it any more.
        """

        socket = _FakeSocket()
        self._install(socket)
        clock = _FakeClock()
        patcher = unittest.mock.patch("lunora.submit.time", types.SimpleNamespace(monotonic=clock.monotonic))
        patcher.start()
        self.addCleanup(patcher.stop)
        release = threading.Event()
        self.addCleanup(release.set)
        posts = []
        unavailable = (503, {"error": {"code": "SHARD_UNAVAILABLE", "message": "try again"}})

        def post(_url, _headers, _body):
            posts.append(clock.now)
            if len(posts) == 2:
                release.wait(TIMEOUT)
            return unavailable

        client = LunoraClient("http://example.invalid", identity="user-a", http_post=post)
        client._call_later = clock.call_later
        client.offline_queue = OfflineQueue(queue_before_first_connect=True)
        settled = []
        client.on_mutation_settled(settled.append)
        await client.submit(SubmitOptions("messages:send", {}))
        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: posts and clock.timers)

        clock.advance(clock.timers[0][0] - clock.now)
        await _wait_for(lambda: len(posts) == 2)

        if end == "socket":
            socket.close()
        else:
            client.close()
        await asyncio.wait_for(run, TIMEOUT)

        release.set()
        await asyncio.sleep(0.1)

        live = [timer for timer in clock.timers if not timer[2].cancelled]
        self.assertEqual(live, [], "no retry timer outlives connect_and_run")
        clock.advance(120.0)
        await asyncio.sleep(0.05)
        self.assertEqual(len(posts), 2, "and nothing posts without a socket")

        return client, settled

    async def test_a_retry_in_flight_when_the_socket_drops_arms_nothing(self):
        client, settled = await self._retry_in_flight_when_the_run_ends("socket")

        self.assertEqual(settled, [])
        self.assertEqual(client.pending_mutation_count, 1, "the write waits for the reconnect")

    async def test_a_retry_in_flight_when_the_client_closes_arms_nothing(self):
        client, settled = await self._retry_in_flight_when_the_run_ends("client")

        self.assertEqual([event.status for event in settled], ["rejected"], "the in-flight write is settled, once")
        self.assertEqual(settled[0].error.code, "CLIENT_CLOSED")
        self.assertEqual(client.pending_mutation_count, 0, "and never requeued into the closed queue")

    async def test_frames_past_the_library_default_size_are_accepted(self):
        """``websockets`` closes on any message over 1 MiB (1009) unless told otherwise.

        A query result or shape seed that size is re-sent on every reconnect, so
        with the default the client could never stay connected to it.
        """

        socket = _FakeSocket()
        fake = self._install(socket)

        client = LunoraClient("http://example.invalid")
        run = asyncio.ensure_future(client.connect_and_run())
        await _wait_for(lambda: socket.sent)
        socket.close()
        await asyncio.wait_for(run, TIMEOUT)

        self.assertEqual(fake.options, [{"max_size": MAX_WS_FRAME_BYTES}])
        self.assertEqual(MAX_WS_FRAME_BYTES, 32 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
