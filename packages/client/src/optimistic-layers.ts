import type { OptimisticLayer, SubscriptionState } from "./subscription";

/**
 * The cursor-gated, rebaseable per-call optimistic-update engine.
 *
 * A per-call `optimistic` transform is recorded as a {@link OptimisticLayer} on
 * its subscription rather than written once and forgotten. The displayed value
 * is always `serverBase` folded through the active layers, so (1) an incoming
 * server frame re-folds the still-pending layers onto the new authoritative base
 * ("rebasing") instead of clobbering them — a queued offline write's optimistic
 * value survives an unrelated delta on the query; and (2) a layer is dropped
 * gaplessly the moment a frame whose `cursor` has reached the write's committed
 * `commitCursor` arrives (its effect is now in `serverBase`), so there is no
 * double-count on the confirming frame — and the drop is keyed on the
 * server-confirmed cursor, never on RPC-response timing (which races the
 * WebSocket broadcast).
 *
 * BOTH optimistic APIs route through this one engine: the single-query per-call
 * `optimistic` registers a TRANSFORM layer (`(current) => next`, which re-derives
 * from the new base on each delta — true rebasing), and the multi-query
 * Convex-parity `optimisticUpdate` registers a CONSTANT-value layer per `setQuery`
 * (see `createLocalStore`). They compose on a shared subscription by fold order
 * (a `setQuery` is an absolute override, so it supersedes earlier layers it folds
 * over), and both get the same gapless cursor-gated drop.
 *
 * Note the constant layer MASKS rather than merges: while pending, it re-clamps to
 * its predicted value and hides any concurrent server change to that query, until
 * the confirming (or `settled`/error) frame drops it. That's the intended absolute
 * -override semantics — and strictly better than the old one-shot model, which
 * the next unrelated frame clobbered outright.
 */

/**
 * Fold the authoritative `base` value through an ordered list of optimistic
 * layers, returning the displayed value. A layer whose transform throws is
 * skipped (its mutation surfaces the error on settle) rather than aborting the
 * fold — so one buggy optimistic write can't blank the whole query.
 */
export const foldOptimistic = (base: unknown, layers: ReadonlyArray<OptimisticLayer>): unknown => {
    let value = base;

    for (const layer of layers) {
        try {
            value = layer.transform(value);
        } catch {
            /* a throwing layer is skipped; the mutation reports the failure itself */
        }
    }

    return value;
};

/**
 * Set a subscription's displayed value and notify its callbacks (throws
 * swallowed). A no-op when `value` is identical to the current `lastValue` — so a
 * fold that re-derives the value already displayed (a confirmed layer dropping, a
 * server frame whose folded result is unchanged) fires no spurious callback.
 */
export const notifySubscription = (state: SubscriptionState, value: unknown): void => {
    if (value === state.lastValue) {
        return;
    }

    // eslint-disable-next-line no-param-reassign -- in-place update of the shared subscription state
    state.lastValue = value;

    for (const callback of state.callbacks) {
        try {
            callback(value);
        } catch {
            /* user callback threw — ignore */
        }
    }
};

/** The settle handle returned by {@link applyOptimisticLayer}. */
export interface OptimisticLayerHandle {
    /**
     * Success: record the CDC `commitCursor` the write landed at. If a server
     * frame has already advanced `serverCursor` to it, the layer is dropped now;
     * otherwise it is dropped when such a frame arrives ({@link dropConfirmedLayers}).
     * A `undefined` cursor (CDC-off shard / no echo) drops the layer immediately —
     * the degraded fallback to one-shot behaviour.
     */
    confirm: (commitCursor: number | undefined) => void;
    /** Failure: remove the layer and re-fold the remainder so the bad value disappears. */
    rollback: () => void;
}

/**
 * Apply one per-call optimistic transform to a subscription as a rebaseable
 * layer, returning a settle handle (or `undefined` if the transform threw,
 * leaving the state untouched).
 */
export const applyOptimisticLayer = (state: SubscriptionState, optimistic: (current: unknown) => unknown): OptimisticLayerHandle | undefined => {
    let next: unknown;

    try {
        // Same input as the historical one-shot path: the current displayed value
        // (serverBase already folded through any prior layers).
        next = optimistic(state.lastValue);
    } catch {
        return undefined;
    }

    const layer: OptimisticLayer = { id: Symbol("optimistic"), transform: optimistic };

    state.optimisticLayers.push(layer);
    notifySubscription(state, next);

    const remove = (): boolean => {
        const index = state.optimisticLayers.findIndex((entry) => entry.id === layer.id);

        if (index === -1) {
            return false;
        }

        state.optimisticLayers.splice(index, 1);

        return true;
    };

    const refold = (): void => {
        // Re-derive the displayed value from the authoritative base through the
        // remaining layers. `notifySubscription` no-ops if it's unchanged.
        notifySubscription(state, foldOptimistic(state.serverBase, state.optimisticLayers));
    };

    return {
        confirm: (commitCursor) => {
            if (commitCursor === undefined) {
                // No server cursor to gate on (CDC off): fall back to dropping the
                // layer silently — the next frame supersedes it as before.
                remove();

                return;
            }

            layer.commitCursor = commitCursor;

            // A confirming (or later) frame already advanced past the commit cursor,
            // so the write is already in `serverBase` — drop the overlay now.
            if (state.serverCursor !== undefined && state.serverCursor >= commitCursor && remove()) {
                refold();
            }
        },
        rollback: () => {
            if (remove()) {
                refold();
            }
        },
    };
};

/**
 * On a server `data`/`delta` frame at `cursor`, drop every optimistic layer whose
 * write has committed at or before it (its effect is now in `serverBase`).
 * Returns `true` if any layer was removed. Layers with no `commitCursor` yet
 * (still queued/in-flight) are kept so their overlay survives the frame.
 */
export const dropConfirmedLayers = (state: SubscriptionState, cursor: number | undefined): boolean => {
    if (cursor === undefined || state.optimisticLayers.length === 0) {
        return false;
    }

    const before = state.optimisticLayers.length;

    // eslint-disable-next-line no-param-reassign -- in-place update of the shared subscription state
    state.optimisticLayers = state.optimisticLayers.filter((layer) => layer.commitCursor === undefined || layer.commitCursor > cursor);

    return state.optimisticLayers.length !== before;
};
