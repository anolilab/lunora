/// The offline queue: ordering, durability, replay and batching.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:lunora/lunora.dart';

import 'harness.dart';

/// One named scenario from the `offlineQueue` block of
/// `protocol/fixtures/offline-optimistic.json`.
///
/// The manifest cases below read every expectation from there rather than
/// writing their own, so this port and the seven siblings assert the same
/// values instead of each documenting its own behaviour.
Map<String, Object?> _scenario(String name) => (fixture('offline-optimistic.json')['offlineQueue']! as Map<String, Object?>)[name]! as Map<String, Object?>;

/// A [MemoryPersistence] that also records which ids were appended and removed,
/// because the fixtures assert the durable calls and not only the queue depth.
class _RecordingPersistence extends MemoryPersistence {
  final List<String> appended = <String>[];
  final List<String> removed = <String>[];

  @override
  Future<void> append(PersistedMutation mutation) {
    appended.add(mutation.id);

    return super.append(mutation);
  }

  @override
  Future<void> remove(String id) {
    removed.add(id);

    return super.remove(id);
  }
}

/// A queued write with nothing attached but its id — the fixtures identify
/// entries by id and care about ordering, not payloads.
QueuedMutation _entry(String id, {String? shardKey, bool Function()? precondition}) =>
    QueuedMutation(id: id, functionPath: 'messages:send', args: const <String, Object?>{}, shardKey: shardKey, precondition: precondition);

List<String> _ids(List<QueuedMutation> items) => <String>[for (final item in items) item.id];

/// The ids the fixture lists under [key], as a plain list of strings.
List<String> _expected(Map<String, Object?> case_, String key) => (case_[key]! as List<Object?>).cast<String>();

// ─── Offline queue: the shared golden scenarios ──────────────────────────────

/// Writes replay in the order they were submitted.
void caseGoldenOfflineQueueFifo() {
  covers('offline_queue_fifo_replay_order');

  final case_ = _scenario('fifo');
  final queue = OfflineQueue();

  for (final id in _expected(case_, 'enqueue')) {
    queue.enqueue(_entry(id));
  }

  equals(queue.size, case_['sizeAfterEnqueue'], 'every write is queued');

  final drained = queue.drain();

  equals(canonical(_ids(drained)), canonical(case_['drained']), 'writes drain oldest first');
  equals(queue.size, case_['sizeAfterDrain'], 'the queue is empty afterwards');
}

/// A drain takes ONE shard's writes and leaves the rest queued, in order.
///
/// The entry the fixture keys on is the one submitted with `''`: an empty shard
/// key and an absent one name the same shard, so it has to drain on the default
/// shard's flush. A port comparing the two strictly leaves it queued forever,
/// because nothing ever flushes a shard named `''`.
void caseGoldenOfflineQueueShardDrain() {
  covers('offline_queue_drains_only_the_named_shard');

  final case_ = _scenario('shardDrain');
  final queue = OfflineQueue();

  for (final entry in (case_['entries']! as List<Object?>).cast<Map<String, Object?>>()) {
    queue.enqueue(_entry(entry['id']! as String, shardKey: entry['shardKey'] as String?));
  }

  final shardKey = case_['drainShardKey'] as String?;
  final drained = queue.drain((item) => sameShard(item.shardKey, shardKey));

  equals(canonical(_ids(drained)), canonical(case_['drained']), "only the named shard's writes drain");
  equals(canonical(_ids(queue.items)), canonical(case_['remaining']), 'the other shards keep their order');
}

/// A flush that aborts on a transient failure returns its unreplayed writes to
/// the FRONT of the queue, in order, without re-persisting them.
///
/// Read from the fixture rather than asserted against numbers written here: this
/// port already drives the behaviour end to end through `setConnected`, but a
/// port that documents its own expectations is exactly what the shared file
/// exists to prevent.
Future<void> caseGoldenOfflineQueueRequeue() async {
  covers('offline_queue_fifo_replay_order');

  final case_ = _scenario('requeue');
  final store = _RecordingPersistence();
  final queue = OfflineQueue(persistence: store);

  for (final id in _expected(case_, 'enqueue')) {
    queue.enqueue(_entry(id));
  }

  await Future<void>.delayed(Duration.zero);

  final requeued = _expected(case_, 'requeued');

  queue.requeue(queue.drain().where((item) => requeued.contains(item.id)).toList());

  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterRequeue']), 'requeued writes return to the front, in order');
  equals(store.appended.length, case_['persistAppendCalls'], 'and a requeue does not re-persist them');
}

/// Closing hands every pending write back so no caller hangs — and leaves
/// durable storage INTACT, because the next session restores from it.
Future<void> caseGoldenOfflineQueueClear() async {
  covers('offline_queue_fifo_replay_order');

  final case_ = _scenario('clear');
  final store = _RecordingPersistence();
  final rejected = <String, Object?>{};
  final queue = OfflineQueue(persistence: store, onSettled: (entry, error) => rejected[entry.id] = error);

  for (final id in _expected(case_, 'enqueue')) {
    queue.enqueue(_entry(id));
  }

  await Future<void>.delayed(Duration.zero);
  queue.clear();

  equals(canonical(rejected.keys.toList()), canonical(case_['rejected']), 'every pending write is handed back');
  equals(queue.size, 0, 'and the queue is empty');

  for (final id in _expected(case_, 'rejected')) {
    final error = rejected[id];

    equals(error is LunoraApiException ? error.code : null, case_['code'], 'each carries the documented code');
  }

  equals(canonical(store.removed), canonical(case_['persistRemoveCalls']), 'closing does not purge durable storage');
  equals(store.records.length, _expected(case_, 'enqueue').length, 'the next session restores them');
}

/// Bounded FIFO: past capacity the OLDEST entry is evicted, un-persisted and
/// reported with a coded reason.
Future<void> caseGoldenOfflineQueueOverflow() async {
  covers('offline_queue_overflow_evicts_oldest');

  final case_ = _scenario('overflow');
  final store = _RecordingPersistence();
  final settled = <String, Object?>{};
  final queue = OfflineQueue(
    maxItems: case_['maxItems']! as int,
    persistence: store,
    onSettled: (entry, error) => settled[entry.id] = error,
  );

  for (final id in _expected(case_, 'enqueue')) {
    queue.enqueue(_entry(id));
  }

  // The unawaited durable writes are queued as microtasks; let them land before
  // reading what the store was asked to do.
  await Future<void>.delayed(Duration.zero);

  equals(canonical(_ids(queue.items)), canonical(case_['remaining']), 'the newest writes survive');
  equals(canonical(settled.keys.toList()), canonical(case_['evicted']), 'only the oldest was settled');

  for (final id in _expected(case_, 'evicted')) {
    final error = settled[id];

    equals(error is LunoraApiException ? error.code : null, case_['code'], 'the eviction carries its coded reason');
  }

  equals(canonical(store.removed), canonical(case_['persistRemoveCalls']), 'the evicted write is un-persisted');
}

/// A write whose assumptions no longer hold is dropped before replay, and the
/// valid ones keep their order.
void caseGoldenOfflineQueuePrecondition() {
  covers('offline_queue_precondition_drops_stale_write');

  final case_ = _scenario('precondition');
  final settled = <String, Object?>{};
  final queue = OfflineQueue(onSettled: (entry, error) => settled[entry.id] = error);

  for (final record in objectList(case_['entries'])) {
    final holds = record['precondition']! as bool;

    queue.enqueue(_entry(record['id']! as String, precondition: () => holds));
  }

  final conflicted = queue.drainConflict();

  equals(canonical(_ids(conflicted)), canonical(case_['conflicted']), 'the stale write is drained out');
  equals(canonical(_ids(queue.items)), canonical(case_['remaining']), 'the valid writes keep their FIFO order');

  for (final id in _expected(case_, 'conflicted')) {
    final error = settled[id];

    equals(error is LunoraApiException ? error.code : null, case_['code'], 'the drop carries its coded reason');
  }
}

/// Restored records are unshifted AHEAD of anything queued during the boot
/// window, and a record stamped under another app version is purged rather than
/// replayed against the current schema.
Future<void> caseGoldenOfflineQueueHydrate() async {
  covers('offline_queue_hydrates_persisted_writes');

  final case_ = _scenario('hydrate');
  final store = _RecordingPersistence();

  for (final record in objectList(case_['persisted'])) {
    await store.append(
      PersistedMutation(
        id: record['id']! as String,
        functionPath: 'messages:send',
        args: const <String, Object?>{},
        shardKey: record['shardKey'] as String?,
        version: record['version'] as String?,
      ),
    );
  }

  store.removed.clear();

  final queue = OfflineQueue(persistence: store, version: case_['version'] as String?);

  for (final id in _expected(case_, 'liveEnqueue')) {
    queue.enqueue(_entry(id));
  }

  await queue.hydrate();
  await Future<void>.delayed(Duration.zero);

  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterHydrate']), 'restored writes are older than this session\'s and replay first');
  equals(canonical(store.removed), canonical(case_['purged']), 'the version-mismatched record is purged, not replayed');
}

/// A write stamped under one identity must never replay under another. `null` is
/// the signed-out identity and a real value; a record with NO stamp — persisted
/// before stamping existed — replays ambiently.
void caseGoldenOfflineQueueIdentityGate() {
  covers('offline_queue_identity_gate_rejects_replay');

  final case_ = _scenario('identityGate');

  for (final row in objectList(case_['cases'])) {
    final stamped = row['stamped'];
    final name = row['name']! as String;

    // Round-tripped through the persisted form on purpose: the three states are
    // carried on the wire by the PRESENCE of the `identity` key, so building the
    // entry from a map is what proves absent and signed-out stay apart.
    final record = PersistedMutation.fromJson(<String, Object?>{
      'id': name,
      'functionPath': 'messages:send',
      'args': const <String, Object?>{},
      if (stamped != 'absent') 'identity': stamped,
    });
    final entry = QueuedMutation(
      id: record.id,
      functionPath: record.functionPath,
      args: record.args,
      identity: record.identity,
      identityStamped: record.identityStamped,
    );

    equals(entry.identityAllowsReplay(row['current'] as String?), row['replays'], 'identity gate: $name');
  }

  equals(offlineIdentityChanged, case_['code'], 'the refusal carries the shared code');
}

/// The end-to-end reconnect path: each write replays under its own idempotency
/// key, a coded verdict is terminal, an unanswered write is re-queued, and the
/// successful write's overlay is confirmed against the ECHOED commit cursor.
Future<void> caseGoldenOfflineFlushReplay() async {
  covers('offline_flush_replays_and_confirms_optimistic');

  final case_ = _scenario('flushReplay');
  final store = _RecordingPersistence();
  final queue = OfflineQueue(persistence: store);
  final poster = Poster();
  final transport = LunoraTransport(url: 'https://app.example', post: poster.call);
  final replayer = OfflineReplayer(transport: transport, queue: queue, isClosed: () => false, isConnected: (_) => true);

  final committed = <String>[];
  final rejected = <String>[];
  final cursors = <String, int?>{};

  for (final id in _expected(case_, 'queued')) {
    queue.enqueue(
      QueuedMutation(
        id: id,
        functionPath: 'messages:send',
        args: const <String, Object?>{},
        onCommit: (cursor) {
          committed.add(id);
          cursors[id] = cursor;
        },
        onReject: (_) => rejected.add(id),
      ),
    );
  }

  await Future<void>.delayed(Duration.zero);
  store.removed.clear();

  // The three fixture outcomes, as this transport expresses them. `ok` and
  // `coded-error` are slots; `transport-error` is an ABSENT slot — a batch is one
  // hop, so a per-entry transport failure is the server not answering for that
  // entry, and an unanswered write is retried under its original idempotency key
  // exactly as an uncoded throw re-queues on the single-call path.
  final responses = objectList(case_['responses']);
  final slots = <String>[
    for (final (index, response) in responses.indexed)
      if (response['outcome'] == 'ok')
        '{"id":$index,"body":{"result":null,"commitCursor":${response['commitCursor']}}}'
      else if (response['outcome'] == 'coded-error')
        '{"id":$index,"body":{"error":{"code":"${response['code']}","message":"gone"}}}',
  ];

  poster.batchReply = '{"results":[${slots.join(',')}]}';

  await replayer.flush();
  await Future<void>.delayed(Duration.zero);

  equals(canonical(committed), canonical(case_['committed']), 'the successful write commits');
  equals(canonical(rejected), canonical(case_['rejected']), 'the coded verdict is terminal');
  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterFlush']), 'the unanswered write is re-queued');
  equals(cursors[_expected(case_, 'committed').first], case_['confirmedCommitCursor'], 'the overlay confirms on the echoed commit cursor');

  final sent = <String>[for (final call in poster.callsAt(0)) call['mutationId']! as String];

  equals(canonical(sent), canonical(case_['mutationIdHeaders']), 'every write replays under the key its original call minted');
  equals(canonical(store.removed), canonical(case_['persistRemoveCalls']), 'only the settled writes are un-persisted');
}

/// A durable store holding more than `maxItems` must not bypass the cap, and the
/// eviction must be REPORTED: a restored record has no awaiter, so a discard
/// carried only by the entry's own reject handler reaches nobody and the durable
/// write vanishes silently.
Future<void> caseGoldenOfflineQueueHydrateOverflow() async {
  covers('offline_queue_hydrate_overflow_settles_discarded');

  final case_ = _scenario('hydrateOverflow');
  final store = _RecordingPersistence();

  for (final record in objectList(case_['persisted'])) {
    await store.append(
      PersistedMutation(
        id: record['id']! as String,
        functionPath: 'messages:send',
        args: const <String, Object?>{},
        shardKey: record['shardKey'] as String?,
        version: record['version'] as String?,
      ),
    );
  }

  final settled = <String>[];
  final codes = <String, String?>{};
  final awaiters = <String, bool>{};
  final queue = OfflineQueue(
    maxItems: case_['maxItems']! as int,
    persistence: store,
    version: case_['version'] as String?,
    onSettled: (entry, error) {
      settled.add(entry.id);
      codes[entry.id] = error is LunoraApiException ? error.code : null;
      awaiters[entry.id] = entry.hasAwaiter;
    },
  );

  await queue.hydrate();
  await Future<void>.delayed(Duration.zero);

  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterHydrate']), 'hydrate evicts from the front exactly as enqueue does');
  equals(canonical(settled), canonical(case_['settledFromClient']), 'the evicted record is reported, not dropped in silence');

  for (final id in _expected(case_, 'evicted')) {
    equals(codes[id], case_['settledCode'], 'the eviction carries its coded reason');
    equals(awaiters[id], case_['settledHadAwaiter'], 'a restored write has no awaiter, and the report says so');
  }
}

/// Two or more queued writes coalesce into ONE `/_lunora/rpc-batch` round trip,
/// and each slot is classified exactly as a whole single-call response is.
Future<void> caseGoldenOfflineFlushBatchesMultipleWrites() async {
  covers('offline_flush_batches_multiple_writes');

  final case_ = _scenario('batchReplay');
  final store = _RecordingPersistence();
  final queue = OfflineQueue(persistence: store);
  final poster = Poster();
  final transport = LunoraTransport(url: 'https://app.example', post: poster.call, clientId: 'c-1');
  final replayer = OfflineReplayer(transport: transport, queue: queue, isClosed: () => false, isConnected: (_) => true);

  final committed = <String>[];
  final rejected = <String>[];
  final cursors = <String, int?>{};

  for (final id in _expected(case_, 'queued')) {
    queue.enqueue(
      QueuedMutation(
        id: id,
        functionPath: 'messages:send',
        args: const <String, Object?>{},
        onCommit: (cursor) {
          committed.add(id);
          cursors[id] = cursor;
        },
        onReject: (_) => rejected.add(id),
      ),
    );
  }

  await Future<void>.delayed(Duration.zero);
  store.removed.clear();

  final slots = <String>[
    for (final slot in objectList(case_['slots']))
      if (slot['outcome'] == 'ok')
        '{"id":${slot['id']},"body":{"result":null,"commitCursor":${slot['commitCursor']}}}'
      else
        '{"id":${slot['id']},"body":{"error":{"code":"${slot['code']}","message":"slot failed"}}}',
  ];

  poster.batchReply = '{"results":[${slots.join(',')}]}';

  await replayer.flush();
  await Future<void>.delayed(Duration.zero);

  equals(poster.batchRequests, case_['requests'], 'the whole flush is one batch hop');
  equals(poster.urls.first.endsWith(case_['path']! as String), true, 'sent to the batch endpoint');
  // The idempotency key and the client id ride in the ENTRY, not in a request
  // header: a batch is one hop carrying independent calls, and a single outer
  // header would de-duplicate the whole chunk against one id.
  equals(
    canonical(<Object?>[
      for (final call in poster.callsAt(0))
        <String, Object?>{'clientId': call['clientId'], 'functionPath': call['functionPath'], 'id': call['id'], 'mutationId': call['mutationId']},
    ]),
    canonical(case_['calls']),
    'every entry carries its own slot id, idempotency key and client id',
  );
  equals(canonical(committed), canonical(case_['committed']), 'the successful slot commits');
  // A transient shard code in a slot is not a verdict, so that write goes back
  // on the queue instead of being reported as failed — and so does the slot the
  // server never returned at all.
  equals(canonical(rejected), canonical(case_['rejected']), 'only the coded verdict is terminal');
  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterFlush']), 'the transient and unanswered writes are re-queued, in order');
  equals(cursors[_expected(case_, 'committed').first], case_['confirmedCommitCursor'], 'the overlay confirms on the echoed commit cursor');
  equals(canonical(store.removed), canonical(case_['persistRemoveCalls']), 'only the settled writes are un-persisted');
}

/// A write whose args cannot be wire-encoded can never succeed, so it settles
/// TERMINALLY on the first flush instead of re-queueing forever ahead of every
/// write behind it — a codec error carries no code, and the transient rule would
/// otherwise loop it.
Future<void> caseGoldenOfflineFlushUnencodableWrite() async {
  covers('offline_flush_unencodable_write_settles_terminal');

  final case_ = _scenario('unencodableWrite');
  final store = _RecordingPersistence();
  final queue = OfflineQueue(persistence: store);
  final poster = Poster(commitCursor: 7, result: 'null');
  final transport = LunoraTransport(url: 'https://app.example', post: poster.call);
  final replayer = OfflineReplayer(transport: transport, queue: queue, isClosed: () => false, isConnected: (_) => true);

  final committed = <String>[];
  final rejected = <String>[];
  final codes = <String, String?>{};
  final unencodable = _expected(case_, 'unencodable').toSet();

  for (final id in _expected(case_, 'queued')) {
    queue.enqueue(
      QueuedMutation(
        id: id,
        functionPath: 'messages:send',
        // `Object()` has no wire representation, so `encodeWire` throws — and the
        // throw carries no code, which is exactly what would classify it as a
        // transport blip and re-queue it.
        args: unencodable.contains(id) ? <String, Object?>{'payload': Object()} : const <String, Object?>{},
        onCommit: (_) => committed.add(id),
        onReject: (error) {
          rejected.add(id);
          codes[id] = error is LunoraApiException ? error.code : null;
        },
      ),
    );
  }

  await Future<void>.delayed(Duration.zero);
  store.removed.clear();

  await replayer.flush();
  await Future<void>.delayed(Duration.zero);

  equals(canonical(rejected), canonical(case_['rejected']), 'the unencodable write settles terminally');
  equals(canonical(committed), canonical(case_['committed']), 'the write behind it still goes out');
  equals(canonical(_ids(queue.items)), canonical(case_['queuedAfterFlush']), 'nothing loops back onto the queue');

  for (final id in _expected(case_, 'rejected')) {
    equals(codes[id], case_['code'], 'the drop carries a code rather than the raw codec exception');
  }

  final sent = <String>[for (final headers in poster.headers) headers['x-lunora-mutation-id']!];

  equals(canonical(sent), canonical(case_['mutationIdHeaders']), 'the unencodable write is never sent');
  equals(canonical(store.removed), canonical(case_['persistRemoveCalls']), 'both settled writes are un-persisted');
}

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

/// A queued write whose args carry `bigint`, `bytes` and a `Date` must survive
/// a store that SERIALISES — which every real adapter does.
///
/// Persisting the native wrappers reported the write "queued" while the adapter
/// either raised (nothing durable written) or stringified them into something
/// that does not read back, so a restart replayed corrupted args.
Future<void> caseTypedArgsSurviveASerialisingStore() async {
  covers('offline_queue_hydrates_persisted_writes');

  final args = <String, Object?>{
    'amount': BigInt.from(7),
    'blob': WireBytes(Uint8List.fromList(<int>[1, 2, 3, 4]), 'Int32Array'),
    'when': const WireDate(1700000000),
  };
  final store = _RecordingPersistence();
  final failures_ = <String>[];
  final queue = OfflineQueue(persistence: store, onPersistenceError: (operation, error, id) => failures_.add('$operation'));

  queue.enqueue(QueuedMutation(id: 'm-typed', functionPath: 'ledger:add', args: args));

  await Future<void>.delayed(Duration.zero);

  equals(canonical(failures_), canonical(<String>[]), 'the record serialises, so nothing is reported as a failed append');
  equals(store.records.length, 1, 'the write reached durable storage');
  equals(
    canonical(store.records.isEmpty ? null : (store.records.first.args! as Map<String, Object?>)['amount']),
    canonical(<Object?>[wireTag, 'bigint', '7']),
    'the durable record holds the WIRE form',
  );

  final restored = OfflineQueue(persistence: store);

  await restored.hydrate();

  equals(canonical(_ids(restored.items)), canonical(<String>['m-typed']), 'the write comes back');
  // Decoded back to the SAME native values, so the replay sends the write that
  // was made rather than whatever the adapter's stringification left.
  equals(
    canonical(restored.items.isEmpty ? null : encodeWire(restored.items.first.args)),
    canonical(encodeWire(args)),
    'and decodes back to the same native values',
  );
}

/// A persisted record whose args do not decode is purged and settled, never
/// replayed with substitute args and never allowed to kill the restart path.
Future<void> caseUndecodableRecordSettlesRejected() async {
  covers('offline_queue_hydrates_persisted_writes');

  final store = _RecordingPersistence();

  // A wire tag with no valid payload: the store was corrupted, or written by an
  // incompatible build.
  await store.append(
    PersistedMutation(
      id: 'm-bad',
      functionPath: 'ledger:add',
      args: <String, Object?>{
        'amount': <Object?>[wireTag, 'bigint', 'not-a-number'],
      },
    ),
  );
  store.removed.clear();

  final settled = <String>[];
  final codes = <String, String?>{};
  final client = LunoraClient(
    url: 'https://app.example',
    post: Poster().call,
    offlineQueue: OfflineQueue(
      persistence: store,
      onSettled: (entry, error) {
        settled.add(entry.id);
        codes[entry.id] = error is LunoraApiException ? error.code : null;
      },
    ),
  );

  equals(await client.hydrate(), 0, 'nothing unreadable is restored');
  await Future<void>.delayed(Duration.zero);

  equals(client.pendingWrites, 0, 'the queue is empty');
  equals(canonical(settled), canonical(<String>['m-bad']), 'the unreadable record is reported, not dropped in silence');
  equals(codes['m-bad'], offlineWriteUndecodable, 'and names why it can never replay');
  equals(canonical(store.removed), canonical(<String>['m-bad']), 'it is purged, not left to fail every restart');
}

/// A batch the worker refuses for SIZE is split and retried, not settled
/// `rejected` entry by entry.
///
/// The worker reads a batch body under a 1 MiB budget
/// (`packages/runtime/src/body-readers.ts`) and answers `413 PAYLOAD_TOO_LARGE`
/// past it. A whole-batch coded envelope is a verdict on every entry, so a
/// count-only chunker settled the lot terminally.
Future<void> caseBatchSplitsOnPayloadTooLarge() async {
  covers('offline_flush_batch_splits_on_payload_too_large');

  const budget = 400;
  final sizes = <int>[];

  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    sizes.add(body.length);

    if (body.length > budget) {
      return const LunoraHttpResponse(413, '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Body too large"}}');
    }

    final calls = (jsonDecode(body) as Map<String, Object?>)['calls']! as List<Object?>;
    final slots = <String>[
      for (final call in calls) '{"id":${(call! as Map<String, Object?>)['id']},"body":{"result":null,"commitCursor":1}}',
    ];

    return LunoraHttpResponse(200, '{"results":[${slots.join(',')}]}');
  }

  final client = LunoraClient(url: 'https://app.example', post: post, clientId: 'c-1', offlineQueue: OfflineQueue(persistence: MemoryPersistence()))
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final queued = <String>['m-0', 'm-1', 'm-2', 'm-3'];
  final settled = <String, Settled>{
    for (final id in queued) id: Settled(client.mutation('messages:send', args: <String, Object?>{'text': 'x' * 120}, mutationId: id)),
  };

  client.setConnected(true);

  for (final entry in settled.values) {
    await entry.done;
  }

  for (final id in queued) {
    equals(settled[id]!.error, null, 'every write commits; none is dropped for the size of the batch it shared ($id)');
  }

  equals(client.pendingWrites, 0, 'the queue is empty');
  check(sizes.any((size) => size > budget), 'the first attempt has to be the over-budget one, or nothing was split');
}

/// A lone queued write must survive an envelope-less 502.
///
/// `parseRpcResponse` codes it `INTERNAL` per protocol §4.2, and every coded
/// error was a verdict on the single-call path — so whether a gateway blip LOST
/// a durable write depended on how deep the queue happened to be.
Future<void> caseLoneQueuedWriteSurvivesAnEnvelopeLess502() async {
  covers('non_2xx_without_error_envelope_fails');

  var posts = 0;

  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    posts += 1;

    return const LunoraHttpResponse(502, '{"message":"bad gateway"}');
  }

  final store = _RecordingPersistence();
  final settled = <String>[];
  final client = LunoraClient(
    url: 'https://app.example',
    post: post,
    offlineQueue: OfflineQueue(persistence: store, onSettled: (entry, error) => settled.add(entry.id)),
  )
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = Settled(client.mutation('messages:send', mutationId: 'm-502'));

  store.removed.clear();
  client.setConnected(true);

  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);

  equals(posts, 1, 'the write was attempted');
  equals(pending.error, null, 'nothing settled: no verdict was ever reached');
  equals(canonical(settled), canonical(<String>[]), 'and nothing reached the observer either');
  equals(canonical(_ids(client.offlineQueue.items)), canonical(<String>['m-502']), 'the write is still queued');
  equals(canonical(store.removed), canonical(<String>[]), 'the durable record stays, because the write is still good');
}

/// A rate-limited replay re-queues and holds the NEXT flush off until the delay
/// the envelope named has passed.
///
/// "Not now", not "no": the write is valid and the server asked for it later, so
/// dropping it loses data for being punctual — and replaying it immediately only
/// earns the same 429.
Future<void> caseRateLimitedReplayRequeuesAndDefers() async {
  covers('offline_flush_replays_and_confirms_optimistic');

  var posts = 0;

  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    posts += 1;

    return const LunoraHttpResponse(429, '{"error":{"code":"TOO_MANY_REQUESTS","message":"slow down","data":{"retryAfterMs":60000}}}');
  }

  final settled = <String>[];
  final client = LunoraClient(
    url: 'https://app.example',
    post: post,
    offlineQueue: OfflineQueue(persistence: MemoryPersistence(), onSettled: (entry, error) => settled.add(entry.id)),
  )
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  final pending = Settled(client.mutation('messages:send', mutationId: 'm-429'));

  client.setConnected(true);
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);

  equals(pending.error, null, 'a rate limit is not a verdict, so nothing is rejected');
  equals(canonical(_ids(client.offlineQueue.items)), canonical(<String>['m-429']), 'the write is re-queued');
  equals(canonical(settled), canonical(<String>[]), 'and nothing settled');

  final again = await client.flushOfflineQueue();

  equals(posts, 1, 'the second flush waits out the delay rather than earning the same 429');
  check(again != null && again > 0, 'and reports how long is left to wait');
  equals(canonical(_ids(client.offlineQueue.items)), canonical(<String>['m-429']), 'the write is still queued');
}

/// A rate-limited SLOT is transient and its delay is honoured, clamped.
///
/// A slot's `body` is exactly a §4.2 envelope, so it runs through the SAME
/// predicate the whole-batch and single-call paths use — a durable write's fate
/// must not depend on how many siblings were queued alongside it. The server's
/// hint is capped at [maxRetryAfterMs]: the delay is the server's, the ceiling is
/// ours.
Future<void> caseRateLimitedBatchSlotIsTransient() async {
  covers('offline_flush_batches_multiple_writes');

  final poster = Poster(result: 'null')
    ..batchReply = '{"results":['
        '{"id":0,"body":{"error":{"code":"TOO_MANY_REQUESTS","message":"slow down","data":{"retryAfterMs":90000}}}},'
        '{"id":1,"body":{"result":null,"commitCursor":7}}'
        ']}';
  // Queued without ever connecting, so this case owns the only flush: the
  // `setConnected(true)` the sibling cases use starts one of its own, and a
  // second call then coalesces into it and returns before anything is sent.
  final client = LunoraClient(
    url: 'https://app.example',
    post: poster.call,
    offlineQueue: OfflineQueue(persistence: MemoryPersistence(), queueBeforeFirstConnect: true),
  )..attachSocket((_) {});

  final limited = Settled(client.mutation('messages:send', mutationId: 'm-limited'));
  final committed = Settled(client.mutation('messages:send', mutationId: 'm-committed'));
  final retryAfter = await client.flushOfflineQueue();

  await committed.done;

  equals(limited.error, null, 'a rate-limited slot is not a verdict, so nothing is rejected');
  equals(committed.error, null, 'and its sibling still commits');
  equals(canonical(_ids(client.offlineQueue.items)), canonical(<String>['m-limited']), 'only the rate-limited write is re-queued');
  equals(retryAfter, maxRetryAfterMs, 'the delay is honoured but clamped: 90000 asked, 60000 held');
}
