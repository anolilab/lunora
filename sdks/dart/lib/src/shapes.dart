/// Shape subscriptions and the poke protocol — partial replication of a keyed
/// view, ported from `packages/client`.
///
/// Its own file because it is genuinely self-contained: two maps nothing else
/// reads, its own frame types, and no interaction with the RPC, optimistic or
/// offline-queue paths. [LunoraClient] holds one [ShapeRegistry] and forwards
/// the four frames that belong to it.
///
/// A poke is an atomically-applied batch of diffs — `pokeStart`, zero or more
/// `pokePart`, then `pokeEnd`. See `protocol/README.md` §5.3.
library;

import 'errors.dart';
import 'wire.dart';

/// Receives a shape view's full contents on every applied poke.
typedef LunoraRowsCallback = void Function(List<Object?> rows);

/// Receives a subscription-scoped error.
typedef LunoraErrorCallback = void Function(LunoraSubscriptionError error);

/// Cancels a subscription and tells the server to stop.
typedef LunoraUnsubscribe = void Function();

/// Writes one JSON frame to an open socket.
typedef LunoraFrameSender = void Function(Map<String, Object?> frame);

/// One open keyed view and the rows it has materialised.
class _ShapeSubscription {
  _ShapeSubscription(this.name, this.args, this.onRows, this.onError);

  final String name;

  /// Kept, not just sent: a reconnect has to rebuild this view's
  /// `shape_subscribe` frame, and a registry holding only the id cannot.
  final Object? args;

  final LunoraRowsCallback? onRows;
  final LunoraErrorCallback? onError;
  final Map<String, Object?> rows = <String, Object?>{};
  final List<String> order = <String>[];
  Object? checkpoint;
  Object? epoch;
}

/// One poke in flight: the row ops buffered per shape, plus the shapes this poke
/// marked as a full (re)seed. One buffer rather than two maps kept in step by
/// hand, so both are dropped together at `pokeEnd`.
class _Poke {
  final Map<String, List<Map<String, Object?>>> parts = <String, List<Map<String, Object?>>>{};
  final Set<String> resets = <String>{};
}

/// How many un-applied poke buffers a registry retains before evicting the
/// oldest. A buffer is only released at its `pokeEnd`; a socket that drops
/// mid-poke never sends one, so without a bound the abandoned buffers accumulate
/// for the life of the client — one per reconnect, and unbounded against a peer
/// that opens pokes it never closes. Concurrent in-flight pokes number in the
/// low single digits, so this is far above any legitimate working set.
const int maxPendingPokes = 64;

/// The open shape views and the pokes in flight against them.
class ShapeRegistry {
  final Map<String, _ShapeSubscription> _shapes = <String, _ShapeSubscription>{};
  final Map<String, _Poke> _pokes = <String, _Poke>{};
  int _nextId = 0;

  /// How many views are open.
  int get length => _shapes.length;

  static Map<String, Object?> buildSubscribeFrame(String id, String name, {Object? args, Object? sinceCheckpoint, Object? sinceEpoch}) {
    final shape = <String, Object?>{'name': name};

    if (args != null) {
      shape['args'] = encodeWire(args);
    }

    final frame = <String, Object?>{'id': id, 'shape': shape, 'type': 'shape_subscribe'};

    if (sinceCheckpoint != null) {
      frame['sinceCheckpoint'] = sinceCheckpoint;
    }
    if (sinceEpoch != null) {
      frame['sinceEpoch'] = sinceEpoch;
    }

    return frame;
  }

  static Map<String, Object?> buildUnsubscribeFrame(String id) => <String, Object?>{'id': id, 'type': 'shape_unsubscribe'};

  /// Opens a partially-replicated keyed view. `onRows` fires once per applied
  /// poke with the view's full contents, in insertion order.
  LunoraUnsubscribe subscribe(
    String name, {
    required LunoraFrameSender? Function() sender,
    Object? args,
    LunoraRowsCallback? onRows,
    LunoraErrorCallback? onError,
  }) {
    _nextId += 1;

    final id = 'shape_$_nextId';

    _shapes[id] = _ShapeSubscription(name, args, onRows, onError);
    sender()?.call(buildSubscribeFrame(id, name, args: args));

    return () {
      if (_shapes.remove(id) != null) {
        sender()?.call(buildUnsubscribeFrame(id));
      }
    };
  }

  /// Deliver a subscription-scoped error to the view with this id, if any.
  void reportError(String id, LunoraSubscriptionError error) => _shapes[id]?.onError?.call(error);

  /// One `shape_subscribe` frame per live view, carrying the checkpoint and
  /// epoch it has materialised up to.
  ///
  /// A resend that walks only the QUERY registry leaves every shape view
  /// subscribed to a socket that no longer exists — silently, and for the rest of
  /// the process's life. Built, not sent: the caller writes a socket this
  /// registry does not own, and a write that synchronously unsubscribes would
  /// otherwise mutate `_shapes` while it is being iterated.
  List<Map<String, Object?>> resendFrames() => <Map<String, Object?>>[
        for (final entry in _shapes.entries)
          buildSubscribeFrame(entry.key, entry.value.name, args: entry.value.args, sinceCheckpoint: entry.value.checkpoint, sinceEpoch: entry.value.epoch),
      ];

  /// Begin buffering a poke.
  void beginPoke(Map<String, Object?> frame) {
    final pokeId = frame['pokeId'];

    if (pokeId is String) {
      // Evict oldest-first at the cap. A Dart Map iterates in insertion order,
      // so the first key is the oldest buffer; one that old is no longer going
      // to see its `pokeEnd`.
      while (_pokes.length >= maxPendingPokes) {
        _pokes.remove(_pokes.keys.first);
      }

      _pokes[pokeId] = _Poke();
    }
  }

  /// Parts buffer until `pokeEnd`: a poke is an atomic batch, so applying them
  /// as they arrive would expose a torn view, and a socket dropping mid-poke
  /// would leave it permanently half-applied.
  void bufferPokePart(Map<String, Object?> frame) {
    final pokeId = frame['pokeId'];
    final shapeId = frame['shapeId'];

    if (pokeId is! String || shapeId is! String) {
      return;
    }

    // A part for an unknown poke is dropped: without its pokeStart there is no
    // batch to join, and guessing applies a fragment.
    final buffer = _pokes[pokeId];

    if (buffer == null) {
      return;
    }

    final patch = frame['rowsPatch'];

    if (patch is! List) {
      return;
    }

    buffer.parts.putIfAbsent(shapeId, () => <Map<String, Object?>>[]).addAll(patch.whereType<Map<String, Object?>>());

    // A shape gets at most one part per poke, but record the flag sticky (never
    // cleared) so a server that split a seed across parts still replaces the view
    // rather than merging into it.
    if (frame['reset'] == true) {
      buffer.resets.add(shapeId);
    }
  }

  /// Apply a buffered poke in one transaction and deliver each affected view.
  void applyPoke(Map<String, Object?> frame) {
    final pokeId = frame['pokeId'];

    if (pokeId is! String) {
      return;
    }

    final buffer = _pokes.remove(pokeId);

    if (buffer == null) {
      return;
    }

    // The view is mutated first and every callback fires afterwards, with the
    // row snapshot taken before delivery — so a callback that re-enters this
    // client sees one consistent poke rather than a half-applied one.
    final deliveries = <MapEntry<LunoraRowsCallback, List<Object?>>>[];

    for (final shapeEntry in buffer.parts.entries) {
      final shape = _shapes[shapeEntry.key];

      if (shape == null) {
        continue;
      }

      // A reset part carries the shape's COMPLETE membership, so it REPLACES the
      // view rather than patching it. Merging one keeps every row that left the
      // shape while this client was away: a (re)seed is inserts-only, so nothing
      // already held can ever be removed by it, and the stale row renders for the
      // life of the client. Nothing else on the wire says so — a retention
      // re-seed keeps the epoch, and most pokes carry no `baseCheckpoint` either.
      if (buffer.resets.contains(shapeEntry.key)) {
        shape.rows.clear();
        shape.order.clear();
      }

      for (final operation in shapeEntry.value) {
        _applyRowOp(shape, operation);
      }

      if (frame.containsKey('checkpoint')) {
        shape.checkpoint = frame['checkpoint'];
      }
      if (frame.containsKey('epoch')) {
        shape.epoch = frame['epoch'];
      }

      final onRows = shape.onRows;

      if (onRows != null) {
        deliveries.add(MapEntry(onRows, <Object?>[for (final key in shape.order) shape.rows[key]]));
      }
    }

    for (final delivery in deliveries) {
      delivery.key(delivery.value);
    }
  }

  static void _applyRowOp(_ShapeSubscription shape, Map<String, Object?> operation) {
    final key = operation['key'];

    if (key is! String) {
      return;
    }

    if (operation['op'] == 'delete') {
      if (shape.rows.remove(key) != null) {
        shape.order.remove(key);
      }

      return;
    }

    // A value-less upsert is membership-only; it must not blank an existing row.
    final value = operation['value'];

    if (value == null) {
      return;
    }

    if (!shape.rows.containsKey(key)) {
      shape.order.add(key);
    }

    shape.rows[key] = decodeWire(value);
  }

  /// Drop every view and every poke in flight.
  void clear() {
    _shapes.clear();
    _pokes.clear();
  }
}
