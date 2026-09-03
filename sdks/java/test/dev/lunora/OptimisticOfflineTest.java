package dev.lunora;

import static dev.lunora.ConformanceTest.check;
import static dev.lunora.ConformanceTest.covers;
import static dev.lunora.ConformanceTest.fixture;

import dev.lunora.Client.Response;
import dev.lunora.Offline.Identity;
import dev.lunora.Offline.OfflineException;
import dev.lunora.Offline.OfflineQueue;
import dev.lunora.Offline.PersistenceAdapter;
import dev.lunora.Offline.QueuedMutation;
import dev.lunora.Submit.FlushReport;
import dev.lunora.Submit.MutationOutcome;
import dev.lunora.Submit.MutationSettled;
import dev.lunora.Submit.MutationStatus;
import dev.lunora.Submit.SubmitOptions;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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
        optimisticLayerDropsOnSettledFrame();
        optimisticLayerRollsBackOnFailure();
        optimisticCursorlessFramePreservesCursor();
        offlineQueueFifoReplayOrder();
        offlineQueueOverflowEvictsOldest();
        offlineQueuePreconditionDropsStaleWrite();
        offlineQueueHydratesPersistedWrites();
        typedArgsSurviveASerialisingStore();
        undecodablePersistedRecordSettlesRejected();
        offlineQueueHydrateOverflowSettlesDiscarded();
        batchRefusedForSizeIsSplitAndRetried();
        loneWriteSurvivesAnEnvelopeLess502();
        rateLimitedReplayRequeuesAndDefersTheNextFlush();
        offlineQueueIdentityGateRejectsReplay();
        offlineFlushReplaysAndConfirmsOptimistic();
        offlineFlushBatchesMultipleWrites();
        batchEntryCapMatchesProtocol();
        offlineFlushUnencodableWriteSettlesTerminal();
        clientIdIsPerInstanceAndPersisted();
        consumerCallbacksRunOutsideTheLock();
        emptyShardKeyNeverReachesTheWire();
    }

    /**
     * Records a violation if {@code name} is running inside the client's monitor, then reaches back
     * into the client.
     *
     * <p>Both halves matter. {@link Thread#holdsLock} is the exact question this port has to answer
     * — its monitor is REENTRANT, so a callback running inside the critical section neither hangs
     * nor deadlocks, which is why the violation was invisible for as long as it was. The re-entrant
     * call is the shape that hard-deadlocks the sibling ports whose lock is not reentrant, kept
     * here so all seven suites drive the same scenario.
     */
    private static void assertUnlocked(Client client, List<String> violations, String name) {
        if (Thread.holdsLock(client.lock)) {
            violations.add(name);
        }

        client.pendingMutationCount();
        client.online();
    }

    /**
     * No callback a consumer supplies runs while the client holds its lock.
     *
     * <p>{@code sdks/README.md} states this for all seven ports: not the optimistic update, not a
     * queue entry's precondition, not {@code onSettled}, not a subscription handler. The transform
     * runs and the precondition is evaluated outside the critical section; the lock is taken only
     * to install the result — in ONE section with the offline decision and the enqueue, so the
     * TOCTOU that strands a write stays closed.
     *
     * <p>No timeout guard, deliberately: {@code synchronized} is reentrant, so a regression here
     * cannot hang the test and a watchdog would never fire. {@code holdsLock} detects it directly.
     */
    private static void consumerCallbacksRunOutsideTheLock() {
        List<String> violations = new ArrayList<>();
        int[] applications = {0};
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> new Response(200, CODED_ERROR));

        client.attachSocket(frame -> {});
        client.subscribe(
                "messages:list",
                new LinkedHashMap<>(),
                value -> assertUnlocked(client, violations, "subscription handler"),
                null,
                null);
        client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}");
        client.detachSocket();

        client.submit(
                new SubmitOptions("messages:list", new LinkedHashMap<>())
                        .optimistic(
                                current -> {
                                    // The FIRST application is the consumer callback the guarantee
                                    // covers. A later REBASE re-runs the same transform from
                                    // `fold`, which necessarily holds the monitor — the layer list
                                    // it folds is the state that monitor guards. That is inherent
                                    // to rebasing, and is why a transform must be pure.
                                    if (applications[0]++ == 0) {
                                        assertUnlocked(client, violations, "optimistic transform");
                                    }

                                    return current;
                                })
                        .optimisticUpdate(
                                (store, args) -> {
                                    assertUnlocked(client, violations, "optimisticUpdate");
                                    store.setQuery("messages:list", args, List.of("z"));
                                })
                        .precondition(
                                () -> {
                                    assertUnlocked(client, violations, "precondition");

                                    return true;
                                })
                        .onSettled(event -> assertUnlocked(client, violations, "onSettled")));

        client.attachSocket(frame -> {});

        FlushReport report = client.flushOfflineQueue(null);

        check(applications[0] > 0, "the transform ran");
        check(report.rejected.size() == 1, "and the write settled, so every callback fired");
        check(
                violations.isEmpty(),
                "these consumer callbacks ran inside the client's monitor: " + violations);
    }

    /**
     * An empty shard key is the DEFAULT shard to this client, and must never reach the wire as one.
     *
     * <p>{@code Offline.sameShard} merges absent and {@code ""} for the drain predicate and the
     * subscription lookup, but the runtime does not — {@code packages/runtime/src/create-worker.ts}
     * says in as many words that an empty string is a valid named shard, and routes it to its own
     * Durable Object. Normalising only the comparisons would be worse than the bug it replaced: the
     * write would drain on a null-shard flush and then land on a DIFFERENT shard from the
     * subscription whose overlay it just updated, rather than simply never replaying.
     */
    private static void emptyShardKeyNeverReachesTheWire() {
        Map<String, Object> empty = Client.buildRpcBody("messages:send", new LinkedHashMap<>(), "");
        Map<String, Object> named =
                Client.buildRpcBody("messages:send", new LinkedHashMap<>(), "room-1");
        Client client = new Client("https://app.example", null);

        check(!empty.containsKey("shardKey"), "an empty shard key is omitted from the RPC body");
        check(!client.wsUrl("", null).contains("shard="), "and from the socket URL");
        check("room-1".equals(named.get("shardKey")), "while a real one still rides the body");
        check(client.wsUrl("room-1", null).contains("shard=room-1"), "and the socket URL");

        // End to end, because the omission has to hold on the path a consumer actually takes.
        List<String> posted = new ArrayList<>();
        Client live =
                new Client(
                        "https://app.example",
                        (url, headers, payload) -> {
                            posted.add(new String(payload, StandardCharsets.UTF_8));

                            return new Response(200, "{\"result\":null}");
                        });

        live.attachSocket(frame -> {});
        live.submit(new SubmitOptions("messages:send", new LinkedHashMap<>()).shardKey(""));

        check(
                !posted.get(0).contains("shardKey"),
                "a write submitted with an empty shard key sends none");
    }

    /**
     * The default client id is minted per INSTANCE, and the issuing one is what a write persists.
     *
     * <p>The shard namespaces an anonymous caller's idempotency rows by this value, so a
     * per-language constant would put every signed-out client of this SDK — in this process and
     * every other — into one namespace: two users calling the same mutation under the same
     * caller-supplied mutation id collide, and the second write short-circuits to the first's
     * cached result without ever running.
     */
    private static void clientIdIsPerInstanceAndPersisted() {
        Client first = new Client("https://app.example", null);
        Client second = new Client("https://app.example", null);

        check(!first.clientId.equals(second.clientId), "two clients must not share a client id");

        MemoryStore store = new MemoryStore();

        first.offlineQueue(new OfflineQueue().persistence(store).queueBeforeFirstConnect(true));
        first.submit(new SubmitOptions("messages:send", new LinkedHashMap<>()));

        // The persisted record carries the id that ISSUED the write, so the replay namespaces
        // server-side under it rather than under whatever a later session minted.
        check(
                first.clientId.equals(store.appended.get(0).get("clientId")),
                "and a queued write persists the issuing client's real id");
    }

    /**
     * The {@code mutationId} of every entry in a batch request body, in order.
     *
     * <p>A flush of two or more writes coalesces into {@code /_lunora/rpc-batch}, so the
     * idempotency key rides in the ENTRY rather than in an {@code x-lunora-mutation-id} header.
     */
    @SuppressWarnings("unchecked")
    private static List<String> batchMutationIds(byte[] body) {
        List<String> ids = new ArrayList<>();

        for (Object raw : batchCalls(body)) {
            ids.add((String) ((Map<String, Object>) raw).get("mutationId"));
        }

        return ids;
    }

    /** The entries of a batch request body, or an empty list for a single call. */
    @SuppressWarnings("unchecked")
    private static List<Object> batchCalls(byte[] body) {
        Object parsed = Json.parse(new String(body, StandardCharsets.UTF_8));

        if (parsed instanceof Map<?, ?> envelope
                && envelope.get("calls") instanceof List<?> calls) {
            return (List<Object>) calls;
        }

        return new ArrayList<>();
    }

    /**
     * Answer a request in whichever shape it arrived in: a single call gets a whole response, a
     * batch gets one success slot per entry. A poster that only speaks the single-call shape makes
     * every batched write look unanswered.
     */
    private static String echoBatchSlots(byte[] body, String result, Long commitCursor) {
        String cursor = commitCursor == null ? "" : ",\"commitCursor\":" + commitCursor;
        List<Object> calls = batchCalls(body);

        if (calls.isEmpty()) {
            return "{\"result\":" + result + cursor + "}";
        }

        StringBuilder slots = new StringBuilder();

        for (int index = 0; index < calls.size(); index++) {
            if (index > 0) {
                slots.append(',');
            }

            slots.append("{\"id\":")
                    .append(index)
                    .append(",\"body\":{\"result\":")
                    .append(result)
                    .append(cursor)
                    .append("}}");
        }

        return "{\"results\":[" + slots + "]}";
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

    /**
     * Throws a CHECKED exception from somewhere a lambda cannot declare one.
     *
     * <p>{@code Optimistic.Transform} does not declare {@code throws}, but a transform that wraps a
     * call which does still delivers one. The fold has to skip it exactly as it skips an unchecked
     * one — catching only {@code RuntimeException} aborts the whole fold and blanks the query for
     * every other layer.
     */
    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneakyThrow(Throwable error) throws T {
        throw (T) error;
    }

    /**
     * One live client with one live subscription, driven end to end.
     *
     * <p>Server frames go through the REAL {@link Client#handleFrame} and optimistic layers are
     * registered by the REAL {@link Client#submit} and settled by the REAL flush. The suite used to
     * drive a hand-copied transcription of the frame handler's {@code data} branch instead, which
     * is why nothing caught the handler nulling the tracked cursor on a cursorless frame: the copy
     * and the production path could disagree indefinitely and every case still passed.
     *
     * <p>Nothing here needs a network — the poster and the frame sender are both injected.
     */
    private static final class Live {
        static final String ID = "sub_1";

        final List<Object> seen = new ArrayList<>();
        final List<MutationSettled> settled = new ArrayList<>();
        final Map<String, Object> args = new LinkedHashMap<>();

        /** The body the injected poster answers a replay with; swapped per flush. */
        private final String[] body = {"{\"result\":null}"};

        final Client client;

        Live() {
            client =
                    new Client(
                            "https://app.example",
                            (url, headers, payload) -> new Response(200, body[0]));
            client.attachSocket(frame -> {});
            client.subscribe("messages:list", args, seen::add, null, null);
            client.onMutationSettled(settled::add);
        }

        /** Feeds one server {@code data} frame through the client's real handler. */
        void frame(Map<String, Object> frame) {
            typedFrame("data", frame);
        }

        void typedFrame(String kind, Map<String, Object> frame) {
            Map<String, Object> out = new LinkedHashMap<>(frame);

            out.put("id", ID);
            out.put("type", kind);
            client.handleFrame(Json.write(out));
        }

        /** Primes the subscription with an authoritative base and no cursor. */
        void base(Object value) {
            Map<String, Object> frame = new LinkedHashMap<>();

            frame.put("data", value);
            frame(frame);
        }

        /** Submits with the socket down, so the write queues and its overlay stays pending. */
        MutationOutcome queue(SubmitOptions options) {
            client.detachSocket();

            MutationOutcome outcome = client.submit(options);

            client.attachSocket(frame -> {});

            return outcome;
        }

        /** Replays the queued writes, with {@code responseBody} as the server's answer. */
        FlushReport flush(String responseBody) {
            body[0] = responseBody;

            return client.flushOfflineQueue(null);
        }

        Object displayed() {
            return seen.isEmpty() ? null : seen.get(seen.size() - 1);
        }

        int layers() {
            return client.subscriptionState(ID).layers.size();
        }

        Long cursor() {
            return client.subscriptionState(ID).serverCursor;
        }
    }

    /** The reply a shard with CDC on echoes for a committed write. */
    private static String committedAt(int commitCursor) {
        return "{\"commitCursor\":" + commitCursor + ",\"result\":{\"ok\":true}}";
    }

    /** A server verdict: terminal, so the write is dropped rather than retried. */
    private static final String CODED_ERROR =
            "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}";

    private static void optimisticLayerRebasesOntoServerFrame() throws IOException {
        covers("optimistic_layer_rebases_onto_server_frame");

        Map<String, Object> testCase = scenario("optimistic", "rebase");
        Live live = new Live();

        live.base(testCase.get("base"));

        int before = live.seen.size();

        live.queue(
                new SubmitOptions("messages:list", live.args)
                        .optimistic(appender(testCase.get("appended"))));

        check(
                live.displayed().equals(testCase.get("displayedAfterApply")),
                "the predicted value is displayed as soon as the layer is applied");
        check(live.seen.size() == before + 1, "and the handler is told exactly once");

        live.frame(map(testCase.get("frame")));

        // The overlay survived the frame and was RE-FOLDED onto the new base, rather than being
        // clobbered by it.
        check(
                live.displayed().equals(testCase.get("displayedAfterFrame")),
                "a pending layer rebases onto the new authoritative base");
        check(
                live.layers() == count(testCase.get("layersAfterFrame")),
                "and is still pending afterwards");

        // A layer that throws is skipped by the fold, not fatal to it. The write path refuses a
        // transform that throws on FIRST application, so this is the other case: one that worked
        // once and throws on a later rebase — with a checked exception, which the fold must skip
        // exactly as it skips an unchecked one.
        Map<String, Object> skipped = scenario("optimistic", "throwingLayerSkipped");
        Live second = new Live();
        int[] applied = {0};

        second.base(skipped.get("base"));
        second.queue(
                new SubmitOptions("messages:list", second.args)
                        .optimistic(
                                current -> {
                                    if (applied[0]++ > 0) {
                                        sneakyThrow(new IOException("buggy optimistic update"));
                                    }

                                    return current;
                                }));
        second.queue(
                new SubmitOptions("messages:list", second.args)
                        .optimistic(appender(skipped.get("appended"))));
        // Any frame re-folds, which is when the buggy layer throws.
        second.base(skipped.get("base"));

        check(second.layers() == count(skipped.get("layers")), "the throwing layer is kept");
        check(
                second.displayed().equals(skipped.get("displayed")),
                "but skipped by the fold, so the good layer still applies");
    }

    /**
     * A byte-identical write yields a {@code settled} frame, never a {@code data} frame. Sweeping
     * confirmed layers only on data frames leaves the prediction on screen until some unrelated
     * write happens to change this query — on a quiet one, forever.
     */
    private static void optimisticLayerDropsOnSettledFrame() throws IOException {
        covers("optimistic_layer_drops_on_settled_frame");

        Map<String, Object> testCase = scenario("optimistic", "settledFrameDrop");
        int commitCursor = count(testCase.get("commitCursor"));
        Live live = new Live();

        live.base(testCase.get("base"));
        live.queue(
                new SubmitOptions("messages:list", live.args)
                        .optimistic(appender(testCase.get("appended"))));
        live.flush(committedAt(commitCursor));
        live.typedFrame("settled", map(testCase.get("belowFrame")));

        check(
                live.displayed().equals(testCase.get("displayedAfterBelowFrame")),
                "a settled frame below the commit cursor keeps the overlay");
        check(
                live.layers() == count(testCase.get("layersAfterBelowFrame")),
                "and the layer with it");

        live.typedFrame("settled", map(testCase.get("atFrame")));

        check(
                live.displayed().equals(testCase.get("displayedAfterAtFrame")),
                "a settled frame reaching the commit cursor drops the overlay");
        check(live.layers() == count(testCase.get("layersAfterAtFrame")), "and the layer is gone");
    }

    private static void optimisticLayerDropsOnCommitCursor() throws IOException {
        covers("optimistic_layer_drops_on_commit_cursor");

        Map<String, Object> testCase = scenario("optimistic", "commitCursorDrop");
        int commitCursor = count(testCase.get("commitCursor"));
        Live live = new Live();

        live.base(testCase.get("base"));
        live.queue(
                new SubmitOptions("messages:list", live.args)
                        .optimistic(appender(testCase.get("appended"))));
        live.flush(committedAt(commitCursor));
        live.frame(map(testCase.get("belowFrame")));

        // Below the commit cursor: the write is NOT in the server base yet, so dropping the overlay
        // here would blink the value away and back.
        check(
                live.displayed().equals(testCase.get("displayedAfterBelowFrame")),
                "a frame below the commit cursor keeps the overlay");
        check(
                live.layers() == count(testCase.get("layersAfterBelowFrame")),
                "and the layer with it");

        live.frame(map(testCase.get("atFrame")));

        // The frame reached the commit cursor: the effect is in the base, so the overlay drops
        // without the value ever double-counting it.
        check(
                live.displayed().equals(testCase.get("displayedAfterAtFrame")),
                "the confirming frame does not double-count the write");
        check(live.layers() == count(testCase.get("layersAfterAtFrame")), "and the layer is gone");

        // CDC is off on this shard, so there is no cursor to gate on. The layer goes, but the
        // display does not revert: the write DID commit.
        Map<String, Object> without = scenario("optimistic", "confirmWithoutCursor");
        Live degraded = new Live();

        degraded.base(without.get("base"));
        degraded.queue(
                new SubmitOptions("messages:list", degraded.args)
                        .optimistic(appender(without.get("appended"))));
        degraded.flush("{\"result\":{\"ok\":true}}");

        check(
                degraded.displayed().equals(without.get("displayedAfterConfirm")),
                "confirming with no cursor does not revert a committed write");
        check(
                degraded.layers() == count(without.get("layersAfterConfirm")),
                "but does drop the layer");

        // The confirming frame beat the RPC response — the common race. The overlay must drop on
        // confirm rather than linger until the next frame.
        Map<String, Object> atFrame = map(testCase.get("atFrame"));
        Live raced = new Live();

        raced.frame(atFrame);
        raced.queue(new SubmitOptions("messages:list", raced.args).optimistic(appender("x")));
        raced.flush(committedAt(commitCursor));

        check(raced.layers() == 0, "a cursor the frames already reached drops the layer now");
        check(raced.displayed().equals(atFrame.get("data")), "and the display reverts to the base");
    }

    private static void optimisticLayerRollsBackOnFailure() throws IOException {
        covers("optimistic_layer_rolls_back_on_failure");

        Map<String, Object> testCase = scenario("optimistic", "rollback");
        Live live = new Live();

        live.base(testCase.get("base"));
        live.queue(
                new SubmitOptions("messages:list", live.args)
                        .optimistic(appender(testCase.get("appended"))));
        live.flush(CODED_ERROR);

        check(
                live.displayed().equals(testCase.get("displayedAfterRollback")),
                "a rolled-back write leaves the server value displayed");
        check(live.layers() == count(testCase.get("layersAfterRollback")), "and no layer");
        check(
                live.settled.size() == 1 && live.settled.get(0).status() == MutationStatus.REJECTED,
                "and the caller is told exactly once");

        // A constant layer is an absolute override: while pending it re-clamps and HIDES the
        // concurrent server change rather than merging with it.
        Map<String, Object> mask = scenario("optimistic", "constantMask");
        Live masked = new Live();

        masked.base(mask.get("base"));
        masked.queue(
                new SubmitOptions("messages:list", masked.args)
                        .optimisticUpdate(
                                (store, args) -> {
                                    store.setQuery("messages:list", args, mask.get("value"));

                                    check(
                                            store.getQuery("messages:list", args)
                                                    .equals(mask.get("displayedAfterApply")),
                                            "getQuery reads back what setQuery wrote");
                                }));

        check(
                masked.displayed().equals(mask.get("displayedAfterApply")),
                "setQuery displays the predicted value");

        masked.frame(map(mask.get("frame")));

        check(
                masked.displayed().equals(mask.get("displayedAfterFrame")),
                "the override masks a concurrent server change");

        masked.flush(CODED_ERROR);

        check(
                masked.displayed().equals(mask.get("displayedAfterRollback")),
                "and rolling back reveals it");
    }

    /**
     * A frame that omits {@code cursor} — legal on data/delta/resume — must LEAVE the tracked
     * cursor alone.
     *
     * <p>Nulling it strands every pending layer: the tracked cursor is what a write's commit cursor
     * is compared against, so the confirm that should have dropped the overlay keeps it and the row
     * renders twice until some later cursored frame happens to land.
     */
    private static void optimisticCursorlessFramePreservesCursor() throws IOException {
        covers("optimistic_cursorless_frame_preserves_cursor");

        Map<String, Object> testCase = scenario("optimistic", "cursorlessFrame");
        Live live = new Live();

        live.base(testCase.get("base"));
        live.queue(
                new SubmitOptions("messages:list", live.args)
                        .optimistic(appender(testCase.get("appended"))));
        live.frame(map(testCase.get("cursoredFrame")));
        live.frame(map(testCase.get("cursorlessFrame")));

        check(
                live.cursor() != null
                        && live.cursor() == count(testCase.get("cursorAfterCursorlessFrame")),
                "a cursorless frame leaves the tracked cursor where it was");
        check(
                live.displayed().equals(testCase.get("displayedAfterCursorlessFrame")),
                "and the pending layer rebases onto its data");
        check(
                live.layers() == count(testCase.get("layersAfterCursorlessFrame")),
                "still pending, because nothing has confirmed it yet");

        live.flush(committedAt(count(testCase.get("commitCursor"))));

        // The assertion the fix exists for: with the cursor nulled there is nothing for the commit
        // cursor to be compared against, so the overlay survives its own confirmation.
        check(
                live.layers() == count(testCase.get("layersAfterConfirm")),
                "so the confirm at that cursor drops the overlay instead of stranding it");
    }

    /**
     * A persistence adapter that records every call.
     *
     * <p>It JSON round-trips every record, which an adapter holding the objects by reference does
     * not — and that is the whole point: a file, a SQLite text column or a preferences store all
     * serialise, so a record carrying the codec's native wrappers either raises here or is written
     * as something that does not read back. Holding references made this suite blind to both.
     */
    private static final class MemoryStore implements PersistenceAdapter {
        final List<Map<String, Object>> records = new ArrayList<>();
        final List<Map<String, Object>> appended = new ArrayList<>();
        final List<String> removed = new ArrayList<>();
        int cleared;

        MemoryStore() {}

        MemoryStore(List<Map<String, Object>> seeded) {
            for (Map<String, Object> record : seeded) {
                records.add(serialise(record));
            }
        }

        private static Map<String, Object> serialise(Map<String, Object> record) {
            return map(Json.parse(Json.write(record)));
        }

        @Override
        public void append(Map<String, Object> record) {
            Map<String, Object> stored = serialise(record);

            appended.add(stored);
            records.add(stored);
        }

        @Override
        public List<Map<String, Object>> load() {
            List<Map<String, Object>> loaded = new ArrayList<>();

            for (Map<String, Object> record : records) {
                loaded.add(serialise(record));
            }

            return loaded;
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

    private static void offlineQueueFifoReplayOrder() throws IOException {
        covers("offline_queue_fifo_replay_order");

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

        // Driven through the CLIENT's flush, not a predicate written here: the drain predicate is
        // production code, and a suite that supplies its own asserts nothing about it.
        covers("offline_queue_drains_only_the_named_shard");

        Map<String, Object> shard = scenario("offlineQueue", "shardDrain");
        List<String> replayed = new ArrayList<>();
        // Three writes drain together, so they coalesce into ONE batch hop and their idempotency
        // keys ride in the entries rather than in a request header.
        Client sharded =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            replayed.addAll(batchMutationIds(body));

                            return new Response(200, echoBatchSlots(body, "null", null));
                        });

        sharded.offlineQueue(new OfflineQueue().queueBeforeFirstConnect(true));

        for (Object raw : list(shard.get("entries"))) {
            Map<String, Object> spec = map(raw);

            sharded.offlineQueue()
                    .enqueue(
                            entry(
                                    (String) spec.get("id"),
                                    spec.get("shardKey") == null
                                            ? null
                                            : spec.get("shardKey").toString()));
        }

        String target =
                shard.get("drainShardKey") == null ? null : shard.get("drainShardKey").toString();

        sharded.flushOfflineQueue(target);

        // `m5` is queued under an EMPTY shard key and the flush is for the ABSENT one — the same
        // shard. Comparing the two strictly leaves it queued forever, because nothing ever flushes
        // a shard named "".
        check(replayed.equals(strings(shard.get("drained"))), "one shard's writes drained");
        check(
                ids(sharded.offlineQueue().items()).equals(strings(shard.get("remaining"))),
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

        // The verdicts are computed OUTSIDE the queue, exactly as the client does it:
        // a precondition is consumer code and never runs where the queue is mid-mutation.
        Set<String> stale = new LinkedHashSet<>();

        for (QueuedMutation item : queue.items()) {
            if (item.precondition != null && !item.precondition.get()) {
                stale.add(item.id);
            }
        }

        check(
                discardedPairs(queue.drainConflict(stale)).equals(wantConflicted),
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

    /**
     * A queued write whose args carry codec wrappers survives a store that SERIALISES.
     *
     * <p>Every real adapter does — a file, a SQLite text column, a preferences store — so
     * persisting the native form either raises inside the adapter (and the write is reported
     * "queued" while nothing durable was written) or writes whatever the adapter makes of an opaque
     * object and replays after a restart with corrupted args.
     */
    private static void typedArgsSurviveASerialisingStore() {
        covers("offline_queue_hydrates_persisted_writes");

        Map<String, Object> args = new LinkedHashMap<>();

        args.put("amount", new Wire.WireBigInt(java.math.BigInteger.valueOf(7)));
        args.put("blob", new Wire.WireBytes(new byte[] {1, 2, 3, 4}, "Int32Array"));
        args.put("when", new Wire.WireDate(1700000000000.0));

        MemoryStore store = new MemoryStore();
        OfflineQueue queue = new OfflineQueue().persistence(store);
        List<String> errors = new ArrayList<>();

        queue.onPersistenceError = (operation, error, id) -> errors.add(operation + ":" + id);
        queue.enqueue(new QueuedMutation("ledger:add", args, null, "m-typed"));

        check(errors.isEmpty(), "the record serialises, so nothing is reported as a failed append");
        check(
                Json.write(map(store.appended.get(0).get("args")).get("amount"))
                        .equals("[\"$lunora.wire$\",\"bigint\",\"7\"]"),
                "the durable record holds the WIRE form of the args");

        OfflineQueue restored = new OfflineQueue().persistence(store);

        restored.hydrate();

        check(ids(restored.items()).equals(List.of("m-typed")), "the write comes back");

        // Decoded back to the SAME native values, so the replay sends the write that was made
        // rather than whatever the adapter's stringification left.
        Map<String, Object> back = map(restored.items().get(0).args);

        check(
                back.get("amount").equals(new Wire.WireBigInt(java.math.BigInteger.valueOf(7))),
                "the bigint decodes back to its exact value");
        check(
                back.get("blob") instanceof Wire.WireBytes bytes
                        && "Int32Array".equals(bytes.ctor())
                        && java.util.Arrays.equals(bytes.data(), new byte[] {1, 2, 3, 4}),
                "and the typed-array view keeps both its bytes and its constructor");
        check(
                back.get("when").equals(new Wire.WireDate(1700000000000.0)),
                "and the date its epoch milliseconds");
    }

    /**
     * A persisted record whose args do not decode is purged and settled, never replayed.
     *
     * <p>Replaying it with substitute args would commit a DIFFERENT write than the caller made,
     * which is corruption rather than failure; throwing out of hydrate would kill the whole restart
     * path for one bad row.
     */
    private static void undecodablePersistedRecordSettlesRejected() {
        covers("offline_queue_hydrates_persisted_writes");

        Map<String, Object> args = new LinkedHashMap<>();
        Map<String, Object> record = new LinkedHashMap<>();

        // A wire tag whose payload is not a bigint literal: the store was corrupted, or written by
        // an incompatible build.
        args.put("amount", List.of(Wire.TAG, "bigint", "not-a-number"));
        record.put("args", args);
        record.put("functionPath", "ledger:add");
        record.put("id", "m-bad");

        MemoryStore store = new MemoryStore(List.of(record));
        List<MutationSettled> settled = new ArrayList<>();
        Client client = new Client("https://app.example", null);

        client.offlineQueue(new OfflineQueue().persistence(store));
        client.onMutationSettled(settled::add);
        client.hydrateOfflineQueue();

        check(client.offlineQueue().items().isEmpty(), "the unreadable write is never queued");
        check(settled.size() == 1, "and it settles exactly once");
        check(
                settled.get(0).mutationId().equals("m-bad")
                        && settled.get(0).status() == MutationStatus.REJECTED
                        && settled.get(0).error() instanceof OfflineException coded
                        && coded.code.equals(Offline.OFFLINE_WRITE_UNDECODABLE),
                "carrying the documented undecodable code");
        check(
                store.removed.equals(List.of("m-bad")),
                "the unreadable record is purged, not left to fail every restart");
    }

    /**
     * A batch the worker refuses for SIZE is split and retried, not settled rejected.
     *
     * <p>The worker reads a batch body under a 1 MiB budget ({@code
     * packages/runtime/src/body-readers.ts}) and answers {@code 413 PAYLOAD_TOO_LARGE} past it. A
     * whole-batch coded envelope is a verdict on every entry, so a count-only chunker settled the
     * lot {@code rejected} — 500 durable writes that would each have committed alone.
     */
    private static void batchRefusedForSizeIsSplitAndRetried() {
        covers("offline_flush_batch_splits_on_payload_too_large");

        int budget = 400;
        List<Integer> bodies = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            bodies.add(body.length);

                            if (body.length > budget) {
                                return new Response(
                                        413,
                                        "{\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"Body"
                                            + " too large\"}}");
                            }

                            return new Response(200, echoBatchSlots(body, "null", 1L));
                        });

        client.clientId = "c-1";
        client.offlineQueue(new OfflineQueue().persistence(store));

        List<String> queued = new ArrayList<>();
        Map<String, Object> args = new LinkedHashMap<>();

        args.put("text", "x".repeat(120));

        for (int index = 0; index < 4; index++) {
            String id = "m-" + index;

            queued.add(id);
            client.offlineQueue().enqueue(new QueuedMutation("messages:send", args, null, id));
        }

        FlushReport report = client.flushOfflineQueue(null);
        int largest = 0;

        for (int size : bodies) {
            largest = Math.max(largest, size);
        }

        check(
                report.committed.equals(queued),
                "every write commits; none is dropped for the size of the batch it shared");
        check(report.rejected.isEmpty(), "and nothing is settled rejected");
        check(client.offlineQueue().items().isEmpty(), "the queue drains");
        check(
                largest > budget,
                "the first attempt has to be the over-budget one, or nothing was split");
    }

    /**
     * An envelope-less 502 does not drop a LONE queued write.
     *
     * <p>{@code parseRpcResponse} codes such a body {@code INTERNAL} (protocol §4.2) and every code
     * outside the transient set used to be a verdict — so whether a gateway blip lost a durable
     * write depended on the queue's depth, because the same response with two or more writes was
     * already classified transient on the batch path.
     */
    private static void loneWriteSurvivesAnEnvelopeLess502() {
        covers("non_2xx_without_error_envelope_fails");

        MemoryStore store = new MemoryStore();
        List<MutationSettled> settled = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> new Response(502, "{\"message\":\"bad gateway\"}"));

        client.offlineQueue(new OfflineQueue().persistence(store));
        client.onMutationSettled(settled::add);
        client.offlineQueue()
                .enqueue(new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m-502"));

        FlushReport report = client.flushOfflineQueue(null);

        check(report.rejected.isEmpty(), "no verdict was reached, so nothing is rejected");
        check(report.requeued.equals(List.of("m-502")), "the write is re-queued");
        check(ids(client.offlineQueue().items()).equals(List.of("m-502")), "and stays queued");
        check(settled.isEmpty(), "nothing settled: no verdict was ever reached");
        check(store.removed.isEmpty(), "the durable record stays, because the write is still good");
    }

    /**
     * A rate-limited replay is re-queued, and the delay the envelope names holds the next flush
     * off.
     *
     * <p>"Not now", not "no": the write is valid and the server asked for it later, so dropping it
     * loses data for being punctual — and replaying the identical burst immediately just earns the
     * same 429, indefinitely.
     */
    private static void rateLimitedReplayRequeuesAndDefersTheNextFlush() {
        covers("offline_flush_replays_and_confirms_optimistic");

        int[] posts = {0};
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            posts[0]++;

                            return new Response(
                                    429,
                                    "{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":60000},\"message\":\"slow"
                                        + " down\"}}");
                        });

        client.offlineQueue(new OfflineQueue().persistence(new MemoryStore()));
        client.offlineQueue()
                .enqueue(new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m-429"));

        FlushReport report = client.flushOfflineQueue(null);

        check(report.rejected.isEmpty(), "a rate limit is not a verdict on the write");
        check(report.requeued.equals(List.of("m-429")), "so it goes back on the queue");
        check(
                Long.valueOf(60000L).equals(report.retryAfterMs),
                "and the delay the envelope named is reported");

        FlushReport again = client.flushOfflineQueue(null);

        check(
                posts[0] == 1,
                "the second flush waits out the delay rather than earning the same 429");
        check(again.retryAfterMs != null && again.retryAfterMs > 0, "reporting what is left of it");
        check(
                ids(client.offlineQueue().items()).equals(List.of("m-429")),
                "the write is still queued");

        // The hint is a number this client did not write, so an absurd one must not be able to park
        // a durable queue for an hour with nothing able to shorten it.
        Client clamped =
                new Client(
                        "https://app.example",
                        (url, headers, body) ->
                                new Response(
                                        429,
                                        "{\"error\":{\"code\":\"RATE_LIMITED\",\"data\":{\"retryAfterMs\":3600000},\"message\":\"slow"
                                            + " down\"}}"));

        clamped.offlineQueue(new OfflineQueue().persistence(new MemoryStore()));
        clamped.offlineQueue()
                .enqueue(
                        new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m-hour"));

        check(
                Long.valueOf(Offline.MAX_RETRY_AFTER_MS)
                        .equals(clamped.flushOfflineQueue(null).retryAfterMs),
                "an over-long delay is clamped rather than honoured");

        // The same classification PER SLOT: a batch reply's slot body is exactly a §4.2 envelope,
        // so a rate-limited entry is retried and its hint read, exactly as a whole response is.
        Client batched =
                new Client(
                        "https://app.example",
                        (url, headers, body) ->
                                new Response(
                                        200,
                                        "{\"results\":[{\"id\":0,\"body\":{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":60000},\"message\":\"slow"
                                            + " down\"}}},{\"id\":1,\"body\":{\"commitCursor\":4,\"result\":null}}]}"));

        batched.offlineQueue(new OfflineQueue().persistence(new MemoryStore()));
        batched.offlineQueue()
                .enqueue(new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m-a"));
        batched.offlineQueue()
                .enqueue(new QueuedMutation("messages:send", new LinkedHashMap<>(), null, "m-b"));

        FlushReport slots = batched.flushOfflineQueue(null);

        check(
                slots.rejected.isEmpty(),
                "a rate-limited SLOT is not a verdict on that write either");
        check(slots.requeued.equals(List.of("m-a")), "so it goes back on the queue");
        check(slots.committed.equals(List.of("m-b")), "while its siblings still settle");
        check(
                Long.valueOf(60000L).equals(slots.retryAfterMs),
                "and the slot's own hint reaches the report");
    }

    /**
     * A restored write the capacity cap drops still reports, through the client-level observer.
     *
     * <p>Driven through {@link Client#hydrateOfflineQueue}, deliberately: a hydrated entry has no
     * per-entry handler, so a client that reports a discard through the entry's own reject callback
     * reports this eviction to NOBODY — the durable write is un-persisted and vanishes in silence.
     * Calling {@code OfflineQueue.hydrate()} directly is what the queue-level case above does, and
     * that is exactly the test that cannot see the bug.
     */
    private static void offlineQueueHydrateOverflowSettlesDiscarded() throws IOException {
        covers("offline_queue_hydrate_overflow_settles_discarded");

        Map<String, Object> overflow = scenario("offlineQueue", "hydrateOverflow");
        MemoryStore store = new MemoryStore(persistedRecords(overflow));
        List<MutationSettled> settled = new ArrayList<>();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> new Response(200, "{\"result\":null}"));

        client.offlineQueue(
                new OfflineQueue()
                        .maxItems(count(overflow.get("maxItems")))
                        .persistence(store)
                        .version((String) overflow.get("version")));
        client.onMutationSettled(settled::add);

        List<String> shardKeys = client.hydrateOfflineQueue();
        List<String> reported = new ArrayList<>();

        for (MutationSettled event : settled) {
            reported.add(event.mutationId());
        }

        check(
                ids(client.offlineQueue().items())
                        .equals(strings(overflow.get("queuedAfterHydrate"))),
                "hydration respects the capacity cap");
        check(
                reported.equals(strings(overflow.get("settledFromClient"))),
                "the evicted restored write reaches the client-level settled observer");
        check(
                settled.get(0).status() == MutationStatus.REJECTED
                        && settled.get(0).error() instanceof OfflineException coded
                        && coded.code.equals(overflow.get("settledCode")),
                "carrying the documented overflow code");
        // Read from the entry's own liveAwaiter, never restated as a literal at the settle site:
        // it is what tells a consumer this is a restored write's ONLY report rather than a live
        // caller's second one.
        check(
                settled.get(0).hadAwaiter()
                        == Boolean.TRUE.equals(overflow.get("settledHadAwaiter")),
                "and stamped as having no live awaiter");
        // Only the shards whose writes SURVIVED — a key gathered before eviction would send the
        // caller to open a socket with nothing queued behind it.
        check(
                shardKeys.equals(strings(overflow.get("shardKeys"))),
                "and only the surviving shards are reported");
        check(
                store.removed.equals(strings(overflow.get("evicted"))),
                "the evicted write is un-persisted");
    }

    /**
     * The entry cap is not a port's to choose: the worker and the shard DO both refuse a larger
     * batch with a coded 400, which {@code protocol/README.md} 4.3 makes a TERMINAL verdict - so a
     * client chunking at a stale value discards durable writes instead of retrying them. It was a
     * bare 500 in ten independent places with nothing reconciling them.
     */
    private static void batchEntryCapMatchesProtocol() throws IOException {
        covers("batch_entry_cap_matches_protocol");

        Map<String, Object> testCase = scenario("offlineQueue", "batchReplay");
        int expected = ((Number) testCase.get("maxEntries")).intValue();

        check(
                Offline.MAX_BATCH_ENTRIES == expected,
                "batch entry cap: " + Offline.MAX_BATCH_ENTRIES + ", want " + expected);
    }

    /**
     * Two or more queued writes coalesce into ONE {@code /_lunora/rpc-batch} round trip, and each
     * slot is classified exactly as a whole single-call response is.
     */
    @SuppressWarnings("unchecked")
    private static void offlineFlushBatchesMultipleWrites() throws IOException {
        covers("offline_flush_batches_multiple_writes");

        Map<String, Object> testCase = scenario("offlineQueue", "batchReplay");
        List<Object> slots = list(testCase.get("slots"));
        List<String> urls = new ArrayList<>();
        List<Object> calls = new ArrayList<>();
        List<Long> confirmed = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            urls.add(url);
                            calls.addAll(batchCalls(body));

                            StringBuilder answers = new StringBuilder();

                            for (Object raw : slots) {
                                Map<String, Object> slot = map(raw);

                                if (answers.length() > 0) {
                                    answers.append(',');
                                }

                                answers.append("{\"id\":").append(count(slot.get("id")));

                                if ("ok".equals(slot.get("outcome"))) {
                                    answers.append(",\"body\":{\"commitCursor\":")
                                            .append(count(slot.get("commitCursor")))
                                            .append(",\"result\":null}}");

                                    continue;
                                }

                                answers.append(",\"body\":{\"error\":{\"code\":\"")
                                        .append(slot.get("code"))
                                        .append("\",\"message\":\"slot failed\"}}}");
                            }

                            return new Response(200, "{\"results\":[" + answers + "]}");
                        });

        client.clientId = "c-1";
        client.offlineQueue(new OfflineQueue().persistence(store));

        for (String id : strings(testCase.get("queued"))) {
            QueuedMutation item =
                    new QueuedMutation("messages:send", new LinkedHashMap<>(), null, id);

            item.onCommit = confirmed::add;
            client.offlineQueue().enqueue(item);
        }

        FlushReport report = client.flushOfflineQueue(null);

        check(urls.size() == count(testCase.get("requests")), "the whole flush is one batch hop");
        check(urls.get(0).endsWith((String) testCase.get("path")), "sent to the batch endpoint");

        // The idempotency key and the client id ride in the ENTRY, not in a request header: a
        // batch is one hop carrying independent calls, and a single outer header would
        // de-duplicate the whole chunk against one id.
        List<Object> wanted = list(testCase.get("calls"));

        check(calls.size() == wanted.size(), "one entry per queued write");

        for (int index = 0; index < calls.size(); index++) {
            Map<String, Object> got = (Map<String, Object>) calls.get(index);
            Map<String, Object> want = map(wanted.get(index));

            check(
                    String.valueOf(got.get("clientId")).equals(String.valueOf(want.get("clientId")))
                            && String.valueOf(got.get("functionPath"))
                                    .equals(String.valueOf(want.get("functionPath")))
                            && count(got.get("id")) == count(want.get("id"))
                            && String.valueOf(got.get("mutationId"))
                                    .equals(String.valueOf(want.get("mutationId"))),
                    "entry " + index + " carries its own slot id, key and client id");
        }

        check(
                report.committed.equals(strings(testCase.get("committed"))),
                "the successful slot commits");
        // A transient shard code in a slot is not a verdict, so that write goes back on the queue
        // instead of being reported as failed — and so does the slot the server never returned.
        check(
                report.rejected.equals(strings(testCase.get("rejected"))),
                "only the coded verdict is terminal");
        check(
                ids(client.offlineQueue().items())
                        .equals(strings(testCase.get("queuedAfterFlush"))),
                "the transient and unanswered writes are re-queued, in order");
        check(
                store.removed.equals(strings(testCase.get("persistRemoveCalls"))),
                "only the settled writes are un-persisted");
        check(
                confirmed.equals(List.of((long) count(testCase.get("confirmedCommitCursor")))),
                "and the committed write confirms against the echoed cursor");
    }

    /**
     * A queued write whose args cannot be wire-encoded settles TERMINALLY on the first flush.
     *
     * <p>A codec failure carries no server code, so the transient rule would re-queue it at the
     * FRONT and retry it on every reconnect forever: never settling its caller, never rolling its
     * overlay back, and blocking every write behind it in the FIFO.
     */
    private static void offlineFlushUnencodableWriteSettlesTerminal() throws IOException {
        covers("offline_flush_unencodable_write_settles_terminal");

        Map<String, Object> testCase = scenario("offlineQueue", "unencodableWrite");
        List<String> unencodable = strings(testCase.get("unencodable"));
        List<String> seenHeaders = new ArrayList<>();
        List<MutationSettled> settled = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            seenHeaders.add(headers.get("x-lunora-mutation-id"));

                            return new Response(200, "{\"result\":{\"ok\":true}}");
                        });

        client.offlineQueue(new OfflineQueue().persistence(store));
        client.onMutationSettled(settled::add);

        for (String id : strings(testCase.get("queued"))) {
            Map<String, Object> args = new LinkedHashMap<>();

            // A class instance in a `v.any()` field: nothing the wire codec can carry.
            if (unencodable.contains(id)) {
                args.put("blob", new Object());
            }

            client.offlineQueue().enqueue(new QueuedMutation("messages:send", args, null, id));
        }

        FlushReport report = client.flushOfflineQueue(null);

        check(
                report.rejected.equals(strings(testCase.get("rejected"))),
                "the unencodable write is rejected rather than retried");
        check(
                report.committed.equals(strings(testCase.get("committed"))),
                "and the survivors alone replay");
        // Only the encodable write reached the wire — the other never even attempted a POST.
        check(
                seenHeaders.equals(strings(testCase.get("mutationIdHeaders"))),
                "the unencodable write never reaches the server");
        check(
                ids(client.offlineQueue().items())
                        .equals(strings(testCase.get("queuedAfterFlush"))),
                "and nothing is left to poison the next flush");
        check(
                store.removed.equals(strings(testCase.get("persistRemoveCalls"))),
                "both are un-persisted");
        check(
                settled.get(0).status() == MutationStatus.REJECTED
                        && settled.get(0).error() instanceof OfflineException coded
                        && coded.code.equals(testCase.get("code")),
                "with the documented terminal code");
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
        List<Object> responses = list(testCase.get("responses"));
        List<String> seenIds = new ArrayList<>();
        List<Long> confirmed = new ArrayList<>();
        MemoryStore store = new MemoryStore();
        // The three fixture outcomes, as this transport now expresses them. Three queued writes
        // coalesce into ONE batch hop, so `ok` and `coded-error` are slots and `transport-error`
        // is an ABSENT slot: a per-entry transport failure is the server not answering for that
        // entry, and an unanswered write is retried under its original idempotency key exactly as
        // an uncoded throw re-queues on the single-call path.
        Client client =
                new Client(
                        "https://app.example",
                        (url, headers, body) -> {
                            seenIds.addAll(batchMutationIds(body));

                            StringBuilder slots = new StringBuilder();

                            for (int index = 0; index < responses.size(); index++) {
                                Map<String, Object> spec = map(responses.get(index));
                                Object outcome = spec.get("outcome");

                                if ("transport-error".equals(outcome)) {
                                    continue;
                                }

                                if (slots.length() > 0) {
                                    slots.append(',');
                                }

                                slots.append("{\"id\":").append(index).append(",\"body\":");

                                if ("coded-error".equals(outcome)) {
                                    slots.append("{\"error\":{\"code\":\"")
                                            .append(spec.get("code"))
                                            .append("\",\"message\":\"gone\"}}}");

                                    continue;
                                }

                                slots.append("{\"commitCursor\":")
                                        .append(count(spec.get("commitCursor")))
                                        .append(",\"result\":{\"ok\":true}}}");
                            }

                            return new Response(200, "{\"results\":[" + slots + "]}");
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
                seenIds.equals(strings(testCase.get("mutationIdHeaders"))),
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

        MutationOutcome outcome =
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

        MutationOutcome outcome =
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
        List<MutationSettled> settled = new ArrayList<>();
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
