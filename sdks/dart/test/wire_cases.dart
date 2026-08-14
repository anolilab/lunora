/// The wire codec and its bounds.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Wire codec ──────────────────────────────────────────────────────────────

void caseWireCodecRoundTrip() {
  covers('wire_codec_round_trip');

  final cases = objectList(fixture('wire-codec.json')['cases']);

  check(cases.length > 10, 'fixture should carry the full case set');

  for (final testCase in cases) {
    final encoded = testCase['encoded'];

    equals(canonical(encodeWire(decodeWire(encoded))), canonical(encoded), 'round-trip mismatch for ${testCase['name']}');
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

void caseDepthCapEnforced() {
  covers('depth_cap_enforced');

  Object? nested = 'leaf';

  for (var level = 0; level < wireMaxDepth + 2; level += 1) {
    nested = <Object?>[nested];
  }

  throws(() => encodeWire(nested), 'encode must enforce the depth cap');
  throws(() => decodeWire(nested), 'decode must enforce the depth cap');
}
