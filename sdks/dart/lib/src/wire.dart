/// The tagged value codec for Lunora's client↔server wire, ported from
/// `shared/wire-codec.ts`.
///
/// The wire is JSON with no reviver; values JSON cannot carry (big integers,
/// bytes, dates, maps/sets, ±Infinity/NaN, `undefined` in an array position)
/// become self-delimiting tagged arrays whose first element is [wireTag].
/// Pure-JSON values encode to a structurally identical tree.
///
/// Dart maps onto this better than most ports. `BigInt` is in `dart:core` and is
/// arbitrary-precision, so a `v.bigint()` decodes to a real number type rather
/// than to the digits-as-text wrapper Swift needs — and it stays correct when
/// compiled to JavaScript, where Dart's `int` is a double and would silently
/// corrupt anything past 2⁵³. `Uint8List` is `dart:typed_data`. Only the four
/// shapes with no faithful Dart counterpart get a wrapper:
///
/// - [WireDate], because an invalid `Date` carries a NaN epoch and `DateTime`
///   cannot hold one — it would collapse to epoch 0.
/// - [WireUrl], because `Uri.parse(x).toString()` normalises scheme and host
///   case, so a round-trip through `Uri` is not the identity the contract needs.
/// - [WireMap] and [WireSet], because a JS `Map` key may be a structure, and a
///   Dart `Map`/`Set` would compare two decoded lists by identity and never
///   match — silently dropping entries.
///
/// [decodeWire] returns those wrappers so `encodeWire(decodeWire(x)) == x` holds
/// for every golden fixture — the conformance contract, asserted in
/// `test/conformance.dart`.
///
/// One guard from the TypeScript original is deliberately absent: it defines
/// `__proto__` keys with `Object.defineProperty` so a decoded document cannot
/// walk into a prototype. A Dart `Map` has no prototype chain and no setter to
/// fire, so `"__proto__"` is an ordinary key here and needs no special case.
///
/// See `protocol/README.md` §2 for the normative grammar.
library;

import 'dart:convert';
import 'dart:typed_data';

/// Marks a JSON array as a tagged wire value. An array is significant to the
/// codec only when its first element is exactly this string.
const String wireTag = r'$lunora.wire$';

/// Bounds recursion so a hostile deeply-nested payload cannot exhaust the stack.
const int wireMaxDepth = 64;

/// Bounds a decoded big integer. `BigInt.parse` is superlinear in the digit
/// count, so an unbounded digit string from an untrusted peer is a denial of
/// service. Applied only on decode — the untrusted direction.
const int wireMaxBigIntDigits = 1024;

/// Largest integer a float64 holds exactly (2^53 - 1). JSON numbers are
/// float64, so an integer past this cannot cross the wire as a number without
/// changing value — `BigInt` and its tag exist for that case.
const int wireMaxExactInteger = 9007199254740991;

/// Largest epoch a `Date` holds (ECMAScript TimeClip). Past this, and for any
/// non-finite epoch, `new Date(v)` is an Invalid Date.
const double wireMaxTimeValue = 8.64e15;

/// `new Date(epoch).getTime()` — ECMAScript TimeClip.
///
/// A `Date` truncates its argument toward zero, and anything non-finite or past
/// ±8.64e15 becomes an Invalid Date, which the reference re-encodes as a NaN
/// tag. Kept verbatim, the epoch went back on the wire as a date the
/// reference's own `Date` can never hold.
double _timeClip(double epoch) {
  if (!epoch.isFinite || epoch.abs() > wireMaxTimeValue) {
    return double.nan;
  }

  return epoch.truncateToDouble();
}

/// Bytes per element for the typed-array views the codec round-trips. A view
/// whose payload is not a whole number of elements is not a view the reference
/// can rebuild — `new Float32Array(buffer)` raises a RangeError there — so
/// accepting it would hand the consumer bytes it cannot reconstruct.
/// `ArrayBuffer` is absent deliberately: it is untyped, so nothing to align.
const Map<String, int> wireTypedArrayElementSizes = <String, int>{
  'BigInt64Array': 8,
  'BigUint64Array': 8,
  'Float32Array': 4,
  'Float64Array': 8,
  'Int16Array': 2,
  'Int32Array': 4,
  'Int8Array': 1,
  'Uint16Array': 2,
  'Uint32Array': 4,
  'Uint8Array': 1,
  'Uint8ClampedArray': 1,
};

/// JavaScript's `undefined`, distinct from JSON null.
///
/// As an object field it is dropped on encode (matching `JSON.stringify`); in an
/// array position it is preserved, because dropping it there would silently
/// shift every later element.
class WireUndefined {
  const WireUndefined();

  /// The single instance callers should pass.
  static const WireUndefined instance = WireUndefined();

  @override
  String toString() => 'WireUndefined';
}

/// A `Date`, as epoch milliseconds.
///
/// A `double` rather than a `DateTime` because an invalid `Date` has a NaN time,
/// which round-trips exactly here and would collapse to epoch 0 through
/// `DateTime`. Call [toDateTime] when the value is known to be a real instant.
class WireDate {
  const WireDate(this.epochMs);

  final double epochMs;

  /// The instant this carries. Throws when [epochMs] is NaN or infinite — an
  /// invalid `Date` has no `DateTime` counterpart, and returning epoch 0 for one
  /// is the silent corruption this wrapper exists to avoid.
  DateTime toDateTime() {
    if (epochMs.isNaN || epochMs.isInfinite) {
      throw WireFormatException('this WireDate carries $epochMs, which is not a representable instant');
    }
    return DateTime.fromMillisecondsSinceEpoch(epochMs.toInt(), isUtc: true);
  }

  @override
  String toString() => 'WireDate($epochMs)';
}

/// A `URL`, carried as its href verbatim — see the library comment for why this
/// is not a `Uri`.
class WireUrl {
  const WireUrl(this.href);

  final String href;

  @override
  String toString() => 'WireUrl($href)';
}

/// A `Map`: ordered pairs whose keys may be non-string, which is why a Dart
/// `Map` cannot represent it.
class WireMap {
  const WireMap(this.entries);

  final List<MapEntry<Object?, Object?>> entries;
}

/// A `Set`: ordered items, for the same reason [WireMap] is not a `Map`.
class WireSet {
  const WireSet(this.items);

  final List<Object?> items;
}

/// A typed-array view that is NOT a plain `Uint8Array`, carrying its constructor
/// name so the exact view type survives. Plain `Uint8Array` bytes are a
/// `Uint8List` and use the 2-element wire form.
class WireBytes {
  const WireBytes(this.data, this.ctor);

  final Uint8List data;
  final String ctor;
}

/// An `Error`: name, message, own enumerable props, optional cause. `stack` is
/// deliberately absent — the peer is untrusted.
class WireError {
  /// [cause] defaults to [WireUndefined] rather than null, because the wire
  /// distinguishes "no cause" (the 5-element form) from "a cause that IS null"
  /// (a 6th element holding null), and Dart has only one null to spend. Defaulting
  /// to null collapsed the two and broke `encodeWire(decodeWire(x)) == x` for the
  /// second.
  const WireError({required this.name, required this.message, this.props = const {}, this.cause = WireUndefined.instance});

  final String name;
  final String message;
  final Map<String, Object?> props;

  /// The error this one wraps, or [WireUndefined] when it carries none.
  final Object? cause;

  @override
  String toString() => '$name: $message';
}

/// A value the codec cannot encode, or a tagged array it cannot decode.
class WireFormatException implements Exception {
  const WireFormatException(this.message);

  final String message;

  @override
  String toString() => 'wire-codec: $message';
}

/// Encode [value] into a JSON-safe tree, tagging the leaves JSON cannot carry.
Object? encodeWire(Object? value, [int depth = 0]) {
  if (depth > wireMaxDepth) {
    throw const WireFormatException('value nesting exceeds the $wireMaxDepth-level limit');
  }

  if (value == null) {
    return null;
  }
  if (value is WireUndefined) {
    return <Object?>[wireTag, 'undefined'];
  }
  if (value is BigInt) {
    return <Object?>[wireTag, 'bigint', value.toString()];
  }
  if (value is WireDate) {
    // Routed back through the encoder so a NaN epoch becomes a ["nan"] tag and
    // rebuilds as an invalid date, rather than collapsing to null.
    return <Object?>[wireTag, 'date', encodeWire(value.epochMs, depth + 1)];
  }
  if (value is WireUrl) {
    return <Object?>[wireTag, 'url', value.href];
  }
  if (value is WireError) {
    return _encodeError(value, depth);
  }
  if (value is WireMap) {
    return <Object?>[
      wireTag,
      'map',
      <Object?>[
        for (final entry in value.entries) <Object?>[encodeWire(entry.key, depth + 1), encodeWire(entry.value, depth + 1)],
      ],
    ];
  }
  if (value is WireSet) {
    return <Object?>[
      wireTag,
      'set',
      <Object?>[for (final item in value.items) encodeWire(item, depth + 1)],
    ];
  }
  if (value is WireBytes) {
    return <Object?>[wireTag, 'bytes', base64.encode(value.data), value.ctor];
  }
  // Before the `List` arm: a Uint8List IS a List<int>, and reaching that arm
  // would encode three bytes as a three-element JSON array.
  if (value is Uint8List) {
    return <Object?>[wireTag, 'bytes', base64.encode(value)];
  }
  if (value is int) {
    return _encodeInt(value);
  }
  if (value is bool || value is String) {
    return value;
  }
  if (value is double) {
    return _encodeDouble(value);
  }
  if (value is List) {
    return _encodeList(value, depth);
  }
  if (value is Map) {
    return _encodeMap(value, depth);
  }

  throw WireFormatException(
    'cannot encode a ${value.runtimeType} over the Lunora wire — only null, bool, int, double, String, List, Map, '
    'BigInt, Uint8List and the Wire* wrappers round-trip',
  );
}

/// A Dart `int` onto the wire.
///
/// Dart's `int` is 64-bit; a JSON number is a float64. Passing a larger one
/// straight through meant the SERVER's own `JSON.parse` rounded it, so the value
/// that arrived was quietly a different integer. Refuse, as the Go port does,
/// and name the way across.
Object? _encodeInt(int value) {
  if (value > wireMaxExactInteger || value < -wireMaxExactInteger) {
    throw WireFormatException(
      'integer $value exceeds the exact float64 range — wrap it in a BigInt so it crosses the wire as a bigint tag',
    );
  }

  return value;
}

Object? _encodeDouble(double value) {
  if (value.isNaN) {
    return <Object?>[wireTag, 'nan'];
  }
  if (value == double.infinity) {
    return <Object?>[wireTag, 'inf'];
  }
  if (value == double.negativeInfinity) {
    return <Object?>[wireTag, '-inf'];
  }
  return value;
}

Object? _encodeList(List<Object?> value, int depth) {
  final encoded = <Object?>[for (final item in value) encodeWire(item, depth + 1)];

  // Escape a user array whose first element is literally the sentinel, or the
  // decoder would mistake it for a tagged value.
  if (encoded.isNotEmpty && encoded.first == wireTag) {
    return <Object?>[wireTag, 'arr', encoded];
  }
  return encoded;
}

Object? _encodeMap(Map<Object?, Object?> value, int depth) {
  final result = <String, Object?>{};

  for (final entry in value.entries) {
    final key = entry.key;

    if (key is! String) {
      throw WireFormatException(
        'cannot encode a Map with a ${key.runtimeType} key as a JSON object — pass a WireMap to carry non-string keys',
      );
    }

    // Drop undefined fields, matching JSON.stringify, so a pure-JSON object
    // stays byte-identical across the codec.
    if (entry.value is WireUndefined) {
      continue;
    }

    result[key] = encodeWire(entry.value, depth + 1);
  }

  return result;
}

Object? _encodeError(WireError error, int depth) {
  final props = <String, Object?>{};

  for (final entry in error.props.entries) {
    if (entry.value is WireUndefined) {
      continue;
    }
    props[entry.key] = encodeWire(entry.value, depth + 1);
  }

  final encoded = <Object?>[wireTag, 'error', error.name, error.message, props];

  // `cause` rides a positional slot; absent when unset, keeping the 5-element
  // form. A cause that IS null still gets the slot — the two are different
  // errors, and only [WireUndefined] means "there was none".
  final cause = error.cause;

  if (cause is! WireUndefined) {
    encoded.add(encodeWire(cause, depth + 1));
  }

  return encoded;
}

/// Inverse of [encodeWire]: revive tagged leaves into their Dart values.
Object? decodeWire(Object? value, [int depth = 0]) {
  if (depth > wireMaxDepth) {
    throw const WireFormatException('value nesting exceeds the $wireMaxDepth-level limit');
  }

  if (value is List) {
    if (value.isNotEmpty && value.first == wireTag) {
      return _decodeTagged(value, depth);
    }
    return <Object?>[for (final item in value) decodeWire(item, depth + 1)];
  }

  if (value is Map) {
    final result = <String, Object?>{};

    for (final entry in value.entries) {
      result['${entry.key}'] = decodeWire(entry.value, depth + 1);
    }

    return result;
  }

  return value;
}

Object? _decodeTagged(List<Object?> value, int depth) {
  if (value.length < 2 || value[1] is! String) {
    return <Object?>[for (final item in value) decodeWire(item, depth + 1)];
  }

  switch (value[1] as String) {
    case 'undefined':
      return WireUndefined.instance;
    case 'nan':
      return double.nan;
    case 'inf':
      return double.infinity;
    case '-inf':
      return double.negativeInfinity;
    case 'bigint':
      return _decodeBigInt(value);
    case 'date':
      _require(value.length >= 3, 'date');
      final epoch = decodeWire(value[2], depth + 1);
      if (epoch is! num) {
        throw const WireFormatException('malformed date tag');
      }
      return WireDate(_timeClip(epoch.toDouble()));
    case 'url':
      _require(value.length >= 3 && value[2] is String, 'url');
      return WireUrl(value[2] as String);
    case 'map':
      return _decodeMap(value, depth);
    case 'set':
      _require(value.length >= 3 && value[2] is List, 'set');
      return WireSet(<Object?>[for (final item in value[2] as List<Object?>) decodeWire(item, depth + 1)]);
    case 'error':
      return _decodeError(value, depth);
    case 'bytes':
      return _decodeBytes(value);
    case 'arr':
      _require(value.length >= 3 && value[2] is List, 'arr');
      return <Object?>[for (final item in value[2] as List<Object?>) decodeWire(item, depth + 1)];
    default:
      // Unknown tag (forward compatibility): an ordinary array.
      return <Object?>[for (final item in value) decodeWire(item, depth + 1)];
  }
}

void _require(bool condition, String tag) {
  if (!condition) {
    throw WireFormatException('malformed $tag tag');
  }
}

Object? _decodeBigInt(List<Object?> value) {
  if (value.length < 3) {
    throw const WireFormatException('invalid or over-long bigint (max $wireMaxBigIntDigits digits)');
  }

  final raw = value[2];

  if (raw is! String || raw.length > wireMaxBigIntDigits || !_isBigIntLiteral(raw)) {
    throw const WireFormatException('invalid or over-long bigint (max $wireMaxBigIntDigits digits)');
  }

  return BigInt.parse(raw);
}

/// Whether [raw] is an optionally-negative run of ASCII digits. Deliberately not
/// a `RegExp`: this runs on untrusted input on every decode.
bool _isBigIntLiteral(String raw) {
  var start = 0;

  if (raw.startsWith('-')) {
    start = 1;
  }
  if (start >= raw.length) {
    return false;
  }

  for (var index = start; index < raw.length; index += 1) {
    final unit = raw.codeUnitAt(index);

    if (unit < 0x30 || unit > 0x39) {
      return false;
    }
  }

  return true;
}

Object? _decodeMap(List<Object?> value, int depth) {
  _require(value.length >= 3 && value[2] is List, 'map');

  final entries = <MapEntry<Object?, Object?>>[];
  final seen = <String, int>{};

  for (final item in value[2] as List<Object?>) {
    if (item is! List || item.length != 2) {
      throw const WireFormatException('malformed map entry tag');
    }

    final key = decodeWire(item[0], depth + 1);
    final entry = MapEntry(key, decodeWire(item[1], depth + 1));
    final identity = _mapKeyIdentity(key);

    // Last write wins, at the FIRST occurrence's position — the reference builds
    // a real Map, and `Map.prototype.set` on a key already present overwrites
    // the value in place rather than appending. Keeping both entries left two
    // peers of one deployment reading a different value from identical bytes.
    if (identity != null) {
      final index = seen[identity];

      if (index != null) {
        entries[index] = entry;
        continue;
      }

      seen[identity] = entries.length;
    }

    entries.add(entry);
  }

  return WireMap(entries);
}

/// A map key's collapse identity, or `null` when it never collapses.
///
/// The reference's `Map` compares keys by SameValueZero: primitives by value
/// (`NaN` equal to itself), everything else by reference — so two structurally
/// identical `WireDate`/bytes keys stay two entries there and must stay two
/// here.
String? _mapKeyIdentity(Object? key) {
  if (key == null) {
    return 'null';
  }

  if (identical(key, WireUndefined.instance)) {
    return 'undefined';
  }

  if (key is bool) {
    return 'bool:$key';
  }

  if (key is String) {
    return 'str:$key';
  }

  if (key is BigInt) {
    return 'big:$key';
  }

  if (key is num) {
    // `1` and `1.0` are one key to the reference, where every JSON number is a
    // double — so they must not split on Dart's int/double distinction.
    return key.isNaN ? 'num:nan' : 'num:${key.toDouble()}';
  }

  return null;
}

Object? _decodeError(List<Object?> value, int depth) {
  _require(value.length >= 4, 'error');

  // The props slot is NOT optional, NOT nullable and NOT a primitive: the
  // reference reads it with `Object.keys`, which throws on a null or missing
  // slot and ENUMERATES a string/number/boolean/array — so
  // `[TAG,"error","E","m","ab"]` would decode there with the invented props
  // {0:"a",1:"b"} while substituting an empty map accepted the same frame here.
  _require(value.length > 4 && value[4] != null, 'error');

  final decoded = decodeWire(value[4], depth + 1);

  _require(decoded is Map<String, Object?>, 'error');

  final props = <String, Object?>{...decoded! as Map<String, Object?>};

  return WireError(
    name: value[2] is String ? value[2] as String : '',
    message: value[3] is String ? value[3] as String : '',
    props: props,
    cause: value.length > 5 ? decodeWire(value[5], depth + 1) : WireUndefined.instance,
  );
}

Object? _decodeBytes(List<Object?> value) {
  _require(value.length >= 3 && value[2] is String, 'bytes');

  final Uint8List data;

  try {
    data = base64.decode(value[2] as String);
  } on FormatException {
    throw const WireFormatException('malformed bytes tag');
  }

  final ctor = value.length > 3 && value[3] is String ? value[3] as String : 'Uint8Array';

  // A plain Uint8Array is a Uint8List and re-encodes to the 2-element form;
  // every other view keeps its constructor name.
  if (ctor == 'Uint8Array') {
    return data;
  }

  if (ctor != 'ArrayBuffer') {
    // An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
    // forward-compat rule in protocol/README.md §2.1. Keeping it re-encoded a
    // 4-element form the reference emits as 3, so the same value relayed
    // through JS and through here produced different bytes, and therefore
    // different stable subscription keys.
    final size = wireTypedArrayElementSizes[ctor];

    if (size == null) {
      return data;
    }

    if (data.length % size != 0) {
      throw WireFormatException('$ctor payload of ${data.length} bytes is not a multiple of its $size-byte element');
    }
  }

  return WireBytes(data, ctor);
}
