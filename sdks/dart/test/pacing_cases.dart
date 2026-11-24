/// A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
/// `RESUBSCRIBE_CONCURRENCY` in `packages/client/src/client-tuning.ts` is the width: a re-sent
/// `subscribe` holds a slot until any frame bearing its id arrives, it is unsubscribed, or
/// [resubscribeAckTimeoutMs] passes with no reply.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`. Like the retry cases these are
/// outside `conformance-cases.json`, so they do not call `covers`.
library;

import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

const int _subscriptions = 7;

List<Object?> _subscribes(List<Map<String, Object?>> sent) => <Object?>[
      for (final frame in sent)
        if (frame['type'] == 'subscribe') frame['id'],
    ];

String _ack(Object? id) => jsonEncode(<String, Object?>{'id': id, 'type': 'ack'});

LunoraUnsubscribe _subscribeChannel(LunoraClient client, int index, [Map<String, Object?>? args]) =>
    client.subscribe('messages:list', args: args ?? <String, Object?>{'channel': 'c$index'}, onData: (_) {});

/// A client holding [count] query subscriptions made on a first socket, attached to [sender] before any resend.
(LunoraClient, List<LunoraUnsubscribe>) _pacedClient(int count, LunoraFrameSender sender) {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final unsubscribes = <LunoraUnsubscribe>[for (var index = 0; index < count; index++) _subscribeChannel(client, index)];

  client.attachSocket(sender);

  return (client, unsubscribes);
}

/// [_pacedClient] recording to [sent], resent.
LunoraClient _reconnected(int count, List<Map<String, Object?>> sent) {
  final (client, _) = _pacedClient(count, sent.add);

  sent.clear();
  client.resendSubscriptions();

  return client;
}

void casePacingOnlyTheWindowGoesOutUntilAReplyArrives() {
  check(resubscribeConcurrency == 3, "the window must be the reference client's 3");

  final sent = <Map<String, Object?>>[];

  _reconnected(_subscriptions, sent);

  equals(_subscribes(sent).length, resubscribeConcurrency, 'a resend must send only the window until a reply arrives');
}

void casePacingAnyFrameBearingTheIdLetsTheNextOneOut() {
  final sent = <Map<String, Object?>>[];
  final client = _reconnected(_subscriptions, sent);
  final window = _subscribes(sent);

  client.handleFrame(_ack(window[0]));
  equals(_subscribes(sent).length, 4, 'an ack must free its slot');

  client.handleFrame(jsonEncode(<String, Object?>{'cursor': 1, 'data': <Object?>[], 'id': window[1], 'type': 'data'}));
  equals(_subscribes(sent).length, 5, 'a data frame that overtakes the ack must free it too');

  client.handleFrame(jsonEncode(<String, Object?>{
    'error': <String, Object?>{'code': 'FORBIDDEN', 'message': 'no'},
    'id': window[2],
    'type': 'error',
  }));
  equals(_subscribes(sent).length, 6, 'so must the error that refuses it');

  client.handleFrame(_ack(window[0]));
  equals(_subscribes(sent).length, 6, 'a second frame for a released id must free nothing');
}

void casePacingEverySubscriptionGoesOutOnceInSubscribeOrder() {
  final sent = <Map<String, Object?>>[];
  final client = _reconnected(_subscriptions, sent);

  for (var answered = 0; answered < _subscribes(sent).length; answered++) {
    client.handleFrame(_ack(_subscribes(sent)[answered]));
  }

  equals(
    _subscribes(sent).join(','),
    <String>[for (var index = 1; index <= _subscriptions; index++) 'sub_$index'].join(','),
    'every subscription must be re-sent once, in subscribe order',
  );
}

void casePacingUnsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne() {
  final sent = <Map<String, Object?>>[];
  final (client, unsubscribes) = _pacedClient(5, sent.add);

  sent.clear();
  client.resendSubscriptions();

  final outstanding = _subscribes(sent);

  unsubscribes[4]();
  equals(_subscribes(sent).length, 3, 'a queued one must be dropped, and free no slot');

  unsubscribes[0]();
  equals(_subscribes(sent).length, 4, 'an outstanding one will never be answered, so its slot must go on');
  check(!_subscribes(sent).contains('sub_5'), 'the unsubscribed queued one must not go out');

  client.handleFrame(_ack(outstanding[1]));
  equals(_subscribes(sent).length, 4, 'nothing must be left to send');
}

void casePacingAnUnansweredOneStopsHoldingItsSlotAfterTheTimeout() {
  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});

  for (var index = 0; index < _subscriptions; index++) {
    _subscribeChannel(client, index);
  }

  client.attachSocket(sent.add);
  sent.clear();

  final before = client.retryClockMs;

  client.resendSubscriptions();

  final after = client.retryClockMs;
  final deadline = client.nextSubscriptionRetryAt;

  if (deadline == null) {
    check(false, 'an outstanding re-subscribe must report its deadline');

    return;
  }

  check(
    deadline >= before + resubscribeAckTimeoutMs && deadline <= after + resubscribeAckTimeoutMs,
    'the deadline must be the ack timeout after the resend, got $deadline',
  );
  equals(client.retryDueSubscriptions(nowMs: deadline - 1), 0, 'a slot must hold until its deadline');
  equals(_subscribes(sent).length, 3, 'nothing may go out before the deadline');
  equals(client.retryDueSubscriptions(nowMs: deadline), resubscribeConcurrency, 'every timed-out slot must let the next one out, and count it');
  equals(_subscribes(sent).length, 6, 'the next window must have gone out');
}

void casePacingAReconnectMidDrainStartsAFreshWindow() {
  final sent = <Map<String, Object?>>[];
  final client = _reconnected(_subscriptions, sent)..detachSocket();

  check(client.nextSubscriptionRetryAt == null, "a dropped socket's slots must be gone");

  final resent = <Map<String, Object?>>[];

  client.attachSocket(resent.add);
  resent.clear();
  client.resendSubscriptions();

  equals(_subscribes(resent).length, resubscribeConcurrency, 'the new socket must get a fresh window');

  client.handleFrame(_ack(_subscribes(sent)[0]));
  equals(_subscribes(resent).length, 4, 'a reply on the new socket must drain its queue');
}

void casePacingAQueuedOneCarriesTheCursorItHasWhenItGoesOut() {
  final client = LunoraClient(url: 'https://app.example')
    ..authSubject = 'alice'
    ..attachSocket((_) {});

  for (var index = 0; index < 4; index++) {
    _subscribeChannel(client, index);
    client.handleFrame(jsonEncode(<String, Object?>{'cursor': 9, 'data': <Object?>[], 'id': 'sub_${index + 1}', 'type': 'data'}));
  }

  final sent = <Map<String, Object?>>[];

  client.attachSocket(sent.add);
  sent.clear();
  client
    ..resendSubscriptions()
    ..authSubject = 'bob'
    ..handleFrame(_ack('sub_1'));

  final late = sent.where((frame) => frame['type'] == 'subscribe' && frame['id'] == 'sub_4').toList();

  if (late.isEmpty) {
    check(false, 'the queued subscription must go out once a slot frees');

    return;
  }

  check(!(late.last['query']! as Map<String, Object?>).containsKey('sinceSeq'), "the new identity must not resume the old one's position, got ${late.last}");
}

void casePacingAFailedPacedSendFromAFrameDoesNotThrow() {
  var failing = false;
  final (client, _) = _pacedClient(4, (frame) {
    if (failing && frame['type'] == 'subscribe') {
      throw StateError('socket write failed');
    }
  });

  client.resendSubscriptions();
  failing = true;

  try {
    client.handleFrame(_ack('sub_1'));
  } on Object catch (error) {
    check(false, 'a paced send that fails must not escape the frame handler, got $error');
  }
}

void casePacingAFailedSendPutsTheUnsentOnesBackInLine() {
  final sent = <Map<String, Object?>>[];
  var broken = true;
  final (client, _) = _pacedClient(_subscriptions, (frame) {
    if (frame['id'] == 'sub_2' && broken) {
      broken = false;

      throw StateError('write failed');
    }

    sent.add(frame);
  });

  sent.clear();

  var threw = false;

  try {
    client.resendSubscriptions();
  } on StateError {
    threw = true;
  }

  check(threw, "the caller's own resend reports the failed write");

  for (var answered = 0; answered < _subscribes(sent).length; answered++) {
    client.handleFrame(_ack(_subscribes(sent)[answered]));
  }

  equals(_subscribes(sent).toSet().length, _subscriptions, 'every subscription must still go out after a failed write, got ${_subscribes(sent)}');
}

void casePacingAFailedUnsubscribeWriteStillSendsTheBatchItFreed() {
  final sent = <Map<String, Object?>>[];
  final (client, unsubscribes) = _pacedClient(5, (frame) {
    if (frame['type'] == 'unsubscribe') {
      throw StateError('write failed');
    }

    sent.add(frame);
  });

  sent.clear();
  client.resendSubscriptions();

  try {
    unsubscribes[0]();
  } on StateError {
    // The unsubscribe write itself is the caller's to see.
  }

  check(_subscribes(sent).contains('sub_4'), 'the batch a failed unsubscribe freed must still go out, got ${_subscribes(sent)}');
}

void casePacingARetryAcrossASocketSwapLeavesTheNewQueueAlone() {
  final old = <Map<String, Object?>>[];
  final fresh = <Map<String, Object?>>[];
  var swapped = false;
  late final LunoraClient client;

  (client, _) = _pacedClient(5, (frame) {
    old.add(frame);

    // The socket is replaced while the retry's own frame is being written to the old one.
    if (frame['id'] == 'sub_5' && !swapped) {
      swapped = true;
      client
        ..detachSocket()
        ..attachSocket(fresh.add)
        ..resendSubscriptions();
    }
  });
  client
    ..resendSubscriptions()
    ..handleFrame(jsonEncode(<String, Object?>{
      'error': <String, Object?>{'code': 'OVERLOADED', 'message': 'busy', 'retryAfterMs': 0},
      'id': 'sub_5',
      'type': 'error',
    }))
    ..retryDueSubscriptions(nowMs: client.retryClockMs + 2 * resubscribeAckTimeoutMs);

  check(swapped, 'the retry must have reached the old socket');
  check(!_subscribes(old).contains('sub_4'), "the new socket's queue must not be drained onto the old one, got ${_subscribes(old)}");
  check(_subscribes(fresh).contains('sub_1'), 'the new socket must keep its own window');
}

void casePacingAQueuedOneWhoseArgsNoLongerEncodeDoesNotStallTheRest() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final args = <Map<String, Object?>>[
    for (var index = 0; index < 5; index++) <String, Object?>{'channel': 'c$index'},
  ];

  for (var index = 0; index < args.length; index++) {
    _subscribeChannel(client, index, args[index]);
  }

  final sent = <Map<String, Object?>>[];

  client.attachSocket(sent.add);
  sent.clear();
  client.resendSubscriptions();

  // The caller mutated a queued subscription's args into something the wire cannot carry.
  args[3]['bad'] = Object();

  client.handleFrame(_ack('sub_1'));

  check(!_subscribes(sent).contains('sub_4'), 'args that no longer encode cannot go out');
  check(_subscribes(sent).contains('sub_5'), 'the next queued one still goes out, got ${_subscribes(sent)}');
}

void casePacingTheCallersResendThrowsForArgsThatNoLongerEncode() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final args = <Map<String, Object?>>[
    for (var index = 0; index < 5; index++) <String, Object?>{'channel': 'c$index'},
  ];

  for (var index = 0; index < args.length; index++) {
    _subscribeChannel(client, index, args[index]);
  }

  final sent = <Map<String, Object?>>[];

  client.attachSocket(sent.add);
  sent.clear();
  args[4]['bad'] = Object();

  var threw = false;

  try {
    client.resendSubscriptions();
  } on WireFormatException {
    threw = true;
  }

  check(threw, "args that no longer encode are the caller's error");
  check(_subscribes(sent).isEmpty, 'nothing goes out on a half re-subscribed socket, got ${_subscribes(sent)}');
}

void casePacingShapeSubscriptionsAreNotPaced() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});

  for (var index = 0; index < 5; index++) {
    client.subscribeShape('roomMessages', args: <String, Object?>{'room': 'r$index'}, onRows: (_) {});
  }

  final sent = <Map<String, Object?>>[];

  client.attachSocket(sent.add);
  sent.clear();
  client.resendSubscriptions();

  equals(sent.where((frame) => frame['type'] == 'shape_subscribe').length, 5, 'every shape subscription must go out at once');
}
