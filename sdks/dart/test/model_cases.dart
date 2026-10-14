/// How a GENERATED MODEL reaches the wire, and the Flutter bindings.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Dart-specific cases ─────────────────────────────────────────────────────

/// `wireValue` must hand a model's `toJson()` through UNCHANGED, nulls included.
///
/// It used to prune them, which broke every `v.nullable()` argument: the server
/// requires that key present holding null. An unset `v.optional()` is omitted by
/// the model itself — `guardOptionalFields` in `targets/dart.ts` puts the
/// `if (x != null)` there, where the required-versus-optional distinction is
/// still visible. This case is what fails if that pruning ever comes back.
void caseWireValuePassesModelJsonThrough() {
  final projected = LunoraClient.wireValue(_ModelWithRequiredNull());

  equals(canonical(projected), '{"channelId":"chan_1","nickname":null}', 'wireValue must keep an explicit null, which a nullable argument needs');
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

/// A widget tree hands one query's stream to more than one builder, and rebuilds
/// after cancelling. A single-subscription controller throws on both — "Stream
/// has already been listened to" — so `watch` gives each listener its own
/// subscription instead.
Future<void> caseWatchSupportsManyListenersAndReListening() async {
  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example')..attachSocket(sent.add);
  final stream = client.watch('messages:list');
  final first = <Object?>[];
  final second = <Object?>[];

  final a = stream.listen(first.add);
  final b = stream.listen(second.add);

  equals(sent.length, 2, 'each listener opens its own subscription');

  client
    ..handleFrame('{"type":"data","id":"sub_1","data":1}')
    ..handleFrame('{"type":"data","id":"sub_2","data":2}');

  await Future<void>.delayed(Duration.zero);

  equals(canonical(first), canonical(<Object?>[1]), 'the first listener gets its own value');
  equals(canonical(second), canonical(<Object?>[2]), 'the second listener is unaffected by the first');

  await a.cancel();

  equals(sent.last['type'], 'unsubscribe', 'cancelling one listener unsubscribes only that one');
  equals(sent.last['id'], 'sub_1', 'and it is the cancelled listener that goes');

  // The rebuild-after-cancel case, which is what actually threw.
  final c = stream.listen((_) {});

  equals(sent.last['type'], 'subscribe', 're-listening after a cancel opens a fresh subscription');

  await b.cancel();
  await c.cancel();
}

/// A call made after `close` must fail fast. It used to be queued against a
/// client that would never flush again, so its Future never settled — the exact
/// hang `close` exists to prevent.
Future<void> caseCallsAfterCloseFailFast() async {
  final client = LunoraClient(url: 'https://app.example', post: Poster().call)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false)
    ..close();

  try {
    await client.mutation('messages:send').timeout(const Duration(seconds: 1));
    failures.add('a write after close should fail rather than hang');
  } on LunoraApiException catch (error) {
    equals(error.code, clientClosed, 'a write after close names why');
  } on TimeoutException {
    failures.add('a write after close hung instead of failing');
  }

  equals(client.pendingWrites, 0, 'and it did not re-enter the queue close had just drained');
  check(client.closed, 'the client reports itself closed');
}

/// The wire distinguishes an error with NO cause from one whose cause IS null —
/// the 5-element form against a 6th element holding null — and Dart has one null
/// to spend on both. Collapsing them broke the round-trip contract the codec's
/// own header asserts.
void caseErrorCauseRoundTrips() {
  final absent = <Object?>[wireTag, 'error', 'E', 'boom', <String, Object?>{}];
  final explicit = <Object?>[wireTag, 'error', 'E', 'boom', <String, Object?>{}, null];

  equals(canonical(encodeWire(decodeWire(absent))), canonical(absent), 'an error with no cause keeps the 5-element form');
  equals(canonical(encodeWire(decodeWire(explicit))), canonical(explicit), 'an error whose cause IS null keeps its slot');
}

/// A queued write must reach the server under the id that NAMESPACES its
/// idempotency row. Without one the shard cannot deduplicate an anonymous
/// caller's write at all, and every retry path re-applies it.
Future<void> caseReplayCarriesTheIssuingClientId() async {
  final poster = Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call, clientId: 'client-a')
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = client.mutation('messages:send', mutationId: 'm1');

  client.setConnected(true);
  await pending;

  equals(poster.headers.first['x-lunora-client-id'], 'client-a', 'a single-call replay names the client that issued it');

  // And through the batch path, where it rides each ENTRY rather than the header.
  final batched = Poster(result: 'null');
  final second = LunoraClient(url: 'https://app.example', post: batched.call, clientId: 'client-b')
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = second.mutation('messages:send', mutationId: 'm1');
  final other = second.mutation('messages:send', mutationId: 'm2');

  second.setConnected(true);
  await Future.wait(<Future<Object?>>[first, other]);

  equals(batched.callsAt(0)[0]['clientId'], 'client-b', 'a batch entry carries it too');
}

/// A write RESTORED from durable storage replays under the id that queued it,
/// not the one this session minted — or a restart moves it into a different
/// dedup namespace and the server applies it twice.
Future<void> caseRestoredWriteKeepsItsOriginalClientId() async {
  final store = MemoryPersistence();

  await store.append(const PersistedMutation(id: 'old', functionPath: 'messages:send', args: <String, Object?>{}, clientId: 'prior-session'));

  final poster = Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call, clientId: 'this-session', offlineQueue: OfflineQueue(persistence: store))
    ..attachSocket((_) {})
    ..setConnected(true);

  await client.hydrate();
  await Future<void>.delayed(Duration.zero);

  equals(poster.headers.first['x-lunora-client-id'], 'prior-session', 'the restored write replays under the id that issued it');
}

/// `hydrate()` after connecting used to strand every restored write for the whole
/// session: `setConnected(true)` early-returns when already connected, and
/// nothing else kicked a flush.
Future<void> caseHydrateAfterConnectingStillReplays() async {
  final store = MemoryPersistence();

  await store.append(const PersistedMutation(id: 'old', functionPath: 'messages:send', args: <String, Object?>{}));

  final poster = Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call, offlineQueue: OfflineQueue(persistence: store))
    ..attachSocket((_) {})
    ..setConnected(true);

  equals(await client.hydrate(), 1, 'the write is restored');

  await Future<void>.delayed(Duration.zero);

  equals(poster.paths.length, 1, 'and replays without waiting for the socket to drop and return');
  equals(client.pendingWrites, 0, 'leaving nothing queued');
}

/// Closing DURING a flush must settle the drained writes, not drop them.
///
/// `_flushOnce` drains the queue before it sends, so those writes are no longer
/// in `_items` and `close()`'s `clear()` cannot see them. Skipping the requeue
/// left every caller's Future unsettled forever — the exact hang `close` exists
/// to prevent.
Future<void> caseCloseDuringAFlushSettlesDrainedWrites() async {
  late LunoraClient client;

  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    client.close();

    throw const SocketFailure();
  }

  client = LunoraClient(url: 'https://app.example', post: post)
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final first = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 1}));
  final second = Settled(client.mutation('messages:send', args: <String, Object?>{'n': 2}));

  client.setConnected(true);

  await first.done.timeout(const Duration(seconds: 1), onTimeout: () => failures.add('a write drained into a closing flush hung'));
  await second.done.timeout(const Duration(seconds: 1), onTimeout: () => failures.add('the second one hung too'));

  equals(first.code, clientClosed, 'the first drained write is settled, not dropped');
  equals(second.code, clientClosed, 'and so is the second');
}

/// Every terminal verdict on a RESTORED write reaches the observer. It has no
/// awaiter, so this is the only way an app hears about it at all.
Future<void> caseRestoredWriteVerdictsReachTheObserver() async {
  final store = MemoryPersistence();

  await store.append(const PersistedMutation(id: 'old', functionPath: 'messages:send', args: <String, Object?>{}, identity: 'subj:alice'));

  final settled = <String?>[];
  final client = LunoraClient(
    url: 'https://app.example',
    post: Poster(result: 'null').call,
    authSubject: 'bob',
    offlineQueue: OfflineQueue(
      persistence: store,
      onSettled: (entry, error) => settled.add(error is LunoraApiException ? error.code : null),
    ),
  )..attachSocket((_) {});

  await client.hydrate();

  client.setConnected(true);
  await Future<void>.delayed(Duration.zero);

  equals(canonical(settled), canonical(<Object?>[offlineIdentityChanged]), 'the identity mismatch is reported rather than silent');
}

/// A model standing in for a generated one carrying a REQUIRED nullable field:
/// `toJson()` writes its null, and the `if (x != null)` guard the emitter adds
/// for an OPTIONAL field is deliberately absent here.
class _ModelWithRequiredNull {
  Map<String, dynamic> toJson() => <String, dynamic>{'channelId': 'chan_1', 'nickname': null};
}
