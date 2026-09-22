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
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient

# Generous: every wait below is satisfied in microseconds when the loop is
# correct, and this only bounds how long a REGRESSION hangs the suite.
TIMEOUT = 5.0


class _FakeSocket:
    """A ``websockets`` connection that records sends and is fed inbound frames."""

    def __init__(self, fail_on: int = -1) -> None:
        self.sent: list = []
        self.inbound: asyncio.Queue = asyncio.Queue()
        self._fail_on = fail_on

    async def send(self, raw: str) -> None:
        if len(self.sent) == self._fail_on:
            raise ConnectionResetError("socket went away mid-write")
        self.sent.append(json.loads(raw))

    def __aiter__(self) -> _FakeSocket:
        return self

    async def __anext__(self) -> str:
        raw = await self.inbound.get()
        if raw is None:
            raise StopAsyncIteration
        return raw

    def close(self) -> None:
        self.inbound.put_nowait(None)


class _FakeWebsockets:
    """Stands in for the optional ``websockets`` module."""

    def __init__(self, socket: _FakeSocket) -> None:
        self._socket = socket
        self.urls: list = []

    def connect(self, url: str) -> _FakeWebsockets:
        self.urls.append(url)
        return self

    async def __aenter__(self) -> _FakeSocket:
        return self._socket

    async def __aexit__(self, *_: object) -> bool:
        return False


async def _wait_for(predicate) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), TIMEOUT)


class TestConnectAndRun(unittest.IsolatedAsyncioTestCase):
    def _install(self, socket: _FakeSocket) -> None:
        self._saved = sys.modules.get("websockets")
        sys.modules["websockets"] = _FakeWebsockets(socket)
        self.addCleanup(self._restore)

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


if __name__ == "__main__":
    unittest.main()
