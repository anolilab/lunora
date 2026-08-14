/// The bounded, optionally durable offline mutation queue, ported from
/// `packages/client/src/offline-queue.ts`.
///
/// Mutations issued while the client is disconnected are enqueued and replayed
/// in the order they were submitted once it reconnects. If the queue exceeds
/// [OfflineQueue.maxItems] the OLDEST entry is dropped with
/// [offlineQueueOverflow] — a bounded queue that drops the newest would make an
/// offline session's most recent work the first thing lost.
///
/// ## Durability is injected, like HTTP and the socket
///
/// This package has no dependencies and no opinion about where a Flutter app
/// keeps durable state — `shared_preferences`, `sqflite`, `hive`, Drift and a
/// plain file are all reasonable, and which one an app already has is not ours
/// to decide. So durability is a [LunoraPersistence] the consumer implements,
/// exactly as the HTTP poster and the frame sender are. [MemoryPersistence]
/// exists for tests and for an app that wants the queue without the durability.
///
/// Without an adapter the queue is in-memory: it survives a dropped socket,
/// which is the common case, but not a process restart.
library;

import 'dart:async';
import 'dart:math';

import 'errors.dart';

/// One mutation as it is written to durable storage.
class PersistedMutation {
  const PersistedMutation({
    required this.id,
    required this.functionPath,
    required this.args,
    this.shardKey,
    this.clientId,
    this.identity,
    this.version,
  });

  /// The stable idempotency key. It is the same value the live call sent as
  /// `x-lunora-mutation-id`, so a replay of a write the server already
  /// committed is deduplicated server-side rather than applied twice.
  final String id;
  final String functionPath;
  final Object? args;
  final String? shardKey;

  /// The client id that ISSUED this write, persisted so a replay lands in the
  /// same server-side dedup namespace it was first sent under.
  ///
  /// Load-bearing for exactly-once on an anonymous call: the shard namespaces a
  /// signed-out caller's idempotency row by this id, and with none it cannot
  /// deduplicate at all — so every retry path re-applies the write. A replay
  /// after a restart must therefore use the id from the RECORD, not the one this
  /// session minted.
  final String? clientId;

  /// Issuing identity fingerprint — null means "queued while signed out",
  /// which is a real value distinct from an absent stamp. Persisted so a
  /// restored write can only replay under the identity that queued it.
  final String? identity;

  /// App/schema version stamped at enqueue. On hydrate a record whose version
  /// does not match the current one is dropped and purged rather than replayed
  /// against a schema it was not written for.
  final String? version;

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'functionPath': functionPath,
        'args': args,
        if (shardKey != null) 'shardKey': shardKey,
        if (clientId != null) 'clientId': clientId,
        if (identity != null) 'identity': identity,
        if (version != null) 'version': version,
      };

  static PersistedMutation fromJson(Map<String, Object?> json) => PersistedMutation(
        id: json['id']! as String,
        functionPath: json['functionPath']! as String,
        args: json['args'],
        shardKey: json['shardKey'] as String?,
        clientId: json['clientId'] as String?,
        identity: json['identity'] as String?,
        version: json['version'] as String?,
      );
}

/// Durable storage for queued mutations. Implement it over whatever store the
/// app already has; see the library comment for why this is not built in.
///
/// [PersistedMutation.toJson] and [PersistedMutation.fromJson] are provided so
/// an implementation only has to move a `Map` in and out, but an adapter over a
/// relational store is free to ignore them.
abstract class LunoraPersistence {
  /// Append one mutation. Called on enqueue.
  ///
  /// Implementations must apply calls in the order they are made. The queue does
  /// not await them — a write should not pay a storage round-trip before its
  /// caller's Future resolves — so an adapter that reorders can let a [remove]
  /// land before the [append] it cancels, leaving a record in storage that the
  /// next session replays as a write this one already rejected.
  Future<void> append(PersistedMutation mutation);

  /// Load every persisted mutation in FIFO order. Called once at startup.
  Future<List<PersistedMutation>> load();

  /// Remove a mutation by id once it has settled, successfully or terminally.
  Future<void> remove(String id);

  /// Drop everything — for a logout, say.
  Future<void> clear();
}

/// A [LunoraPersistence] that keeps records in memory.
///
/// Not durable across a process restart, so it is for tests and for an app that
/// wants the queue's ordering and bounds without the storage. It does record
/// FIFO order faithfully, so a suite can exercise the hydrate path against it.
class MemoryPersistence implements LunoraPersistence {
  final List<PersistedMutation> _records = <PersistedMutation>[];

  /// The records currently held, in FIFO order.
  List<PersistedMutation> get records => List<PersistedMutation>.unmodifiable(_records);

  @override
  Future<void> append(PersistedMutation mutation) async => _records.add(mutation);

  @override
  Future<List<PersistedMutation>> load() async => List<PersistedMutation>.of(_records);

  @override
  Future<void> remove(String id) async => _records.removeWhere((record) => record.id == id);

  @override
  Future<void> clear() async => _records.clear();
}

/// Which durable operation failed, for [OfflineQueue.onPersistenceError].
enum PersistenceOperation { append, load, remove }

/// One queued mutation, awaiting replay.
class QueuedMutation {
  QueuedMutation({
    required this.id,
    required this.functionPath,
    required this.args,
    this.shardKey,
    this.clientId,
    this.identity,
    this.completer,
    this.precondition,
    this.onCommit,
    this.onReject,
  });

  final String id;
  final String functionPath;
  final Object? args;
  final String? shardKey;

  /// The client id that issued this write — see [PersistedMutation.clientId].
  final String? clientId;

  final String? identity;

  /// The caller awaiting this write, or null for a record restored from durable
  /// storage — a reload leaves no awaiter, and completing a `Completer` nobody
  /// listens to with an error is an unhandled async error in Dart, not a no-op.
  final Completer<Object?>? completer;

  /// Evaluated just before replay. Returning false drops the write instead of
  /// sending it, for the case where its preconditions no longer hold — the
  /// document it referred to was deleted while offline, say.
  final bool Function()? precondition;

  /// Invoked on a successful replay with the server's echoed commit cursor, so
  /// a live optimistic layer drops gaplessly once a frame reaches it. Absent on
  /// a restored record, whose optimistic write lived in a prior session.
  final void Function(int? commitCursor)? onCommit;

  /// Invoked on any terminal rejection, before the awaiter is completed — this
  /// is where the client unwinds the write's optimistic layers.
  final void Function(Object error)? onReject;

  /// Set by the queue so a settled write reaches [OfflineQueue.onSettled].
  ///
  /// Not the same thing as [completer]: a RESTORED write has no completer, no
  /// `onReject` and no awaiter at all, so without this every verdict on one — an
  /// identity mismatch, a failed precondition, unencodable args, a server
  /// rejection — was reached in total silence.
  void Function(QueuedMutation entry, Object? error)? onSettled;

  /// True when a live caller is still awaiting this write.
  bool get hasAwaiter => completer != null;

  void resolve(Object? value) {
    onSettled?.call(this, null);

    if (completer != null && !completer!.isCompleted) {
      completer!.complete(value);
    }
  }

  void reject(Object error) {
    onReject?.call(error);
    onSettled?.call(this, error);

    if (completer != null && !completer!.isCompleted) {
      completer!.completeError(error);
    }
  }

  PersistedMutation toPersisted(String? version) => PersistedMutation(
        id: id,
        functionPath: functionPath,
        args: args,
        shardKey: shardKey,
        clientId: clientId,
        identity: identity,
        version: version,
      );
}

/// A process-unique id, used as a mutation's idempotency key.
///
/// It must be globally unique: the server deduplicates a replayed write by it,
/// so two clients colliding on one would let the first write suppress the
/// second. `Random.secure()` where the platform has a CSPRNG, falling back to
/// the ordinary generator mixed with a monotonic counter so two ids minted in
/// the same millisecond on a platform without one still differ.
String nextMutationId() {
  _idCounter += 1;

  final random = _secureRandom ?? _fallbackRandom;
  final buffer = StringBuffer();

  for (var index = 0; index < 8; index += 1) {
    buffer.write(random.nextInt(0x10000).toRadixString(16).padLeft(4, '0'));
  }

  return '$buffer-${_idCounter.toRadixString(16)}';
}

int _idCounter = 0;
final Random _fallbackRandom = Random();
final Random? _secureRandom = _trySecureRandom();

Random? _trySecureRandom() {
  try {
    return Random.secure();
  } on UnsupportedError {
    return null;
  }
}

/// Bounded FIFO queue of mutations awaiting replay.
class OfflineQueue {
  OfflineQueue({
    this.maxItems = 1000,
    this.queueBeforeFirstConnect = false,
    this.persistence,
    this.version,
    this.onSizeChange,
    this.onSettled,
    this.onPersistenceError,
  });

  /// The cap. Reaching it drops the OLDEST entry.
  final int maxItems;

  /// Queue writes issued before the client has ever been connected.
  ///
  /// Off by default, matching the reference client: until the first connect the
  /// client has not completed a handshake, so a failure there is more likely a
  /// misconfiguration than a network blip and failing fast says so. Turn it on
  /// for an offline-first app that must accept writes on a cold first launch.
  final bool queueBeforeFirstConnect;

  final LunoraPersistence? persistence;

  /// Stamped on every persisted write; a restored record whose stamp differs is
  /// purged rather than replayed.
  final String? version;

  /// Notified with the new depth after any change — drives a "N writes pending"
  /// indicator.
  final void Function(int size)? onSizeChange;

  /// Notified whenever a queued write reaches a terminal verdict — replayed,
  /// rejected by the server, evicted on overflow, discarded by a failed
  /// precondition or an identity change, or abandoned by `close`. `error` is null
  /// on success.
  ///
  /// Worth handling, and the only way to see half of them: a RESTORED write has
  /// no awaiter, so its verdict reaches no Future at all.
  final void Function(QueuedMutation entry, Object? error)? onSettled;

  /// Notified when a durable operation fails — a full disk, a revoked
  /// permission. A failed `append` means the write is queued in memory but NOT
  /// durable, so it will not survive a restart.
  final void Function(PersistenceOperation operation, Object error, String? mutationId)? onPersistenceError;

  final List<QueuedMutation> _items = <QueuedMutation>[];

  int get size => _items.length;

  /// Whether a write issued while disconnected should be queued rather than
  /// failing fast.
  ///
  /// The rule is the queue's, so the decision is too. Before the client's first
  /// successful connect a failure is more likely a misconfiguration than a
  /// network blip, and failing fast says so — unless [queueBeforeFirstConnect]
  /// turns that off for an offline-first app.
  bool acceptsWhileDisconnected({required bool everConnected}) => everConnected || queueBeforeFirstConnect;

  /// The queued writes, oldest first. A copy: mutating the queue is done
  /// through its own methods.
  List<QueuedMutation> get items => List<QueuedMutation>.unmodifiable(_items);

  void enqueue(QueuedMutation entry) {
    entry.onSettled = onSettled;
    _items.add(entry);
    _evictOverflow();

    final store = persistence;

    // Persisted only if it SURVIVED the eviction that adding it may have
    // triggered. Persisting first and un-persisting after would race: both calls
    // are unawaited, so the `remove` could land before its own `append` and
    // leave the record in durable storage forever, to be replayed by a later
    // session as a write this one already rejected.
    if (store != null && _items.contains(entry)) {
      // Fire-and-forget with an explicit error hop: awaiting here would make
      // every queued write pay a storage round-trip before its caller's Future
      // resolves, and the in-memory queue is already authoritative for this
      // session. A failure means "queued but not durable", which is what the
      // handler is told.
      unawaited(
        store.append(entry.toPersisted(version)).catchError((Object error) {
          onPersistenceError?.call(PersistenceOperation.append, error, entry.id);
        }),
      );
    }

    _notifySize();
  }

  /// Restore mutations persisted in a prior session and re-queue them in FIFO
  /// order. Returns how many were restored.
  ///
  /// Restored entries already live in durable storage, so they are not
  /// re-appended, and they carry no awaiter. They are INSERTED AHEAD of
  /// whatever is already queued rather than appended: the durable store's order
  /// is authoritative, a prior-session write is always older than anything from
  /// this session, and replaying a boot-time write before an older restored one
  /// on the same document would let last-writer-wins clobber the newer data
  /// with the stale one.
  Future<int> hydrate() async {
    final store = persistence;

    if (store == null) {
      return 0;
    }

    final List<PersistedMutation> persisted;

    try {
      persisted = await store.load();
    } on Object catch (error) {
      onPersistenceError?.call(PersistenceOperation.load, error, null);

      rethrow;
    }

    final restored = <QueuedMutation>[];
    final seen = <String>{for (final item in _items) item.id};

    for (final record in persisted) {
      if (!seen.add(record.id)) {
        continue;
      }

      // Version gate: a write persisted by a different app or schema version is
      // dropped and purged rather than replayed against the current one.
      if (version != null && record.version != version) {
        unawaited(
          store.remove(record.id).catchError((Object error) {
            onPersistenceError?.call(PersistenceOperation.remove, error, record.id);
          }),
        );

        continue;
      }

      restored.add(
        QueuedMutation(
          id: record.id,
          functionPath: record.functionPath,
          args: record.args,
          shardKey: record.shardKey,
          clientId: record.clientId,
          identity: record.identity,
        )..onSettled = onSettled,
      );
    }

    _items.insertAll(0, restored);

    // A durable store holding more than `maxItems` records — because the cap was
    // lowered between sessions, or writes piled up across restarts — must not
    // bypass the cap. Evicting here means the queue never exceeds it regardless
    // of how it got there.
    _evictOverflow();
    _notifySize();

    return restored.length;
  }

  /// Remove and return every queued mutation, oldest first.
  ///
  /// No per-shard predicate, unlike the reference client: there the socket is
  /// per-shard so one shard can reconnect while others are down, whereas this
  /// transport has a single injected connection whose shard rides its URL. One
  /// connectivity signal means one drain.
  List<QueuedMutation> drain() {
    final drained = List<QueuedMutation>.of(_items);

    _items.clear();
    _notifySize();

    return drained;
  }

  /// Return previously-drained mutations to the FRONT of the queue, preserving
  /// their order and without re-persisting them — they were never un-persisted,
  /// so durable storage still holds them. Used when a flush aborts on a
  /// transport failure: the unreplayed writes wait for the next reconnect.
  void requeue(List<QueuedMutation> items) {
    if (items.isEmpty) {
      return;
    }

    _items.insertAll(0, items);
    _notifySize();
  }

  /// Remove and reject every mutation whose precondition no longer holds,
  /// returning them. The rest keep their order.
  ///
  /// Called before a flush to weed out writes whose assumptions have expired
  /// while offline.
  List<QueuedMutation> drainConflict() {
    final conflicted = <QueuedMutation>[];
    final kept = <QueuedMutation>[];

    for (final item in _items) {
      final precondition = item.precondition;

      if (precondition != null && !precondition()) {
        conflicted.add(item);
      } else {
        kept.add(item);
      }
    }

    if (conflicted.isEmpty) {
      return conflicted;
    }

    _items
      ..clear()
      ..addAll(kept);
    _notifySize();

    for (final item in conflicted) {
      item.reject(const LunoraApiException(offlinePreconditionFailed, 'offline mutation skipped: precondition failed before replay'));
    }

    return conflicted;
  }

  /// Reject every pending mutation so an awaiting caller cannot hang forever
  /// when the client is closed mid-flight.
  ///
  /// Durable storage is left INTACT on purpose: closing an app must not discard
  /// writes the next session will restore. Call the adapter's own `clear()` to
  /// purge them, on logout for instance.
  void clear() {
    final pending = List<QueuedMutation>.of(_items);

    _items.clear();
    _notifySize();

    for (final item in pending) {
      item.reject(const LunoraApiException(clientClosed, 'client closed with the write still queued'));
    }
  }

  /// Un-persist a settled write. Called by the client once a replay has reached
  /// a terminal verdict, success or otherwise.
  void unpersist(String id) {
    final store = persistence;

    if (store == null) {
      return;
    }

    unawaited(
      store.remove(id).catchError((Object error) {
        onPersistenceError?.call(PersistenceOperation.remove, error, id);
      }),
    );
  }

  /// Drop entries from the FRONT — the oldest — until the queue is at or under
  /// [maxItems], rejecting, un-persisting and reporting each.
  void _evictOverflow() {
    while (_items.length > maxItems) {
      final dropped = _items.removeAt(0);
      const error = LunoraApiException(offlineQueueOverflow, 'offline queue overflow');

      unpersist(dropped.id);
      // `reject` carries it to `onSettled`, which is where a restored entry —
      // having no awaiter — is heard from at all.
      dropped.reject(error);
    }
  }

  void _notifySize() => onSizeChange?.call(_items.length);
}
