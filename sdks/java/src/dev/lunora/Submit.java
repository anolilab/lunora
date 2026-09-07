package dev.lunora;

import dev.lunora.Client.ApiException;
import dev.lunora.Client.RpcReply;
import dev.lunora.Offline.Identity;
import dev.lunora.Offline.OfflineException;
import dev.lunora.Offline.OfflineQueue;
import dev.lunora.Offline.QueuedMutation;
import dev.lunora.Optimistic.LocalStore;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * The offline-capable write path, and the value types it exchanges with a consumer.
 *
 * <p>It lives beside {@link Client} rather than inside it — matching the Go and Rust ports' {@code
 * submit} modules — because the write path is a self-contained feature (queue, replay, optimistic
 * settling) bolted onto a client whose other job is the wire protocol. Everything here is static
 * and takes the owning client explicitly, so there is one client object and one monitor, not two.
 *
 * <p><b>Locking.</b> {@code Client.lock} guards the subscription registry AND the queue — the queue
 * is deliberately not internally locked (see {@link OfflineQueue}), because two locks over one
 * logical operation is how a deadlock gets built. Every queue mutation below therefore happens
 * inside {@code synchronized (client.lock)}. What must stay OUTSIDE it: the consumer's {@code
 * precondition} predicate, every settle (a rejection rolls optimistic layers back and notifies
 * listeners), and the network round trip in a replay. {@code synchronized} is reentrant so taking
 * the monitor costs nothing here — but that reentrancy is exactly why it would silently run a
 * consumer's callback inside the critical section if we did not keep them out by hand.
 */
public final class Submit {
    private Submit() {}

    /** What {@link Client#submit} did with a write. */
    public enum MutationStatus {
        /** The write went out and the server answered. */
        COMMITTED,
        /** The socket was down and the write was enqueued for replay. */
        QUEUED,
        /** A settled verdict, never a submit outcome. */
        REJECTED
    }

    /**
     * What {@link Client#submit} did with a write.
     *
     * <p>This is the deliberate divergence from {@code @lunora/client}, whose {@code mutation()}
     * returns a promise that stays PENDING until a queued write finally replays. A pending promise
     * is a fine thing to hold in a browser event loop and a bad thing to hold on a pooled JVM
     * thread, so the ports return the outcome immediately and report the eventual verdict through
     * {@code onSettled} (per write) or {@link Client#onMutationSettled} (per client). A caller that
     * must not report success early checks {@code status}.
     */
    public record MutationOutcome(
            MutationStatus status, String mutationId, Object value, Long commitCursor) {}

    /**
     * The terminal verdict on a queued write, once it replays.
     *
     * <p>{@code hadAwaiter} is false for a write restored from durable storage: the caller that
     * submitted it is gone, so this event is the ONLY report it produces. It is read from the
     * entry's own {@code liveAwaiter} field at the settle site rather than restated here, so the
     * two cannot desync.
     */
    public record MutationSettled(
            String mutationId,
            MutationStatus status,
            Object value,
            RuntimeException error,
            boolean hadAwaiter) {}

    /** What one {@link Client#flushOfflineQueue} pass achieved. */
    public static final class FlushReport {
        /** The ids the server accepted. */
        public final List<String> committed = new ArrayList<>();

        /** The ids dropped on a verdict, an identity change, or a stale precondition. */
        public final List<String> rejected = new ArrayList<>();

        /** The ids left queued for the next reconnect. */
        public final List<String> requeued = new ArrayList<>();

        /** The ids dropped because their precondition no longer held. */
        public final List<String> conflicted = new ArrayList<>();

        /**
         * Milliseconds the server asked the caller to wait before flushing again, when a replay
         * came back rate-limited. Null otherwise.
         *
         * <p>The client enforces it too — a flush inside the window is a no-op — so this is for a
         * caller that schedules its own retry.
         */
        public Long retryAfterMs;
    }

    /** One offline-capable write. */
    public static final class SubmitOptions {
        public final String functionPath;
        public final Object args;

        /** Null routes to the default shard. */
        public String shardKey;

        /** The idempotency key; minted when null. */
        public String mutationId;

        /**
         * The single-query shortcut: the transform is layered onto every subscription registered
         * under the SAME (functionPath, args, shardKey) as this write, mirroring {@code
         * @lunora/client}'s per-call {@code optimistic}.
         */
        public Optimistic.Transform optimistic;

        /**
         * The general form — it receives a {@link LocalStore} and may patch any number of
         * subscribed queries. Both settle together, against the same commit cursor.
         */
        public BiConsumer<LocalStore, Object> optimisticUpdate;

        /**
         * Re-evaluated just before a QUEUED write replays; false drops it rather than replaying a
         * write that can only fail. Called with the client's monitor RELEASED, so it may read the
         * client it was handed.
         */
        public Supplier<Boolean> precondition;

        /** Reports the eventual verdict on a queued write. */
        public Consumer<MutationSettled> onSettled;

        public SubmitOptions(String functionPath, Object args) {
            this.functionPath = functionPath;
            this.args = args;
        }

        public SubmitOptions shardKey(String shardKey) {
            this.shardKey = shardKey;

            return this;
        }

        public SubmitOptions optimistic(Optimistic.Transform optimistic) {
            this.optimistic = optimistic;

            return this;
        }

        public SubmitOptions optimisticUpdate(BiConsumer<LocalStore, Object> optimisticUpdate) {
            this.optimisticUpdate = optimisticUpdate;

            return this;
        }

        public SubmitOptions precondition(Supplier<Boolean> precondition) {
            this.precondition = precondition;

            return this;
        }

        public SubmitOptions onSettled(Consumer<MutationSettled> onSettled) {
            this.onSettled = onSettled;

            return this;
        }
    }

    /** One optimistic override: the layer to install, and the value its first application gave. */
    private record PendingLayer(
            Optimistic.State state, Optimistic.Transform transform, Object predicted) {}

    /** See {@link Client#submit}. */
    static MutationOutcome submit(Client client, SubmitOptions options) {
        List<BiConsumer<Long, List<Runnable>>> confirms = new ArrayList<>();
        List<Consumer<List<Runnable>>> rollbacks = new ArrayList<>();
        boolean queueIt;
        List<Offline.Discarded> evicted = List.of();
        List<Runnable> deferred = new ArrayList<>();
        String writeId = options.mutationId != null ? options.mutationId : Offline.randomId();

        // The consumer's optimistic code runs HERE, with no monitor held. `sdks/README.md`
        // guarantees no callback a consumer supplies ever runs inside the client's critical
        // section, and this is the one that used to: `synchronized` is reentrant so it could never
        // deadlock, which is exactly why the violation was invisible.
        List<PendingLayer> pending = recordOptimistic(client, options);

        // ONE critical section for the install, the offline decision AND the enqueue. Split across
        // two, the socket can attach and a flush run to completion in the gap — and the write lands
        // in a queue nothing will drain until the NEXT disconnect, after submit already answered
        // "queued". Safe to enqueue under the monitor because `enqueue` invokes no callback: it
        // returns what the cap evicted, and those settle below, outside.
        synchronized (client.lock) {
            if (client.closed) {
                throw new OfflineException(Offline.CLIENT_CLOSED, "client is closed");
            }

            for (PendingLayer layer : pending) {
                Optimistic.Handle handle =
                        Optimistic.installLayer(
                                layer.state(), layer.transform(), layer.predicted(), deferred);

                confirms.add(handle::confirm);
                rollbacks.add(handle::rollback);
            }

            queueIt =
                    client.sender == null
                            && (client.wasEverConnected
                                    || client.offlineQueue.queueBeforeFirstConnect);

            if (queueIt) {
                evicted = enqueueWrite(client, options, writeId, confirms, rollbacks);
            }
        }

        Client.runDeferred(deferred);

        if (queueIt) {
            reportDiscarded(client, evicted);

            return new MutationOutcome(MutationStatus.QUEUED, writeId, null, null);
        }

        RpcReply reply;

        try {
            reply =
                    client.rpcFull(
                            options.functionPath, options.args, options.shardKey, writeId, null);
        } catch (RuntimeException error) {
            settleLayers(client, List.of(), rollbacks, null);

            throw error;
        }

        // Confirmed against the write's COMMITTED cursor, so the overlay drops when (or once) a
        // frame at that cursor lands — never on this call's return, which races the broadcast.
        settleLayers(client, confirms, List.of(), reply.commitCursor());

        return new MutationOutcome(
                MutationStatus.COMMITTED, writeId, reply.result(), reply.commitCursor());
    }

    /** See {@link Client#hydrateOfflineQueue}. */
    static List<String> hydrate(Client client) {
        OfflineQueue.Hydrated hydrated;

        synchronized (client.lock) {
            hydrated = client.offlineQueue.hydrate();
        }

        // A restored record the cap dropped has no per-entry handler AND no live caller, so the
        // client-level emission inside `settleRejected` is its only report. Without it the durable
        // write is un-persisted here and vanishes in total silence.
        reportDiscarded(client, hydrated.evicted());

        return hydrated.shardKeys();
    }

    /** See {@link Client#flushOfflineQueue}. */
    static FlushReport flush(Client client, String shardKey) {
        FlushReport report = new FlushReport();
        OfflineQueue queue;
        String current;
        List<QueuedMutation> snapshot;

        synchronized (client.lock) {
            // A server that answered "not now" gets waited out. Without this the caller's own
            // reconnect loop replays the identical burst immediately and earns the same 429,
            // indefinitely.
            long remaining = client.flushNotBefore - System.nanoTime();

            if (remaining > 0) {
                report.retryAfterMs = remaining / 1_000_000L + 1;

                return report;
            }

            queue = client.offlineQueue;
            current = client.identity;
            snapshot = queue.items();
        }

        dropStalePreconditions(client, queue, snapshot, report);

        List<QueuedMutation> drained;

        // A null shard key and an empty one are the SAME shard: a write submitted with `""` must
        // drain on the default shard's flush, not wait forever for a flush of a shard named "".
        synchronized (client.lock) {
            drained = queue.drain(item -> Offline.sameShard(shardKey, item.shardKey));
        }

        if (drained.isEmpty()) {
            return report;
        }

        // Gated against ONE identity snapshot: a flush is a single authenticated burst, so every
        // write in it necessarily runs under one identity.
        List<QueuedMutation> sendable = new ArrayList<>();
        List<Offline.Discarded> mismatched = new ArrayList<>();

        for (QueuedMutation item : drained) {
            if (Offline.identityAllowsReplay(item.identity, current)) {
                sendable.add(item);

                continue;
            }

            mismatched.add(
                    new Offline.Discarded(
                            item,
                            Offline.OFFLINE_IDENTITY_CHANGED,
                            "offline mutation skipped: auth identity changed before replay"));
        }

        settleTerminal(client, queue, mismatched, report);
        replay(client, queue, encodableOrSettleTerminal(client, queue, sendable, report), report);

        return report;
    }

    /**
     * Drops the writes whose precondition no longer holds, before anything replays.
     *
     * <p>The predicate is the CONSUMER's, so it is evaluated on a snapshot with the monitor
     * released and the failures are dropped by id under it afterwards. Running it inside would put
     * arbitrary consumer code — which may well call back into this client — in the critical section
     * that guards the subscription registry.
     */
    private static void dropStalePreconditions(
            Client client, OfflineQueue queue, List<QueuedMutation> snapshot, FlushReport report) {
        Set<String> stale = new HashSet<>();

        for (QueuedMutation item : snapshot) {
            if (item.precondition != null && !item.precondition.get()) {
                stale.add(item.id);
            }
        }

        if (stale.isEmpty()) {
            return;
        }

        List<Offline.Discarded> conflicted = new ArrayList<>();

        synchronized (client.lock) {
            for (QueuedMutation item : queue.drain(item -> stale.contains(item.id))) {
                conflicted.add(
                        new Offline.Discarded(
                                item,
                                Offline.OFFLINE_PRECONDITION_FAILED,
                                "offline mutation skipped: precondition failed before replay"));
            }
        }

        for (Offline.Discarded discarded : conflicted) {
            report.conflicted.add(discarded.entry().id);
        }

        settleTerminal(client, queue, conflicted, report);
    }

    /**
     * Partitions the writes that can be wire-encoded from the ones that cannot, settling the latter
     * TERMINALLY.
     *
     * <p>Before the replay loop, deliberately. A codec failure carries no server code, so letting
     * one surface mid-replay classifies it transient, re-queues it at the FRONT, and retries it on
     * every reconnect forever — never settling its caller, never rolling its overlay back, and
     * blocking every write behind it in the FIFO. The failure is deterministic: the same args
     * encode identically next time. Encoding is cheap and the flush is the slow reconnect path.
     */
    private static List<QueuedMutation> encodableOrSettleTerminal(
            Client client, OfflineQueue queue, List<QueuedMutation> items, FlushReport report) {
        List<QueuedMutation> encodable = new ArrayList<>();
        List<Offline.Discarded> unencodable = new ArrayList<>();

        for (QueuedMutation item : items) {
            try {
                Wire.encode(item.args);
                encodable.add(item);
            } catch (RuntimeException error) {
                unencodable.add(
                        new Offline.Discarded(
                                item,
                                Offline.OFFLINE_WRITE_UNENCODABLE,
                                "offline mutation dropped: " + error.getMessage()));
            }
        }

        settleTerminal(client, queue, unencodable, report);

        return encodable;
    }

    /** Un-persists a batch of drained writes and settles each as a rejection. */
    private static void settleTerminal(
            Client client,
            OfflineQueue queue,
            List<Offline.Discarded> discarded,
            FlushReport report) {
        if (discarded.isEmpty()) {
            return;
        }

        synchronized (client.lock) {
            for (Offline.Discarded item : discarded) {
                queue.unpersist(item.entry().id);
            }
        }

        for (Offline.Discarded item : discarded) {
            report.rejected.add(item.entry().id);
        }

        reportDiscarded(client, discarded);
    }

    private static void replay(
            Client client, OfflineQueue queue, List<QueuedMutation> sendable, FlushReport report) {
        // A lone write rides the single-call path, which is the proven one. Two or more coalesce
        // into batch round trips — the flaky-reconnect win, where N queued writes cost a handful
        // of hops instead of N.
        if (sendable.size() < 2) {
            replaySequential(client, queue, sendable, report);

            return;
        }

        List<QueuedMutation> toRequeue = new ArrayList<>();
        List<List<QueuedMutation>> chunks = chunkBatches(sendable);

        for (int index = 0; index < chunks.size(); index++) {
            // Chunks replay sequentially, which is what preserves FIFO across a flush longer than
            // one batch.
            BatchOutcome outcome = replayBatched(client, queue, chunks.get(index), report);

            toRequeue.addAll(outcome.requeue());

            if (outcome.stop()) {
                // A whole-chunk transport failure. Leave every write not yet sent queued, in
                // order, rather than sending on into a connection that just failed.
                for (List<QueuedMutation> later : chunks.subList(index + 1, chunks.size())) {
                    toRequeue.addAll(later);
                }

                break;
            }
        }

        if (toRequeue.isEmpty()) {
            return;
        }

        synchronized (client.lock) {
            queue.requeue(toRequeue);
        }

        for (QueuedMutation entry : toRequeue) {
            report.requeued.add(entry.id);
        }
    }

    /** What one batch chunk left for the caller: the writes to re-queue, and whether to stop. */
    private record BatchOutcome(List<QueuedMutation> requeue, boolean stop) {}

    /**
     * A batch entry's contribution to the request body, in bytes.
     *
     * <p>The args dominate and are the only part that can be large; the constant covers the entry's
     * fixed keys and the comma joining it to the next one. Encoding twice (here and in {@link
     * #replayBatched}) is deliberate — the flush is the slow path, and carrying the encoded form
     * through the chunker would put a second representation of every queued write in memory.
     */
    private static int entryBytes(QueuedMutation item) {
        String encoded =
                Json.write(Wire.encode(item.args != null ? item.args : new LinkedHashMap<>()));

        return encoded.getBytes(StandardCharsets.UTF_8).length
                + item.functionPath.length()
                + item.id.length()
                + 160;
    }

    /**
     * Splits a flush into batch bodies the worker will accept.
     *
     * <p>By BYTES as well as by count: the worker reads a batch body under a 1 MiB budget and
     * answers {@code 413 PAYLOAD_TOO_LARGE} past it, so 500 writes carrying bytes or long text are
     * one request the server refuses whole. A single write over the budget still forms its own
     * chunk — splitting cannot help it, and {@link #replayBatched} settles it on the answer.
     */
    private static List<List<QueuedMutation>> chunkBatches(List<QueuedMutation> items) {
        List<List<QueuedMutation>> chunks = new ArrayList<>();
        List<QueuedMutation> current = new ArrayList<>();
        long size = 0;

        for (QueuedMutation item : items) {
            int cost = entryBytes(item);

            if (!current.isEmpty()
                    && (current.size() >= Offline.MAX_BATCH_ENTRIES
                            || size + cost > Offline.MAX_BATCH_BYTES)) {
                chunks.add(current);
                current = new ArrayList<>();
                size = 0;
            }

            current.add(item);
            size += cost;
        }

        if (!current.isEmpty()) {
            chunks.add(current);
        }

        return chunks;
    }

    /** Records a rate limit's delay, and holds the next flush off until it passes. */
    private static void noteRetryAfter(Client client, FlushReport report, RuntimeException error) {
        Long delay = retryAfterMs(error);

        if (delay == null) {
            return;
        }

        report.retryAfterMs = delay;

        synchronized (client.lock) {
            long until = System.nanoTime() + delay * 1_000_000L;

            if (until - client.flushNotBefore > 0) {
                client.flushNotBefore = until;
            }
        }
    }

    /**
     * How long a rate-limited replay asks to wait, if the envelope said.
     *
     * <p>Null when the server named no delay — the caller then decides its own backoff rather than
     * hammering, which is what {@link FlushReport#retryAfterMs} reports.
     *
     * <p>Clamped at {@link Offline#MAX_RETRY_AFTER_MS}. The hint is a number this client did not
     * write, so an absurd one must not be able to park a durable queue indefinitely.
     *
     * <p>Only the envelope's {@code data.retryAfterMs} is read. {@code protocol/README.md} §4.3
     * allows the {@code Retry-After} HEADER as the alternative hint, and this port cannot honour
     * that half: {@link Client.HttpPoster} surfaces {@code (status, body)} only, and widening it
     * would change the contract every consumer implements for one optional hint the RPC plane
     * already carries in the envelope.
     */
    static Long retryAfterMs(RuntimeException error) {
        if (!(error instanceof ApiException api)
                || !Offline.RATE_LIMIT_ERROR_CODES.contains(api.code)
                || !(api.data instanceof Map<?, ?> data)) {
            return null;
        }

        return data.get("retryAfterMs") instanceof Number delay && delay.longValue() > 0
                ? Math.min(delay.longValue(), Offline.MAX_RETRY_AFTER_MS)
                : null;
    }

    /** Replays writes one at a time. FIFO is preserved by the loop itself. */
    private static void replaySequential(
            Client client, OfflineQueue queue, List<QueuedMutation> sendable, FlushReport report) {
        for (int index = 0; index < sendable.size(); index++) {
            QueuedMutation item = sendable.get(index);
            RpcReply reply;

            try {
                reply =
                        client.rpcFull(
                                item.functionPath,
                                item.args,
                                item.shardKey,
                                item.id,
                                item.clientId);
            } catch (RuntimeException error) {
                if (!isTransient(error)) {
                    synchronized (client.lock) {
                        queue.unpersist(item.id);
                    }

                    settleRejected(client, item, error);
                    report.rejected.add(item.id);

                    continue;
                }

                noteRetryAfter(client, report, error);

                // Nothing after this write may go out ahead of it: replaying out of order is how a
                // durable queue corrupts the data it was protecting.
                List<QueuedMutation> pending =
                        new ArrayList<>(sendable.subList(index, sendable.size()));

                synchronized (client.lock) {
                    queue.requeue(pending);
                }

                for (QueuedMutation entry : pending) {
                    report.requeued.add(entry.id);
                }

                return;
            }

            synchronized (client.lock) {
                queue.unpersist(item.id);
            }

            settleCommitted(client, item, reply.result(), reply.commitCursor());
            report.committed.add(item.id);
        }
    }

    /**
     * Replays one chunk over {@code POST /_lunora/rpc-batch}.
     *
     * <p>The worker forwards the entries to their shard, which dispatches each through its ordinary
     * single-call path — so per-entry {@code mutationId} idempotency and in-order application are
     * inherited from the proven route rather than re-implemented here.
     *
     * <p>Returns the writes to put back and whether the caller should STOP because the whole chunk
     * failed at the transport level. Re-queuing is the caller's, once and in order, so a write
     * cannot land twice in the queue.
     */
    private static BatchOutcome replayBatched(
            Client client, OfflineQueue queue, List<QueuedMutation> items, FlushReport report) {
        List<Object> calls = new ArrayList<>();

        for (int index = 0; index < items.size(); index++) {
            QueuedMutation item = items.get(index);
            Map<String, Object> call = new LinkedHashMap<>();

            call.put("args", Wire.encode(item.args != null ? item.args : new LinkedHashMap<>()));
            call.put("functionPath", item.functionPath);
            // The slot this entry's result comes back in.
            call.put("id", index);
            // The same stable key the single-call replay sends, beside the id that namespaces its
            // de-duplication row for an anonymous caller. Per ENTRY, not on the outer request: a
            // batch is one hop, but its entries are dispatched as independent single calls.
            call.put("mutationId", item.id);
            call.put("clientId", item.clientId != null ? item.clientId : client.clientId);

            if (item.shardKey != null && !item.shardKey.isEmpty()) {
                call.put("shardKey", item.shardKey);
            }

            calls.add(call);
        }

        Map<String, Object> body;

        try {
            body = client.rpcBatch(calls);
        } catch (RuntimeException error) {
            // Transport failure — nothing committed, so retry everything.
            return new BatchOutcome(new ArrayList<>(items), true);
        }

        if (body.get("results") instanceof List<?> results) {
            return new BatchOutcome(settleBatchSlots(client, queue, items, results, report), false);
        }

        // No per-slot results. A coded envelope is a verdict on the WHOLE batch — a bad request,
        // an authorization denial — and therefore terminal for every entry; anything else is
        // transport, and transient.
        if (!(body.get("error") instanceof Map<?, ?> envelope)) {
            return new BatchOutcome(new ArrayList<>(items), true);
        }

        ApiException error = batchSlotError(envelope, "batch rejected");

        // The body was too big, not wrong — every entry in it would have committed alone. Halve and
        // retry; the estimate the chunker used cannot see the framing the worker actually measured,
        // and only the answer can.
        if (Offline.PAYLOAD_TOO_LARGE.equals(error.code) && items.size() > 1) {
            int middle = items.size() / 2;
            BatchOutcome left = replayBatched(client, queue, items.subList(0, middle), report);

            if (left.stop()) {
                List<QueuedMutation> requeue = new ArrayList<>(left.requeue());

                requeue.addAll(items.subList(middle, items.size()));

                return new BatchOutcome(requeue, true);
            }

            BatchOutcome right =
                    replayBatched(client, queue, items.subList(middle, items.size()), report);
            List<QueuedMutation> requeue = new ArrayList<>(left.requeue());

            requeue.addAll(right.requeue());

            return new BatchOutcome(requeue, right.stop());
        }

        // A shard blip or a rate limit is not a verdict on the batch's contents. Requeue it whole
        // and stop the flush, exactly as the single-call path does for the same codes.
        if (isTransient(error)) {
            noteRetryAfter(client, report, error);

            return new BatchOutcome(new ArrayList<>(items), true);
        }

        for (QueuedMutation item : items) {
            synchronized (client.lock) {
                queue.unpersist(item.id);
            }

            settleRejected(client, item, error);
            report.rejected.add(item.id);
        }

        return new BatchOutcome(new ArrayList<>(), false);
    }

    /**
     * Demuxes a batch reply back onto the writes it replayed, in input order, classifying each slot
     * exactly as {@link #replaySequential} classifies a whole response.
     *
     * @return the writes the caller must re-queue
     */
    private static List<QueuedMutation> settleBatchSlots(
            Client client,
            OfflineQueue queue,
            List<QueuedMutation> items,
            List<?> results,
            FlushReport report) {
        Map<Integer, Map<?, ?>> bySlot = new LinkedHashMap<>();

        for (Object raw : results) {
            if (raw instanceof Map<?, ?> entry
                    && entry.get("id") instanceof Number id
                    && entry.get("body") instanceof Map<?, ?> slot) {
                bySlot.put(id.intValue(), slot);
            }
        }

        List<QueuedMutation> requeue = new ArrayList<>();

        for (int index = 0; index < items.size(); index++) {
            QueuedMutation item = items.get(index);
            Map<?, ?> slot = bySlot.get(index);

            if (slot == null) {
                // The server never returned this slot. It may or may not have committed, so retry
                // it — the `mutationId` makes that safe.
                requeue.add(item);

                continue;
            }

            if (slot.get("error") instanceof Map<?, ?> envelope) {
                ApiException error = batchSlotError(envelope, "request failed");

                // Classified by the SAME predicate the whole-batch and single-call paths use, not
                // by a second code set: a slot's body is exactly a §4.2 envelope, so a shard blip
                // or a limiter refusing to look means the server reached no verdict on that entry
                // and the write goes back on the queue rather than being reported as failed. Two
                // code sets is how one of them silently falls behind the other.
                if (isTransient(error)) {
                    noteRetryAfter(client, report, error);
                    requeue.add(item);

                    continue;
                }

                synchronized (client.lock) {
                    queue.unpersist(item.id);
                }

                settleRejected(client, item, error);
                report.rejected.add(item.id);

                continue;
            }

            Long cursor =
                    slot.get("commitCursor") instanceof Number number ? number.longValue() : null;

            synchronized (client.lock) {
                queue.unpersist(item.id);
            }

            settleCommitted(client, item, Wire.decode(slot.get("result")), cursor);
            report.committed.add(item.id);
        }

        return requeue;
    }

    /**
     * Rebuilds an {@link ApiException} from a slot's or a batch's error envelope, defaulting the
     * way {@code parseRpcResponse} does.
     */
    private static ApiException batchSlotError(Map<?, ?> envelope, String fallback) {
        return new ApiException(
                envelope.get("code") instanceof String code ? code : "INTERNAL",
                envelope.get("message") instanceof String message ? message : fallback,
                envelope.get("data") == null ? null : Wire.decode(envelope.get("data")),
                // The HTTP status is not in scope on the batch path — `rpcBatch` returns the parsed
                // body only — so a batch envelope is classified by its CODE alone. That is enough:
                // an envelope-less non-2xx never reaches here (it parses to no `results` and no
                // `error`, which the caller already treats as transport).
                false);
    }

    /**
     * Whether a failed replay may be retried rather than dropped.
     *
     * <p>A raw exception from the injected poster is the network, not the server: no verdict was
     * reached, so the write is still good. A codec failure is the opposite — deterministic, so
     * retrying it re-runs the same encode and fails identically, forever.
     */
    static boolean isTransient(RuntimeException error) {
        if (error instanceof ApiException api) {
            return api.transientFailure
                    || Offline.TRANSIENT_ERROR_CODES.contains(api.code)
                    || Offline.RATE_LIMIT_ERROR_CODES.contains(api.code);
        }

        return !(error instanceof OfflineException) && !(error instanceof Wire.WireFormatException);
    }

    /**
     * Runs both optimistic APIs' consumer code and returns the layers to install — with NO monitor
     * held.
     *
     * <p>The transform is applied, and the multi-query update is run, against a snapshot of what
     * each matching subscription currently displays. Only the RESULT crosses into the critical
     * section, so a callback that reaches back into the client it was handed — {@code
     * pendingMutationCount()}, {@code online()}, another {@code submit} — is running against a
     * client that holds nothing.
     */
    private static List<PendingLayer> recordOptimistic(Client client, SubmitOptions options) {
        List<PendingLayer> pending = new ArrayList<>();

        if (options.optimistic != null) {
            for (Client.StateSnapshot target :
                    client.snapshotStates(options.functionPath, options.args, options.shardKey)) {
                Object predicted;

                try {
                    // Same input as the reference client: the current DISPLAYED value, i.e.
                    // serverBase already folded through any prior layers.
                    predicted = options.optimistic.apply(target.value());
                } catch (Exception ignored) {
                    // Nothing to display and nothing to settle, so no layer is installed.
                    continue;
                }

                pending.add(new PendingLayer(target.state(), options.optimistic, predicted));
            }
        }

        if (options.optimisticUpdate == null) {
            return pending;
        }

        LocalStore store =
                new LocalStore(
                        target -> {
                            List<Client.StateSnapshot> matches =
                                    client.snapshotStates(
                                            target.functionPath(), target.args(), options.shardKey);

                            return matches.isEmpty() ? null : matches.get(0).value();
                        },
                        path -> client.matchingQueries(path, options.shardKey));

        try {
            options.optimisticUpdate.accept(store, options.args);
        } catch (RuntimeException ignored) {
            // A throwing update contributes nothing: recording installs no layer, so there is
            // nothing to unwind and the cache is left exactly as it was found. The write proceeds.
            return pending;
        }

        for (LocalStore.Override override : store.overrides) {
            for (Client.StateSnapshot target :
                    client.snapshotStates(
                            override.functionPath(), override.args(), options.shardKey)) {
                // A CONSTANT layer: while pending it re-clamps to the predicted value on every
                // frame, masking a concurrent server change rather than merging with it.
                pending.add(
                        new PendingLayer(
                                target.state(), current -> override.value(), override.value()));
            }
        }

        return pending;
    }

    /**
     * Builds one queued write. Runs with the client's monitor held; returns what the cap evicted.
     */
    private static List<Offline.Discarded> enqueueWrite(
            Client client,
            SubmitOptions options,
            String writeId,
            List<BiConsumer<Long, List<Runnable>>> confirms,
            List<Consumer<List<Runnable>>> rollbacks) {
        QueuedMutation entry =
                new QueuedMutation(options.functionPath, options.args, options.shardKey, writeId);

        // The client id that ISSUED the write, so a replay namespaces server-side under it rather
        // than whatever a later session minted.
        entry.clientId = client.clientId;
        // Bound at enqueue time, so the write can only ever replay as whoever made it.
        entry.identity =
                client.identity == null ? Identity.signedOut() : Identity.of(client.identity);
        entry.liveAwaiter = true;
        entry.precondition = options.precondition;
        entry.onSettled = options.onSettled;
        entry.onCommit = cursor -> settleLayers(client, confirms, List.of(), cursor);
        entry.reject = error -> settleLayers(client, List.of(), rollbacks, null);

        return client.offlineQueue.enqueue(entry);
    }

    /**
     * Settles every write the queue let go of without sending it.
     *
     * <p>Runs with the monitor RELEASED: a rejection rolls optimistic layers back, and a consumer's
     * callback must never run inside the critical section that guards the subscription registry.
     * Every discard path funnels through here, so an eviction can never drop a durable write in
     * silence — which matters most for a hydrated record, whose original caller did not survive the
     * restart.
     */
    static void reportDiscarded(Client client, List<Offline.Discarded> discarded) {
        for (Offline.Discarded item : discarded) {
            settleRejected(client, item.entry(), item.error());
        }
    }

    /**
     * Confirms the overlay BEFORE the caller is told, so the gapless drop is already in place when
     * the confirming frame lands.
     */
    private static void settleCommitted(
            Client client, QueuedMutation item, Object value, Long commitCursor) {
        if (item.onCommit != null) {
            item.onCommit.accept(commitCursor);
        }

        emitSettled(
                client,
                new MutationSettled(
                        item.id, MutationStatus.COMMITTED, value, null, item.liveAwaiter),
                item.onSettled);
    }

    /**
     * Rolls the write's overlay back, then reports the verdict.
     *
     * <p>The client-level emission is UNCONDITIONAL and the per-entry handler runs in ADDITION to
     * it, never instead: a restored write has no per-entry handler at all, so gating the report on
     * one is how a hydrated eviction settles to nobody.
     */
    private static void settleRejected(Client client, QueuedMutation item, RuntimeException error) {
        if (item.reject != null) {
            try {
                item.reject.accept(error);
            } catch (RuntimeException ignored) {
                // A consumer's rejection handler throwing is not this client's failure.
            }
        }

        emitSettled(
                client,
                new MutationSettled(
                        item.id, MutationStatus.REJECTED, null, error, item.liveAwaiter),
                item.onSettled);
    }

    /**
     * Runs a write's confirms or rollbacks under the monitor and delivers the resulting
     * notifications outside it.
     */
    private static void settleLayers(
            Client client,
            List<BiConsumer<Long, List<Runnable>>> confirms,
            List<Consumer<List<Runnable>>> rollbacks,
            Long commitCursor) {
        List<Runnable> deferred = new ArrayList<>();

        synchronized (client.lock) {
            Optimistic.confirmAll(confirms, commitCursor, deferred);
            Optimistic.rollbackAll(rollbacks, deferred);
        }

        Client.runDeferred(deferred);
    }

    private static void emitSettled(
            Client client, MutationSettled event, Consumer<MutationSettled> onSettled) {
        List<Consumer<MutationSettled>> listeners = new ArrayList<>();

        if (onSettled != null) {
            listeners.add(onSettled);
        }

        synchronized (client.lock) {
            listeners.addAll(client.settledListeners);
        }

        for (Consumer<MutationSettled> listener : listeners) {
            try {
                listener.accept(event);
            } catch (RuntimeException ignored) {
                // A write's terminal verdict is the only report a restored write ever produces, so
                // one bad observer must not stop the rest being told.
            }
        }
    }
}
