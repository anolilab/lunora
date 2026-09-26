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
/// ECMA-262 Number::toString laid over the SHORTEST digit string that reads
/// back as the same double. Dart's `toString` already chooses those digits —
/// it is shortest-round-trip, as ECMAScript is — but lays them out its own way
/// ("1.0" where ECMAScript writes "1"), so only its digits and exponent are
/// used and the layout is ECMA-262's.
///
/// A fixed-precision search cannot stand in for this. The one this replaced
/// tried `toStringAsFixed(0..20)`, so a value needing more than 20 places to
/// round-trip — reachable just above 1e-6 — was spelled at 20, and three
/// adjacent doubles all keyed as `-0.00000607387560669604`: one subscription
/// received another's frames and optimistic overlays.
///
/// Works on the double throughout, never on a narrowed `int`: an `int` is
/// 64-bit, so `(1e20).toInt()` saturates rather than converting.
String formatDouble(double value) {
  if (value.isNaN || value.isInfinite) {
    return 'null';
  }
  // The key is `stableStringify`, NOT `String()`: it emits the bare token "-0"
  // for a negative zero, precisely so a key cannot collapse -0 and 0 into one.
  // (`String(-0)` in JavaScript IS "0" — that is the read this used to make,
  // and it dropped the sign.)
  if (value == 0) {
    return value.isNegative ? '-0' : '0';
  }

  // `<whole>.<fraction>` with an optional `e<sign><exponent>`, read as digits
  // d1..dk and an exponent n such that the value is 0.d1..dk × 10^n.
  final text = value.abs().toString();
  final marker = text.indexOf('e');
  final mantissa = marker < 0 ? text : text.substring(0, marker);
  final point = mantissa.indexOf('.');
  final whole = point < 0 ? mantissa : mantissa.substring(0, point);
  var digits = point < 0 ? whole : '$whole${mantissa.substring(point + 1)}';
  var n = whole.length + (marker < 0 ? 0 : int.parse(text.substring(marker + 1)));
  var start = 0;
  var end = digits.length;

  // A nonzero value has a nonzero digit, so neither loop runs off the string.
  while (digits.codeUnitAt(start) == 0x30) {
    start += 1;
  }
  while (digits.codeUnitAt(end - 1) == 0x30) {
    end -= 1;
  }

  digits = digits.substring(start, end);
  n -= start;

  final k = digits.length;
  final String body;

  if (k <= n && n <= 21) {
    body = '$digits${'0' * (n - k)}';
  } else if (0 < n && n <= 21) {
    body = '${digits.substring(0, n)}.${digits.substring(n)}';
  } else if (-6 < n && n <= 0) {
    body = '0.${'0' * -n}$digits';
  } else {
    final exponent = n - 1;

    body = '${digits[0]}${k > 1 ? '.${digits.substring(1)}' : ''}e${exponent < 0 ? '-' : '+'}${exponent.abs()}';
  }

  return value.isNegative ? '-$body' : body;
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
