"""The cursor-gated, rebaseable optimistic-update engine.

A port of ``packages/client/src/optimistic-layers.ts``. An optimistic transform
is recorded as a LAYER on its subscription rather than written once and
forgotten, so the displayed value is always ``server_base`` folded through the
active layers. Two things follow, and both are the reason for the design:

1. An incoming server frame re-folds the still-pending layers onto the new
   authoritative base ("rebasing") instead of clobbering them — a queued offline
   write's predicted value survives an unrelated delta on the same query.
2. A layer is dropped the moment a frame whose ``cursor`` has reached the write's
   committed ``commit_cursor`` arrives (its effect is now in ``server_base``), so
   there is no double-count on the confirming frame. The drop is keyed on the
   SERVER-confirmed cursor, never on RPC-response timing, which races the
   WebSocket broadcast.

Both optimistic APIs route through this one engine: the single-query per-call
transform registers a TRANSFORM layer (re-derived from the new base on each
delta — true rebasing), and the multi-query local store registers a CONSTANT
layer per ``set_query``. They compose on a shared subscription by fold order.

The constant layer MASKS rather than merges: while pending it re-clamps to its
predicted value and hides a concurrent server change to that query, until the
confirming (or rollback) event drops it. That is the intended absolute-override
semantics.

**Callbacks are never invoked from here.** Every function that would notify takes
a ``deferred`` list and appends thunks to it instead. The client mutates layer
state under the lock that guards its subscription registry, and running a
consumer's callback inside that critical section is how the read loop deadlocks
against a handler that subscribes. The caller drains ``deferred`` once it has
released the lock — the same discipline ``LunoraClient.handle_frame`` already
uses for server frames.

**Divergence from ``@lunora/client``.** The TypeScript engine suppresses a
notification whose folded result is reference-identical to the value already
displayed. Reference identity has no portable meaning across these seven
languages, and structural equality is not available for every value in all of
them, so the ports notify on every fold instead: applying a layer, dropping one,
and each server frame. A consumer therefore sees at most a few redundant
callbacks carrying the same value, never a missing one.
"""

from __future__ import annotations

import contextlib
from functools import partial
from itertools import count
from typing import Any, Callable, Optional

Transform = Callable[[Any], Any]

#: A thunk queued for the caller to run once it has released its lock.
Deferred = list

_ids = count(1)


class OptimisticLayer:
    """One active optimistic transform layered onto a subscription."""

    __slots__ = ("commit_cursor", "id", "transform")

    def __init__(self, transform: Transform) -> None:
        self.id = next(_ids)
        self.transform = transform
        # The committed CDC cursor from the mutation's response; ``None`` while
        # the write is still queued or in flight, which is what keeps the overlay
        # alive across unrelated deltas until it is confirmed.
        self.commit_cursor: Optional[int] = None


def fold_optimistic(base: Any, layers: list) -> Any:
    """Fold ``base`` through ``layers`` in order, returning the displayed value.

    A layer whose transform raises is SKIPPED rather than aborting the fold: one
    buggy optimistic write must not blank the whole query for every other layer.
    The mutation that registered it surfaces the failure itself.
    """

    value = base
    for layer in layers:
        value = _apply_or_skip(layer, value)
    return value


def _apply_or_skip(layer: OptimisticLayer, value: Any) -> Any:
    try:
        return layer.transform(value)
    except Exception:
        # Extracted from the fold loop so the guard is one function call rather
        # than a per-iteration exception frame.
        return value


def notify_subscription(sub: Any, value: Any, deferred: Deferred) -> None:
    """Set the displayed value and queue the subscription's callbacks."""

    sub.last_value = value
    deferred.extend(partial(_safe_call, callback, value) for callback in list(sub.callbacks))


def _safe_call(callback: Callable[[Any], None], value: Any) -> None:
    with contextlib.suppress(Exception):
        callback(value)


class OptimisticHandle:
    """The settle handle returned by :func:`apply_optimistic_layer`."""

    __slots__ = ("_layer", "_sub")

    def __init__(self, sub: Any, layer: OptimisticLayer) -> None:
        self._sub = sub
        self._layer = layer

    def confirm(self, commit_cursor: Optional[int], deferred: Deferred) -> None:
        """Success: gate the layer's removal on the server-confirmed cursor.

        A ``None`` cursor (CDC off on this shard, so nothing was echoed) drops the
        layer immediately but does NOT re-fold: ``confirm`` runs on SUCCESS, so
        the displayed optimistic value reflects a write that just committed, and
        re-folding here would visibly revert it to the pre-write base until the
        authoritative frame supersedes it. :meth:`rollback` is the path that
        re-folds.
        """

        if commit_cursor is None:
            self._remove()
            return

        self._layer.commit_cursor = commit_cursor

        # A confirming (or later) frame already advanced past the commit cursor,
        # so the write is in ``server_base`` — drop the overlay now.
        if self._sub.server_cursor is not None and self._sub.server_cursor >= commit_cursor and self._remove():
            self._refold(deferred)

    def rollback(self, deferred: Deferred) -> None:
        """Failure: remove the layer and re-fold, so the bad value disappears."""

        if self._remove():
            self._refold(deferred)

    def _remove(self) -> bool:
        for index, entry in enumerate(self._sub.optimistic_layers):
            if entry.id == self._layer.id:
                del self._sub.optimistic_layers[index]
                return True
        return False

    def _refold(self, deferred: Deferred) -> None:
        notify_subscription(self._sub, fold_optimistic(self._sub.server_base, self._sub.optimistic_layers), deferred)


def apply_optimistic_layer(sub: Any, transform: Transform, deferred: Deferred) -> Optional[OptimisticHandle]:
    """Layer one optimistic transform onto ``sub``, returning its settle handle.

    Returns ``None`` (leaving the subscription untouched) when the transform
    raises on the value it is first handed — there is nothing to display and
    nothing to settle.
    """

    try:
        # Same input as the reference client: the current DISPLAYED value, i.e.
        # ``server_base`` already folded through any prior layers.
        predicted = transform(sub.last_value)
    except Exception:
        return None

    layer = OptimisticLayer(transform)
    sub.optimistic_layers.append(layer)
    notify_subscription(sub, predicted, deferred)

    return OptimisticHandle(sub, layer)


def drop_confirmed_layers(sub: Any, cursor: Optional[int]) -> bool:
    """Drop every layer whose write has committed at or before ``cursor``.

    Called on each ``data``/``delta`` frame: a layer confirmed at a cursor the
    frame has reached is now reflected in ``server_base``, so keeping it would
    double-count. Layers with no ``commit_cursor`` yet (still queued or in flight)
    are kept, so their overlay survives the frame. Returns whether anything was
    removed.
    """

    if cursor is None or not sub.optimistic_layers:
        return False

    before = len(sub.optimistic_layers)
    sub.optimistic_layers = [layer for layer in sub.optimistic_layers if layer.commit_cursor is None or layer.commit_cursor > cursor]

    return len(sub.optimistic_layers) != before


class OptimisticLocalStore:
    """Read/write handle over the client's live query cache.

    Handed to a mutation's ``optimistic_update`` callback so a single write can
    patch MANY subscribed queries at once. Each :meth:`set_query` registers a
    constant layer through the same engine the single-query path uses, so the
    whole batch rebases onto incoming deltas and settles together — confirmed on
    the mutation's commit cursor, or rolled back on failure.
    """

    __slots__ = ("_deferred", "_find", "_matching", "confirms", "rollbacks")

    def __init__(
        self,
        find: Callable[[str, Any], list],
        matching: Callable[[str], list],
        deferred: Deferred,
    ) -> None:
        self._find = find
        self._matching = matching
        self._deferred = deferred
        self.confirms: list = []
        self.rollbacks: list = []

    def get_query(self, function_path: str, args: Any = None) -> Any:
        """Current cached value for a subscribed query, or ``None`` if not subscribed.

        Reflects any optimistic override already written in this batch.
        """

        matches = self._find(function_path, args)
        return matches[0].last_value if matches else None

    def get_all_queries(self, function_path: str) -> list:
        """Every loaded subscription on ``function_path`` as ``(args, value)`` pairs.

        Handy when a write must patch every variant of a list query (all
        channels, all filters) without enumerating their args up front.
        """

        return [(sub.args, sub.last_value) for sub in self._matching(function_path)]

    def set_query(self, function_path: str, args: Any, value: Any) -> None:
        """Write an optimistic override for a subscribed query.

        A no-op when nothing is subscribed for it — you only patch queries the
        consumer is actually watching.
        """

        for sub in self._find(function_path, args):
            handle = apply_optimistic_layer(sub, lambda _current, held=value: held, self._deferred)
            if handle is not None:
                self.confirms.append(handle.confirm)
                self.rollbacks.append(handle.rollback)


def confirm_all(confirms: list, commit_cursor: Optional[int], deferred: Deferred) -> None:
    """Confirm every layer a write registered, against its committed cursor."""

    for confirm in confirms:
        with contextlib.suppress(Exception):
            confirm(commit_cursor, deferred)


def rollback_all(rollbacks: list, deferred: Deferred) -> None:
    """Unwind a write's optimistic layers, most-recent-first.

    LIFO, not FIFO: layers compose by fold order, so removing an earlier one
    first would re-fold the later ones onto a base they never saw.
    """

    for rollback in reversed(rollbacks):
        with contextlib.suppress(Exception):
            rollback(deferred)
