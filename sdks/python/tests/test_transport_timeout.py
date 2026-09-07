"""The default HTTP transport used to have no timeout at all.

Python is the only SDK that ships a concrete, self-contained transport as its
default (every other language requires the caller to inject one), so it is the
only place a stock `LunoraClient` can hang a thread forever against an
unresponsive server. `urllib.request.urlopen`'s own default timeout is `None`.

No `tests._manifest.covers` call: this is not one of the shared
`protocol/conformance-cases.json` cases, it is Python-transport-specific.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import _NO_REDIRECT_OPENER, LunoraClient, _urllib_post

# Well under DEFAULT_HTTP_TIMEOUT so the test proves the override works, and
# short enough that it does not slow the suite down.
SHORT_TIMEOUT = 0.2


class _AcceptAndStall:
    """A TCP server that accepts a connection and never writes a response.

    Models an unresponsive/slow-draining server without a real network call or
    a `sleep` anywhere near a realistic HTTP timeout.
    """

    def __init__(self) -> None:
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(1)
        self.port = self._server.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept_and_stall, daemon=True)
        self._thread.start()

    def _accept_and_stall(self) -> None:
        try:
            conn, _addr = self._server.accept()
        except OSError:
            return
        try:
            self._stop.wait(5)  # hold the connection open; never send a reply
        finally:
            conn.close()

    def close(self) -> None:
        self._stop.set()
        self._server.close()
        self._thread.join(timeout=1)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


class TestDefaultTransportTimeout(unittest.TestCase):
    def test_stalled_server_raises_instead_of_hanging(self):
        server = _AcceptAndStall()
        try:
            started = time.monotonic()
            with self.assertRaises(OSError):  # socket.timeout / TimeoutError
                _urllib_post(server.url + "/_lunora/rpc", {}, b"{}", timeout=SHORT_TIMEOUT)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, SHORT_TIMEOUT + 2, "should fail close to the configured timeout, not hang")
        finally:
            server.close()

    def test_client_default_transport_honors_configured_timeout(self):
        server = _AcceptAndStall()
        try:
            client = LunoraClient(server.url, timeout=SHORT_TIMEOUT)
            with self.assertRaises(OSError):
                client._http_post(server.url + "/_lunora/rpc", {}, b"{}")
        finally:
            server.close()

    def test_injected_http_post_is_unaffected_by_the_timeout_parameter(self):
        # Every other SDK requires an injected transport, and this must keep
        # whatever timeout semantics it already has: the `timeout` constructor
        # argument must not reach it at all.
        def fake_post(_url, _headers, _body):
            return 200, {"result": "ok"}

        client = LunoraClient("https://app.example", http_post=fake_post, timeout=SHORT_TIMEOUT)

        self.assertIs(client._http_post, fake_post)

    def test_http_error_envelope_still_returns_code_and_body(self):
        # Unrelated to the timeout: the existing HTTPError branch (error
        # envelopes still carrying a JSON body) must keep working exactly as
        # before threading a timeout through `urlopen`.
        import json
        import urllib.error
        from unittest.mock import patch

        class _FakeHTTPError(urllib.error.HTTPError):
            def __init__(self, code, body):
                super().__init__("http://app.example/_lunora/rpc", code, "err", {}, None)
                self._body = body

            def read(self):
                return self._body

            def close(self):
                pass  # no underlying fp to release

        def raise_http_error(_request, **_kwargs):
            raise _FakeHTTPError(502, json.dumps({"error": {"code": "INTERNAL", "message": "bad gateway"}}).encode("utf-8"))

        # The opener, not `urllib.request.urlopen`: the poster drives its own
        # opener so that redirects are refused rather than followed with the
        # bearer token attached, and patching the module function would leave the
        # real request to run.
        with patch.object(_NO_REDIRECT_OPENER, "open", side_effect=raise_http_error):
            status, body = _urllib_post("http://app.example/_lunora/rpc", {}, b"{}")

        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": {"code": "INTERNAL", "message": "bad gateway"}})


if __name__ == "__main__":
    unittest.main()
