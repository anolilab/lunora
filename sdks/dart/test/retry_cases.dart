/// The live-query retry hint: a subscription error's `retryAfterMs` schedules one
/// cold re-subscribe of its query, which the caller pulls through
/// `retryDueSubscriptions` at `nextSubscriptionRetryAt`.
///
/// Asserted against the `subscriptionRetry` golden in `protocol/fixtures/ws-frames.json`.
/// That group is deliberately outside `conformance-cases.json`, which only requires
/// behaviour every port has, so these cases do not call `covers`.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

Map<String, Object?> _retryGoldens() => fixture('ws-frames.json')['subscriptionRetry']! as Map<String, Object?>;

/// A client with `sub_1` subscribed on an open socket, holding the golden seed frame and nothing else.
LunoraClient _openSubscribed(Map<String, Object?> retry, List<Map<String, Object?>> sent, List<LunoraSubscriptionError> errors) {
  final client = LunoraClient(url: 'https://app.example');

  attachRecording(client, sent);
  client.subscribe('messages:list', args: <String, Object?>{'channel': 'general'}, onError: errors.add);
  sent.clear();
  client.handleFrame(jsonEncode(retry['seedFrame']));

  return client;
}

/// [_openSubscribed] with the golden hint delivered, so the retry is pending.
LunoraClient _hinted(Map<String, Object?> retry, List<Map<String, Object?>> sent) {
  final client = _openSubscribed(retry, sent, <LunoraSubscriptionError>[]);

  client.handleFrame(jsonEncode(retry['hintFrame']));

  return client;
}

/// The golden hint's error, with its delay replaced.
Map<String, Object?> _hintWithDelay(Object? retryAfterMs) => <String, Object?>{
      'id': 'sub_1',
      'type': 'error',
      'error': <String, Object?>{'code': 'SUBSCRIPTION_REFRESH_FAILED', 'message': 'refresh failed', 'retryAfterMs': retryAfterMs},
    };

/// The golden hint schedules exactly one cold re-subscribe at its deadline. Nothing is sent before it,
/// the frame sent at it is the cold subscribe golden, and it does not fire again.
void caseSubscriptionRetryFiresOneColdResubscribeAtTheHint() {
  final retry = _retryGoldens();
  final sent = <Map<String, Object?>>[];
  final client = _hinted(retry, sent);
  final due = client.nextSubscriptionRetryAt;

  if (due == null) {
    check(false, 'the golden hint must schedule a retry');

    return;
  }

  equals(client.retryDueSubscriptions(nowMs: due - 1), 0, 'nothing may be sent before the retry is due');
  check(sent.isEmpty, 'nothing may be sent before the retry is due');
  equals(client.retryDueSubscriptions(nowMs: due), 1, 'the retry must send exactly one frame when due');
  equals(canonical(sent), canonical(<Object?>[retry['retryFrame']]), 'the retry must be the cold subscribe golden, with no resume cursor');
  equals(client.retryDueSubscriptions(nowMs: due + 60000), 0, 'a fired retry must not fire again');
  equals(client.nextSubscriptionRetryAt, null, 'no retry may remain pending once it has fired');
}

/// The hint is scheduled, and the error callback still fires once with the server's code.
void caseSubscriptionRetryLeavesTheErrorCallbackAsBefore() {
  final retry = _retryGoldens();
  final errors = <LunoraSubscriptionError>[];
  final client = _openSubscribed(retry, <Map<String, Object?>>[], errors);

  client.handleFrame(jsonEncode(retry['hintFrame']));

  equals(errors.length, 1, 'the error callback must still fire once for a hinted error');
  equals(errors.isEmpty ? null : errors.first.code, 'SUBSCRIPTION_REFRESH_FAILED', 'the error callback must still receive the server code');
  check(client.nextSubscriptionRetryAt != null, 'the hint must still schedule the retry alongside the callback');
}

/// A newer hint for the same subscription replaces the pending deadline, so the old one fires nothing.
void caseSubscriptionRetryLaterHintReplacesThePendingOne() {
  final retry = _retryGoldens();
  final sent = <Map<String, Object?>>[];
  final client = _hinted(retry, sent);
  final first = client.nextSubscriptionRetryAt!;

  client.handleFrame(jsonEncode(retry['laterHintFrame']));

  final second = client.nextSubscriptionRetryAt!;

  check(second > first, 'a later hint must push the pending retry later');
  equals(client.retryDueSubscriptions(nowMs: first), 0, 'the replaced retry must not fire at its old deadline');
  check(sent.isEmpty, 'the replaced retry must not send');
  equals(client.retryDueSubscriptions(nowMs: second), 1, 'the replacing retry must fire at its new deadline');
}

/// Each answering frame cancels the pending retry, so nothing is sent even far past its deadline.
void caseSubscriptionRetryCancelledByAnsweringFrames() {
  final retry = _retryGoldens();

  for (final cancel in objectList(retry['cancelFrames'])) {
    final sent = <Map<String, Object?>>[];
    final client = _hinted(retry, sent);
    final due = client.nextSubscriptionRetryAt!;

    client.handleFrame(jsonEncode(cancel['frame']));

    equals(client.nextSubscriptionRetryAt, null, 'a ${cancel['name']} frame must cancel the pending retry');
    equals(client.retryDueSubscriptions(nowMs: due + 60000), 0, 'a cancelled ${cancel['name']} retry must never send');
    check(sent.isEmpty, 'a cancelled ${cancel['name']} retry must not send');
  }
}

/// No hint, a hint that is not a finite number at or above zero, and a TOKEN_EXPIRED frame all schedule nothing.
void caseSubscriptionRetryIgnoresFramesWithoutAValidHint() {
  final retry = _retryGoldens();

  for (final rejected in objectList(retry['noRetryFrames'])) {
    final client = _openSubscribed(retry, <Map<String, Object?>>[], <LunoraSubscriptionError>[]);

    client.handleFrame(jsonEncode(rejected['frame']));

    equals(client.nextSubscriptionRetryAt, null, 'a ${rejected['name']} error must schedule no retry');
  }
}

/// An unsubscribe, a socket detach, a socket attach and close each cancel the pending retry.
void caseSubscriptionRetryCancelledByUnsubscribeSocketAndClose() {
  final retry = _retryGoldens();
  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example');

  attachRecording(client, sent);

  final unsubscribe = client.subscribe('messages:list', args: <String, Object?>{'channel': 'general'}, onError: (_) {});

  client.handleFrame(jsonEncode(retry['seedFrame']));
  client.handleFrame(jsonEncode(retry['hintFrame']));
  unsubscribe();

  equals(client.nextSubscriptionRetryAt, null, 'an unsubscribe must cancel the pending retry');

  final detached = _hinted(retry, <Map<String, Object?>>[]);

  detached.detachSocket();

  equals(detached.nextSubscriptionRetryAt, null, 'a socket detach must cancel the pending retry');

  final reattached = _hinted(retry, <Map<String, Object?>>[]);

  reattached.attachSocket((_) {});

  equals(reattached.nextSubscriptionRetryAt, null, 'a socket attach must cancel the pending retry');

  final closed = _hinted(retry, <Map<String, Object?>>[]);

  closed.close();

  equals(closed.nextSubscriptionRetryAt, null, 'closing the client must cancel the pending retry');
}

/// A shape view's error is never a query re-run: it reaches the shape's callback and schedules nothing.
void caseSubscriptionRetryIgnoresShapeErrors() {
  final sent = <Map<String, Object?>>[];
  final errors = <LunoraSubscriptionError>[];
  final client = LunoraClient(url: 'https://app.example');

  attachRecording(client, sent);
  client.subscribeShape('messages:list', args: <String, Object?>{'channel': 'general'}, onRows: (_) {}, onError: errors.add);
  client.handleFrame(jsonEncode(<String, Object?>{
    'id': 'shape_1',
    'type': 'error',
    'error': <String, Object?>{'code': 'SUBSCRIPTION_REFRESH_FAILED', 'message': 'refresh failed', 'retryAfterMs': 5000},
  }));

  equals(errors.length, 1, 'the shape error must still reach the shape callback, which proves it was routed');
  equals(client.nextSubscriptionRetryAt, null, 'a shape error must not schedule a query re-subscribe');
}

/// A hint above [maxRetryAfterMs] is clamped to it: a 3600000 ms hint is due well before an hour.
void caseSubscriptionRetryClampedToMaxRetryAfter() {
  final retry = _retryGoldens();
  final client = _openSubscribed(retry, <Map<String, Object?>>[], <LunoraSubscriptionError>[]);

  client.handleFrame(jsonEncode(_hintWithDelay(3600000)));

  // The clock starts at client construction, so an unclamped deadline (3600000 + a few ms) is past
  // this instant, and a clamped one (60000 + a few ms) is not.
  equals(client.retryDueSubscriptions(nowMs: 3599999), 1, 'a 3600000 ms hint must be clamped to maxRetryAfterMs');
}

/// An attached client whose `sub_1` and `sub_2` each hold a pending retry, writing through [sender].
LunoraClient _twoHinted(LunoraFrameSender sender) {
  final client = LunoraClient(url: 'https://app.example')..attachSocket(sender);

  for (final channel in <String>['a', 'b']) {
    client.subscribe('messages:list', args: <String, Object?>{'channel': channel});
  }

  for (final id in <String>['sub_1', 'sub_2']) {
    client.handleFrame(jsonEncode(<String, Object?>{..._hintWithDelay(5000), 'id': id}));
  }

  return client;
}

/// A sender that throws stops the batch, and the retries it never wrote stay due.
void caseSubscriptionRetryFailedWriteKeepsUnsentRetriesDue() {
  var failing = false;
  var subscribes = 0;
  final client = _twoHinted((frame) {
    if (frame['type'] != 'subscribe') {
      return;
    }

    if (failing) {
      failing = false;

      throw StateError('socket write failed');
    }

    subscribes++;
  });
  final later = client.retryClockMs + 10000;

  subscribes = 0;
  failing = true;

  var threw = false;

  try {
    client.retryDueSubscriptions(nowMs: later);
  } on StateError {
    threw = true;
  }

  check(threw, "the sender's failure must reach the caller");
  check(client.retryDueSubscriptions(nowMs: later) == 2, 'both retries must stay due after a failed write');
  check(subscribes == 2, 'both retries must be written once the socket accepts them');
}

/// A sender that detaches the socket stops the batch: the rest would go to a socket that is gone.
void caseSubscriptionRetryDetachMidBatchStopsRetries() {
  var armed = false;
  var subscribes = 0;
  late final LunoraClient client;

  client = _twoHinted((frame) {
    if (armed && frame['type'] == 'subscribe') {
      subscribes++;
      client.detachSocket();
    }
  });
  armed = true;

  final sent = client.retryDueSubscriptions(nowMs: client.retryClockMs + 10000);

  check(sent == 1 && subscribes == 1, 'a detached socket must take no more retries, sent=$sent subscribes=$subscribes');
}

/// The deadline is read on a clock the caller can see, so a timer armed for the difference fires at the hint.
void caseSubscriptionRetryDeadlineIsOnThePublicClock() {
  final retry = _retryGoldens();
  final sent = <Map<String, Object?>>[];
  final client = _hinted(retry, sent);
  final due = client.nextSubscriptionRetryAt!;
  final wait = due - client.retryClockMs;

  check(wait > 4000 && wait <= 5000, 'the wait to the deadline must be the hint, got $wait');
}
