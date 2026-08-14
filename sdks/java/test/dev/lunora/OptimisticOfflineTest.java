package dev.lunora;

import static dev.lunora.ConformanceTest.check;
import static dev.lunora.ConformanceTest.covers;
import static dev.lunora.ConformanceTest.fixture;

import dev.lunora.Client.FlushReport;
import dev.lunora.Client.MutationStatus;
import dev.lunora.Client.Response;
import dev.lunora.Client.SubmitOptions;
import dev.lunora.Offline.Identity;
import dev.lunora.Offline.OfflineException;
import dev.lunora.Offline.OfflineQueue;
import dev.lunora.Offline.PersistenceAdapter;
import dev.lunora.Offline.QueuedMutation;
import dev.lunora.Optimistic.LocalStore;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The cursor-gated optimistic-layer engine and the durable offline write queue, against the shared
 * golden scenarios in {@code protocol/fixtures/offline-optimistic.json}.
 *
 * <p>Every expectation is read from that file so this port and the other six assert the same values
 * rather than each documenting its own behaviour. {@link ConformanceTest} calls {@link #run}; the
 * end of its {@code main} is the after-all hook that holds this suite to the manifest.
 */
final class OptimisticOfflineTest {
    private OptimisticOfflineTest() {}

    static void run() throws IOException {
        optimisticLayerRebasesOntoServerFrame();
        optimisticLayerDropsOnCommitCursor();
        optimisticLayerRollsBackOnFailure();
        offlineQueueFifoAndShardDrain();
        offlineQueueOverflowEvictsOldest();
        offlineQueuePreconditionDropsStaleWrite();
        offlineQueueHydratesPersistedWrites();
        offlineQueueIdentityGateRejectsReplay();
        offlineFlushReplaysAndConfirmsOptimistic();
    }

    private static Map<String, Object> scenario(String block, String name) throws IOException {
        return map(map(fixture("offline-optimistic.json").get(block)).get(name));
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object value) {
        return (List<Object>) value;
    }

    /** The one place a parsed-JSON object is narrowed, so the cast is asserted once. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static int count(Object value) {
        return ((Number) value).intValue();
    }

    /**
     * The one transform primitive the fixtures use: push onto a COPY of the list.
     *
     * <p>A copy, not an in-place add: a transform is re-run on every rebase, so one that mutated
     * its input would compound its own effect on each server frame.
     */
    private static Optimistic.Transform appender(Object item) {
        return current -> {
            List<Object> next =
                    new ArrayList<>(current instanceof List<?> entries ? entries : List.of());

            next.add(item);

            return next;
        };
    }

    /** Applies one server data frame the way {@code Client.handleFrame} does. */
    private static void applyFrame(Optimistic.State state, Map<String, Object> frame) {
        state.serverBase = frame.get("data");
        state.serverCursor =
                frame.get("cursor") instanceof Number number ? number.longValue() : null;
        Optimistic.dropConfirmedLayers(state, state.serverCursor);
        Optimistic.notifySubscription(
                state, Optimistic.fold(state.serverBase, state.layers), new ArrayList<>());
    }

    private static void optimisticLayerRebasesOntoServerFrame() throws IOException {
        covers("optimistic_layer_rebases_onto_server_frame");

        Map<String, Object> testCase = scenario("optimistic", "rebase");
        List<Object> seen = new ArrayList<>();
        Optimistic.State state = new Optimistic.State(testCase.get("base"));

        state.callbacks.add(seen::add);

        List<Runnable> deferred = new ArrayList<>();

        Optimistic.applyLayer(state, appender(testCase.get("appended")), deferred);
        deferred.forEach(Runnable::run);

        check(
                state.lastValue.equals(testCase.get("displayedAfterApply")),
                "the predicted value is displayed as soon as the layer is applied");
        check(seen.size() == 1, "and the handler is told exactly once");

        applyFrame(state, map(testCase.get("frame")));

        // The overlay survived the frame and was RE-FOLDED onto the new base, rather than being
        // clobbered by it.
        check(
                state.lastValue.equals(testCase.get("displayedAfterFrame")),
                "a pending layer rebases onto the new authoritative base");
        check(
                state.layers.size() == count(testCase.get("layersAfterFrame")),
                "and is still pending afterwards");

        // A layer that throws is skipped by the fold, not fatal to it. Registered directly rather
        // than through applyLayer, which refuses a transform that throws on first application —
        // this is the other case: one that worked once and throws on a later rebase.
        Map<String, Object> skipped = scenario("optimistic", "throwingLayerSkipped");
        Optimistic.State second = new Optimistic.State(skipped.get("base"));

        second.layers.add(
                new Optimistic.Layer(
                        current -> {
                            throw new IllegalStateException("buggy optimistic update");
                        }));
        Optimistic.applyLayer(second, appender(skipped.get("appended")), new ArrayList<>());

        check(second.layers.size() == count(skipped.get("layers")), "the throwing layer is kept");
        check(
                Optimistic.fold(second.serverBase, second.layers).equals(skipped.get("displayed")),
                "but skipped by the fold, so the good layer still applies");
    }

    private static void optimisticLayerDropsOnCommitCursor() throws IOException {
        covers("optimistic_layer_drops_on_commit_cursor");

        Map<String, Object> testCase = scenario("optimistic", "commitCursorDrop");
        Optimistic.State state = new Optimistic.State(testCase.get("base"));
        List<Runnable> deferred = new ArrayList<>();
        Optimistic.Handle handle =
                Optimistic.applyLayer(state, appender(testCase.get("appended")), deferred);

        handle.confirm((long) count(testCase.get("commitCursor")), deferred);
        applyFrame(state, map(testCase.get("belowFrame")));

        // Below the commit cursor: the write is NOT in the server base yet, so dropping the overlay
        // here would blink the value away and back.
        check(
                state.lastValue.equals(testCase.get("displayedAfterBelowFrame")),
                "a frame below the commit cursor keeps the overlay");
        check(
                state.layers.size() == count(testCase.get("layersAfterBelowFrame")),
                "and the layer with it");

        applyFrame(state, map(testCase.get("atFrame")));

        // The frame reached the commit cursor: the effect is in the base, so the overlay drops
        // without the value ever double-counting it.
        check(
                state.lastValue.equals(testCase.get("displayedAfterAtFrame")),
                "the confirming frame does not double-count the write");
        check(
                state.layers.size() == count(testCase.get("layersAfterAtFrame")),
                "and the layer is gone");

        // CDC is off on this shard, so there is no cursor to gate on. The layer goes, but the
        // display does not revert: the write DID commit.
        Map<String, Object> without = scenario("optimistic", "confirmWithoutCursor");
        Optimistic.State degraded = new Optimistic.State(without.get("base"));
        Optimistic.Handle degradedHandle =
                Optimistic.applyLayer(
                        degraded, appender(without.get("appended")), new ArrayList<>());

        degradedHandle.confirm(null, new ArrayList<>());

        check(
                degraded.lastValue.equals(without.get("displayedAfterConfirm")),
                "confirming with no cursor does not revert a committed write");
        check(
                degraded.layers.size() == count(without.get("layersAfterConfirm")),
                "but does drop the layer");

        // The confirming frame beat the RPC response — the common race. The overlay must drop on
        // confirm rather than linger until the next frame.
        Map<String, Object> atFrame = map(testCase.get("atFrame"));
        Optimistic.State raced = new Optimistic.State(atFrame.get("data"));

        raced.serverCursor = (long) count(atFrame.get("cursor"));

        Optimistic.Handle racedHandle =
                Optimistic.applyLayer(raced, appender("x"), new ArrayList<>());

        racedHandle.confirm((long) count(testCase.get("commitCursor")), new ArrayList<>());

        check(raced.layers.isEmpty(), "a cursor the frames already reached drops the layer now");
        check(raced.lastValue.equals(atFrame.get("data")), "and the display reverts to the base");
    }

    private static void optimisticLayerRollsBackOnFailure() throws IOException {
        covers("optimistic_layer_rolls_back_on_failure");

        Map<String, Object> testCase = scenario("optimistic", "rollback");
        List<Object> seen = new ArrayList<>();
        Optimistic.State state = new Optimistic.State(testCase.get("base"));

        state.callbacks.add(seen::add);

        List<Runnable> deferred = new ArrayList<>();
        Optimistic.Handle handle =
                Optimistic.applyLayer(state, appender(testCase.get("appended")), deferred);

        handle.rollback(deferred);
        deferred.forEach(Runnable::run);

        check(
                state.lastValue.equals(testCase.get("displayedAfterRollback")),
                "a rolled-back write leaves the server value displayed");
        check(state.layers.size() == count(testCase.get("layersAfterRollback")), "and no layer");
        check(
                seen.get(seen.size() - 1).equals(testCase.get("displayedAfterRollback")),
                "the handler saw it");

        // A constant layer is an absolute override: while pending it re-clamps and HIDES the
        // concurrent server change rather than merging with it.
        Map<String, Object> mask = scenario("optimistic", "constantMask");
        Optimistic.State masked = new Optimistic.State(mask.get("base"));
        List<Runnable> maskDeferred = new ArrayList<>();
        LocalStore store =
                new LocalStore(
                        target -> List.of(masked),
                        path ->
                                List.of(
                                        new Optimistic.QueryEntry(
                                                new LinkedHashMap<>(), masked.lastValue)),
                        maskDeferred);

        store.setQuery("messages:list", new LinkedHashMap<>(), mask.get("value"));
        maskDeferred.forEach(Runnable::run);

        check(
                masked.lastValue.equals(mask.get("displayedAfterApply")),
                "setQuery displays the predicted value");
        check(
                store.getQuery("messages:list", new LinkedHashMap<>())
                        .equals(mask.get("displayedAfterApply")),
                "and getQuery reads it back");

        applyFrame(masked, map(mask.get("frame")));

        check(
                masked.lastValue.equals(mask.get("displayedAfterFrame")),
                "the override masks a concurrent server change");

        Optimistic.rollbackAll(store.rollbacks, new ArrayList<>());

        check(
                masked.lastValue.equals(mask.get("displayedAfterRollback")),
                "and rolling back reveals it");
    }

    /** A persistence adapter that records every call. */
    private static final class MemoryStore implements PersistenceAdapter {
        final List<Map<String, Object>> records = new ArrayList<>();
        final List<Map<String, Object>> appended = new ArrayList<>();
        final List<String> removed = new ArrayList<>();
        int cleared;

        MemoryStore() {}

        MemoryStore(List<Map<String, Object>> seeded) {
            records.addAll(seeded);
        }

        @Override
        public void append(Map<String, Object> record) {
            appended.add(record);
            records.add(record);
        }

        @Override
        public List<Map<String, Object>> load() {
            return List.copyOf(records);
        }

        @Override
        public void remove(String mutationId) {
            removed.add(mutationId);
            records.removeIf(record -> mutationId.equals(record.get("id")));
        }

        @Override
        public void clear() {
            cleared++;
            records.clear();
        }
    }

    private static QueuedMutation entry(String id, String shardKey) {
        return new QueuedMutation("messages:send", new LinkedHashMap<>(), shardKey, id);
    }

    /** The "id:code" pairs a queue reported letting go of. */
    private static List<String> discardedPairs(List<Offline.Discarded> discarded) {
        List<String> out = new ArrayList<>();

        for (Offline.Discarded item : discarded) {
            out.add(item.entry().id + ":" + item.code());
        }

        return out;
    }

    private static List<String> ids(List<QueuedMutation> items) {
        List<String> out = new ArrayList<>();

        for (QueuedMutation item : items) {
            out.add(item.id);
        }

        return out;
    }

    private static List<String> strings(Object value) {
        List<String> out = new ArrayList<>();

        for (Object entry : list(value)) {
            out.add(entry == null ? null : entry.toString());
        }

        return out;
    }

    private static void offlineQueueFifoAndShardDrain() throws IOException {
        covers("offline_queue_fifo_and_shard_drain");

        Map<String, Object> fifo = scenario("offlineQueue", "fifo");
        List<Integer> sizes = new ArrayList<>();
        OfflineQueue queue = new OfflineQueue();

        queue.onSizeChange = sizes::add;

        for (String id : strings(fifo.get("enqueue"))) {
            queue.enqueue(entry(id, null));
        }

        check(queue.size() == count(fifo.get("sizeAfterEnqueue")), "every write is queued");
        check(
                ids(queue.drain(null)).equals(strings(fifo.get("drained"))),
                "writes drain in submission order");
        check(
                sizes.get(sizes.size() - 1) == count(fifo.get("sizeAfterDrain")),
                "and the depth observer sees the queue empty");

        Map<String, Object> shard = scenario("offlineQueue", "shardDrain");
        OfflineQueue sharded = new OfflineQueue();

        for (Object raw : list(shard.get("entries"))) {
            Map<String, Object> spec = map(raw);

            sharded.enqueue(
                    entry(
                            (String) spec.get("id"),
                            spec.get("shardKey") == null ? null : spec.get("shardKey").toString()));
        }

        String target =
                shard.get("drainShardKey") == null ? null : shard.get("drainShardKey").toString();
        List<QueuedMutation> drained =
                sharded.drain(
                        item ->
                                target == null
                                        ? item.shardKey == null
                                        : target.equals(item.shardKey));

        check(ids(drained).equals(strings(shard.get("drained"))), "one shard's writes drained");
        check(
                ids(sharded.items()).equals(strings(shard.get("remaining"))),
                "and the rest stay queued in order");

        Map<String, Object> requeue = scenario("offlineQueue", "requeue");
        MemoryStore store = new MemoryStore();
        OfflineQueue durable = new OfflineQueue().persistence(store);

        for (String id : strings(requeue.get("enqueue"))) {
            durable.enqueue(entry(id, null));
        }

        List<String> wanted = strings(requeue.get("requeued"));
        List<QueuedMutation> returning = new ArrayList<>();

        for (QueuedMutation item : durable.drain(null)) {
            if (wanted.contains(item.id)) {
                returning.add(item);
            }
        }

        durable.requeue(returning);

        check(
                ids(durable.items()).equals(strings(requeue.get("queuedAfterRequeue"))),
                "requeued writes return to the front, in order");
        // Durable storage still holds them — they were never un-persisted, so a re-append would
        // duplicate the record.
        check(
                store.appended.size() == count(requeue.get("persistAppendCalls")),
                "and a requeue does not re-persist them");
    }

    private static void offlineQueueOverflowEvictsOldest() throws IOException {
        covers("offline_queue_overflow_evicts_oldest");

        Map<String, Object> testCase = scenario("offlineQueue", "overflow");
        List<Offline.Discarded> evicted = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        OfflineQueue queue =
                new OfflineQueue().maxItems(count(testCase.get("maxItems"))).persistence(store);

        for (String id : strings(testCase.get("enqueue"))) {
            evicted.addAll(queue.enqueue(entry(id, null)));
        }

        String code = (String) testCase.get("code");
        List<String> wantEvicted = strings(testCase.get("evicted"));

        check(
                ids(queue.items()).equals(strings(testCase.get("remaining"))),
                "the newest writes survive the cap");
        // Returned, not rejected in place: the caller settles it once it has left the monitor. A
        // hydrated entry has no live caller at all, so this is the only thing standing between an
        // eviction and a durable write vanishing in silence.
        check(
                discardedPairs(evicted).equals(List.of(wantEvicted.get(0) + ":" + code)),
                "the OLDEST write is returned as discarded, with the documented code");
        check(
                store.removed.equals(strings(testCase.get("persistRemoveCalls"))),
                "an evicted write is un-persisted");

        Map<String, Object> clear = scenario("offlineQueue", "clear");
        MemoryStore clearStore = new MemoryStore();
        OfflineQueue closing = new OfflineQueue().persistence(clearStore);
        List<String> enqueued = strings(clear.get("enqueue"));

        for (String id : enqueued) {
            closing.enqueue(entry(id, null));
        }

        List<String> wantClosed = new ArrayList<>();

        for (String id : strings(clear.get("rejected"))) {
            wantClosed.add(id + ":" + clear.get("code"));
        }

        check(
                discardedPairs(closing.clear()).equals(wantClosed),
                "closing returns every queued write, with the documented code");
        check(closing.size() == 0, "and empties the queue");
        // Closing must NOT discard writes the next session will restore.
        check(clearStore.removed.isEmpty(), "but leaves the durable records alone");
        check(clearStore.records.size() == enqueued.size(), "so a later session can restore them");
    }

    private static void offlineQueuePreconditionDropsStaleWrite() throws IOException {
        covers("offline_queue_precondition_drops_stale_write");

        Map<String, Object> testCase = scenario("offlineQueue", "precondition");
        OfflineQueue queue = new OfflineQueue();

        for (Object raw : list(testCase.get("entries"))) {
            Map<String, Object> spec = map(raw);
            boolean verdict = Boolean.TRUE.equals(spec.get("precondition"));
            QueuedMutation item = entry((String) spec.get("id"), null);

            item.precondition = () -> verdict;
            queue.enqueue(item);
        }

        List<String> wantConflicted = new ArrayList<>();

        for (String id : strings(testCase.get("conflicted"))) {
            wantConflicted.add(id + ":" + testCase.get("code"));
        }

        check(
                discardedPairs(queue.drainConflict()).equals(wantConflicted),
                "only the write whose precondition failed is dropped, with the documented code");
        check(
                ids(queue.items()).equals(strings(testCase.get("remaining"))),
                "and the valid writes keep their FIFO order");
    }

    private static List<Map<String, Object>> persistedRecords(Map<String, Object> testCase) {
        List<Map<String, Object>> records = new ArrayList<>();

        for (Object raw : list(testCase.get("persisted"))) {
            Map<String, Object> spec = map(raw);
            Map<String, Object> record = new LinkedHashMap<>();

            record.put("args", new LinkedHashMap<String, Object>());
            record.put("functionPath", "messages:send");
            record.put("id", spec.get("id"));
            record.put("shardKey", spec.get("shardKey"));
            record.put("version", spec.get("version"));
            records.add(record);
        }

        return records;
    }

    private static void offlineQueueHydratesPersistedWrites() throws IOException {
        covers("offline_queue_hydrates_persisted_writes");

        Map<String, Object> testCase = scenario("offlineQueue", "hydrate");
        MemoryStore store = new MemoryStore(persistedRecords(testCase));
        OfflineQueue queue =
                new OfflineQueue().persistence(store).version((String) testCase.get("version"));

        // Submitted during the boot window, BEFORE the durable load returns.
        for (String id : strings(testCase.get("liveEnqueue"))) {
            queue.enqueue(entry(id, null));
        }

        OfflineQueue.Hydrated hydrated = queue.hydrate();
        List<String> shardKeys = hydrated.shardKeys();

        check(hydrated.evicted().isEmpty(), "nothing exceeded the default capacity");

        // The durable store's order is authoritative: a prior-session write is always older, so
        // replaying the boot-time write first would let last-writer-wins clobber newer data.
        check(
                ids(queue.items()).equals(strings(testCase.get("queuedAfterHydrate"))),
                "restored writes land ahead of the boot-time write");
        // A record stamped under another app version is dropped AND purged.
        check(
                store.removed.equals(strings(testCase.get("purged"))),
                "and a stale-version record is purged rather than replayed");
        check(
                new HashSet<>(shardKeys).equals(new HashSet<>(strings(testCase.get("shardKeys")))),
                "the surviving writes' shard keys are reported");

        Map<String, Object> overflow = scenario("offlineQueue", "hydrateOverflow");
        MemoryStore overflowStore = new MemoryStore(persistedRecords(overflow));
        OfflineQueue capped =
                new OfflineQueue()
                        .maxItems(count(overflow.get("maxItems")))
                        .persistence(overflowStore)
                        .version((String) overflow.get("version"));
        OfflineQueue.Hydrated cappedHydrated = capped.hydrate();
        List<String> cappedKeys = cappedHydrated.shardKeys();
        List<String> evicted = new ArrayList<>();

        for (Offline.Discarded item : cappedHydrated.evicted()) {
            evicted.add(item.entry().id);
        }

        check(
                ids(capped.items()).equals(strings(overflow.get("queuedAfterHydrate"))),
                "hydration respects the capacity cap");
        check(
                evicted.equals(strings(overflow.get("evicted"))),
                "dropping the oldest restored write");
        // Only the shards whose writes SURVIVED — a key gathered before eviction would send the
        // caller to open a socket with nothing queued behind it.
        check(
                cappedKeys.equals(strings(overflow.get("shardKeys"))),
                "and reports only the surviving shards");

        // Version gating is OFF until a version is configured.
        check(!Offline.isStaleVersion(null, null), "no version configured, nothing is stale");
        check(!Offline.isStaleVersion(null, "v1"), "even a stamped record");
        check(Offline.isStaleVersion("v2", null), "an unstamped record is stale once gating is on");
        check(Offline.isStaleVersion("v2", "v1"), "and so is one from another version");
        check(!Offline.isStaleVersion("v2", "v2"), "the current version is not");

        // Two anonymous clients that collided on an id would share one de-duplication namespace
        // server-side, letting one suppress the other's writes.
        Set<String> minted = new HashSet<>();

        for (int index = 0; index < 2000; index++) {
            minted.add(Offline.randomId());
        }

        check(minted.size() == 2000, "minted ids must not collide");
    }

    private static void offlineQueueIdentityGateRejectsReplay() throws IOException {
        covers("offline_queue_identity_gate_rejects_replay");

        Map<String, Object> testCase = scenario("offlineQueue", "identityGate");

        for (Object raw : list(testCase.get("cases"))) {
            Map<String, Object> spec = map(raw);
            Object stampedRaw = spec.get("stamped");
            Identity stamped;

            if ("absent".equals(stampedRaw)) {
                stamped = Identity.absent();
            } else if (stampedRaw == null) {
                stamped = Identity.signedOut();
            } else {
                stamped = Identity.of(stampedRaw.toString());
            }

            String current = spec.get("current") == null ? null : spec.get("current").toString();

            check(
                    Offline.identityAllowsReplay(stamped, current)
                            == Boolean.TRUE.equals(spec.get("replays")),
                    "identity gate: " + spec.get("name"));
        }

        List<Map<String, String>> posts = new ArrayList<>();
        List<String> codes = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            posts.add(headers);

                            return new Response(200, "{\"result\":null}");
                        });

        client.identity = "user-b";

        QueuedMutation queued =
                new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m1");

        queued.identity = Identity.of("user-a");
        queued.reject =
                error -> codes.add(error instanceof OfflineException coded ? coded.code : "?");
        client.offlineQueue().enqueue(queued);

        FlushReport report = client.flushOfflineQueue(null);

        check(report.rejected.equals(List.of("m1")), "the mismatched write is rejected");
        check(report.committed.isEmpty(), "and nothing commits");
        // Nothing reached the wire: a restart must not push the previous user's queued writes as
        // the current one.
        check(posts.isEmpty(), "the write never reaches the server");
        check(codes.equals(List.of(testCase.get("code"))), "and it carries the documented code");
    }

    private static void offlineFlushReplaysAndConfirmsOptimistic() throws IOException {
        covers("offline_flush_replays_and_confirms_optimistic");

        Map<String, Object> testCase = scenario("offlineQueue", "flushReplay");
        Map<String, Map<String, Object>> bySlot = new LinkedHashMap<>();

        for (Object raw : list(testCase.get("responses"))) {
            Map<String, Object> spec = map(raw);

            bySlot.put((String) spec.get("id"), spec);
        }

        List<String> seenHeaders = new ArrayList<>();
        List<Long> confirmed = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            String mutationId = headers.get("x-lunora-mutation-id");

                            seenHeaders.add(mutationId);

                            Map<String, Object> spec = bySlot.get(mutationId);
                            Object outcome = spec.get("outcome");

                            if ("transport-error".equals(outcome)) {
                                throw new IllegalStateException("connection reset");
                            }

                            if ("coded-error".equals(outcome)) {
                                return new Response(
                                        200,
                                        "{\"error\":{\"code\":\""
                                                + spec.get("code")
                                                + "\",\"message\":\"gone\"}}");
                            }

                            return new Response(
                                    200,
                                    "{\"commitCursor\":"
                                            + count(spec.get("commitCursor"))
                                            + ",\"result\":{\"ok\":true}}");
                        });

        client.offlineQueue(new OfflineQueue().persistence(store));

        for (String id : strings(testCase.get("queued"))) {
            QueuedMutation item =
                    new QueuedMutation("messages:send", new LinkedHashMap<>(), null, id);

            item.clientId = "client-1";
            item.onCommit = confirmed::add;
            client.offlineQueue().enqueue(item);
        }

        FlushReport report = client.flushOfflineQueue(null);

        // Replayed in FIFO order, each under its own idempotency key so a write the server already
        // committed is de-duplicated rather than re-applied.
        check(
                seenHeaders.equals(strings(testCase.get("mutationIdHeaders"))),
                "queued writes replay in order, under their own idempotency keys");
        check(
                report.committed.equals(strings(testCase.get("committed"))),
                "the good write commits");
        // A coded verdict is terminal: replaying it would only re-trigger the same failure. A
        // transport failure is not, so that write stays queued.
        check(
                report.rejected.equals(strings(testCase.get("rejected"))),
                "a coded verdict is terminal");
        check(
                ids(client.offlineQueue().items())
                        .equals(strings(testCase.get("queuedAfterFlush"))),
                "and a transport failure leaves its write queued");
        check(
                report.requeued.equals(strings(testCase.get("queuedAfterFlush"))),
                "as the report says");
        check(
                store.removed.equals(strings(testCase.get("persistRemoveCalls"))),
                "every terminally settled write is un-persisted");
        check(
                confirmed.equals(List.of((long) count(testCase.get("confirmedCommitCursor")))),
                "and the committed write confirms against the echoed cursor");

        submitQueuesWhileOffline(count(testCase.get("confirmedCommitCursor")));
        submitBeforeFirstConnectFailsFast();
        submitRollsBackARejectedWrite();
        overflowDuringSubmitSettles();
    }

    /** A write made with the socket down is queued, keeps its overlay, and replays on the flush. */
    private static void submitQueuesWhileOffline(int commitCursor) {
        int[] posts = {0};
        List<Object> seen = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            posts[0]++;

                            return new Response(
                                    200,
                                    "{\"commitCursor\":"
                                            + commitCursor
                                            + ",\"result\":{\"ok\":true}}");
                        });
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("channel", "general");

        client.attachSocket(frame -> {});
        client.subscribe("messages:list", args, seen::add, null, null);
        // Prime the subscription with a server value, then drop the socket.
        client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}");
        client.detachSocket();

        Client.MutationOutcome outcome =
                client.submit(new SubmitOptions("messages:list", args).optimistic(appender("c")));
        List<Object> predicted = List.of("a", "c");

        check(outcome.status() == MutationStatus.QUEUED, "a write with the socket down is queued");
        check(seen.get(seen.size() - 1).equals(predicted), "and its overlay is displayed");
        check(posts[0] == 0, "nothing reaches the wire while the socket is down");
        check(client.pendingMutationCount() == 1, "and the queue depth reflects it");

        client.attachSocket(frame -> {});
        client.flushOfflineQueue(null);

        check(posts[0] == 1, "the flush replays it");
        check(client.pendingMutationCount() == 0, "and drains the queue");
        // Still displayed: the overlay is confirmed at the commit cursor and drops only once a
        // frame reaches it.
        check(seen.get(seen.size() - 1).equals(predicted), "the overlay survives the reply");

        client.handleFrame(
                "{\"cursor\":"
                        + commitCursor
                        + ",\"data\":[\"a\",\"c\"],\"id\":\"sub_1\",\"type\":\"data\"}");

        check(
                seen.get(seen.size() - 1).equals(predicted),
                "and the confirming frame does not double-count it");
    }

    /**
     * Never connected and the opt-in is off, so a misconfigured endpoint surfaces on the first
     * write rather than silently filling a queue that will never flush.
     */
    private static void submitBeforeFirstConnectFailsFast() {
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            throw new IllegalStateException("no route to host");
                        });
        boolean threw = false;

        try {
            client.submit(new SubmitOptions("messages:send", new LinkedHashMap<>()));
        } catch (RuntimeException expected) {
            threw = true;
        }

        check(threw, "the first write fails before any connect");
        check(client.pendingMutationCount() == 0, "and nothing is queued");

        client.offlineQueue(new OfflineQueue().queueBeforeFirstConnect(true));

        Client.MutationOutcome outcome =
                client.submit(new SubmitOptions("messages:send", new LinkedHashMap<>()));

        check(outcome.status() == MutationStatus.QUEUED, "the opt-in queues it instead");
        check(client.pendingMutationCount() == 1, "and the queue holds it");
    }

    /**
     * An eviction triggered from inside {@code submit} settles rather than running a consumer's
     * callback inside the monitor that guards the subscription registry.
     *
     * <p>This is the regression: the queue used to reject an evicted write in place, and that
     * rejection rolls optimistic layers back — which re-enters the very monitor {@code submit} was
     * holding. A {@code synchronized} block is reentrant so this port never hung, but its Go
     * sibling self-deadlocked and its Ruby sibling swallowed the verdict entirely.
     */
    private static void overflowDuringSubmitSettles() throws IOException {
        Map<String, Object> testCase = scenario("offlineQueue", "overflow");
        int maxItems = count(testCase.get("maxItems"));
        List<Client.MutationSettled> settled = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> new Response(200, "{\"result\":null}"));

        client.offlineQueue(new OfflineQueue().maxItems(maxItems).queueBeforeFirstConnect(true));
        client.onMutationSettled(settled::add);

        for (int index = 0; index < strings(testCase.get("enqueue")).size(); index++) {
            client.submit(new SubmitOptions("messages:send", new LinkedHashMap<>()));
        }

        check(settled.size() == 1, "the evicted write settles exactly once");
        check(settled.get(0).status() == MutationStatus.REJECTED, "as a rejection");
        check(
                settled.get(0).error() instanceof OfflineException coded
                        && coded.code.equals(testCase.get("code")),
                "carrying the documented overflow code");
        check(client.pendingMutationCount() == maxItems, "and the cap is respected");
    }

    /** A rejected write takes its optimistic overlay down with it. */
    private static void submitRollsBackARejectedWrite() {
        List<Object> seen = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) ->
                                new Response(
                                        200,
                                        "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}"));

        client.attachSocket(frame -> {});
        client.subscribe("messages:list", new LinkedHashMap<>(), seen::add, null, null);
        client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}");

        boolean threw = false;

        try {
            client.submit(
                    new SubmitOptions("messages:list", new LinkedHashMap<>())
                            .optimistic(appender("c")));
        } catch (Client.ApiException expected) {
            threw = true;
        }

        check(threw, "the server's verdict reaches the caller");
        check(seen.get(seen.size() - 1).equals(List.of("a")), "and the overlay is gone");
    }
}
