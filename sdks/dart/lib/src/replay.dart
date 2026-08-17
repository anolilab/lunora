/// Replaying the offline queue: what goes out, in what order, and how each
/// verdict is classified.
///
/// Its own file because it is POLICY, and the queue beside it is a data
/// structure. Batch chunking, FIFO preservation across chunks, the
/// terminal-versus-transient rule and the per-slot demux are the rules a reader
/// debugging "why did my write land twice" comes looking for, and they belong
/// next to the bounds and eviction they act on rather than inside the socket
/// client, which has nothing to do with any of it.
///
/// Ported from `packages/client/src/lunora-client.ts`'s `flushOffline`,
/// `replaySequential`, `replayBatched` and `settleReplayBatchSlots`.
library;

import 'dart:async';
import 'dart:convert';

import 'errors.dart';
import 'offline_queue.dart';
import 'transport.dart';
import 'wire.dart';

/// Replays queued writes over a [LunoraTransport].
///
/// Two collaborators and two predicates, rather than the half-dozen closures a
/// client-shaped extraction would need: the transport makes the requests, the
/// queue holds the writes, and the client answers whether it is still open and
/// still connected.
class OfflineReplayer {
  OfflineReplayer({required this.transport, required this.queue, required this.isClosed, required this.isConnected});

  final LunoraTransport transport;
  final OfflineQueue queue;

  /// Whether the client has been closed. Re-checked after every `await`: a flush
  /// has already DRAINED the queue, so `close()` cannot see the writes in flight
  /// and they have to be settled here instead.
  final bool Function() isClosed;

  /// Whether the socket is up, for the coalesced-reconnect loop.
  final bool Function() isConnected;

  bool _flushing = false;
  bool _flushAgain = false;

  /// Replay every queued write, oldest first.
  ///
  /// Called for you on the transition to connected; public because a caller that
  /// knows connectivity came back some other way may want to trigger it.
  ///
  /// A write issued DURING a flush goes straight out rather than behind the
  /// queue, because the client is connected by then. That matches the reference
  /// client, whose gate opens the moment its socket does; if a strict global
  /// order matters, wait for this Future before writing again.
  Future<void> flush() async {
    if (_flushing) {
      // A reconnect arrived mid-flush. Remembered rather than dropped: the
      // running flush may already have stopped on the very transport failure
      // that caused the disconnect, and its re-queued writes would then sit
      // untouched until some LATER reconnect happened to come along.
      _flushAgain = true;

      return;
    }

    _flushing = true;

    try {
      do {
        _flushAgain = false;

        await _flushOnce();
        // Only while still connected, so a disconnect that lands mid-pass ends
        // the loop instead of retrying into a socket that is down.
      } while (_flushAgain && isConnected());
    } finally {
      _flushing = false;
    }
  }

  /// One drain-and-replay pass. See [flush], which owns the
  /// re-entrancy and the coalesced-reconnect loop around it.
  Future<void> _flushOnce() async {
    // A client with no poster cannot replay anything. Checked here rather than
    // per write, because the two replay shapes classified it oppositely: the
    // single-call path saw a CODED error and rejected the whole queue
    // terminally, while the batch path treated it as transport and kept it. A
    // missing poster is configuration, not a verdict on any write, so nothing is
    // drained and nothing is lost.
    if (isClosed() || !transport.canSend) {
      return;
    }

    // Weed out writes whose assumptions expired while offline before draining
    // the rest. `drainConflict` rejects each one itself.
    for (final stale in queue.drainConflict()) {
      queue.unpersist(stale.id);
    }

    final drained = queue.drain();

    if (drained.isEmpty) {
      return;
    }

    // ONE identity snapshot for the whole batch: a replay is a sequence of
    // authenticated requests and there is no point between them where the
    // token could change without this loop seeing it. A mismatch is rejected
    // rather than silently dropped, so an awaiting caller gets a verdict.
    final identity = transport.identityFingerprint();
    final sendable = <QueuedMutation>[];

    for (final item in drained) {
      if (item.identity == identity) {
        sendable.add(item);
      } else {
        queue.unpersist(item.id);
        item.reject(const LunoraApiException(offlineIdentityChanged, 'offline mutation discarded: it was queued under a different identity'));
      }
    }

    final encodable = _encodableOrSettleTerminal(sendable);

    if (encodable.isEmpty) {
      return;
    }

    // A lone write rides the single-call path, which is the proven one. Two or
    // more coalesce into batch round trips — the flaky-reconnect win, where N
    // queued writes cost a handful of hops instead of N.
    if (encodable.length == 1) {
      await _replaySequential(encodable);

      return;
    }

    final toRequeue = <QueuedMutation>[];

    for (var start = 0; start < encodable.length; start += lunoraMaxBatchEntries) {
      final end = start + lunoraMaxBatchEntries > encodable.length ? encodable.length : start + lunoraMaxBatchEntries;
      // Chunks replay sequentially, which is what preserves FIFO across a flush
      // longer than one batch.
      final outcome = await _replayBatched(encodable.sublist(start, end));

      toRequeue.addAll(outcome.requeue);

      if (outcome.stop) {
        // A whole-chunk transport failure. Leave every write not yet sent queued,
        // in order, rather than sending on into a connection that just failed.
        toRequeue.addAll(encodable.sublist(end));

        break;
      }
    }

    _returnOrAbandon(toRequeue);
  }

  /// Put drained writes back on the queue, or settle them if the client closed
  /// underneath the flush.
  ///
  /// The distinction is the whole point. `_flushOnce` DRAINS the queue before it
  /// sends, so by the time a flush is in flight those writes are no longer in
  /// `_items` — and `close()`'s `clear()`, which only rejects what is still
  /// there, cannot see them. Dropping them here left every caller's Future
  /// unsettled forever, which is precisely the hang `close` exists to prevent.
  ///
  /// Durable storage is left intact, matching `close()`: a write rejected here
  /// because the app shut down should still be restored by the next session.
  void _returnOrAbandon(List<QueuedMutation> items) {
    if (items.isEmpty) {
      return;
    }

    if (!isClosed()) {
      queue.requeue(items);

      return;
    }

    for (final item in items) {
      item.reject(const LunoraApiException(clientClosed, 'client closed while the write was being replayed'));
    }
  }

  /// Partition writes into the ones that can be encoded and settle the rest
  /// terminally.
  ///
  /// A write whose args cannot be wire-encoded can NEVER replay: the codec
  /// failure is deterministic, not transient. Rejecting it here is what stops it
  /// re-queueing forever — a silent hang where the caller's Future never settles
  /// and its optimistic layer never rolls back. Encoding is cheap and the flush
  /// is the slow reconnect path, so it is done up front for both replay shapes.
  List<QueuedMutation> _encodableOrSettleTerminal(List<QueuedMutation> items) {
    final encodable = <QueuedMutation>[];

    for (final item in items) {
      try {
        encodeWire(item.args ?? const <String, Object?>{});
        encodable.add(item);
      } on Object catch (error) {
        queue.unpersist(item.id);
        item.reject(LunoraApiException('BAD_REQUEST', 'offline mutation cannot be encoded: $error'));
      }
    }

    return encodable;
  }

  /// Replay writes one at a time. FIFO is preserved by the loop itself.
  Future<void> _replaySequential(List<QueuedMutation> items) async {
    for (var index = 0; index < items.length; index += 1) {
      final item = items[index];

      try {
        final outcome = await transport.rpc(item.functionPath, args: item.args, shardKey: item.shardKey, mutationId: item.id, issuedBy: item.clientId);

        queue.unpersist(item.id);
        item.onCommit?.call(outcome.commitCursor);
        item.resolve(outcome.result);
      } on LunoraApiException catch (error) {
        // A coded error means the server answered and rejected the write.
        // Terminal: replaying it would fail identically forever.
        queue.unpersist(item.id);
        item.reject(error);
      } on Object {
        // Uncoded: a transport failure. Transient — put this write and every
        // one after it back at the front, in order, and stop the flush.
        _returnOrAbandon(items.sublist(index));

        return;
      }
    }
  }

  /// Replay one chunk over `POST /_lunora/rpc-batch`.
  ///
  /// The worker forwards the entries to their shard, which dispatches each
  /// through its ordinary single-call path — so per-entry `mutationId`
  /// idempotency and in-order application are inherited from the proven route
  /// rather than re-implemented here.
  ///
  /// Returns the writes to re-queue, and whether the caller should STOP: a
  /// whole-chunk transport failure leaves the later chunks unsent. Re-queuing is
  /// the caller's, once and in order, so a write cannot land twice in the queue.
  Future<({List<QueuedMutation> requeue, bool stop})> _replayBatched(List<QueuedMutation> items) async {
    if (!transport.canSend) {
      return (requeue: items, stop: true);
    }

    final calls = <Object?>[
      for (final (index, item) in items.indexed)
        <String, Object?>{
          'args': encodeWire(item.args ?? const <String, Object?>{}),
          'functionPath': item.functionPath,
          // The slot this entry's result comes back in.
          'id': index,
          // The same stable key the single-call replay sends, so the shard
          // deduplicates a write it already committed — beside the id that
          // namespaces that dedup row for an anonymous caller. Per ENTRY, not on
          // the outer request: a batch is one hop, but its entries are dispatched
          // as independent single calls.
          'mutationId': item.id,
          'clientId': item.clientId ?? transport.clientId,
          if (item.shardKey != null) 'shardKey': item.shardKey,
        },
    ];

    final LunoraHttpResponse response;

    try {
      response = await transport.post!(transport.join(lunoraRpcBatchPath), transport.requestHeaders(), jsonEncode(<String, Object?>{'calls': calls}));
    } on Object {
      // Transport failure — nothing committed, so retry everything.
      return (requeue: items, stop: true);
    }

    final Object? decoded;

    try {
      decoded = response.body.isEmpty ? null : jsonDecode(response.body);
    } on FormatException {
      // A non-JSON body, an edge 5xx say. Transient: do not lose the writes.
      return (requeue: items, stop: true);
    }

    final body = decoded is Map<String, Object?> ? decoded : const <String, Object?>{};
    final results = body['results'];

    if (results is List) {
      return (requeue: _settleBatchSlots(items, results), stop: false);
    }

    // No per-slot results. A coded envelope is a verdict on the whole batch — a
    // bad request, an authorization denial — and therefore terminal for every
    // entry; anything else is transport, and transient.
    final envelope = body['error'];

    if (envelope is Map<String, Object?>) {
      final error = LunoraApiException(
        envelope['code'] is String ? envelope['code'] as String : 'INTERNAL',
        envelope['message'] is String ? envelope['message'] as String : 'batch rejected',
        envelope['data'] == null ? null : decodeWire(envelope['data']),
      );

      for (final item in items) {
        queue.unpersist(item.id);
        item.reject(error);
      }

      return (requeue: <QueuedMutation>[], stop: false);
    }

    return (requeue: items, stop: true);
  }

  /// Demux a batch reply back onto the writes it replayed, in input order,
  /// classifying each slot exactly as the single-call replay classifies a whole
  /// response. Returns the writes to re-queue.
  List<QueuedMutation> _settleBatchSlots(List<QueuedMutation> items, List<Object?> results) {
    final bySlot = <int, Map<String, Object?>>{};

    for (final entry in results) {
      if (entry is! Map<String, Object?>) {
        continue;
      }

      final id = entry['id'];
      final slot = entry['body'];

      if (id is int && slot is Map<String, Object?>) {
        bySlot[id] = slot;
      }
    }

    final requeue = <QueuedMutation>[];

    for (final (index, item) in items.indexed) {
      final slot = bySlot[index];

      if (slot == null) {
        // The server never returned this slot. It may or may not have committed,
        // so retry it — the `mutationId` makes that safe.
        requeue.add(item);

        continue;
      }

      final envelope = slot['error'];

      if (envelope is Map<String, Object?>) {
        final code = envelope['code'] is String ? envelope['code'] as String : 'INTERNAL';

        // A transient shard failure is the batch's counterpart of an uncoded
        // throw on the single-call path: the server never reached a verdict, so
        // the write goes back on the queue rather than being reported as failed.
        if (transientBatchErrorCodes.contains(code)) {
          requeue.add(item);
        } else {
          queue.unpersist(item.id);
          item.reject(
            LunoraApiException(
              code,
              envelope['message'] is String ? envelope['message'] as String : 'request failed',
              envelope['data'] == null ? null : decodeWire(envelope['data']),
            ),
          );
        }

        continue;
      }

      final cursor = slot['commitCursor'];

      queue.unpersist(item.id);
      item.onCommit?.call(cursor is int ? cursor : null);
      item.resolve(decodeWire(slot['result']));
    }

    return requeue;
  }
}
