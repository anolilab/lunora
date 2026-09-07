"""Native-construction unit tests for the wire codec (not fixture-driven)."""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.wire import (
    TAG,
    UNDEFINED,
    WireBigInt,
    WireBytes,
    WireDate,
    WireError,
    WireMap,
    WireSet,
    WireUrl,
    decode_wire,
    encode_wire,
    stable_wire_key,
)


class TestEncodeNative(unittest.TestCase):
    def test_pure_json_is_identity(self):
        value = {"a": 1, "b": [True, None, "x"], "c": {"d": 2.5}}
        self.assertEqual(encode_wire(value), value)

    def test_bigint(self):
        self.assertEqual(encode_wire(WireBigInt(7)), [TAG, "bigint", "7"])

    def test_bytes_uint8(self):
        self.assertEqual(encode_wire(b"\x01\x02\x03"), [TAG, "bytes", "AQID"])

    def test_typed_array_keeps_ctor(self):
        self.assertEqual(encode_wire(WireBytes(b"\x01\x02\x03", "ArrayBuffer")), [TAG, "bytes", "AQID", "ArrayBuffer"])

    def test_date(self):
        self.assertEqual(encode_wire(WireDate(1700000000000)), [TAG, "date", 1700000000000])

    def test_nan_inf(self):
        self.assertEqual(encode_wire(math.nan), [TAG, "nan"])
        self.assertEqual(encode_wire(math.inf), [TAG, "inf"])
        self.assertEqual(encode_wire(-math.inf), [TAG, "-inf"])

    def test_undefined_field_dropped_but_array_position_tagged(self):
        self.assertEqual(encode_wire({"a": UNDEFINED, "b": 1}), {"b": 1})
        self.assertEqual(encode_wire([1, UNDEFINED, 2]), [1, [TAG, "undefined"], 2])

    def test_map_set_url(self):
        self.assertEqual(encode_wire(WireMap([("a", 1)])), [TAG, "map", [["a", 1]]])
        self.assertEqual(encode_wire(WireSet([1, 2])), [TAG, "set", [1, 2]])
        self.assertEqual(encode_wire(WireUrl("https://x/")), [TAG, "url", "https://x/"])

    def test_error(self):
        self.assertEqual(encode_wire(WireError("Error", "boom")), [TAG, "error", "Error", "boom", {}])

    def test_error_labels_are_coerced_so_encode_stays_decodable(self):
        # ``decode_wire`` refuses a non-string in either label slot, so an
        # encoder that passed them through emitted a frame its own decoder
        # rejects — and a decoder raise on a subscription frame kills the
        # subscription rather than surfacing the error.
        encoded = encode_wire(WireError(5, {"a": 1}))

        self.assertEqual(encoded[2], "5")
        self.assertEqual(decode_wire(encoded).name, "5")

    def test_array_sentinel_escape(self):
        self.assertEqual(encode_wire([TAG, "x"]), [TAG, "arr", [TAG, "x"]])

    def test_rejects_unsupported(self):
        with self.assertRaises(TypeError):
            encode_wire(object())


class TestDecodeRoundTrip(unittest.TestCase):
    def test_bigint_roundtrips_to_wrapper(self):
        decoded = decode_wire([TAG, "bigint", "42"])
        self.assertEqual(decoded, WireBigInt(42))
        self.assertEqual(encode_wire(decoded), [TAG, "bigint", "42"])

    def test_bytes_roundtrips_to_python_bytes(self):
        self.assertEqual(decode_wire([TAG, "bytes", "AQID"]), b"\x01\x02\x03")

    def test_over_long_bigint_rejected(self):
        with self.assertRaises(ValueError):
            decode_wire([TAG, "bigint", "1" * 2000])


class TestStableKey(unittest.TestCase):
    def test_sorts_keys(self):
        self.assertEqual(stable_wire_key({"b": 2, "a": 1}), '{"a":1,"b":2}')

    def test_bigint_arg(self):
        self.assertEqual(stable_wire_key({"n": WireBigInt(7)}), '{"n":["$lunora.wire$","bigint","7"]}')


if __name__ == "__main__":
    unittest.main()
