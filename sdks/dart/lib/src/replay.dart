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

  /// Whether the socket for a given shard is up, for the coalesced-reconnect
  /// loop. Takes the shard key so a disconnect on one shard cannot end another
  /// shard's flush.
  final bool Function(String? shardKey) isConnected;

  /// Shard keys with a flush in flight, and the subset that must run again when
  /// it finishes. Per SHARD, not one pair of flags: one shard's socket can come
  /// back while another is still down, and a single flag would let shard A's
  /// running flush swallow shard B's reconnect entirely.
  final Set<String> _flushing = <String>{};
  final Set<String> _flushAgain = <String>{};

  /// Elapsed milliseconds before which a flush is a no-op, set when a replay came
  /// back rate-limited and the envelope named a delay.
  ///
  /// Measured against [_clock] rather than the wall clock, so a device's clock
  /// jumping — an NTP correction, a user changing the date — cannot strand a
  /// queue for hours.
  int _flushNotBefore = 0;

  final Stopwatch _clock = Stopwatch()..start();

  /// Replay every queued write, oldest first.
  ///
  /// Called for you on the transition to connected; public because a caller that
  /// knows connectivity came back some other way may want to trigger it.
  ///
  /// A write issued DURING a flush goes straight out rather than behind the
  /// queue, because the client is connected by then. That matches the reference
  /// client, whose gate opens the moment its socket does; if a strict global
  /// order matters, wait for this Future before writing again.
  /// Returns the milliseconds the server asked the caller to wait before
  /// flushing again, when a replay came back rate-limited, and null otherwise.
  Future<int?> flush({String? shardKey}) async {
    final shard = shardKey ?? '';

    if (_flushing.contains(shard)) {
      // A reconnect arrived mid-flush. Remembered rather than dropped: the
      // running flush may already have stopped on the very transport failure
      // that caused the disconnect, and its re-queued writes would then sit
      // untouched until some LATER reconnect happened to come along.
      _flushAgain.add(shard);

      return null;
    }

    _flushing.add(shard);

    try {
      bool again;
      int? retryAfter;

      do {
        _flushAgain.remove(shard);

        retryAfter = await _flushOnce(shardKey);
        // Only while THIS shard is still connected, so a disconnect that lands
        // mid-pass ends the loop instead of retrying into a socket that is down.
        again = _flushAgain.contains(shard);
      } while (again && isConnected(shardKey));

      return retryAfter;
    } finally {
      _flushing.remove(shard);
      _flushAgain.remove(shard);
    }
  }

  /// One drain-and-replay pass. See [flush], which owns the
  /// re-entrancy and the coalesced-reconnect loop around it.
  Future<int?> _flushOnce(String? shardKey) async {
    // A client with no poster cannot replay anything. Checked here rather than
    // per write, because the two replay shapes classified it oppositely: the
    // single-call path saw a CODED error and rejected the whole queue
    // terminally, while the batch path treated it as transport and kept it. A
    // missing poster is configuration, not a verdict on any write, so nothing is
    // drained and nothing is lost.
    if (isClosed() || !transport.canSend) {
      return null;
    }

    // A server that answered "not now" gets waited out. Without this the
    // caller's own reconnect loop replays the identical burst immediately and
    // earns the same 429, indefinitely.
    final remaining = _flushNotBefore - _clock.elapsedMilliseconds;

    if (remaining > 0) {
      return remaining;
    }

    // Weed out writes whose assumptions expired while offline before draining
    // the rest. `drainConflict` rejects each one itself.
    for (final stale in queue.drainConflict()) {
      queue.unpersist(stale.id);
    }

    // `sameShard`, not `==`: a null shard key and an empty one are the SAME
    // shard, so a write submitted with `''` drains on the default shard's flush
    // instead of waiting for a socket that is never opened.
    final drained = queue.drain((item) => sameShard(item.shardKey, shardKey));

    if (drained.isEmpty) {
      return null;
    }

    // ONE identity snapshot for the whole batch: a replay is a sequence of
    // authenticated requests and there is no point between them where the
    // token could change without this loop seeing it. A mismatch is rejected
    // rather than silently dropped, so an awaiting caller gets a verdict.
    final identity = transport.identityFingerprint();
    final sendable = <QueuedMutation>[];

    for (final item in drained) {
      if (item.identityAllowsReplay(identity)) {
        sendable.add(item);
      } else {
        queue.unpersist(item.id);
        item.reject(const LunoraApiException(offlineIdentityChanged, 'offline mutation discarded: it was queued under a different identity'));
      }
    }

    final encodable = _encodableOrSettleTerminal(sendable);

    if (encodable.isEmpty) {
      return null;
    }

    final state = _FlushState();

    // A lone write rides the single-call path, which is the proven one. Two or
    // more coalesce into batch round trips — the flaky-reconnect win, where N
    // queued writes cost a handful of hops instead of N.
    if (encodable.length == 1) {
      await _replaySequential(encodable, state);

      return state.retryAfterMs;
    }

    final toRequeue = <QueuedMutation>[];
    final chunks = _chunkBatches(encodable);

    for (var index = 0; index < chunks.length; index += 1) {
      // Chunks replay sequentially, which is what preserves FIFO across a flush
      // longer than one batch.
      final outcome = await _replayBatched(chunks[index], state);

      toRequeue.addAll(outcome.requeue);

      if (outcome.stop) {
        // A whole-chunk transport failure. Leave every write not yet sent queued,
        // in order, rather than sending on into a connection that just failed.
        for (final later in chunks.sublist(index + 1)) {
          toRequeue.addAll(later);
        }

        break;
      }
    }

    _returnOrAbandon(toRequeue);

    return state.retryAfterMs;
  }

  /// A batch entry's contribution to the request body, in bytes.
  ///
  /// The args dominate and are the only part that can be large; the constant
  /// covers the entry's fixed keys and the comma joining it to the next one.
  /// Encoding twice — here and in [_replayBatched] — is deliberate: the flush is
  /// the slow reconnect path, and carrying the encoded form through the chunker
  /// would hold a second representation of every queued write in memory.
  static int _entryBytes(QueuedMutation item) =>
      utf8.encode(jsonEncode(encodeWire(item.args ?? const <String, Object?>{}))).length + item.functionPath.length + item.id.length + 160;

  /// Split a flush into batch bodies the worker will accept.
  ///
  /// By BYTES as well as by count: the worker reads a batch body under a 1 MiB
  /// budget and answers `413 PAYLOAD_TOO_LARGE` past it, so 500 writes carrying
  /// bytes or long text are one request the server refuses whole. A single write
  /// over the budget still forms its own chunk — splitting cannot help it, and
  /// [_replayBatched] settles it on the answer.
  static List<List<QueuedMutation>> _chunkBatches(List<QueuedMutation> items) {
    final chunks = <List<QueuedMutation>>[];
    var current = <QueuedMutation>[];
    var size = 0;

    for (final item in items) {
      final cost = _entryBytes(item);

      if (current.isNotEmpty && (current.length >= lunoraMaxBatchEntries || size + cost > lunoraMaxBatchBytes)) {
        chunks.add(current);
        current = <QueuedMutation>[];
        size = 0;
      }

      current.add(item);
      size += cost;
    }

    if (current.isNotEmpty) {
      chunks.add(current);
    }

    return chunks;
  }

  /// Record a rate limit's delay, and hold the next flush off until it passes.
  void _noteRetryAfter(_FlushState state, Object error) {
    final delay = retryAfterMs(error);

    if (delay == null) {
      return;
    }

    state.retryAfterMs = delay;
    _flushNotBefore = _flushNotBefore > _clock.elapsedMilliseconds + delay ? _flushNotBefore : _clock.elapsedMilliseconds + delay;
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
        item.reject(LunoraApiException(offlineWriteUnencodable, 'offline mutation cannot be wire-encoded: $error'));
      }
    }

    return encodable;
  }

  /// Replay writes one at a time. FIFO is preserved by the loop itself.
  Future<void> _replaySequential(List<QueuedMutation> items, _FlushState state) async {
    for (var index = 0; index < items.length; index += 1) {
      final item = items[index];

      try {
        final outcome = await transport.rpc(item.functionPath, args: item.args, shardKey: item.shardKey, mutationId: item.id, issuedBy: item.clientId);

        queue.unpersist(item.id);
        item.onCommit?.call(outcome.commitCursor);
        item.resolve(outcome.result);
      } on LunoraApiException catch (error) {
        // Coded, but not necessarily a VERDICT. A 5xx, an envelope-less non-2xx
        // (an edge error page, a WAF block, a proxy), a shard blip or a rate
        // limit all mean the write never reached one — so it goes back on the
        // queue rather than being dropped for having been alone in the flush.
        if (isTransientFailure(error)) {
          _noteRetryAfter(state, error);
          _returnOrAbandon(items.sublist(index));

          return;
        }

        // The server answered and rejected the write. Terminal: replaying it
        // would fail identically forever.
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
  Future<({List<QueuedMutation> requeue, bool stop})> _replayBatched(List<QueuedMutation> items, _FlushState state) async {
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
      return (requeue: _settleBatchSlots(items, results, state), stop: false);
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
        response.status >= 500,
      );

      // The body was too big, not wrong — every entry in it would have committed
      // alone. Halve and retry: the estimate the chunker used cannot see the
      // framing the worker actually measured, and only the answer can.
      if (error.code == payloadTooLarge && items.length > 1) {
        final middle = items.length ~/ 2;
        final left = await _replayBatched(items.sublist(0, middle), state);

        if (left.stop) {
          // The left half stopped the flush, so the right half is re-queued
          // UNSENT and in order behind it.
          return (requeue: <QueuedMutation>[...left.requeue, ...items.sublist(middle)], stop: true);
        }

        final right = await _replayBatched(items.sublist(middle), state);

        return (requeue: <QueuedMutation>[...left.requeue, ...right.requeue], stop: right.stop);
      }

      // A shard blip, a gateway failure or a rate limit is not a verdict on the
      // batch's contents. Requeue it whole and stop the flush, exactly as the
      // single-call path does for the same codes.
      if (isTransientFailure(error)) {
        _noteRetryAfter(state, error);

        return (requeue: items, stop: true);
      }

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
  List<QueuedMutation> _settleBatchSlots(List<QueuedMutation> items, List<Object?> results, _FlushState state) {
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
        final error = LunoraApiException(
          envelope['code'] is String ? envelope['code'] as String : 'INTERNAL',
          envelope['message'] is String ? envelope['message'] as String : 'request failed',
          envelope['data'] == null ? null : decodeWire(envelope['data']),
        );

        // The SAME predicate the whole-batch and single-call paths use, not a
        // second code set beside them: a slot's `body` is exactly a §4.2
        // envelope, so a durable write's fate must not depend on how many
        // siblings were queued alongside it. A shard that was never reached and
        // a limiter that refused to look are both "no verdict", so the write goes
        // back on the queue rather than being reported as failed.
        if (isTransientFailure(error)) {
          _noteRetryAfter(state, error);
          requeue.add(item);
        } else {
          queue.unpersist(item.id);
          item.reject(error);
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

/// What one flush pass has learned that its caller needs after it ends.
///
/// One mutable holder threaded through the replay shapes rather than a return
/// value on each: a flush that splits a batch recursively has several places
/// that can meet a rate limit, and only the outermost caller reports one.
class _FlushState {
  /// Milliseconds the server asked the caller to wait before flushing again.
  int? retryAfterMs;
}
