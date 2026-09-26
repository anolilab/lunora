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
  covers('complete_frame_cancels_without_dropping_the_subscription');

  var cancellations = 0;

  for (final testCase in objectList(fixture('ws-frames.json')['serverFrames'])) {
    final sent = <Map<String, Object?>>[];
    final client = LunoraClient(url: 'https://app.example')..attachSocket(sent.add);
    final seen = <Object?>[];
    final errors = <LunoraSubscriptionError>[];

    client.subscribe(
      'messages:list',
      args: <String, Object?>{'channel': 'general'},
      onData: seen.add,
      onError: errors.add,
    );
    sent.clear();

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

    // Cancelled AND kept. Removing the entry takes it out of the map
    // `resendSubscriptions` walks, which froze the query across every future
    // reconnect with nothing reported.
    if (expect['resendsAfterReconnect'] == true) {
      cancellations += 1;
      equals(errors.length, 1, 'a complete frame cancels once');
      equals(errors.first.code, expect['code'], 'cancellation code');
      equals(errors.first.message, expect['message'], 'cancellation message');
      client.resendSubscriptions();
      equals(
        jsonEncode(sent.where((frame) => frame['type'] == 'subscribe').map((frame) => frame['id']).toList()),
        jsonEncode(<Object?>[expect['id']]),
        'the cancelled subscription is resent on reconnect',
      );
    }
  }

  // A conditional assertion that never runs is worse than none: without this,
  // renaming the fixture key would leave every suite green.
  equals(cancellations, 1, 'serverFrames must carry one cancelling case');
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

/// Feeds every frame of [sequence] through the read loop's entry point.
void _feed(LunoraClient client, Object? sequence) {
  for (final frame in sequence! as List<Object?>) {
    client.handleFrame(jsonEncode(frame));
  }
}

/// The view a shape holds right now, read back through the only public window
/// onto it: a poke carrying an empty, non-reset part re-delivers the view as is.
List<Object?> _shapeView(LunoraClient client, List<List<Object?>> delivered) {
  _feed(client, <Object?>[
    <String, Object?>{'type': 'pokeStart', 'pokeId': 'probe'},
    <String, Object?>{'type': 'pokePart', 'pokeId': 'probe', 'shapeId': 'shape_1', 'rowsPatch': <Object?>[]},
    <String, Object?>{'type': 'pokeEnd', 'pokeId': 'probe'},
  ]);

  return delivered.removeLast();
}

/// A poke is applied WHOLE or not at all, per shape: a row the codec refuses
/// leaves the view, its checkpoint and its callbacks exactly as they were, and
/// reaches the shape's error callback instead of escaping the read loop.
void caseShapePokeWithUndecodableRowIsRefusedWhole() {
  covers('shape_poke_with_undecodable_row_is_refused_whole');

  final shape = fixture('ws-frames.json')['shape']! as Map<String, Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final delivered = <List<Object?>>[];
  final errors = <LunoraSubscriptionError>[];

  client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'}, onRows: delivered.add, onError: errors.add);
  _feed(client, shape['pokeSequence']);
  delivered.clear();

  try {
    _feed(client, shape['undecodableRowPokeSequence']);
  } on Object catch (error) {
    failures.add('an undecodable row escaped the read loop: $error');
  }

  equals(delivered.length, 0, 'no rows callback fires for the refused poke');
  equals(canonical(errors.map((error) => error.code).toList()), canonical(<Object?>[shape['undecodableRowErrorCode']]), 'the shape is told once, coded');
  equals(canonical(_shapeView(client, delivered)), canonical(shape['expectedRows']), 'the view is untouched: no reset clear, no row applied');

  final resent = <Map<String, Object?>>[];

  client
    ..attachSocket(resent.add)
    ..resendSubscriptions();
  equals(resent.single['sinceCheckpoint'], shape['undecodableRowResendCheckpoint'], 'the checkpoint did not advance past rows the view never held');
  equals(resent.single['sinceEpoch'], 'e1', 'nor did the epoch');
}

/// No frame shape can make the read loop's entry point raise, and none of these
/// touches a live subscription — including a STRING cursor, which is not one.
void caseMalformedFramesAreIgnoredWithoutRaising() {
  covers('malformed_frames_are_ignored_without_raising');

  final case_ = fixture('ws-frames.json')['malformedFrames']! as Map<String, Object?>;
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final seen = <Object?>[];

  client.subscribe('messages:list', args: const <String, Object?>{}, onData: seen.add, onError: (_) => seen.add('error'));
  client.handleFrame(jsonEncode(case_['setupFrame']));
  seen.clear();

  for (final frame in case_['frames']! as List<Object?>) {
    try {
      client.handleFrame(jsonEncode(frame));
    } on Object catch (error) {
      failures.add('frame ${jsonEncode(frame)} raised $error');
    }
  }

  equals(seen.length, 0, 'no malformed frame reaches sub_1');

  final resent = <Map<String, Object?>>[];

  client
    ..attachSocket(resent.add)
    ..resendSubscriptions();

  final query = resent.single['query']! as Map<String, Object?>;

  equals(query['sinceSeq'], case_['resendSinceSeq'], 'the resume cursor is untouched');
  equals(query['sinceEpoch'], case_['resendSinceEpoch'], 'and so is the epoch');
}

/// `close()` finishes every live `watch()` stream: the value delivered before
/// it still arrives, then the stream is done — a `StreamBuilder` is not left
/// waiting on a client that will never feed it again.
Future<void> caseSubscriptionStreamEndsOnClose() async {
  covers('subscription_stream_ends_on_close');

  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final events = StreamIterator<Object?>(client.watch('messages:list', args: const <String, Object?>{}));
  final first = events.moveNext();

  pushData(client, 'sub_1', <String, Object?>{'n': 1});
  client.close();

  equals(await first.timeout(const Duration(seconds: 2), onTimeout: () => false), true, 'the value delivered before close arrives');
  equals(canonical(events.current), canonical(<String, Object?>{'n': 1}), 'and it is that value');
  equals(await events.moveNext().timeout(const Duration(seconds: 2), onTimeout: () => true), false, 'then the stream ends');
}

/// Changing the identity FROM a set value retires what that identity left live:
/// every resume cursor and epoch, and every shape view (its callbacks told
/// `[]`). A first sign-in and a re-assertion of the same identity evict nothing.
void caseIdentityChangeEvictsPreviousSession() {
  covers('identity_change_evicts_previous_session');

  final case_ = fixture('ws-frames.json')['identityChange']! as Map<String, Object?>;
  final shape = fixture('ws-frames.json')['shape']! as Map<String, Object?>;
  final retained = case_['retained']! as Map<String, Object?>;
  final evicted = case_['evicted']! as Map<String, Object?>;

  for (final transition in objectList(case_['transitions'])) {
    final what = '${transition['from']} -> ${transition['to']}';
    final client = LunoraClient(url: 'https://app.example', authSubject: transition['from'] as String?)..attachSocket((_) {});
    final delivered = <List<Object?>>[];

    client
      ..subscribe('messages:list', args: const <String, Object?>{})
      ..subscribeShape('roomMessages', args: <String, Object?>{'room': 'general'}, onRows: delivered.add);
    client.handleFrame(jsonEncode(case_['queryFrame']));
    _feed(client, shape['pokeSequence']);
    delivered.clear();

    client.authSubject = transition['to'] as String?;

    final notified = List<List<Object?>>.of(delivered);
    final resent = <Map<String, Object?>>[];

    client
      ..attachSocket(resent.add)
      ..resendSubscriptions();

    final query = resent.firstWhere((frame) => frame['type'] == 'subscribe')['query']! as Map<String, Object?>;
    final shapeFrame = resent.firstWhere((frame) => frame['type'] == 'shape_subscribe');
    final view = _shapeView(client, delivered);

    if (transition['evicts'] == true) {
      check(!query.containsKey('sinceSeq') && !query.containsKey('sinceEpoch'), '$what: the query resubscribes cold');
      check(!shapeFrame.containsKey('sinceCheckpoint') && !shapeFrame.containsKey('sinceEpoch'), '$what: the shape resubscribes cold');
      equals(canonical(view), canonical(evicted['shapeRows']), '$what: the shape view is emptied');
      equals(canonical(notified), canonical(<Object?>[evicted['shapeCallbackRows']]), '$what: and its callbacks are told so');
    } else {
      equals(query['sinceSeq'], retained['sinceSeq'], '$what: the query keeps its cursor');
      equals(query['sinceEpoch'], retained['sinceEpoch'], '$what: and its epoch');
      equals(shapeFrame['sinceCheckpoint'], retained['sinceCheckpoint'], '$what: the shape keeps its checkpoint');
      equals(view.length, retained['shapeRowCount'], '$what: and its rows');
      equals(notified.length, 0, '$what: and no callback is told anything');
    }
  }
}
