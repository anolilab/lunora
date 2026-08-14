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

import 'dart:async';
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

// ─── Optimistic updates ──────────────────────────────────────────────────────

/// A poster that records what it was asked to send and answers from a script.
class _Poster {
  _Poster({this.commitCursor, this.result = '{"ok":true}'});

  final List<Map<String, Object?>> bodies = <Map<String, Object?>>[];
  final List<Map<String, String>> headers = <Map<String, String>>[];

  int? commitCursor;
  String result;

  /// Fail this many calls with an UNCODED throw — a transport failure.
  int transportFailures = 0;

  /// Answer this many calls with a coded error envelope — a server rejection.
  int codedFailures = 0;

  /// The function paths reached, in order.
  List<String> get paths => <String>[for (final body in bodies) body['functionPath']! as String];

  Future<LunoraHttpResponse> call(String url, Map<String, String> sent, String body) async {
    headers.add(sent);
    bodies.add(jsonDecode(body) as Map<String, Object?>);

    if (transportFailures > 0) {
      transportFailures -= 1;

      throw const SocketFailure();
    }

    if (codedFailures > 0) {
      codedFailures -= 1;

      return const LunoraHttpResponse(400, '{"error":{"code":"CONFLICT","message":"nope"}}');
    }

    final cursor = commitCursor == null ? '' : ',"commitCursor":$commitCursor';

    return LunoraHttpResponse(200, '{"result":$result$cursor}');
  }
}

/// An uncoded failure, standing in for a dropped socket. Deliberately NOT a
/// [LunoraApiException]: the replay classifies terminal-versus-transient by
/// exactly that difference.
class SocketFailure implements Exception {
  const SocketFailure();
}

/// Push one `data` frame at [cursor] into [client] for subscription [id].
void pushData(LunoraClient client, String id, Object? data, {int? cursor}) {
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'data', 'id': id, 'data': data, if (cursor != null) 'cursor': cursor}));
}

/// A layer must survive an unrelated server frame, re-derived from the new base
/// rather than clobbered by it — the whole point of rebasing.
void caseOptimisticLayerRebasesOntoAServerFrame() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final seen = <Object?>[];

  // Subscribed and mutated on the SAME path, which is what the per-call
  // `optimistic` targets — see `LunoraClient.mutation`.
  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  // No poster is configured, so the send fails and the layer never confirms —
  // which is the state under test: an unconfirmed layer must survive frames.
  unawaited(
    client.mutation('counter:value', optimistic: (current) => <Object?>[...(current! as List<Object?>), 'pending']).catchError((Object _) => null),
  );

  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'the optimistic value shows immediately');

  // An unrelated write lands. The layer has no commit cursor yet, so it must
  // re-fold onto the NEW base rather than be dropped or clobbered.
  pushData(client, 'sub_1', <Object?>['a', 'b'], cursor: 2);

  equals(canonical(seen.last), canonical(<Object?>['a', 'b', 'pending']), 'the pending layer rebases onto the new base');
}

/// The gapless drop: once a frame reaches the write's commit cursor the layer
/// comes off, because its effect is now in the base.
Future<void> caseOptimisticLayerDropsOnItsCommitCursor() async {
  final poster = _Poster(commitCursor: 7, result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  await client.mutation('counter:value', optimistic: (current) => <Object?>[...(current! as List<Object?>), 'pending']);

  // Confirmed at cursor 7 but no frame has reached it, so the overlay stays.
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'a confirmed layer survives until a frame reaches its cursor');

  // A frame BEFORE the commit cursor must not drop it either.
  pushData(client, 'sub_1', <Object?>['a'], cursor: 6);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'a frame short of the commit cursor keeps the layer');

  // The confirming frame carries the write, so the layer must come off — and
  // the value must NOT show 'pending' twice.
  pushData(client, 'sub_1', <Object?>['a', 'pending'], cursor: 7);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'the confirming frame drops the layer with no double-count');

  // The proof the layer is really gone rather than merely producing the same
  // text: a later unrelated frame must show no residue of it. Asserted this way
  // and not on a delivery COUNT, because a re-fold builds a fresh list every
  // time — so the unchanged-value skip, which compares collections by identity
  // exactly as the reference client's `===` does, does not suppress it.
  pushData(client, 'sub_1', <Object?>['a', 'pending', 'c'], cursor: 8);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending', 'c']), 'no overlay residue after the layer is dropped');
}

/// A `settled` frame carries no value — the write's result was byte-identical —
/// but it still advances the cursor, so it must sweep confirmed layers too.
Future<void> caseSettledFrameDropsAConfirmedLayer() async {
  final poster = _Poster(commitCursor: 4, result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  await client.mutation('counter:value', optimistic: (_) => <Object?>['a', 'ghost']);

  equals(canonical(seen.last), canonical(<Object?>['a', 'ghost']), 'the overlay is displayed');

  client.handleFrame(jsonEncode(<String, Object?>{'type': 'settled', 'id': 'sub_1', 'cursor': 4}));

  equals(canonical(seen.last), canonical(<Object?>['a']), 'a settled frame past the commit cursor releases the overlay');
}

/// A failed write must leave no trace.
Future<void> caseOptimisticLayerRollsBackOnFailure() async {
  final poster = _Poster()..codedFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  try {
    await client.mutation('counter:value', optimistic: (_) => <Object?>['a', 'doomed']);
    _failures.add('a rejected mutation should rethrow');
  } on LunoraApiException catch (error) {
    equals(error.code, 'CONFLICT', 'the server error reaches the caller');
  }

  equals(canonical(seen.last), canonical(<Object?>['a']), 'the failed write rolls its overlay back');
}

/// The multi-query path: one write patches every subscribed query it names.
Future<void> caseOptimisticUpdatePatchesManyQueries() async {
  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final unread = <Object?>[];
  final list = <Object?>[];

  client.subscribe('messages:list', onData: list.add);
  client.subscribe('messages:unread', onData: unread.add);
  pushData(client, 'sub_1', <Object?>['a']);
  pushData(client, 'sub_2', 3);

  await client.mutation(
    'messages:send',
    optimisticUpdate: (store, _) {
      equals(canonical(store.getQuery('messages:list')), canonical(<Object?>['a']), 'getQuery reads the live value');
      store
        ..setQuery('messages:list', <Object?>['a', 'new'])
        ..setQuery('messages:unread', 4);
    },
  );

  equals(canonical(list.last), canonical(<Object?>['a', 'new']), 'the list query is patched');
  equals(unread.last, 4, 'the count query is patched in the same write');
}

/// A buggy update must not fail the mutation, and must not leave half a patch.
Future<void> caseThrowingOptimisticUpdateUnwindsOnlyItsOwnWrites() async {
  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final list = <Object?>[];

  client.subscribe('messages:list', onData: list.add);
  pushData(client, 'sub_1', <Object?>['a']);

  await client.mutation(
    'messages:send',
    optimisticUpdate: (store, _) {
      store.setQuery('messages:list', <Object?>['a', 'half']);

      throw StateError('buggy update');
    },
  );

  equals(canonical(list.last), canonical(<Object?>['a']), 'the partial patch is unwound');
  equals(poster.paths.length, 1, 'the mutation still went out');
}

/// Dart has no `undefined`, so without the explicit delivered flag a query whose
/// first value is null would be suppressed as unchanged and never arrive.
void caseFirstNullValueIsDelivered() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  var deliveries = 0;

  client.subscribe('messages:list', onData: (_) => deliveries += 1);
  pushData(client, 'sub_1', null);
  pushData(client, 'sub_1', null);

  equals(deliveries, 1, 'a first null is delivered, and a second identical one is not');
}

// ─── Offline queue ───────────────────────────────────────────────────────────

/// The core promise: a write issued while disconnected is held, and replays in
/// order under the SAME idempotency key once the client reconnects.
Future<void> caseQueuedWritesReplayInOrderOnReconnect() async {
  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = client.mutation('messages:send', args: <String, Object?>{'n': 1}, mutationId: 'm1');
  final second = client.mutation('messages:send', args: <String, Object?>{'n': 2}, mutationId: 'm2');

  equals(client.pendingWrites, 2, 'both writes are queued while disconnected');
  equals(poster.paths.length, 0, 'nothing was sent while disconnected');

  client.setConnected(true);

  await Future.wait(<Future<Object?>>[first, second]);

  equals(poster.paths.length, 2, 'both writes replayed');
  equals(canonical(poster.bodies.first['args']), canonical(<String, Object?>{'n': 1}), 'the oldest write replays first');
  equals(poster.headers.first['x-lunora-mutation-id'], 'm1', 'the replay carries the idempotency key the call minted');
  equals(client.pendingWrites, 0, 'the queue is empty afterwards');
}

/// A queued write's optimistic overlay must survive until the REPLAY confirms
/// it — this is the case the reference client's rebasing exists for.
Future<void> caseQueuedWriteKeepsItsOverlayUntilReplay() async {
  final poster = _Poster(commitCursor: 9, result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  final pending = client.mutation('counter:value', optimistic: (current) => <Object?>[...(current! as List<Object?>), 'queued']);

  equals(canonical(seen.last), canonical(<Object?>['a', 'queued']), 'a queued write shows optimistically');

  client.setConnected(true);
  await pending;

  pushData(client, 'sub_1', <Object?>['a', 'queued'], cursor: 9);

  equals(canonical(seen.last), canonical(<Object?>['a', 'queued']), 'the replay confirms the layer at its commit cursor');
  equals(seen.length, 3, 'no double-count when the confirming frame lands');
}

/// A bounded queue drops the OLDEST, so an offline session's most recent work is
/// not the first thing lost.
Future<void> caseQueueOverflowDropsTheOldest() async {
  final client = LunoraClient(url: 'https://app.example', post: _Poster().call, offlineQueue: OfflineQueue(maxItems: 2))
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final dropped = client.mutation('messages:send', args: <String, Object?>{'n': 1});
  unawaited(client.mutation('messages:send', args: <String, Object?>{'n': 2}).catchError((Object _) => null));
  unawaited(client.mutation('messages:send', args: <String, Object?>{'n': 3}).catchError((Object _) => null));

  equals(client.pendingWrites, 2, 'the queue is held at its cap');

  try {
    await dropped;
    _failures.add('the evicted write should reject');
  } on LunoraApiException catch (error) {
    equals(error.code, offlineQueueOverflow, 'the evicted write rejects with the overflow code');
  }
}

/// A transport failure mid-flush must not lose the writes behind it, and must
/// not reorder them.
Future<void> caseTransportFailureRequeuesTheRestInOrder() async {
  final poster = _Poster(result: 'null')..transportFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = client.mutation('messages:send', args: <String, Object?>{'n': 1}, mutationId: 'm1');
  final second = client.mutation('messages:send', args: <String, Object?>{'n': 2}, mutationId: 'm2');

  client.setConnected(true);
  await Future<void>.delayed(Duration.zero);

  equals(client.pendingWrites, 2, 'the failed write and everything after it stay queued');
  equals(poster.paths.length, 1, 'the flush stopped at the failure rather than sending on');

  // The socket comes back. Both writes must go out, still oldest first.
  client
    ..setConnected(false)
    ..setConnected(true);

  await Future.wait(<Future<Object?>>[first, second]);

  equals(poster.headers[1]['x-lunora-mutation-id'], 'm1', 'the failed write is retried first, keeping FIFO');
  equals(client.pendingWrites, 0, 'the queue drains');
}

/// A coded error means the server answered. Retrying forever would hang the
/// caller and never release its overlay.
Future<void> caseCodedErrorIsTerminal() async {
  final poster = _Poster(result: 'null')..codedFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send', args: <String, Object?>{'n': 1});

  client.setConnected(true);

  try {
    await pending;
    _failures.add('a server-rejected replay should reject its caller');
  } on LunoraApiException catch (error) {
    equals(error.code, 'CONFLICT', 'the server verdict reaches the queued caller');
  }

  equals(client.pendingWrites, 0, 'a terminally-rejected write is not re-queued');
}

/// A write whose assumptions expired while offline is discarded rather than sent
/// against state it no longer suits.
Future<void> casePreconditionFailureDiscardsBeforeReplay() async {
  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  var valid = true;
  final pending = client.mutation('messages:send', args: <String, Object?>{'n': 1}, precondition: () => valid);

  valid = false;
  client.setConnected(true);

  try {
    await pending;
    _failures.add('a failed precondition should reject');
  } on LunoraApiException catch (error) {
    equals(error.code, offlinePreconditionFailed, 'the discarded write names why');
  }

  equals(poster.paths.length, 0, 'nothing was sent for the discarded write');
}

/// Durable order is authoritative: a prior session's write is older than
/// anything from this one, so it must replay first.
Future<void> caseHydrateRestoresAheadOfThisSession() async {
  final store = MemoryPersistence();

  await store.append(const PersistedMutation(id: 'old', functionPath: 'messages:first', args: <String, Object?>{}));

  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call, offlineQueue: OfflineQueue(persistence: store))
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  // A write issued during the boot window, BEFORE hydrate resolves.
  final fresh = client.mutation('messages:second', mutationId: 'new');

  equals(await client.hydrate(), 1, 'the persisted write is restored');
  equals(client.pendingWrites, 2, 'both writes are queued');

  client.setConnected(true);
  await fresh;

  equals(canonical(poster.paths), canonical(<Object?>['messages:first', 'messages:second']), 'the restored write replays ahead of this session');
  equals(store.records.length, 0, 'a replayed write is removed from durable storage');
}

/// A write queued as one user must never replay as another.
Future<void> caseIdentityChangeDiscardsQueuedWrites() async {
  final poster = _Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call, authSubject: 'user_a')
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send', args: <String, Object?>{'n': 1});

  client
    ..authSubject = 'user_b'
    ..setConnected(true);

  try {
    await pending;
    _failures.add('a write queued under another identity should reject');
  } on LunoraApiException catch (error) {
    equals(error.code, offlineIdentityChanged, 'the discarded write names why');
  }

  equals(poster.paths.length, 0, 'the other user\'s write was never sent');
}

/// The identity stamp is a digest, not the token: an app's queue file must not
/// become somewhere a bearer token sits at rest. Values captured from the
/// reference client, so the two cannot drift apart silently.
void caseTokenDigestMatchesTheReferenceClient() {
  const expectations = <(String, String)>[
    ('', '0:ztntfp:45h'),
    ('a', '1:1r9wi7g:3t3a'),
    ('token-abc', '9:6xtdsz:ku9cs9'),
    ('eyJhbGciOiJIUzI1NiJ9.payload.sig', 'w:t846r5:1i09z6p'),
    // A surrogate pair, because the digest walks code UNITS and a rune-wise
    // walk would silently produce a different value here and nowhere else.
    ('\u{1F511}ünïcode', '9:zq7trr:4ipgmf'),
  ];

  for (final (token, want) in expectations) {
    equals(LunoraClient(url: 'https://app.example', authToken: token).identityFingerprint(), want, 'digest of a ${token.length}-unit token');
  }

  equals(LunoraClient(url: 'https://app.example').identityFingerprint(), null, 'no token is the signed-out identity');
  equals(
    LunoraClient(url: 'https://app.example', authToken: 'ignored', authSubject: 'user_1').identityFingerprint(),
    'subj:user_1',
    'a subject wins over the token, so a refresh keeps the queue',
  );
}

/// A reconnect that lands WHILE a flush is running must not be dropped: the
/// running flush has very likely just stopped on the transport failure that
/// caused the disconnect, so without coalescing it its re-queued writes would
/// sit untouched until some later reconnect happened along.
Future<void> caseReconnectDuringAFlushIsNotLost() async {
  late LunoraClient client;
  var calls = 0;

  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    calls += 1;

    if (calls == 1) {
      // The socket drops and comes back while this very call is in flight.
      client
        ..setConnected(false)
        ..setConnected(true);

      throw const SocketFailure();
    }

    return const LunoraHttpResponse(200, '{"result":null}');
  }

  client = LunoraClient(url: 'https://app.example', post: post)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send', mutationId: 'm1');

  client.setConnected(true);

  await pending;

  equals(calls, 2, 'the reconnect that arrived mid-flush ran a second pass');
  equals(client.pendingWrites, 0, 'the write is not stranded');
}

/// Closing must not leave a caller awaiting a write forever.
Future<void> caseCloseRejectsPendingWrites() async {
  final client = LunoraClient(url: 'https://app.example', post: _Poster().call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send');

  client.close();

  try {
    await pending;
    _failures.add('closing should reject a queued write');
  } on LunoraApiException catch (error) {
    equals(error.code, clientClosed, 'the pending write names why it will not land');
  }
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

  caseOptimisticLayerRebasesOntoAServerFrame();
  await caseOptimisticLayerDropsOnItsCommitCursor();
  await caseSettledFrameDropsAConfirmedLayer();
  await caseOptimisticLayerRollsBackOnFailure();
  await caseOptimisticUpdatePatchesManyQueries();
  await caseThrowingOptimisticUpdateUnwindsOnlyItsOwnWrites();
  caseFirstNullValueIsDelivered();

  await caseQueuedWritesReplayInOrderOnReconnect();
  await caseQueuedWriteKeepsItsOverlayUntilReplay();
  await caseQueueOverflowDropsTheOldest();
  await caseTransportFailureRequeuesTheRestInOrder();
  await caseCodedErrorIsTerminal();
  await casePreconditionFailureDiscardsBeforeReplay();
  await caseHydrateRestoresAheadOfThisSession();
  await caseIdentityChangeDiscardsQueuedWrites();
  caseTokenDigestMatchesTheReferenceClient();
  await caseReconnectDuringAFlushIsNotLost();
  await caseCloseRejectsPendingWrites();

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
    stdout.writeln('PASS  ${required.length} manifest cases + 21 dart-specific');
    return;
  }

  for (final failure in _failures) {
    stderr.writeln('FAIL  $failure');
  }

  exit(1);
}
