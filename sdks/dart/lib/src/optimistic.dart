/// The cursor-gated, rebaseable optimistic-update engine, ported from
/// `packages/client/src/optimistic-layers.ts` and `local-store.ts`.
///
/// A per-call `optimistic` transform is recorded as a [OptimisticLayer] on its
/// subscription rather than written once and forgotten. The displayed value is
/// always `serverBase` folded through the active layers, so:
///
/// 1. an incoming server frame re-folds the still-pending layers onto the new
///    authoritative base ("rebasing") instead of clobbering them — a queued
///    offline write's optimistic value survives an unrelated delta on the query;
/// 2. a layer is dropped gaplessly the moment a frame whose `cursor` has reached
///    the write's committed `commitCursor` arrives (its effect is now in
///    `serverBase`), so there is no double-count on the confirming frame — and
///    the drop is keyed on the server-confirmed cursor, never on RPC-response
///    timing, which races the WebSocket broadcast.
///
/// Both APIs route through this one engine: the single-query per-call
/// `optimistic` registers a TRANSFORM layer (`(current) => next`, which
/// re-derives from the new base on each delta — true rebasing), and the
/// multi-query `optimisticUpdate` registers a CONSTANT-value layer per
/// `setQuery`. They compose by fold order, and both get the same cursor-gated
/// drop. A constant layer MASKS rather than merges: while pending it re-clamps
/// to its predicted value and hides concurrent server changes to that query,
/// until the confirming frame drops it. That is the intended absolute-override
/// semantics.
library;

/// Transforms the currently displayed value into the predicted one.
typedef LunoraOptimistic = Object? Function(Object? current);

/// One active optimistic transform layered onto a subscription.
class OptimisticLayer {
  OptimisticLayer(this.transform);

  final LunoraOptimistic transform;

  /// The committed CDC cursor from the mutation response; null until confirmed,
  /// which is what keeps a still-queued write's overlay alive across unrelated
  /// frames.
  int? commitCursor;
}

/// The mutable per-subscription state the engine folds over.
///
/// An interface rather than the subscription class itself so the engine stays
/// testable and the client's own bookkeeping (callbacks, ids, resume state)
/// does not leak in here.
abstract class OptimisticTarget {
  /// The authoritative server value the layers fold onto — the value with NO
  /// optimistic overlay. Tracks the displayed value exactly whenever no layers
  /// are active.
  abstract Object? serverBase;

  /// The last displayed value, i.e. [serverBase] folded through [layers].
  abstract Object? lastValue;

  /// Whether anything has been delivered yet.
  ///
  /// Tracked separately from [lastValue] because Dart has no `undefined`: the
  /// reference client distinguishes "never delivered" from "delivered null" by
  /// the difference between `undefined` and `null`, and without this flag a
  /// query whose first value IS null would be suppressed as unchanged and never
  /// reach its subscriber at all.
  abstract bool delivered;

  /// The `__cdc_log` high-watermark the displayed value reflects. Null until
  /// the first cursor-stamped frame arrives.
  ///
  /// Read-only to the engine, which never advances a cursor — the client owns
  /// that, from the frame.
  int? get serverCursor;

  /// Active layers, in application order.
  abstract List<OptimisticLayer> layers;

  /// Deliver a new displayed value to whoever is watching.
  void deliver(Object? value);
}

/// Fold the authoritative [base] through an ordered list of layers, returning
/// the displayed value.
///
/// A layer whose transform throws is SKIPPED rather than aborting the fold, so
/// one buggy optimistic write cannot blank the whole query; its mutation still
/// surfaces the error when it settles.
Object? foldOptimistic(Object? base, List<OptimisticLayer> layers) {
  var value = base;

  for (final layer in layers) {
    try {
      value = layer.transform(value);
    } on Object {
      // A throwing layer is skipped; the mutation reports the failure itself.
    }
  }

  return value;
}

/// Set a target's displayed value and notify it.
///
/// A no-op when the value is unchanged, so a fold that re-derives the value
/// already displayed — a confirmed layer dropping, a server frame whose folded
/// result is identical — fires no spurious callback. `==` rather than
/// `identical`, because it is the exact counterpart of the reference client's
/// `===` for every type the codec produces: value equality on primitives,
/// identity on the collections `decodeWire` builds.
void notifyTarget(OptimisticTarget target, Object? value) {
  if (target.delivered && value == target.lastValue) {
    return;
  }

  target.delivered = true;
  target.lastValue = value;
  target.deliver(value);
}

/// The settle handle returned by [applyOptimisticLayer].
class OptimisticLayerHandle {
  OptimisticLayerHandle(this._confirm, this._rollback);

  final void Function(int? commitCursor) _confirm;
  final void Function() _rollback;

  /// Success: record the CDC cursor the write landed at. If a server frame has
  /// already advanced past it the layer is dropped now; otherwise it is dropped
  /// when such a frame arrives (see [dropConfirmedLayers]).
  void confirm(int? commitCursor) => _confirm(commitCursor);

  /// Failure: remove the layer and re-fold the remainder so the bad value
  /// disappears.
  void rollback() => _rollback();
}

/// Apply one optimistic transform to [target] as a rebaseable layer, returning
/// a settle handle — or null if the transform threw, leaving the state
/// untouched.
OptimisticLayerHandle? applyOptimisticLayer(OptimisticTarget target, LunoraOptimistic optimistic) {
  final Object? next;

  try {
    // The same input the reference client uses: the current displayed value,
    // which is serverBase already folded through any prior layers.
    next = optimistic(target.lastValue);
  } on Object {
    return null;
  }

  final layer = OptimisticLayer(optimistic);

  target.layers.add(layer);
  notifyTarget(target, next);

  bool remove() => target.layers.remove(layer);

  void refold() {
    // Re-derive the displayed value from the authoritative base through the
    // remaining layers. `notifyTarget` no-ops if it is unchanged.
    notifyTarget(target, foldOptimistic(target.serverBase, target.layers));
  }

  return OptimisticLayerHandle(
    (commitCursor) {
      if (commitCursor == null) {
        // No server cursor to gate on (CDC off): drop the layer but do NOT
        // re-fold. `confirm` runs on SUCCESS, so the displayed optimistic value
        // reflects the write that just committed — re-folding here would revert
        // it to the pre-write serverBase, a visible regress of a successful
        // write, until the authoritative frame supersedes it. The failure path
        // is the one that re-folds.
        remove();

        return;
      }

      layer.commitCursor = commitCursor;

      // A confirming (or later) frame already advanced past the commit cursor,
      // so the write is already in serverBase — drop the overlay now.
      final cursor = target.serverCursor;

      if (cursor != null && cursor >= commitCursor && remove()) {
        refold();
      }
    },
    () {
      if (remove()) {
        refold();
      }
    },
  );
}

/// On a server `data`/`delta` frame at [cursor], drop every layer whose write
/// has committed at or before it — its effect is now in `serverBase`.
///
/// Layers with no `commitCursor` yet (still queued or in flight) are kept so
/// their overlay survives the frame. Returns true if any layer was removed.
bool dropConfirmedLayers(OptimisticTarget target, int? cursor) {
  if (cursor == null || target.layers.isEmpty) {
    return false;
  }

  final before = target.layers.length;

  target.layers = target.layers.where((layer) => layer.commitCursor == null || layer.commitCursor! > cursor).toList();

  return target.layers.length != before;
}

/// Unwind a batch of rollbacks in LIFO order, so layers come off in the reverse
/// of the order they were applied.
void rollbackOptimistic(List<OptimisticLayerHandle> handles) {
  for (var index = handles.length - 1; index >= 0; index -= 1) {
    handles[index].rollback();
  }
}

/// Read/write handle over the client's live query cache, handed to a mutation's
/// [LunoraOptimisticUpdate] so a single write can patch many subscribed queries
/// at once.
///
/// [getQuery] reads the current value — server value, or any still-pending
/// optimistic override — of a subscribed query; [setQuery] registers a constant
/// optimistic layer on top. The whole batch rebases onto incoming deltas and
/// settles together, on the mutation's commit cursor or its failure.
abstract class OptimisticLocalStore {
  /// Current cached value for the subscribed query, or null when nothing is
  /// subscribed to it. Reflects any override already written in this batch.
  Object? getQuery(String functionPath, {Object? args});

  /// Every loaded subscription on [functionPath], regardless of args, paired
  /// with the args it was subscribed under — for a write that must patch every
  /// variant of a list query without enumerating their args up front.
  List<({Object? args, Object? value})> getAllQueries(String functionPath);

  /// Write an optimistic override for the subscribed query. A no-op when no
  /// subscription matches: you only patch queries something is watching.
  void setQuery(String functionPath, Object? value, {Object? args});
}

/// A mutation's multi-query optimistic update.
typedef LunoraOptimisticUpdate = void Function(OptimisticLocalStore store, Object? args);
