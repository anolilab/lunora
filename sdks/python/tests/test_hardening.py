"""Hardening cases the Python port was missing.

Coverage drifted: the Go, Ruby, Rust, Swift, Java and Kotlin ports each assert
the decode-side bounds, and Python did not — so ``MAX_DEPTH`` and
``MAX_BIGINT_DIGITS``, both justified in ``wire.py`` as defences against a
hostile peer, were unasserted here. ``protocol/conformance-cases.json`` is now
the shared list that keeps the suites aligned.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from typing import ClassVar

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient, LunoraError, parse_rpc_response
from lunora.wire import MAX_BIGINT_DIGITS, MAX_DEPTH, TAG, UNDEFINED, decode_wire, encode_wire, stable_stringify
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
