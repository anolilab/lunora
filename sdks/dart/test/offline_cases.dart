/// The offline queue: ordering, durability, replay and batching.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Offline queue ───────────────────────────────────────────────────────────

/// The core promise: a write issued while disconnected is held, and replays in
/// order under the SAME idempotency key once the client reconnects.
Future<void> caseQueuedWritesReplayInOrderOnReconnect() async {
  final poster = Poster(result: 'null');
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
  // Two or more writes coalesce into ONE batch round trip.
  equals(poster.batchRequests, 1, 'the flush cost one request, not one per write');

  final calls = poster.callsAt(0);

  equals(canonical(calls[0]['args']), canonical(<String, Object?>{'n': 1}), 'the oldest write is the first entry');
  equals(calls[0]['mutationId'], 'm1', 'each entry carries the idempotency key its call minted');
  equals(calls[1]['mutationId'], 'm2', 'and they keep their order');
  equals(client.pendingWrites, 0, 'the queue is empty afterwards');
}

/// A queued write's optimistic overlay must survive until the REPLAY confirms
/// it — this is the case the reference client's rebasing exists for.
Future<void> caseQueuedWriteKeepsItsOverlayUntilReplay() async {
  final poster = Poster(commitCursor: 9, result: 'null');
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
  final client = LunoraClient(url: 'https://app.example', post: Poster().call, offlineQueue: OfflineQueue(maxItems: 2))
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final dropped = client.mutation('messages:send', args: <String, Object?>{'n': 1});
  unawaited(client.mutation('messages:send', args: <String, Object?>{'n': 2}).catchError((Object _) => null));
  unawaited(client.mutation('messages:send', args: <String, Object?>{'n': 3}).catchError((Object _) => null));

  equals(client.pendingWrites, 2, 'the queue is held at its cap');

  try {
    await dropped;
    failures.add('the evicted write should reject');
  } on LunoraApiException catch (error) {
    equals(error.code, offlineQueueOverflow, 'the evicted write rejects with the overflow code');
  }
}

/// A transport failure mid-flush must not lose the writes behind it, and must
/// not reorder them.
Future<void> caseTransportFailureRequeuesTheRestInOrder() async {
  final poster = Poster(result: 'null')..transportFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = client.mutation('messages:send', args: <String, Object?>{'n': 1}, mutationId: 'm1');
  final second = client.mutation('messages:send', args: <String, Object?>{'n': 2}, mutationId: 'm2');

  client.setConnected(true);
  await Future<void>.delayed(Duration.zero);

  equals(client.pendingWrites, 2, 'the failed write and everything after it stay queued');
  equals(poster.batchRequests, 1, 'the flush stopped at the failure rather than sending on');

  // The socket comes back. Both writes must go out, still oldest first.
  client
    ..setConnected(false)
    ..setConnected(true);

  await Future.wait(<Future<Object?>>[first, second]);

  equals(poster.callsAt(1)[0]['mutationId'], 'm1', 'the failed write is retried first, keeping FIFO');
  equals(client.pendingWrites, 0, 'the queue drains');
}

/// A coded error means the server answered. Retrying forever would hang the
/// caller and never release its overlay.
Future<void> caseCodedErrorIsTerminal() async {
  final poster = Poster(result: 'null')..codedFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send', args: <String, Object?>{'n': 1});

  client.setConnected(true);

  try {
    await pending;
    failures.add('a server-rejected replay should reject its caller');
  } on LunoraApiException catch (error) {
    equals(error.code, 'CONFLICT', 'the server verdict reaches the queued caller');
  }

  equals(client.pendingWrites, 0, 'a terminally-rejected write is not re-queued');
}

/// A write whose assumptions expired while offline is discarded rather than sent
/// against state it no longer suits.
Future<void> casePreconditionFailureDiscardsBeforeReplay() async {
  final poster = Poster(result: 'null');
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
    failures.add('a failed precondition should reject');
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

  final poster = Poster(result: 'null');
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
  final poster = Poster(result: 'null');
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
    failures.add('a write queued under another identity should reject');
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

/// A slot the server answered with a TRANSIENT shard failure never reached a
/// verdict, so its write goes back on the queue — while a slot beside it that
/// the server did decide is settled terminally. Getting this wrong permanently
/// rejects a durable write over a shard that was briefly unreachable.
Future<void> caseBatchSlotsAreClassifiedIndependently() async {
  final poster = Poster(result: 'null')
    ..batchReply = '{"results":['
        '{"id":0,"body":{"error":{"code":"SHARD_UNAVAILABLE","message":"try again"}}},'
        '{"id":1,"body":{"error":{"code":"CONFLICT","message":"nope"}}},'
        '{"id":2,"body":{"result":null,"commitCursor":4}}'
        ']}';

  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final transient = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 1}, mutationId: 'm1'));
  final rejected = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 2}, mutationId: 'm2'));
  final ok = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 3}, mutationId: 'm3'));

  client.setConnected(true);

  await ok.done;
  await rejected.done;

  equals(rejected.code, 'CONFLICT', 'the server verdict reaches that entry only');
  equals(client.pendingWrites, 1, 'only the transient slot is re-queued');

  // And it lands on the next flush, rather than being lost or reported failed.
  client
    ..setConnected(false)
    ..setConnected(true);

  await transient.done;

  equals(client.pendingWrites, 0, 'the re-queued write settles on the next reconnect');
  // A LONE write rides the single-call path, so its key is a header rather than
  // a batch entry — which is the shape the second flush takes here.
  equals(poster.headers[1]['x-lunora-mutation-id'], 'm1', 'under the key it was minted with');
}

/// A slot the server never returned may or may not have committed, so it is
/// retried — safe, because the entry carries the same idempotency key.
Future<void> caseBatchMissingSlotIsRetried() async {
  final poster = Poster(result: 'null')..batchReply = '{"results":[{"id":0,"body":{"result":null}}]}';
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 1}, mutationId: 'm1'));
  final second = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 2}, mutationId: 'm2'));

  client.setConnected(true);
  await first.done;

  equals(client.pendingWrites, 1, 'the unanswered slot goes back on the queue');

  // It comes back on the next flush, under the key it was minted with.
  client
    ..setConnected(false)
    ..setConnected(true);

  await second.done;

  equals(poster.headers[1]['x-lunora-mutation-id'], 'm2', 'the retry reuses the original idempotency key');
}

/// A whole-batch coded rejection is a verdict on every entry — the server
/// decided, so re-queuing would retry a request it will reject identically.
Future<void> caseWholeBatchRejectionIsTerminal() async {
  final poster = Poster(result: 'null')..batchReply = '{"error":{"code":"FORBIDDEN","message":"no"}}';
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 1}));
  final second = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 2}));

  client.setConnected(true);

  await first.done;
  await second.done;

  equals(first.code, 'FORBIDDEN', 'the whole-batch verdict reaches the first caller');
  equals(second.code, 'FORBIDDEN', 'and the second');
  equals(client.pendingWrites, 0, 'nothing is left queued');
}

/// Closing must not leave a caller awaiting a write forever.
Future<void> caseCloseRejectsPendingWrites() async {
  final client = LunoraClient(url: 'https://app.example', post: Poster().call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send');

  client.close();

  try {
    await pending;
    failures.add('closing should reject a queued write');
  } on LunoraApiException catch (error) {
    equals(error.code, clientClosed, 'the pending write names why it will not land');
  }
}
