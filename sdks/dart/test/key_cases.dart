/// The stable subscription key: number spelling, key order, escaping.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Stable key ──────────────────────────────────────────────────────────────

void caseStableWireKeyFixtures() {
  covers('stable_wire_key_fixtures');

  final document = fixture('stable-wire-key.json');

  for (final testCase in objectList(document['cases'])) {
    equals(stableWireKey(testCase['args']), testCase['key'], 'stable key for ${testCase['name']}');
  }

  for (final testCase in objectList(document['typed'])) {
    equals(stableWireKey(decodeWire(testCase['wireArgs'])), testCase['key'], 'stable key for ${testCase['name']}');
  }
}

/// Expected spellings captured from a real JS engine, not derived from the spec
/// — the two disagreed for the go and ruby ports before this existed.
void caseFormatNumberMatchesEcmaScript() {
  covers('format_number_matches_ecmascript');

  // A list of pairs and not a map: 0.0 and -0.0 are the same map key, and the
  // negative-zero case below is precisely the one that must not be folded away.
  const expectations = <(double, String)>[
    (0, '0'),
    (3, '3'),
    (1.5, '1.5'),
    (-2.5, '-2.5'),
    (1e-5, '0.00001'),
    (1e-6, '0.000001'),
    (1e-7, '1e-7'),
    (1.5e-7, '1.5e-7'),
    (1e-21, '1e-21'),
    (1e20, '100000000000000000000'),
    (1e21, '1e+21'),
    // An integral double past 2^53: ECMAScript prints the SHORTEST digits that
    // read back as the same double and zero-pads, so this is not the exact
    // expansion 1152921504606846976 that toStringAsFixed(0) writes.
    (1.152921504606847e18, '1152921504606847000'),
    // The key is `stableStringify`, not `String()`: it emits the bare token
    // "-0", which is how a key keeps -0 and 0 apart. This case used to assert
    // "0" and pinned the divergence it exists to catch.
    (-0.0, '-0'),
  ];

  for (final (value, want) in expectations) {
    equals(formatDouble(value), want, 'formatDouble($value)');
  }
}

/// JavaScript sorts by UTF-16 code unit, so an astral character is its high
/// surrogate (0xD83D) and sorts after U+2028 but before U+FFFD. A Dart string IS
/// UTF-16 code units, so the plain sort agrees — which is what this pins, since
/// four sibling ports need a hand-written comparator to get here.
void caseKeyOrderMatchesUtf16() {
  covers('key_order_matches_utf16');

  final rendered = stableStringify(<String, Object?>{'A': 1, '\u2028': 2, '\u{1F600}': 3, '\uFFFD': 4});

  equals(rendered, '{"A":1,"\u2028":2,"\u{1F600}":3,"\uFFFD":4}', 'object keys must sort by UTF-16 code unit');
}

void caseStringEscapingMatchesJsonStringify() {
  covers('string_escaping_matches_json_stringify');

  // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
  equals(jsonStringLiteral('a<b>&c'), '"a<b>&c"', 'angle brackets and ampersand stay raw');
  equals(jsonStringLiteral('\u2028\u2029'), '"\u2028\u2029"', 'line and paragraph separators stay raw');
  equals(jsonStringLiteral('tab\there'), r'"tab\there"', 'a tab is escaped');
  equals(jsonStringLiteral('\u0001'), r'"\u0001"', 'a control character is escaped as \\u00xx');

  // Well-formed `JSON.stringify` has escaped an unpaired surrogate since ES2019,
  // and Dart is the only port where one can exist — the others walk Unicode
  // scalars. A raw one here would put an invalid UTF-16 sequence in a key that is
  // compared verbatim against the reference client's.
  equals(jsonStringLiteral('\uD800'), r'"\ud800"', 'a lone high surrogate is escaped');
  equals(jsonStringLiteral('\uDC00'), r'"\udc00"', 'a lone low surrogate is escaped');
  equals(jsonStringLiteral('\u{1F600}'), '"\u{1F600}"', 'a well-formed pair stays raw');
}
