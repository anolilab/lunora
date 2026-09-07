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

/// A manifest case: every port asserts it against the shared fixture's
/// `resetPokeSequence`. It starts from the cold-seed state on purpose — a re-seed
/// is inserts-only, so `m1` leaves the shape with no delete op behind it, and a
/// client that merges renders it for the rest of its life.
/// A buffer is only released at its `pokeEnd`. A socket that drops mid-poke never
/// sends one, so its buffer would be retained for the life of the client — one
/// leak per reconnect, and unbounded against a peer that opens pokes it never
/// closes.
///
/// Asserted black-box: an evicted poke behaves exactly like one that was never
/// opened, which is the only form of this all eight ports can share.
void casePendingPokeBuffersAreBounded() {
  covers('pending_poke_buffers_are_bounded');

  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final delivered = <List<Object?>>[];

  client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'}, onRows: delivered.add);

  // A poke opened, part-filled, then abandoned when the socket dropped.
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeStart', 'pokeId': 'stale'}));
  client.handleFrame(
    jsonEncode(<String, Object?>{
      'type': 'pokePart',
      'pokeId': 'stale',
      'shapeId': 'shape_1',
      'rowsPatch': <Object?>[
        <String, Object?>{'op': 'insert', 'key': 'ghost', 'value': 'ghost-row'},
      ],
    }),
  );

  for (var index = 0; index < maxPendingPokes; index++) {
    client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeStart', 'pokeId': 'filler-$index'}));
  }

  // The abandoned buffer is gone, so its late pokeEnd is a no-op.
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeEnd', 'pokeId': 'stale'}));

  equals(delivered.length, 0, 'the ghost row of an evicted poke must never reach the view');

  // ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
  final newest = 'filler-${maxPendingPokes - 1}';

  client.handleFrame(
    jsonEncode(<String, Object?>{
      'type': 'pokePart',
      'pokeId': newest,
      'shapeId': 'shape_1',
      'rowsPatch': <Object?>[
        <String, Object?>{'op': 'insert', 'key': 'm1', 'value': 'kept'},
      ],
    }),
  );
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeEnd', 'pokeId': newest}));

  equals(delivered.length, 1, 'the newest buffer must survive and apply');
  equals(canonical(delivered.last), canonical(<Object?>['kept']), 'the surviving poke applies its rows');
}

void caseResetPokeReplacesTheView() {
  covers('shape_reset_poke_replaces_membership');

  final shape = fixture('ws-frames.json')['shape'] as Map<String, Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final delivered = <List<Object?>>[];

  client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'}, onRows: delivered.add);

  for (final entry in shape['pokeSequence']! as List<Object?>) {
    client.handleFrame(jsonEncode(entry));
  }

  equals(canonical(delivered.last), canonical(shape['expectedRows']), 'materialised rows');

  for (final entry in shape['resetPokeSequence']! as List<Object?>) {
    client.handleFrame(jsonEncode(entry));
  }

  // m1 left the shape while this client was away, and the re-seed says so by
  // omission — it carries no delete, only the rows that are still members.
  equals(canonical(delivered.last), canonical(shape['resetExpectedRows']), 'a reset poke replaces the view');
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

/// A reconnect has to re-subscribe the SHAPE views too.
///
/// `resendSubscriptions` walked only the query registry, so after the first
/// socket drop every `subscribeShape` view stopped receiving pokes for the rest
/// of the process's life, and nothing said so.
void caseShapeSubscriptionsResendAfterReconnect() {
  covers('shape_subscriptions_resend_after_reconnect');

  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});

  client.subscribe('messages:list', args: <String, Object?>{'channel': 'general'});
  client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'});

  // The cursors a resume carries are written by the frame handler, so they have
  // to exist before the resend is built.
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'data', 'id': 'sub_1', 'data': <Object?>[], 'cursor': 9, 'epoch': 'e1'}));
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeStart', 'pokeId': 'poke-1', 'epoch': 'e1'}));
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokePart', 'pokeId': 'poke-1', 'shapeId': 'shape_1', 'reset': true, 'rowsPatch': <Object?>[]}));
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'pokeEnd', 'pokeId': 'poke-1', 'checkpoint': 5, 'epoch': 'e1'}));

  final resent = <Map<String, Object?>>[];

  client
    ..attachSocket(resent.add)
    ..resendSubscriptions();

  equals(canonical(<Object?>[for (final frame in resent) frame['type']]), canonical(<Object?>['subscribe', 'shape_subscribe']), 'BOTH registries resend');

  if (resent.length != 2) {
    return;
  }

  equals((resent[0]['query']! as Map<String, Object?>)['sinceSeq'], 9, 'the query frame carries its resume cursor');
  equals(resent[1]['id'], 'shape_1', 'the shape frame is addressed at the live view');
  equals((resent[1]['shape']! as Map<String, Object?>)['name'], 'roomMessages', 'the shape frame names the shape');
  equals(canonical((resent[1]['shape']! as Map<String, Object?>)['args']), canonical(<String, Object?>{'room': 'general'}), 'and carries its args');
  equals(resent[1]['sinceCheckpoint'], 5, 'the shape resumes from the checkpoint it materialised');
  equals(resent[1]['sinceEpoch'], 'e1', 'and from the epoch it saw');
}

/// A payload the codec refuses must not end the socket read loop.
///
/// It reaches THAT subscription's error callback coded `INVALID_FRAME`; letting
/// it escape `handleFrame` killed the caller's loop and with it every other
/// subscription on the client, over one bad frame.
void caseRefusedPayloadReachesTheSubscriptionNotTheReadLoop() {
  covers('server_frame_consumer');

  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final errors = <LunoraSubscriptionError>[];
  final second = <Object?>[];

  client.subscribe('messages:list', onError: errors.add);
  client.subscribe('messages:other', onData: second.add);

  // A bigint tag whose payload is not a number — the codec rejects it.
  final Object? kind = client.handleFrame(
    jsonEncode(<String, Object?>{
      'type': 'data',
      'id': 'sub_1',
      'data': <String, Object?>{
        'amount': <Object?>[wireTag, 'bigint', 'not-a-number'],
      },
    }),
  );

  equals(kind, 'error', 'the refusal is reported as an error frame rather than thrown');
  equals(errors.length, 1, 'the refusal reaches the addressed subscription');
  equals(errors.isEmpty ? null : errors.first.code, 'INVALID_FRAME', 'coded so a consumer can classify it');

  pushData(client, 'sub_2', <Object?>['still here']);

  equals(
      canonical(second),
      canonical(<Object?>[
        <Object?>['still here'],
      ]),
      'every OTHER subscription keeps delivering');
}
