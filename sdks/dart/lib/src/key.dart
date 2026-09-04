/// The stable subscription / dedup key, ported from `shared/wire-key.ts`.
///
/// [stableWireKey] is `stableStringify(encodeWire(value))`: a canonical JSON
/// encoding with object keys sorted at every depth, arrays keeping their order,
/// null fields kept and `undefined` object fields dropped. Two argument records
/// differing only in key insertion order collapse to one key — which is the
/// point, since this de-duplicates subscriptions and is compared verbatim
/// against a key produced by the reference TypeScript client.
///
/// Sorting needs no helper here. JavaScript compares strings by UTF-16 code
/// unit, and so does Dart's `String.compareTo` — Dart strings ARE sequences of
/// UTF-16 code units. The ports whose strings are Unicode scalars or UTF-8 bytes
/// (Swift, Python, Go, Rust) each carry a hand-written comparator to reproduce
/// this; the astral case in `test/conformance.dart` pins that the plain sort is
/// in fact equivalent rather than merely assumed to be.
///
/// See `protocol/README.md` §3 for the normative definition.
library;

import 'wire.dart';

/// Canonical JSON encoding of a pure-JSON tree.
///
/// Runs on the OUTPUT of [encodeWire], so it only ever sees
/// null/bool/int/double/String/List/Map.
String stableStringify(Object? value) {
  if (value == null || value is WireUndefined) {
    return 'null';
  }
  if (value is bool) {
    return value ? 'true' : 'false';
  }
  // Before `num`: an int is exact and must not go through the double formatter,
  // which would render 2^60 in its nearest-double spelling.
  if (value is int) {
    return '$value';
  }
  if (value is double) {
    return formatDouble(value);
  }
  if (value is String) {
    return jsonStringLiteral(value);
  }
  if (value is List) {
    return '[${value.map(stableStringify).join(',')}]';
  }
  if (value is Map) {
    return _stableObject(value);
  }

  return 'null';
}

/// The stable cache / dedup key for [value].
String stableWireKey(Object? value) => stableStringify(encodeWire(value));

String _stableObject(Map<Object?, Object?> value) {
  // The pairs are carried through the sort rather than the keys alone: looking
  // the value back up by its stringified key would silently yield null for any
  // map whose keys are not already strings.
  final pairs = <MapEntry<String, Object?>>[
    for (final entry in value.entries)
      if (entry.value is! WireUndefined) MapEntry('${entry.key}', entry.value),
  ]..sort((a, b) => a.key.compareTo(b.key));

  return '{${pairs.map((pair) => '${jsonStringLiteral(pair.key)}:${stableStringify(pair.value)}').join(',')}}';
}

/// Renders a double exactly as `String(v)` does in JavaScript, which is what
/// `JSON.stringify` emits for a finite number.
///
/// Dart's own `toString` writes "1.0" for an integral value and "1e-5" where
/// ECMAScript writes "1" and "0.00001". ECMAScript drops the decimal on an
/// integral value, stays positional from 1e-6 up to (not including) 1e21,
/// switches to exponential outside that, and never pads the exponent. A key is
/// compared verbatim, so the spellings must match.
String formatDouble(double value) {
  if (value.isNaN || value.isInfinite) {
    return 'null';
  }
  // Before the integral branch. The key is `stableStringify`, NOT `String()`:
  // it emits the bare token "-0" for a negative zero, precisely so a key cannot
  // collapse -0 and 0 into one. (`String(-0)` in JavaScript IS "0" — that is
  // the read this used to make, and it dropped the sign.)
  if (value == 0) {
    return value.isNegative ? '-0' : '0';
  }
  if (value == value.truncateToDouble() && value.abs() < 1e21) {
    // `toString` prints the SHORTEST digits that read back as the same double,
    // which is ECMAScript's rule; `toStringAsFixed(0)` prints the EXACT
    // expansion, so 2^60 came out as 1152921504606846976 where `String(2**60)`
    // is 1152921504606847000.
    final rendered = value.toString();

    return rendered.endsWith('.0') ? rendered.substring(0, rendered.length - 2) : rendered;
  }

  final magnitude = value.abs();

  if (magnitude >= 1e-6 && magnitude < 1e21) {
    return _positional(value);
  }

  return _exponential(value);
}

/// Positional rendering at the shortest precision that still parses back to the
/// same double — ECMAScript's "shortest round-trip" rule.
///
/// The 20-place ceiling is `toStringAsFixed`'s own, and is shared with every
/// sibling port (Swift's `%.20f`, Python's, Go's). A value needing more than 20
/// FRACTIONAL digits to round-trip — reachable only just above 1e-6 — falls back
/// to the 20-place rendering and is then one ulp off what ECMAScript prints.
/// Left as the siblings have it: a seventh, differently-correct algorithm is how
/// ports drift, and the fix belongs to all of them at once.
String _positional(double value) {
  for (var precision = 0; precision <= 20; precision += 1) {
    final candidate = value.toStringAsFixed(precision);

    if (double.parse(candidate) == value) {
      return _trimTrailingZeros(candidate);
    }
  }

  return _trimTrailingZeros(value.toStringAsFixed(20));
}

/// Dart's `toStringAsExponential` already emits ECMAScript's exponent spelling
/// ("1e-7", "1e+21"), so only the mantissa's trailing zeros need trimming —
/// unlike the C-`printf` ports, which also have to unpad the exponent.
String _exponential(double value) {
  for (var precision = 0; precision <= 17; precision += 1) {
    final candidate = value.toStringAsExponential(precision);

    if (double.parse(candidate) == value) {
      return _trimMantissa(candidate);
    }
  }

  return _trimMantissa(value.toStringAsExponential(17));
}

String _trimMantissa(String text) {
  final marker = text.indexOf('e');

  if (marker < 0) {
    return text;
  }

  return '${_trimTrailingZeros(text.substring(0, marker))}${text.substring(marker)}';
}

String _trimTrailingZeros(String text) {
  if (!text.contains('.')) {
    return text;
  }

  var end = text.length;

  while (end > 0 && text.codeUnitAt(end - 1) == 0x30) {
    end -= 1;
  }
  if (end > 0 && text.codeUnitAt(end - 1) == 0x2E) {
    end -= 1;
  }

  return text.substring(0, end);
}

/// Quotes a string the way `JSON.stringify` does.
///
/// Not `jsonEncode`: Dart escapes the same set, but this walks code units so the
/// output is pinned by this function rather than by whatever `dart:convert`
/// decides. `<`, `>`, `&`, U+2028 and U+2029 stay raw, matching JavaScript.
///
/// An UNPAIRED surrogate is escaped, matching well-formed `JSON.stringify` since
/// ES2019. Dart is the only port where this is reachable — Swift, Rust and Go
/// walk Unicode scalars, which cannot hold a lone surrogate — so the plain
/// code-unit walk is equivalent to the reference everywhere except here.
String jsonStringLiteral(String value) {
  final buffer = StringBuffer('"');

  for (var index = 0; index < value.length; index += 1) {
    final unit = value.codeUnitAt(index);

    switch (unit) {
      case 0x22:
        buffer.write(r'\"');
      case 0x5C:
        buffer.write(r'\\');
      case 0x0A:
        buffer.write(r'\n');
      case 0x0D:
        buffer.write(r'\r');
      case 0x09:
        buffer.write(r'\t');
      case 0x08:
        buffer.write(r'\b');
      case 0x0C:
        buffer.write(r'\f');
      default:
        if (unit < 0x20 || _isUnpairedSurrogate(value, index)) {
          buffer.write('\\u${unit.toRadixString(16).padLeft(4, '0')}');
        } else {
          buffer.writeCharCode(unit);
        }
    }
  }

  buffer.write('"');

  return buffer.toString();
}

/// Whether the code unit at [index] is a surrogate with no partner beside it.
bool _isUnpairedSurrogate(String value, int index) {
  final unit = value.codeUnitAt(index);

  if (unit >= 0xD800 && unit <= 0xDBFF) {
    final next = index + 1 < value.length ? value.codeUnitAt(index + 1) : 0;

    return next < 0xDC00 || next > 0xDFFF;
  }

  if (unit >= 0xDC00 && unit <= 0xDFFF) {
    final previous = index > 0 ? value.codeUnitAt(index - 1) : 0;

    return previous < 0xD800 || previous > 0xDBFF;
  }

  return false;
}
