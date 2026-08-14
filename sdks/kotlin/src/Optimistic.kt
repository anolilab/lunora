package dev.lunora

import java.util.concurrent.atomic.AtomicLong

/**
 * The cursor-gated, rebaseable optimistic-update engine — a port of
 * `packages/client/src/optimistic-layers.ts`.
 *
 * An optimistic transform is recorded as a LAYER on its subscription rather than
 * written once and forgotten, so the displayed value is always [State.serverBase]
 * folded through the active layers. Two things follow, and both are the reason
 * for the design:
 *
 * 1. An incoming server frame re-folds the still-pending layers onto the new
 *    authoritative base ("rebasing") instead of clobbering them, so a queued
 *    offline write's predicted value survives an unrelated delta on the query.
 * 2. A layer is dropped the moment a frame whose `cursor` has reached the write's
 *    committed [Layer.commitCursor] arrives (its effect is now in the base), so
 *    the confirming frame cannot double-count it. The drop is keyed on the
 *    SERVER-confirmed cursor, never on RPC-response timing, which races the
 *    socket broadcast.
 *
 * Both optimistic APIs route through this one engine: the single-query per-call
 * transform registers a TRANSFORM layer (re-derived from the new base on every
 * delta — true rebasing), and the multi-query [LocalStore] registers a CONSTANT
 * layer per [LocalStore.setQuery]. They compose on a shared subscription by fold
 * order, and a constant layer MASKS rather than merges — while pending it
 * re-clamps to its predicted value and hides a concurrent server change to that
 * query, which is the intended absolute-override semantics.
 *
 * **Callbacks are never invoked from here.** Every function that would notify
 * takes a `deferred` list and appends to it instead. The client mutates layer
 * state inside the monitor that guards its subscription registry, and running a
 * consumer's callback in that critical section is how the socket reader stalls
 * behind a slow consumer — or deadlocks against a handler that subscribes. The
 * caller drains `deferred` once it has left the monitor, the same discipline
 * [Client.handleFrame] already uses.
 *
 * **Divergence from `@lunora/client`.** The TypeScript engine suppresses a
 * notification whose folded result is reference-identical to the value already
 * displayed. Reference identity has no portable meaning across the seven ports,
 * so they notify on every fold instead — a consumer sees at most a few redundant
 * callbacks carrying the same value, never a missing one.
 */
object Optimistic {
    /**
     * Derives the value to display from the value displayed now.
     *
     * It is re-run on every rebase, so it must derive from its input rather than
     * remember: a transform that closed over what it produced last time would
     * compound its own effect on each server frame.
     */
    private val nextLayerId = AtomicLong()

    /** One active optimistic transform layered onto a subscription. */
    class Layer(val transform: (WireValue) -> WireValue) {
        val id: Long = nextLayerId.incrementAndGet()

        /**
         * The CDC cursor the write committed at, from the mutation's response.
         * Null while the write is still queued or in flight, which is what keeps
         * the overlay alive across unrelated deltas until it is confirmed.
         */
        var commitCursor: Long? = null
    }

    /** The layered value a subscription displays. */
    class State(base: WireValue = WireValue.Null) {
        /**
         * The authoritative value with NO overlay. It tracks [lastValue] exactly
         * while no layer is active, and is what the layers fold onto when one is.
         */
        var serverBase: WireValue = base

        /** The CDC high-watermark [lastValue] reflects, from the last cursor-stamped frame. */
        var serverCursor: Long? = null

        /** The DISPLAYED value: [serverBase] folded through [layers]. */
        var lastValue: WireValue = base

        /**
         * The active overlays, in application order. Empty for the common case —
         * no pending optimistic write — where this behaves exactly as a plain
         * server-value assignment.
         */
        val layers = mutableListOf<Layer>()

        /** Receive the displayed value. */
        val callbacks = mutableListOf<(WireValue) -> Unit>()
    }

    /**
     * Folds [base] through [layers] in order, returning the displayed value.
     *
     * A layer whose transform throws is SKIPPED rather than aborting the fold:
     * one buggy optimistic update must not blank the whole query for every other
     * layer. The mutation that registered it surfaces the failure itself.
     */
    fun fold(base: WireValue, layers: List<Layer>): WireValue {
        var value = base

        for (layer in layers) {
            value = try {
                layer.transform(value)
            } catch (error: RuntimeException) {
                value
            }
        }

        return value
    }

    /** Sets the displayed value and queues the subscription's handlers. */
    fun notifySubscription(state: State, value: WireValue, deferred: MutableList<() -> Unit>) {
        state.lastValue = value

        for (callback in state.callbacks.toList()) {
            deferred.add {
                try {
                    callback(value)
                } catch (error: RuntimeException) {
                    // A consumer's handler throwing is not this client's failure,
                    // and must not stop the remaining handlers from being told.
                }
            }
        }
    }

    /** Settles one layer: [confirm] on success, [rollback] on failure. */
    class Handle(private val state: State, private val layer: Layer) {
        /**
         * Gates the layer's removal on the server-confirmed cursor.
         *
         * A null cursor (CDC off on this shard, so nothing was echoed) drops the
         * layer immediately but does NOT re-fold: confirm runs on SUCCESS, so the
         * displayed value reflects a write that just committed, and re-folding
         * here would visibly revert it to the pre-write base until the
         * authoritative frame supersedes it. [rollback] is the path that re-folds.
         */
        fun confirm(commitCursor: Long?, deferred: MutableList<() -> Unit>) {
            if (commitCursor == null) {
                remove()

                return
            }

            layer.commitCursor = commitCursor

            // A confirming (or later) frame already advanced past the commit
            // cursor, so the write is in serverBase — drop the overlay now rather
            // than leaving it until the next frame.
            val reached = state.serverCursor

            if (reached != null && reached >= commitCursor && remove()) {
                refold(deferred)
            }
        }

        /** Removes the layer and re-folds, so the bad value disappears. */
        fun rollback(deferred: MutableList<() -> Unit>) {
            if (remove()) refold(deferred)
        }

        private fun remove(): Boolean = state.layers.removeAll { it.id == layer.id }

        private fun refold(deferred: MutableList<() -> Unit>) {
            notifySubscription(state, fold(state.serverBase, state.layers), deferred)
        }
    }

    /**
     * Layers one transform onto [state], returning its settle handle — or null,
     * leaving the state untouched, when the transform throws on the value it is
     * first handed: there is nothing to display and nothing to settle.
     */
    fun applyLayer(state: State, transform: (WireValue) -> WireValue, deferred: MutableList<() -> Unit>): Handle? {
        val predicted = try {
            // Same input as the reference client: the current DISPLAYED value,
            // i.e. serverBase already folded through any prior layers.
            transform(state.lastValue)
        } catch (error: RuntimeException) {
            return null
        }

        val layer = Layer(transform)

        state.layers.add(layer)
        notifySubscription(state, predicted, deferred)

        return Handle(state, layer)
    }

    /**
     * Drops every layer whose write has committed at or before [cursor],
     * reporting whether anything was removed.
     *
     * Called on each data/delta frame: a layer confirmed at a cursor the frame
     * has reached is now reflected in [State.serverBase], so keeping it would
     * double-count. Layers with no commit cursor yet (still queued or in flight)
     * are kept, so their overlay survives the frame.
     */
    fun dropConfirmedLayers(state: State, cursor: Long?): Boolean {
        if (cursor == null || state.layers.isEmpty()) return false

        return state.layers.removeAll { layer -> layer.commitCursor?.let { it <= cursor } == true }
    }

    /** Confirms every layer a write registered, against its committed cursor. */
    fun confirmAll(confirms: List<(Long?, MutableList<() -> Unit>) -> Unit>, commitCursor: Long?, deferred: MutableList<() -> Unit>) {
        for (confirm in confirms) confirm(commitCursor, deferred)
    }

    /**
     * Unwinds a write's layers, most-recent-first.
     *
     * LIFO, not FIFO: layers compose by fold order, so removing an earlier one
     * first would re-fold the later ones onto a base they never saw.
     */
    fun rollbackAll(rollbacks: List<(MutableList<() -> Unit>) -> Unit>, deferred: MutableList<() -> Unit>) {
        for (rollback in rollbacks.asReversed()) rollback(deferred)
    }

    /** A subscribed query's args paired with its displayed value. */
    data class QueryEntry(val args: WireValue, val value: WireValue)

    /**
     * A read/write handle over the client's live query cache, handed to a write's
     * `optimisticUpdate` so ONE mutation can patch MANY subscribed queries.
     *
     * Each [setQuery] registers a constant layer through the same engine the
     * single-query path uses, so the whole batch rebases onto incoming deltas and
     * settles together — confirmed on the mutation's commit cursor, or rolled
     * back on failure.
     */
    class LocalStore(
        private val find: (String, WireValue?) -> List<State>,
        private val matching: (String) -> List<QueryEntry>,
        private val deferred: MutableList<() -> Unit>,
    ) {
        /** The settle closures every [setQuery] produced, in application order. */
        val confirms = mutableListOf<(Long?, MutableList<() -> Unit>) -> Unit>()

        val rollbacks = mutableListOf<(MutableList<() -> Unit>) -> Unit>()

        /**
         * The current cached value for a subscribed query, or null when nothing is
         * subscribed for it. Reflects any override already written in this batch.
         */
        fun getQuery(functionPath: String, args: WireValue? = null): WireValue? = find(functionPath, args).firstOrNull()?.lastValue

        /**
         * Every loaded subscription on [functionPath] with the args it was
         * subscribed under — for a write that must patch every variant of a list
         * query without enumerating their args up front.
         */
        fun getAllQueries(functionPath: String): List<QueryEntry> = matching(functionPath)

        /**
         * Writes an optimistic override for a subscribed query. A no-op when
         * nothing is subscribed for it: you only patch queries the consumer is
         * watching.
         */
        fun setQuery(functionPath: String, args: WireValue?, value: WireValue) {
            for (state in find(functionPath, args)) {
                val handle = applyLayer(state, { value }, deferred) ?: continue

                confirms.add(handle::confirm)
                rollbacks.add(handle::rollback)
            }
        }
    }
}
