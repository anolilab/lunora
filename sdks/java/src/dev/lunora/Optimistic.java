package dev.lunora;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.UnaryOperator;

/**
 * The cursor-gated, rebaseable optimistic-update engine — a port of {@code
 * packages/client/src/optimistic-layers.ts}.
 *
 * <p>An optimistic transform is recorded as a LAYER on its subscription rather than written once
 * and forgotten, so the displayed value is always {@code serverBase} folded through the active
 * layers. Two things follow, and both are the reason for the design:
 *
 * <ol>
 *   <li>An incoming server frame re-folds the still-pending layers onto the new authoritative base
 *       ("rebasing") instead of clobbering them, so a queued offline write's predicted value
 *       survives an unrelated delta on the same query.
 *   <li>A layer is dropped the moment a frame whose {@code cursor} has reached the write's
 *       committed {@code commitCursor} arrives (its effect is now in the base), so the confirming
 *       frame cannot double-count it. The drop is keyed on the SERVER-confirmed cursor, never on
 *       RPC-response timing, which races the socket broadcast.
 * </ol>
 *
 * <p>Both optimistic APIs route through this one engine: the single-query per-call transform
 * registers a TRANSFORM layer (re-derived from the new base on every delta — true rebasing), and
 * the multi-query {@link LocalStore} registers a CONSTANT layer per {@code setQuery}. They compose
 * on a shared subscription by fold order, and a constant layer MASKS rather than merges — while
 * pending it re-clamps to its predicted value and hides a concurrent server change to that query,
 * which is the intended absolute-override semantics.
 *
 * <p><b>Callbacks are never invoked from here.</b> Every method that would notify takes a {@code
 * deferred} list and appends to it instead. The client mutates layer state inside the monitor that
 * guards its subscription registry, and running a consumer's callback in that critical section is
 * how the socket reader stalls behind a slow consumer — or deadlocks against a handler that
 * subscribes. The caller drains {@code deferred} once it has left the monitor, the same discipline
 * {@code Client.handleFrame} already uses.
 *
 * <p><b>Divergence from {@code @lunora/client}.</b> The TypeScript engine suppresses a notification
 * whose folded result is reference-identical to the value already displayed. Reference identity has
 * no portable meaning across the seven ports, so they notify on every fold instead — a consumer
 * sees at most a few redundant callbacks carrying the same value, never a missing one.
 */
public final class Optimistic {
    private Optimistic() {}

    /**
     * Derives the value to display from the value displayed now.
     *
     * <p>It is re-run on every rebase, so it must derive from its input rather than remember: a
     * transform that mutated the list it was handed would compound its own effect on each frame.
     */
    public interface Transform extends UnaryOperator<Object> {}

    private static int nextLayerId;

    /** Mints a layer id. Called only with the owning client's monitor held. */
    private static synchronized int mintLayerId() {
        return ++nextLayerId;
    }

    /** One active optimistic transform layered onto a subscription. */
    public static final class Layer {
        final int id;
        final Transform transform;

        /**
         * The CDC cursor the write committed at, from the mutation's response. Null while the write
         * is still queued or in flight, which is what keeps the overlay alive across unrelated
         * deltas until it is confirmed.
         */
        Long commitCursor;

        public Layer(Transform transform) {
            this.id = mintLayerId();
            this.transform = transform;
        }
    }

    /** The layered value a subscription displays. */
    public static final class State {
        /**
         * The authoritative value with NO overlay. It tracks {@link #lastValue} exactly while no
         * layer is active, and is what the layers fold onto when one is.
         */
        public Object serverBase;

        /**
         * The CDC high-watermark {@link #lastValue} reflects, from the last cursor-stamped frame.
         */
        public Long serverCursor;

        /** The DISPLAYED value: {@link #serverBase} folded through {@link #layers}. */
        public Object lastValue;

        /**
         * The active overlays, in application order. Empty for the common case — no pending
         * optimistic write — where this behaves exactly as a plain server-value assignment.
         */
        public final List<Layer> layers = new ArrayList<>();

        /** Receive the displayed value. */
        public final List<Consumer<Object>> callbacks = new ArrayList<>();

        public State(Object base) {
            this.serverBase = base;
            this.lastValue = base;
        }
    }

    /**
     * Folds {@code base} through {@code layers} in order, returning the displayed value.
     *
     * <p>A layer whose transform throws is SKIPPED rather than aborting the fold: one buggy
     * optimistic update must not blank the whole query for every other layer. The mutation that
     * registered it surfaces the failure itself.
     *
     * <p>{@code Exception}, not {@code RuntimeException}: {@link Transform} cannot DECLARE a
     * checked exception, but nothing stops one arriving through a wrapped call or a sneaky throw,
     * and one buggy layer aborting the fold is precisely the outcome this catch exists to prevent.
     * {@code Error} is deliberately not caught — a fold is not the place to swallow an OOM.
     */
    public static Object fold(Object base, List<Layer> layers) {
        Object value = base;

        for (Layer layer : layers) {
            try {
                value = layer.transform.apply(value);
            } catch (Exception ignored) {
                // A throwing layer is skipped, never fatal to the fold.
            }
        }

        return value;
    }

    /** Sets the displayed value and queues the subscription's handlers. */
    public static void notifySubscription(State state, Object value, List<Runnable> deferred) {
        state.lastValue = value;

        for (Consumer<Object> callback : List.copyOf(state.callbacks)) {
            deferred.add(
                    () -> {
                        try {
                            callback.accept(value);
                        } catch (RuntimeException ignored) {
                            // A consumer's handler throwing is not this client's failure, and must
                            // not stop the remaining handlers from being told.
                        }
                    });
        }
    }

    /** Settles one layer: {@link #confirm} on success, {@link #rollback} on failure. */
    public static final class Handle {
        private final State state;
        private final Layer layer;

        Handle(State state, Layer layer) {
            this.state = state;
            this.layer = layer;
        }

        /**
         * Gates the layer's removal on the server-confirmed cursor.
         *
         * <p>A null cursor (CDC off on this shard, so nothing was echoed) drops the layer
         * immediately but does NOT re-fold: confirm runs on SUCCESS, so the displayed value
         * reflects a write that just committed, and re-folding here would visibly revert it to the
         * pre-write base until the authoritative frame supersedes it. {@link #rollback} is the path
         * that re-folds.
         */
        public void confirm(Long commitCursor, List<Runnable> deferred) {
            if (commitCursor == null) {
                remove();

                return;
            }

            layer.commitCursor = commitCursor;

            // A confirming (or later) frame already advanced past the commit cursor, so the write
            // is in serverBase — drop the overlay now rather than leaving it until the next frame.
            if (state.serverCursor != null && state.serverCursor >= commitCursor && remove()) {
                refold(deferred);
            }
        }

        /** Removes the layer and re-folds, so the bad value disappears. */
        public void rollback(List<Runnable> deferred) {
            if (remove()) {
                refold(deferred);
            }
        }

        private boolean remove() {
            return state.layers.removeIf(entry -> entry.id == layer.id);
        }

        private void refold(List<Runnable> deferred) {
            notifySubscription(state, fold(state.serverBase, state.layers), deferred);
        }
    }

    /**
     * Installs a layer whose FIRST application has already been computed, and returns its settle
     * handle.
     *
     * <p>The split is the point: {@code transform} is a consumer's closure, and running it is the
     * caller's job — done with the client's monitor RELEASED, against a snapshot of the displayed
     * value. This method only installs the result, which is what the monitor is actually needed
     * for. A transform that threw on that first application never reaches here: there is nothing to
     * display and nothing to settle, so the caller drops it.
     *
     * <p>The transform is still STORED, not just its result, because a per-call optimistic layer
     * rebases — it is re-derived from each new authoritative base by {@link #fold}. That re-run
     * does happen under the monitor; it is inherent to rebasing and is why a transform must be
     * pure.
     */
    public static Handle installLayer(
            State state, Transform transform, Object predicted, List<Runnable> deferred) {
        Layer layer = new Layer(transform);

        state.layers.add(layer);
        notifySubscription(state, predicted, deferred);

        return new Handle(state, layer);
    }

    /**
     * Drops every layer whose write has committed at or before {@code cursor}, reporting whether
     * anything was removed.
     *
     * <p>Called on each data/delta frame: a layer confirmed at a cursor the frame has reached is
     * now reflected in {@code serverBase}, so keeping it would double-count. Layers with no commit
     * cursor yet (still queued or in flight) are kept, so their overlay survives the frame.
     */
    public static boolean dropConfirmedLayers(State state, Long cursor) {
        if (cursor == null || state.layers.isEmpty()) {
            return false;
        }

        return state.layers.removeIf(
                layer -> layer.commitCursor != null && layer.commitCursor <= cursor);
    }

    /** Confirms every layer a write registered, against its committed cursor. */
    public static void confirmAll(
            List<BiConsumer<Long, List<Runnable>>> confirms,
            Long commitCursor,
            List<Runnable> deferred) {
        for (BiConsumer<Long, List<Runnable>> confirm : confirms) {
            confirm.accept(commitCursor, deferred);
        }
    }

    /**
     * Unwinds a write's layers, most-recent-first.
     *
     * <p>LIFO, not FIFO: layers compose by fold order, so removing an earlier one first would
     * re-fold the later ones onto a base they never saw.
     */
    public static void rollbackAll(
            List<Consumer<List<Runnable>>> rollbacks, List<Runnable> deferred) {
        for (int index = rollbacks.size() - 1; index >= 0; index--) {
            rollbacks.get(index).accept(deferred);
        }
    }

    /** A subscribed query's args paired with its displayed value. */
    public record QueryEntry(Object args, Object value) {}

    /**
     * A read/write handle over the client's live query cache, handed to a write's {@code
     * optimisticUpdate} so ONE mutation can patch MANY subscribed queries.
     *
     * <p><b>A pure recorder.</b> {@link #setQuery} writes nothing — it appends an {@link Override},
     * and the caller installs the batch as constant layers afterwards. That is what lets the
     * consumer's update closure run with the client's monitor RELEASED while the install still
     * happens in ONE critical section together with the offline decision and the enqueue. Reads go
     * through the injected accessors, which take the monitor themselves for the instant they need
     * it.
     *
     * <p>Installed, each override behaves exactly as before: a constant layer through the same
     * engine the single-query path uses, so the whole batch rebases onto incoming deltas and
     * settles together — confirmed on the mutation's commit cursor, or rolled back on failure.
     */
    public static final class LocalStore {
        private final Function<QueryTarget, Object> read;
        private final Function<String, List<QueryEntry>> matching;

        /** The overrides {@link #setQuery} recorded, in the order they were written. */
        public final List<Override> overrides = new ArrayList<>();

        public LocalStore(
                Function<QueryTarget, Object> read, Function<String, List<QueryEntry>> matching) {
            this.read = read;
            this.matching = matching;
        }

        /** One subscribed query, as the store addresses it. */
        public record QueryTarget(String functionPath, Object args) {}

        /** One recorded {@link #setQuery}: the query it targets and the value to display for it. */
        public record Override(String functionPath, Object args, Object value) {}

        /**
         * The current cached value for a subscribed query, or null when nothing is subscribed for
         * it. Reflects any override already written in this batch — the last one wins, so a second
         * {@code setQuery} on the same target reads back as the second.
         */
        public Object getQuery(String functionPath, Object args) {
            String key = Key.stableWireKey(args);

            for (int index = overrides.size() - 1; index >= 0; index--) {
                Override override = overrides.get(index);

                if (override.functionPath().equals(functionPath)
                        && Key.stableWireKey(override.args()).equals(key)) {
                    return override.value();
                }
            }

            return read.apply(new QueryTarget(functionPath, args));
        }

        /**
         * Every loaded subscription on {@code functionPath} with the args it was subscribed under —
         * for a write that must patch every variant of a list query without enumerating their args
         * up front.
         */
        public List<QueryEntry> getAllQueries(String functionPath) {
            return matching.apply(functionPath);
        }

        /**
         * Records an optimistic override for a subscribed query. Installing it is a no-op when
         * nothing is subscribed for it: you only patch queries the consumer is watching.
         */
        public void setQuery(String functionPath, Object args, Object value) {
            overrides.add(new Override(functionPath, args, value));
        }
    }
}
