"""Hardening cases the Python port was missing.

Coverage drifted: the Go, Ruby, Rust, Swift, Java and Kotlin ports each assert
the decode-side bounds, and Python did not — so ``MAX_DEPTH`` and
``MAX_BIGINT_DIGITS``, both justified in ``wire.py`` as defences against a
hostile peer, were unasserted here. ``protocol/conformance-cases.json`` is now
the shared list that keeps the suites aligned.
"""

from __future__ import annotations

import http.server
import json
import os
import sys
import threading
import unittest
from typing import ClassVar

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient, LunoraError, _urllib_post, parse_rpc_response
from lunora.wire import (
    MAX_BIGINT_DIGITS,
    MAX_DEPTH,
    MAX_EXACT_INTEGER,
    TAG,
    UNDEFINED,
    WireBigInt,
    WireFormatError,
    decode_wire,
    encode_wire,
    stable_stringify,
)
from tests._fixtures import load
from tests._manifest import covers


class TestDecodeBounds(unittest.TestCase):
    def test_over_long_bigint_rejected(self):
        covers("over_long_bigint_rejected")

        # Decimal parsing is superlinear; an unbounded digit string is a DoS.
        with self.assertRaises(ValueError):
            decode_wire([TAG, "bigint", "9" * (MAX_BIGINT_DIGITS + 1)])

        with self.assertRaises(ValueError):
            decode_wire([TAG, "bigint", "12x4"])

        self.assertEqual(decode_wire([TAG, "bigint", "-42"]).value, -42)

    def test_malformed_values_rejected(self):
        covers("malformed_values_rejected")

        # The list is data (protocol/fixtures/wire-codec.json), not a per-suite
        # invention: a rejection each port hard-codes for itself is a rejection
        # only some ports have, which is how one of them ended up accepting a
        # truncated base64 payload as valid short bytes.
        for case in load("wire-codec.json")["rejected"]:
            # WireFormatError, not a bare ValueError/IndexError: a caller
            # catching the codec's own type has to catch all of them.
            with self.subTest(case=case["name"]), self.assertRaises(WireFormatError):
                decode_wire(case["encoded"])

        self.assertEqual(decode_wire([TAG, "bytes", "AQID"]), b"\x01\x02\x03")

        # A bare [TAG] is NOT malformed: it is the forward-compat shape, and the
        # reference hands it back as an ordinary array rather than indexing past
        # the end of it.
        self.assertEqual(decode_wire([TAG]), [TAG])

        # And the rejection has to REACH the subscription that owns the frame.
        # `handle_frame` catches WireFormatError only, so every stdlib exception
        # the codec used to leak — IndexError off a short tagged array, TypeError
        # off a null props slot, ValueError off a non-ASCII digit string — escaped
        # it and ended the socket read loop, taking every OTHER subscription on
        # the client down with it. Driving the whole list through the client is
        # what holds the codec to raising only its own type.
        for case in load("wire-codec.json")["rejected"]:
            with self.subTest(case=case["name"]):
                client = LunoraClient("https://app.example")
                client.attach_socket(lambda _frame: None)

                seen: list = []
                errors: list = []
                client.subscribe("messages:list", None, seen.append, errors.append)

                descriptor = client.handle_frame({"data": case["encoded"], "id": "sub_1", "type": "data"})

                self.assertEqual(descriptor["kind"], "error", "handle_frame must return rather than throw")
                self.assertEqual(seen, [], "a malformed value must not reach on_data")
                self.assertEqual(len(errors), 1, "a malformed value must surface via on_error")

    def test_exact_integer_range_enforced(self):
        covers("exact_integer_range_enforced")

        # Python's int is arbitrary-precision and a JSON number is not, so an
        # integer past 2**53-1 passed through here was rounded by the server's
        # own JSON.parse — a different integer arrived and neither end could
        # tell. WireBigInt is the way across.
        self.assertEqual(encode_wire(MAX_EXACT_INTEGER), MAX_EXACT_INTEGER)
        self.assertEqual(encode_wire(-MAX_EXACT_INTEGER), -MAX_EXACT_INTEGER)

        with self.assertRaises(WireFormatError):
            encode_wire(MAX_EXACT_INTEGER + 1)

        with self.assertRaises(WireFormatError):
            encode_wire(-MAX_EXACT_INTEGER - 1)

        self.assertEqual(
            encode_wire(WireBigInt(MAX_EXACT_INTEGER + 1)),
            [TAG, "bigint", str(MAX_EXACT_INTEGER + 1)],
        )

    def test_depth_cap_enforced(self):
        covers("depth_cap_enforced")

        nested = "leaf"
        for _ in range(MAX_DEPTH + 2):
            nested = [nested]

        with self.assertRaises(ValueError):
            encode_wire(nested)

        with self.assertRaises(ValueError):
            decode_wire(nested)

    def test_unknown_tag_decodes_as_array(self):
        # Forward compatibility: a tag this client does not know is an array.
        self.assertEqual(len(decode_wire([TAG, "future-thing", "payload"])), 3)


class TestUndefinedSemantics(unittest.TestCase):
    def test_undefined_is_distinct_from_none(self):
        covers("undefined_is_distinct_from_null")

        encoded = encode_wire({"dropped": UNDEFINED, "kept": None})

        self.assertNotIn("dropped", encoded, "an UNDEFINED object field must be dropped, matching JSON.stringify")
        self.assertIn("kept", encoded, "a None object field must be kept as null")

        # In an array position the slot must survive, or later elements shift.
        self.assertEqual(encode_wire([UNDEFINED, 1]), [[TAG, "undefined"], 1])


class TestEcmaScriptSpellings(unittest.TestCase):
    # Captured from a real JS engine, not derived from the spec.
    CASES: ClassVar[list[tuple[float, str]]] = [
        (0, "0"),
        (3, "3"),
        (1.5, "1.5"),
        (-2.5, "-2.5"),
        (1e-5, "0.00001"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (1e-21, "1e-21"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        # An integral double past 2**53: ECMAScript prints the shortest
        # round-tripping digits and zero-pads, so this is NOT the exact
        # expansion 1152921504606846976 that an int conversion yields.
        (2.0**60, "1152921504606847000"),
        # Negative zero keeps its sign; every integer conversion drops it.
        (-0.0, "-0"),
    ]

    def test_format_number_matches_ecmascript(self):
        covers("format_number_matches_ecmascript")

        for value, want in self.CASES:
            self.assertEqual(stable_stringify(value), want, f"formatting {value}")

    def test_key_order_matches_utf16(self):
        covers("key_order_matches_utf16")

        # JavaScript sorts by UTF-16 code unit: an astral character is its high
        # surrogate, so it sorts after U+2028 but before U+FFFD.
        rendered = stable_stringify({"�": 4, "\U0001f600": 3, " ": 2, "A": 1})

        self.assertEqual(rendered, '{"A":1," ":2,"\U0001f600":3,"�":4}')

    def test_string_escaping_matches_json_stringify(self):
        covers("string_escaping_matches_json_stringify")

        # JSON.stringify leaves <, > and & raw and does not escape U+2028/9.
        self.assertEqual(stable_stringify("a<b>&c"), '"a<b>&c"')
        self.assertEqual(stable_stringify("  "), '"  "')


class TestTransportErrors(unittest.TestCase):
    def test_non_2xx_without_error_envelope_fails(self):
        covers("non_2xx_without_error_envelope_fails")

        # protocol/README.md §4.2 — without the status check this returned None
        # and raised nothing, so a caller believes its mutation committed.
        with self.assertRaises(LunoraError) as caught:
            parse_rpc_response({"message": "bad gateway"}, 502)

        self.assertEqual(caught.exception.code, "INTERNAL")

    def test_redirect_does_not_replay_the_bearer_token(self):
        """A 3xx must not hand the caller's credentials to the redirect target.

        ``urllib``'s default redirect handler copies every header but
        ``content-*`` onto the new request and follows it to any host, so a
        challenge page or an open redirect walked off with the bearer token.
        The reference client's ``fetch`` drops it cross-origin; this poster
        refuses the redirect outright.
        """

        received: list[dict] = []

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # BaseHTTPRequestHandler's own naming
                received.append(dict(self.headers))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"result":null}')

            do_POST = do_GET  # noqa: N815 - BaseHTTPRequestHandler dispatches on the verb

            def log_message(self, *_args):
                pass

        target = http.server.HTTPServer(("127.0.0.1", 0), Target)
        redirect_to = f"http://127.0.0.1:{target.server_address[1]}/stolen"

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # BaseHTTPRequestHandler's own naming
                self.send_response(302)
                self.send_header("location", redirect_to)
                self.end_headers()

            def log_message(self, *_args):
                pass

        origin = http.server.HTTPServer(("127.0.0.1", 0), Redirector)

        for server in (target, origin):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

        status, parsed = _urllib_post(
            f"http://127.0.0.1:{origin.server_address[1]}/lunora/rpc",
            {"authorization": "Bearer s3cret", "content-type": "application/json"},
            b"{}",
        )

        self.assertEqual(received, [], "the redirect target must never be contacted")
        self.assertEqual(status, 302, "a refused redirect surfaces as the non-2xx it is")

        with self.assertRaises(LunoraError):
            parse_rpc_response(parsed, status)


class TestPokeAtomicity(unittest.TestCase):
    def test_poke_parts_do_not_apply_before_poke_end(self):
        covers("poke_parts_do_not_apply_before_poke_end")

        here = os.path.dirname(os.path.abspath(__file__))
        root = here
        for _ in range(8):
            if os.path.isdir(os.path.join(root, "protocol", "fixtures")):
                break
            root = os.path.dirname(root)

        with open(os.path.join(root, "protocol", "fixtures", "ws-frames.json"), encoding="utf-8") as handle:
            shape = json.load(handle)["shape"]

        client = LunoraClient("https://app.example")
        client._send = lambda _frame: None
        fired = []
        client.subscribe_shape("roomMessages", None, fired.append)

        # Everything except the terminal pokeEnd.
        for frame in shape["pokeSequence"][:-1]:
            client.handle_frame(frame)

        self.assertEqual(fired, [], "the view would be torn if parts applied before pokeEnd")


if __name__ == "__main__":
    unittest.main()
