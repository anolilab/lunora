/// The wire codec and its bounds.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Wire codec ──────────────────────────────────────────────────────────────

void caseWireCodecRoundTrip() {
  covers('wire_codec_round_trip');

  final cases = objectList(fixture('wire-codec.json')['cases']);

  check(cases.length > 10, 'fixture should carry the full case set');

  for (final testCase in cases) {
    final encoded = testCase['encoded'];

    // A handful of shapes are legitimately not fixed points — a bare [tag]
    // array is escaped on the way out, an undefined object field is dropped —
    // and carry the expected re-encoding.
    final expected = testCase.containsKey('reencoded') ? testCase['reencoded'] : encoded;

    final reencoded = encodeWire(decodeWire(encoded));

    equals(canonical(reencoded), canonical(expected), 'round-trip mismatch for ${testCase['name']}');

    // And again as the BYTES the transport sends. `canonical` goes through
    // `stableStringify`, which formats numbers the ECMAScript way — a string
    // this port never puts on a socket. `transport.dart` sends
    // `jsonEncode(buildRpcBody(...))` over `encodeWire` output, and jsonEncode
    // spells a Dart double `1700000000000.0` where the reference writes
    // `1700000000000`, so every date on the wire diverged while this case
    // reported green. A round-trip assertion measured on a string the transport
    // never sends cannot see the divergence it exists to catch.
    equals(jsonEncode(reencoded), jsonEncode(expected), 'wire-text mismatch for ${testCase['name']}');
  }
}

void caseUndefinedIsDistinctFromNull() {
  covers('undefined_is_distinct_from_null');

  final encoded = encodeWire(<String, Object?>{'dropped': WireUndefined.instance, 'kept': null}) as Map<String, Object?>;

  check(!encoded.containsKey('dropped'), 'an undefined object field must be dropped, matching JSON.stringify');
  check(encoded.containsKey('kept'), 'a null object field must be kept');

  // In an array position the slot must survive, or every later element shifts.
  final inArray = encodeWire(<Object?>[WireUndefined.instance, 1]) as List<Object?>;

  equals((inArray.first as List<Object?>)[1], 'undefined', 'undefined in an array position must be tagged');
}

void caseOverLongBigIntRejected() {
  covers('over_long_bigint_rejected');

  throws(() => decodeWire(<Object?>[wireTag, 'bigint', '9' * (wireMaxBigIntDigits + 1)]), 'an over-long bigint must be rejected');
  throws(() => decodeWire(<Object?>[wireTag, 'bigint', '12x4']), 'a non-numeric bigint must be rejected');

  equals(decodeWire(<Object?>[wireTag, 'bigint', '-42']), BigInt.from(-42), 'a legitimate bigint must decode');
}

/// Walks the shared rejection list.
///
/// The list is data (`protocol/fixtures/wire-codec.json`), not a per-suite
/// invention: a rejection each port hard-codes for itself is a rejection only
/// some ports have, which is how one of them ended up accepting a truncated
/// base64 payload as valid short bytes.
void caseMalformedValuesRejected() {
  covers('malformed_values_rejected');

  final rejected = objectList(fixture('wire-codec.json')['rejected']);

  check(rejected.isNotEmpty, 'the fixture must carry a rejection list');

  for (final testCase in rejected) {
    throws(() => decodeWire(testCase['encoded']), '${testCase['name']} must be rejected');
  }

  final decoded = decodeWire(<Object?>[wireTag, 'bytes', 'AQID']);

  check(
      decoded is List<int> && decoded.length == 3 && decoded[0] == 1 && decoded[1] == 2 && decoded[2] == 3, 'well-formed bytes must still decode to [1, 2, 3]');

  // A bare [tag] is NOT malformed: it is the forward-compat shape, and the
  // reference hands it back as an ordinary array.
  final passthrough = decodeWire(<Object?>[wireTag]);

  check(passthrough is List && passthrough.length == 1, 'a bare tag array must decode as an ordinary array');
}

/// An integer a float64 cannot hold exactly must not silently become a
/// different integer on the wire. Dart's `int` is 64-bit, so passing one through
/// left the SERVER's own `JSON.parse` to round it.
void caseExactIntegerRangeEnforced() {
  covers('exact_integer_range_enforced');

  equals(encodeWire(wireMaxExactInteger), wireMaxExactInteger, 'the largest exact integer must encode');
  equals(encodeWire(-wireMaxExactInteger), -wireMaxExactInteger, 'the smallest exact integer must encode');

  throws(() => encodeWire(wireMaxExactInteger + 1), 'an integer past the exact float64 range must be refused, not rounded');
  throws(() => encodeWire(-wireMaxExactInteger - 1), 'an integer past the exact float64 range must be refused, not rounded');

  // BigInt is the way across, and it keeps every digit.
  equals(
    canonical(encodeWire(BigInt.parse('9007199254740992'))),
    canonical(<Object?>[wireTag, 'bigint', '9007199254740992']),
    'BigInt carries the value the number range refuses',
  );
}

void caseDepthCapEnforced() {
  covers('depth_cap_enforced');

  Object? nested = 'leaf';

  for (var level = 0; level < wireMaxDepth + 2; level += 1) {
    nested = <Object?>[nested];
  }

  throws(() => encodeWire(nested), 'encode must enforce the depth cap');
  throws(() => decodeWire(nested), 'decode must enforce the depth cap');
}
