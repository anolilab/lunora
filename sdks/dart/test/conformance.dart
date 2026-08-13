/// Protocol-conformance suite: drives the Dart SDK against the shared golden
/// fixtures in `protocol/fixtures/`, the same files the TypeScript client and
/// every sibling port are tested against.
///
/// A plain `main()` rather than a `package:test` suite, matching the java and
/// kotlin legs. `package:test` is not in the SDK, so depending on it would make
/// this package's `dart pub get` reach pub.dev — and the transport is defined to
/// have no dependencies at all (see `pubspec.yaml`). The end of `main` is the
/// after-all hook the manifest check needs, which is the one thing XCTest and
/// libtest could not give the swift and rust ports.
///
/// Run it with `dart run test/conformance.dart`, or through `sdks/run-all.sh`.
library;

import 'dart:convert';
import 'dart:io';

import 'package:lunora/lunora.dart';

final List<String> _failures = <String>[];
final Set<String> _covered = <String>{};

/// Records that the named manifest case actually executed. The evidence is the
/// call, never a list of names a suite claims to cover.
void covers(String name) => _covered.add(name);

void check(bool condition, String what) {
  if (!condition) {
    _failures.add(what);
  }
}

void equals(Object? got, Object? want, String what) {
  if (got != want) {
    _failures.add('$what\n     got: $got\n    want: $want');
  }
}

/// Re-serialises so two structures compare as text with a canonical key order,
/// independent of the order the fixture file happens to use.
String canonical(Object? value) => stableStringify(value);

void throws(void Function() body, String what) {
  try {
    body();
    _failures.add('$what — expected a throw, got none');
  } on Object {
    // The throw is the assertion.
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

late final Directory _fixtures = _findFixtures();

Directory _findFixtures() {
  var directory = File.fromUri(Platform.script).parent;

  for (var hop = 0; hop < 8; hop += 1) {
    final candidate = Directory('${directory.path}/protocol/fixtures');

    if (candidate.existsSync()) {
      return candidate;
    }

    final parent = directory.parent;

    if (parent.path == directory.path) {
      break;
    }

    directory = parent;
  }

  throw StateError('could not locate protocol/fixtures');
}

Map<String, Object?> fixture(String name) => jsonDecode(File('${_fixtures.path}/$name').readAsStringSync()) as Map<String, Object?>;

List<Map<String, Object?>> objectList(Object? value) => (value as List<Object?>).cast<Map<String, Object?>>();

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
  ];

  for (final (value, want) in expectations) {
    equals(formatDouble(value), want, 'formatDouble($value)');
  }

  // Not in the shared table because the sibling ports render it "-0": ECMAScript
  // spells negative zero "0", and Dart's toStringAsFixed does not.
  equals(formatDouble(-0.0), '0', 'formatDouble(-0.0)');
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
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

void caseRpcRequestBodies() {
  covers('rpc_request_bodies');

  final request = fixture('rpc.json')['request'] as Map<String, Object?>;

  for (final testCase in objectList(request['cases'])) {
    final args = testCase.containsKey('args') ? testCase['args'] : decodeWire(testCase['argsWire']);
    final body = LunoraClient.buildRpcBody(testCase['functionPath'] as String, args, shardKey: testCase['shardKey'] as String?);

    equals(canonical(body), canonical(testCase['body']), 'rpc body for ${testCase['name']}');
  }
}

void caseRpcResponses() {
  covers('rpc_responses');

  final document = fixture('rpc.json');

  for (final testCase in objectList(document['responseOk'])) {
    final response = testCase['response'] as Map<String, Object?>;
    final value = LunoraClient.parseRpcResponse(response);

    equals(canonical(encodeWire(value)), canonical(response['result']), 'rpc result for ${testCase['name']}');
  }

  for (final testCase in objectList(document['responseError'])) {
    final response = testCase['response'] as Map<String, Object?>;

    try {
      LunoraClient.parseRpcResponse(response, status: 400);
      _failures.add('${testCase['name']} — expected a LunoraApiException, got none');
    } on LunoraApiException catch (error) {
      equals(error.code, testCase['code'], 'error code for ${testCase['name']}');
      equals(error.message, testCase['message'], 'error message for ${testCase['name']}');

      if (testCase.containsKey('dataWire')) {
        equals(canonical(encodeWire(error.data)), canonical(testCase['dataWire']), 'error data for ${testCase['name']}');
      }
    }
  }
}

void caseNon2xxWithoutErrorEnvelopeFails() {
  covers('non_2xx_without_error_envelope_fails');

  // protocol/README.md §4.2. Without the status check this returned a null
  // result and threw nothing — the caller believes its mutation committed.
  throws(
    () => LunoraClient.parseRpcResponse(<String, Object?>{'message': 'bad gateway'}, status: 502),
    'a non-2xx with no error envelope must fail',
  );
}

// ─── WebSocket frames ────────────────────────────────────────────────────────

void caseClientFrameBuilders() {
  covers('client_frame_builders');

  final frames = fixture('ws-frames.json')['clientFrames'] as Map<String, Object?>;

  equals(canonical(LunoraClient.buildConnectFrame(clientId: 'client-test')), canonical(frames['connect']), 'connect frame');
  equals(
    canonical(LunoraClient.buildConnectFrame(clientId: 'client-test', context: <String, Object?>{'roomId': 'general'})),
    canonical(frames['connect-with-context']),
    'connect frame with context',
  );
  equals(
    canonical(LunoraClient.buildSubscribeFrame('sub_1', 'messages:list', <String, Object?>{'channel': 'general'})),
    canonical(frames['subscribe-cold']),
    'cold subscribe frame',
  );
  equals(
    canonical(
      LunoraClient.buildSubscribeFrame('sub_1', 'messages:list', <String, Object?>{'channel': 'general'}, sinceSeq: 12, sinceEpoch: 'e1'),
    ),
    canonical(frames['subscribe-resume']),
    'resume subscribe frame',
  );
  equals(canonical(LunoraClient.buildUnsubscribeFrame('sub_1')), canonical(frames['unsubscribe']), 'unsubscribe frame');
}

void caseServerFrameConsumer() {
  covers('server_frame_consumer');

  for (final testCase in objectList(fixture('ws-frames.json')['serverFrames'])) {
    final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
    final seen = <Object?>[];
    final errors = <LunoraSubscriptionError>[];

    client.subscribe(
      'messages:list',
      args: <String, Object?>{'channel': 'general'},
      onData: seen.add,
      onError: errors.add,
    );

    final expect = testCase['expect'] as Map<String, Object?>;
    final kind = client.handleFrame(jsonEncode(testCase['frame']));

    equals(kind, expect['kind'], 'frame kind for ${testCase['name']}');

    if (expect.containsKey('valueWire')) {
      equals(seen.length, 1, 'onData should fire once for ${testCase['name']}');
      equals(canonical(encodeWire(seen.first)), canonical(expect['valueWire']), 'delivered value for ${testCase['name']}');
    }

    if (expect['kind'] == 'error') {
      equals(errors.length, 1, 'onError should fire once for ${testCase['name']}');
      equals(errors.first.code, expect['code'], 'error code for ${testCase['name']}');
    }
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

void caseShapeSubscribeFrame() {
  covers('shape_subscribe_frame');

  final shape = fixture('ws-frames.json')['shape'] as Map<String, Object?>;
  final frame = LunoraClient.buildShapeSubscribeFrame('shape_1', 'roomMessages', args: <String, Object?>{'room': 'general'});

  equals(canonical(frame), canonical(shape['shape-subscribe-cold']), 'shape subscribe frame');
}

void casePokeSequenceMaterialisesRows() {
  covers('poke_sequence_materialises_rows');

  final shape = fixture('ws-frames.json')['shape'] as Map<String, Object?>;
  final sequence = shape['pokeSequence'] as List<Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final delivered = <List<Object?>>[];

  client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'}, onRows: delivered.add);

  for (final entry in sequence) {
    client.handleFrame(jsonEncode(entry));
  }

  equals(delivered.length, 1, 'a poke applies atomically at pokeEnd');
  equals(canonical(delivered.last), canonical(shape['expectedRows']), 'materialised rows');
}

void casePokePartsDoNotApplyBeforePokeEnd() {
  covers('poke_parts_do_not_apply_before_poke_end');

  final shape = fixture('ws-frames.json')['shape'] as Map<String, Object?>;
  final sequence = shape['pokeSequence'] as List<Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  var fired = 0;

  client.subscribeShape('roomMessages', onRows: (_) => fired += 1);

  for (final entry in sequence.take(sequence.length - 1)) {
    client.handleFrame(jsonEncode(entry));
  }

  equals(fired, 0, 'the view would be torn if parts applied before pokeEnd');
}

// ─── Dart-specific cases ─────────────────────────────────────────────────────

/// quicktype's Dart backend emits every field in `toJson()`, so an unset
/// optional would reach the wire as `"limit": null` — which `v.optional()`
/// rejects. Two sibling ports shipped exactly that bug. This is the check that
/// fails if the pruning in `LunoraClient.wireValue` is ever dropped.
void caseWireValuePrunesUnsetOptionals() {
  final projected = LunoraClient.wireValue(_ModelWithUnsetOptional());

  equals(
    canonical(projected),
    '{"channelId":"chan_1","nested":{"kept":1}}',
    'wireValue must omit an unset optional rather than send it as null',
  );
}

/// The Flutter binding: a `watch` stream must start the subscription on first
/// listen and tear it down when the listener cancels, so a disposed widget
/// cannot leave a live subscription behind.
Future<void> caseWatchStreamUnsubscribesOnCancel() async {
  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example')..attachSocket(sent.add);

  equals(sent.length, 0, 'watch must not subscribe before it is listened to');

  final received = <Object?>[];
  final subscription = client.watch('messages:list', args: <String, Object?>{'channel': 'general'}).listen(received.add);

  equals(sent.length, 1, 'listening must send exactly one subscribe frame');
  equals(sent.first['type'], 'subscribe', 'the frame sent on listen is a subscribe');

  client.handleFrame(jsonEncode(<String, Object?>{'type': 'data', 'id': sent.first['id'], 'data': 42}));

  // The value crosses an asynchronous stream, so let the event loop deliver it.
  await Future<void>.delayed(Duration.zero);

  equals(received.length, 1, 'the stream must deliver the pushed value');
  equals(received.first, 42, 'the delivered value');

  await subscription.cancel();

  equals(sent.length, 2, 'cancelling must send an unsubscribe frame');
  equals(sent.last['type'], 'unsubscribe', 'the frame sent on cancel is an unsubscribe');
}

/// A model standing in for quicktype's output: `toJson()` emits the unset
/// optional as null, exactly as the generated ones do.
class _ModelWithUnsetOptional {
  Map<String, dynamic> toJson() => <String, dynamic>{
        'channelId': 'chan_1',
        'limit': null,
        'nested': <String, dynamic>{'kept': 1, 'dropped': null},
      };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

Future<void> main() async {
  caseWireCodecRoundTrip();
  caseUndefinedIsDistinctFromNull();
  caseOverLongBigIntRejected();
  caseDepthCapEnforced();
  caseStableWireKeyFixtures();
  caseFormatNumberMatchesEcmaScript();
  caseKeyOrderMatchesUtf16();
  caseStringEscapingMatchesJsonStringify();
  caseRpcRequestBodies();
  caseRpcResponses();
  caseNon2xxWithoutErrorEnvelopeFails();
  caseClientFrameBuilders();
  caseServerFrameConsumer();
  caseShapeSubscribeFrame();
  casePokeSequenceMaterialisesRows();
  casePokePartsDoNotApplyBeforePokeEnd();
  caseWireValuePrunesUnsetOptionals();
  await caseWatchStreamUnsubscribesOnCancel();

  // The after-all hook. Adding a name to protocol/conformance-cases.json turns
  // this leg red until a case actually executes under it — the evidence is the
  // `covers` call inside the case, never a list of names this file claims.
  final manifest = jsonDecode(File('${_fixtures.parent.path}/conformance-cases.json').readAsStringSync()) as Map<String, Object?>;
  final required = (manifest['required'] as List<Object?>).cast<String>();

  check(required.isNotEmpty, 'the manifest must list at least one required case');

  for (final name in required) {
    check(_covered.contains(name), 'protocol/conformance-cases.json requires case $name, which this run did not exercise');
  }

  if (_failures.isEmpty) {
    stdout.writeln('PASS  ${required.length} manifest cases + 2 dart-specific');
    return;
  }

  for (final failure in _failures) {
    stderr.writeln('FAIL  $failure');
  }

  exit(1);
}
