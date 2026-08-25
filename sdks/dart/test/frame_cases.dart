/// WebSocket frames and the shape/poke protocol.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

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

/// The `Stream` form of a live query: same subscription, same decode, same order
/// as the callback form.
Future<void> caseSubscriptionStreamYieldsFrameValuesInOrder() async {
  covers('subscription_stream_yields_frame_values_in_order');

  final case_ = fixture('ws-frames.json')['stream']! as Map<String, Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  // A queued iterator, not `await for`: the frames are fed from this same
  // isolate, so the loop has to be driven one `moveNext()` at a time.
  final events = StreamIterator<Object?>(client.watch('messages:list', args: <String, Object?>{'channel': 'general'}));
  final seen = <Object?>[];

  for (final frame in case_['frames']! as List<Object?>) {
    // moveNext() BEFORE the frame, and deliberately so: `watch` opens its
    // subscription on first listen, and a StreamIterator does not listen until
    // moveNext() is called. Feeding the frame first therefore pushed it at a
    // client with no such subscription registered, it was dropped, and the
    // await that followed never completed — which is how this case hung and
    // took the other 53 with it.
    final next = events.moveNext();

    client.handleFrame(jsonEncode(frame));

    equals(await next, true, 'the stream delivers a value per frame');
    seen.add(events.current);
  }

  // Cancelling tears the subscription down, so nothing is left registered
  // against a client the consumer has finished with.
  await events.cancel();

  equals(canonical(encodeWire(seen)), canonical(case_['yielded']), "the stream yields the frames' values, in order");
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
