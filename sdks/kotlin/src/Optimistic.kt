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
 * **The write path is split in two for the same reason.** [record] runs the
 * consumer's transform against a [Slot] snapshot with NO lock held and returns a
 * [Pending]; [install] takes the monitor and adds the layer. Nothing the consumer
 * supplied runs inside the critical section. The one exception is [fold] on the
 * FRAME path, which re-runs a transform under the monitor deliberately: it
 * produces the value the frame delivers, and that needs a base nothing else is
 * mutating.
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
     *
     * [Exception], not [RuntimeException]: a transform is consumer code, Kotlin
     * has no checked exceptions to declare, and a Java-checked one thrown across
     * the boundary must be skipped exactly like any other — not abort the fold.
     */
    fun fold(base: WireValue, layers: List<Layer>): WireValue {
        var value = base

        for (layer in layers) {
            value = try {
                layer.transform(value)
            } catch (error: Exception) {
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
                } catch (error: Exception) {
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
     * One subscribed query as a WRITE's own code sees it.
     *
     * A snapshot, not a live view. [value] is read once under the client's
     * monitor; each override the batch records advances it, so a consumer's
     * transform and its `optimisticUpdate` see their own writes without reading
     * anything the client is concurrently mutating. That is what lets both run
     * with the monitor RELEASED — see [record] and [install].
     */
    class Slot(val state: State, val functionPath: String, val args: WireValue, val argsKey: String, val shardKey: String?, var value: WireValue)

    /** A layer recorded outside the client's monitor, ready to install under it. */
    class Pending(val state: State, val transform: (WireValue) -> WireValue, val predicted: WireValue)

    /**
     * Runs [transform] against [slot]'s snapshot and records what it would
     * display — or null, leaving the slot untouched, when it throws on the value
     * it is first handed: there is nothing to display and nothing to settle.
     *
     * NO LOCK IS HELD HERE, which is the whole point: [transform] is the
     * consumer's own code and may re-enter the client it was handed.
     */
    fun record(slot: Slot, transform: (WireValue) -> WireValue): Pending? {
        val predicted = try {
            // Same input as the reference client: the current DISPLAYED value,
            // i.e. serverBase already folded through any prior layers.
            transform(slot.value)
        } catch (error: Exception) {
            return null
        }

        slot.value = predicted

        return Pending(slot.state, transform, predicted)
    }

    /**
     * Installs a recorded layer and queues its notification, returning the settle
     * handle. Runs with the client's monitor held, and invokes nothing the
     * consumer supplied.
     *
     * The value displayed is the one [record] predicted, against the snapshot it
     * ran on. A frame landing in the window between the two is NOT folded in
     * here: re-folding means re-running the consumer's transform, which is
     * exactly what this split exists to keep out of the critical section. The
     * next frame rebases the layer and the display catches up — the same
     * mechanism that reconciles every other overlay.
     */
    fun install(pending: Pending, deferred: MutableList<() -> Unit>): Handle {
        val layer = Layer(pending.transform)

        pending.state.layers.add(layer)
        notifySubscription(pending.state, pending.predicted, deferred)

        return Handle(pending.state, layer)
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
    fun confirmAll(handles: List<Handle>, commitCursor: Long?, deferred: MutableList<() -> Unit>) {
        for (handle in handles) handle.confirm(commitCursor, deferred)
    }

    /**
     * Unwinds a write's layers, most-recent-first.
     *
     * LIFO, not FIFO: layers compose by fold order, so removing an earlier one
     * first would re-fold the later ones onto a base they never saw.
     */
    fun rollbackAll(handles: List<Handle>, deferred: MutableList<() -> Unit>) {
        for (handle in handles.asReversed()) handle.rollback(deferred)
    }

    /** A subscribed query's args paired with its displayed value. */
    data class QueryEntry(val args: WireValue, val value: WireValue)

    /**
     * A read/write handle over the client's query cache, handed to a write's
     * `optimisticUpdate` so ONE mutation can patch MANY subscribed queries.
     *
     * A pure RECORDER over a [Slot] snapshot: it reads and writes nothing live,
     * so the consumer's update runs with the client's monitor released. Each
     * [setQuery] records a constant layer through the same engine the
     * single-query path uses; the client installs the batch under the monitor
     * afterwards, so the whole set rebases onto incoming deltas and settles
     * together — confirmed on the mutation's commit cursor, or rolled back on
     * failure.
     */
    class LocalStore(private val find: (String, WireValue?) -> List<Slot>, private val matching: (String) -> List<Slot>) {
        /** The layers this batch recorded, in application order. */
        val recorded = mutableListOf<Pending>()

        /**
         * The current cached value for a subscribed query, or null when nothing is
         * subscribed for it. Reflects any override already written in this batch.
         */
        fun getQuery(functionPath: String, args: WireValue? = null): WireValue? = find(functionPath, args).firstOrNull()?.value

        /**
         * Every loaded subscription on [functionPath] with the args it was
         * subscribed under — for a write that must patch every variant of a list
         * query without enumerating their args up front.
         */
        fun getAllQueries(functionPath: String): List<QueryEntry> = matching(functionPath).map { QueryEntry(it.args, it.value) }

        /**
         * Writes an optimistic override for a subscribed query. A no-op when
         * nothing is subscribed for it: you only patch queries the consumer is
         * watching.
         */
        fun setQuery(functionPath: String, args: WireValue?, value: WireValue) {
            for (slot in find(functionPath, args)) record(slot) { value }?.let { recorded.add(it) }
        }
    }
}
