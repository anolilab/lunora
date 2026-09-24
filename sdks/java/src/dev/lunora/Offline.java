package dev.lunora;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * The durable offline write queue — a port of {@code packages/client/src/offline-queue.ts}.
 *
 * <p>Writes submitted while the socket is down are enqueued and replayed, in submission order, once
 * it comes back. With a {@link PersistenceAdapter} wired they are mirrored to durable storage as
 * well, so {@link OfflineQueue#hydrate} restores them after a restart and the next flush replays
 * them.
 *
 * <p>The queue is deliberately transport-free: it never sends anything. The client owns the flush
 * ({@code Client.flushOfflineQueue}), which is what keeps this class testable with no network and
 * lets a consumer drive a flush from its own reconnect logic.
 *
 * <p><b>Divergences from {@code @lunora/client}</b>, all recorded in {@code sdks/README.md}: the
 * persistence adapter is SYNCHRONOUS (the browser client's is async because IndexedDB is; a
 * consumer here injects whatever it likes and owns its own threading, exactly as it does for the
 * HTTP poster and the frame sender); the identity stamp is an opaque string the CONSUMER sets
 * ({@code Client.identity}) rather than a fingerprint derived from an auth token, because these
 * SDKs do not manage auth sessions and a derived stamp would mean persisting a hash of a bearer
 * token in the consumer's storage; and there is no multi-tab leader election, because there are no
 * tabs.
 */
public final class Offline {
    private Offline() {}

    /** The oldest write was dropped because the queue is at capacity. */
    public static final String OFFLINE_QUEUE_OVERFLOW = "OFFLINE_QUEUE_OVERFLOW";

    /** The write's precondition no longer held when the flush reached it. */
    public static final String OFFLINE_PRECONDITION_FAILED = "OFFLINE_PRECONDITION_FAILED";

    /** The write was queued under a different identity than the one now in effect. */
    public static final String OFFLINE_IDENTITY_CHANGED = "OFFLINE_IDENTITY_CHANGED";

    /** The client was closed while the write was still queued. */
    public static final String CLIENT_CLOSED = "CLIENT_CLOSED";

    /**
     * The write's arguments cannot be wire-encoded, so it can never succeed.
     *
     * <p>Terminal, deliberately. A codec failure carries no server code, so the transient rule
     * ("anything uncoded is a transport blip, re-queue it") would replay the write on every
     * reconnect forever — never settling its caller, never rolling its overlay back, and blocking
     * every write behind it in the FIFO.
     */
    public static final String OFFLINE_WRITE_UNENCODABLE = "OFFLINE_WRITE_UNENCODABLE";

    /**
     * A restored record's args are not readable as wire values — the store was corrupted, or
     * written by an incompatible build.
     *
     * <p>Purged and REPORTED rather than replayed with substitute args: a record hydrated as empty
     * args replays SUCCESSFULLY with the wrong arguments, which is corruption rather than failure.
     */
    public static final String OFFLINE_WRITE_UNDECODABLE = "OFFLINE_WRITE_UNDECODABLE";

    /**
     * Whether two shard keys name the same shard: an ABSENT key and an EMPTY one do.
     *
     * <p>A consumer that submits with {@code shardKey: ""} means the default shard, the same one
     * {@code null} names. Comparing the two strictly queues the write under a shard nothing ever
     * flushes, and points its optimistic overlay at a subscription that does not exist.
     */
    public static boolean sameShard(String left, String right) {
        return (left == null ? "" : left).equals(right == null ? "" : right);
    }

    /**
     * The coded errors a replay must NOT treat as the server's final word.
     *
     * <p>The shard was momentarily unreachable, so the identical call under the same idempotency
     * key is expected to succeed later, and dropping the write would lose it to a transient
     * condition. Every other coded error IS a verdict: replaying it would only re-trigger the same
     * failure, a poison-message loop.
     */
    public static final Set<String> TRANSIENT_ERROR_CODES =
            Set.of("SHARD_ERROR", "SHARD_UNAVAILABLE");

    /**
     * Codes that say "not now" rather than "no".
     *
     * <p>A rate-limited replay is the one verdict a durable queue must never honour: the write is
     * perfectly valid and the server is asking for it later, so dropping it loses data for being
     * punctual. The delay comes from the envelope's {@code data.retryAfterMs} (see {@code
     * protocol/fixtures/rpc.json}'s {@code responseError.with-data}).
     */
    public static final Set<String> RATE_LIMIT_ERROR_CODES =
            Set.of("RATE_LIMITED", "TOO_MANY_REQUESTS");

    /**
     * The longest delay a rate-limit hint is honoured for, matching the reference client's own
     * clamp. A server (or a proxy inventing one) that names an hour would otherwise park a durable
     * queue for an hour with nothing able to shorten it — the caller can always flush again sooner
     * once this window passes.
     */
    public static final long MAX_RETRY_AFTER_MS = 60_000L;

    /** Bounds the queue when no capacity is configured. */
    public static final int DEFAULT_MAX_ITEMS = 1000;

    /**
     * Hard cap on entries in one batch, matching the server's own ({@code shared/batch-wire.ts}).
     *
     * <p>A Durable Object is single-threaded and replays a batch's entries sequentially, so an
     * unbounded one could pin a shard for tens of thousands of dispatches. A flush with a larger
     * backlog chunks itself.
     */
    public static final int MAX_BATCH_ENTRIES = 500;

    /**
     * Byte budget for one batch body, under the worker's own 1 MiB body cap ({@code
     * packages/runtime/src/body-readers.ts}).
     *
     * <p>The entry cap alone is blind to size: 500 writes carrying bytes or long text exceed a
     * megabyte, the worker answers {@code 413 PAYLOAD_TOO_LARGE}, and a whole-batch coded envelope
     * is terminal for every entry — so a count-only chunker settles 500 durable writes {@code
     * rejected} that would each have committed alone. Written as the subtraction it is: the cap
     * minus 64 KiB of headroom for the request line, the headers and the JSON framing this estimate
     * does not weigh.
     */
    public static final int MAX_BATCH_BYTES = 1_048_576 - 65_536;

    /**
     * The worker's answer to a body over its cap. Coded, so it arrives as a whole-batch envelope —
     * which every other coded envelope is a verdict on every entry, and this one is not.
     */
    public static final String PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";

    /** A coded, queue-scoped failure. */
    public static final class OfflineException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public final String code;

        public OfflineException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /**
     * Who made a queued write.
     *
     * <p>Three states, not two, and the third is load-bearing. {@code absent()} is a record that
     * carries no stamp at all — written before stamping existed — and replays ambiently under
     * whatever identity is current. {@code signedOut()} is a write made with nobody signed in,
     * which must replay signed out. {@code of(subject)} names the subject. Collapsing the first two
     * would either strand every old record or silently push one user's queued writes as another.
     */
    public record Identity(boolean present, String subject) {
        public static Identity absent() {
            return new Identity(false, null);
        }

        public static Identity signedOut() {
            return new Identity(true, null);
        }

        public static Identity of(String subject) {
            return new Identity(true, subject);
        }
    }

    /**
     * Whether a write stamped {@code stamped} may replay under {@code current} (null = signed out).
     */
    public static boolean identityAllowsReplay(Identity stamped, String current) {
        if (stamped == null || !stamped.present()) {
            return true;
        }

        return stamped.subject() == null ? current == null : stamped.subject().equals(current);
    }

    /**
     * Durable storage for queued writes. Injected, and synchronous.
     *
     * <p>{@code append} and {@code remove} are best-effort from the queue's point of view: a thrown
     * exception is reported through the persistence-error observer and the write carries on,
     * because losing durability is strictly better than losing the write itself. {@code load} is
     * the one call whose failure propagates — hydrating from a store that cannot be read must not
     * look like an empty store.
     */
    public interface PersistenceAdapter {
        void append(Map<String, Object> record);

        List<Map<String, Object>> load();

        void remove(String mutationId);

        void clear();
    }

    /**
     * A write the queue let go of without sending it, and the coded reason.
     *
     * <p>Returned rather than rejected in place, which is the whole point: the client calls into
     * this queue with its own monitor held (see {@link OfflineQueue}), and a rejection handler
     * rolls optimistic layers back — which needs that same monitor. A {@code synchronized} block is
     * reentrant, so this port never deadlocked over it, but it did run a consumer's callback inside
     * the critical section that guards the subscription registry. Its Go sibling, whose mutex is
     * not reentrant, self-deadlocked outright. The caller settles these once it has left the
     * monitor.
     */
    public record Discarded(QueuedMutation entry, String code, String message) {
        /** The coded error this write settles with. */
        public OfflineException error() {
            return new OfflineException(code, message);
        }
    }

    /** One write waiting for the socket to come back. */
    public static final class QueuedMutation {
        /**
         * The stable idempotency key the replay sends as {@code x-lunora-mutation-id}, so the
         * server de-duplicates a write it already committed rather than applying it twice.
         */
        public String id;

        public String functionPath;
        public Object args;

        /** Null routes to the default shard. */
        public String shardKey;

        /**
         * The client id that ISSUED the write. Persisted and restored, so a replay namespaces
         * server-side under the id that made it rather than whatever the current session minted.
         */
        public String clientId;

        public Identity identity = Identity.absent();

        /**
         * Whether a live caller is waiting on this write. False by default, which is exactly right
         * for one restored from storage after a restart — its original caller is gone, so the
         * client-level settle observer is the only report it will ever produce.
         *
         * <p>Read at the settle site and stamped onto the {@link Submit.MutationSettled} event, so
         * a consumer can tell a restored write's only report from a live caller's second one. It is
         * the single source of that truth: restating it as a literal inside a settle closure is how
         * the two copies desync.
         */
        public boolean liveAwaiter;

        /**
         * Re-evaluated just before replay; false drops the write instead of replaying one that can
         * only fail (the row it edited was deleted while the client was offline).
         */
        public Supplier<Boolean> precondition;

        /**
         * Fires on a successful replay with the echoed commit cursor, so a pending optimistic layer
         * drops gaplessly once a frame reaches it.
         */
        public Consumer<Long> onCommit;

        /**
         * Takes this write's optimistic overlay back down when it settles as a rejection. Null for
         * a restored write, which has no overlay: the session that displayed one is gone.
         */
        public Consumer<RuntimeException> reject;

        /**
         * The submitting caller's per-write settle handler, carried as data rather than baked into
         * a closure so the terminal event is built once, at the settle site, from the entry's own
         * fields. Null for a restored write.
         */
        public Consumer<Submit.MutationSettled> onSettled;

        public QueuedMutation(String functionPath, Object args, String shardKey, String id) {
            this.args = args;
            this.functionPath = functionPath;
            this.id = id;
            this.shardKey = shardKey;
        }

        /**
         * The durable form. Callback fields are deliberately not persisted.
         *
         * <p>{@code args} is the WIRE form, not the native one. A real adapter serialises — a file,
         * a SQLite text column, a preferences store — and the native form carries the codec's own
         * wrappers, so a queued write with a bigint, bytes, date or map argument either fails to
         * serialise (and is reported "queued" while nothing durable was written) or serialises as
         * whatever the adapter makes of an opaque object and replays after a restart with CORRUPTED
         * args. Encoding here also throws for args outside the codec entirely, which {@link
         * OfflineQueue#enqueue} reports as the failed append it is — the write stays in memory with
         * its real args and settles terminally on the next flush, never persisted as a substitute.
         */
        public Map<String, Object> record(String version) {
            Map<String, Object> record = new LinkedHashMap<>();

            record.put("args", Wire.encode(args == null ? new LinkedHashMap<>() : args));
            record.put("functionPath", functionPath);
            record.put("id", id);

            if (clientId != null) {
                record.put("clientId", clientId);
            }

            if (identity != null && identity.present()) {
                record.put("identity", identity.subject());
            }

            if (shardKey != null) {
                record.put("shardKey", shardKey);
            }

            if (version != null) {
                record.put("version", version);
            }

            return record;
        }

        /**
         * Rebuilds a queued write from durable storage.
         *
         * <p>The restored entry carries no resolve/reject: the caller that submitted it did not
         * survive the restart. A missing {@code identity} key restores as absent (a legacy record)
         * while a stored null restores as signed out — the distinction the identity gate turns on.
         *
         * <p>Throws {@link Wire.WireFormatException} when the stored args are not wire values.
         * Never substitutes: a record hydrated as empty args replays SUCCESSFULLY with the wrong
         * arguments, which is corruption rather than failure. {@link OfflineQueue#hydrate} settles
         * such a record terminally instead.
         */
        public static QueuedMutation fromRecord(Map<String, Object> record) {
            QueuedMutation entry =
                    new QueuedMutation(
                            record.get("functionPath") instanceof String path ? path : "",
                            Wire.decode(record.get("args")),
                            record.get("shardKey") instanceof String shard ? shard : null,
                            record.get("id") instanceof String id ? id : "");

            entry.clientId = record.get("clientId") instanceof String id ? id : null;
            entry.identity =
                    record.containsKey("identity")
                            ? (record.get("identity") instanceof String subject
                                    ? Identity.of(subject)
                                    : Identity.signedOut())
                            : Identity.absent();

            return entry;
        }
    }

    private static final SecureRandom ENTROPY = new SecureRandom();
    private static final AtomicLong ID_COUNTER = new AtomicLong();

    /**
     * Mints a process-unique, collision-resistant id.
     *
     * <p>It must be globally unique rather than merely locally distinct: the server scopes a
     * replayed write's de-duplication watermark by {@code (identity, clientId)}, and an anonymous
     * push has no verified identity — so two anonymous clients that collided would share one
     * watermark namespace and each could suppress the other's writes.
     */
    public static String randomId() {
        byte[] entropy = new byte[8];

        ENTROPY.nextBytes(entropy);

        StringBuilder out = new StringBuilder(40);

        out.append(String.format("%016x", System.nanoTime()));
        out.append(String.format("%08x", ID_COUNTER.incrementAndGet() & 0xFFFFFFFFL));

        for (byte value : entropy) {
            out.append(String.format("%02x", value & 0xFF));
        }

        return out.toString();
    }

    /**
     * Whether a persisted record should be dropped and purged on hydrate.
     *
     * <p>Gating is OFF until a version is configured, so a consumer that never sets one restores
     * everything. Once set, a record stamped with anything else — including one from before gating
     * was adopted, which carries no stamp — is stale, so adopting a version starts from a clean
     * slate rather than replaying writes shaped for an older schema.
     */
    public static boolean isStaleVersion(String current, String stamped) {
        return current != null && !current.equals(stamped);
    }

    /**
     * A bounded FIFO of writes waiting for the socket, optionally durable.
     *
     * <p>Not internally synchronized, and deliberately so: every method mutates the same list, and
     * the client that owns the queue already holds a monitor over its subscription registry. Two
     * locks over one logical operation is how a deadlock gets built. Call these with the owning
     * client's monitor held — which is what {@link Client} does — or from one thread.
     *
     * <p>Nothing here invokes a consumer's callback, which is what makes calling it under that
     * monitor safe: every method that lets go of a write RETURNS it as a {@link Discarded} instead,
     * and the client settles those once it has left the monitor. See {@link Discarded} for what the
     * alternative cost.
     */
    public static final class OfflineQueue {
        private final List<QueuedMutation> items = new ArrayList<>();
        private int maxItems = DEFAULT_MAX_ITEMS;

        /**
         * Whether writes may queue before the socket has EVER connected. Off by default: without it
         * a misconfigured endpoint silently accumulates writes that will never flush instead of
         * failing on the first one.
         */
        public boolean queueBeforeFirstConnect;

        private PersistenceAdapter persistence;
        private String version;

        /** Notified with the new depth after any size change. */
        public IntConsumer onSizeChange;

        /** Notified when a durable append or remove threw: operation, error, write id. */
        public TriConsumer onPersistenceError;

        /** Reports a swallowed durable-write failure. */
        public interface TriConsumer {
            void accept(String operation, RuntimeException error, String mutationId);
        }

        public OfflineQueue maxItems(int maxItems) {
            this.maxItems = Math.max(1, maxItems);

            return this;
        }

        public OfflineQueue queueBeforeFirstConnect(boolean allowed) {
            this.queueBeforeFirstConnect = allowed;

            return this;
        }

        public OfflineQueue persistence(PersistenceAdapter persistence) {
            this.persistence = persistence;

            return this;
        }

        /**
         * Stamps persisted writes; a record from another version is purged on hydrate. Leaving it
         * unset turns gating off.
         */
        public OfflineQueue version(String version) {
            this.version = version;

            return this;
        }

        public int size() {
            return items.size();
        }

        /** A snapshot of the queued writes, oldest first. */
        public List<QueuedMutation> items() {
            return List.copyOf(items);
        }

        /**
         * Adds a write to the back of the queue, persisting it and capping the queue. Returns
         * whatever the cap evicted, for the caller to report.
         */
        public List<Discarded> enqueue(QueuedMutation entry) {
            if (entry.id == null) {
                entry.id = randomId();
            }

            items.add(entry);

            if (persistence != null) {
                persist("append", entry.id, () -> persistence.append(entry.record(version)));
            }

            List<Discarded> evicted = evictOverflow();

            notifySize();

            return evicted;
        }

        /**
         * Restores writes persisted in a prior session.
         *
         * <p>Returns the distinct shard keys of the records that SURVIVED — so the caller can open
         * exactly those sockets to trigger a flush — alongside whatever the capacity cap evicted. A
         * no-op with no adapter configured.
         *
         * <p>Restored records are placed AHEAD of whatever is already queued. Hydration runs after
         * construction (a durable load takes time), so a write submitted during that boot window is
         * already in the list — and the store's order is authoritative, since a prior-session write
         * is always older. Appending would let a boot-time write replay first and last-writer-wins
         * clobber newer data with stale.
         */
        public Hydrated hydrate() {
            if (persistence == null) {
                return new Hydrated(List.of(), List.of());
            }

            Set<String> seen = new HashSet<>();

            for (QueuedMutation item : items) {
                seen.add(item.id);
            }

            List<QueuedMutation> restored = new ArrayList<>();
            List<Discarded> undecodable = new ArrayList<>();

            for (Map<String, Object> record : persistence.load()) {
                String id = record.get("id") instanceof String text ? text : "";

                if (!seen.add(id)) {
                    continue;
                }

                String stamped = record.get("version") instanceof String text ? text : null;

                if (isStaleVersion(version, stamped)) {
                    persist("remove", id, () -> persistence.remove(id));

                    continue;
                }

                try {
                    restored.add(QueuedMutation.fromRecord(record));
                } catch (RuntimeException error) {
                    // Purged and REPORTED, never replayed with substitute args: a record whose args
                    // do not decode has no correct replay, and sending it with an empty argument
                    // object would commit a different write than the one the caller made.
                    persist("remove", id, () -> persistence.remove(id));

                    QueuedMutation husk =
                            new QueuedMutation(
                                    record.get("functionPath") instanceof String path ? path : "",
                                    null,
                                    record.get("shardKey") instanceof String shard ? shard : null,
                                    id);

                    undecodable.add(
                            new Discarded(
                                    husk,
                                    OFFLINE_WRITE_UNDECODABLE,
                                    "offline mutation restored from storage cannot be wire-decoded:"
                                            + " "
                                            + error.getMessage()));
                }
            }

            items.addAll(0, restored);

            // A store holding more than maxItems (the cap was lowered between sessions, or writes
            // piled up across restarts) must not bypass it.
            List<Discarded> evicted = new ArrayList<>(undecodable);

            evicted.addAll(evictOverflow());

            notifySize();

            // Shard keys are read AFTER eviction, from the entries that actually survived: eviction
            // drops from the front — the oldest restored records — so a key gathered beforehand can
            // name a shard with nothing queued behind it.
            Set<QueuedMutation> survivors = new HashSet<>(items);
            Set<String> shardKeys = new LinkedHashSet<>();

            for (QueuedMutation entry : restored) {
                if (survivors.contains(entry)) {
                    shardKeys.add(entry.shardKey);
                }
            }

            return new Hydrated(new ArrayList<>(shardKeys), evicted);
        }

        /**
         * What one {@link #hydrate} restored: the surviving shard keys, and what the cap dropped.
         */
        public record Hydrated(List<String> shardKeys, List<Discarded> evicted) {}

        /**
         * Removes and returns queued writes, oldest first. A null predicate drains everything;
         * otherwise only the matching writes go and the rest stay queued in order — which is how
         * one shard flushes while others are still down.
         */
        public List<QueuedMutation> drain(Predicate<QueuedMutation> predicate) {
            if (predicate == null) {
                List<QueuedMutation> drained = new ArrayList<>(items);

                items.clear();
                notifySize();

                return drained;
            }

            // One pass, not two filters: the predicate is the caller's, and calling it twice per
            // entry would double any side effect it happens to carry.
            List<QueuedMutation> drained = new ArrayList<>();
            List<QueuedMutation> kept = new ArrayList<>();

            for (QueuedMutation item : items) {
                (predicate.test(item) ? drained : kept).add(item);
            }

            if (!drained.isEmpty()) {
                items.clear();
                items.addAll(kept);
                notifySize();
            }

            return drained;
        }

        /**
         * Returns drained writes to the FRONT, in order, without re-persisting them: they were
         * never un-persisted, so durable storage still holds them. Used when a flush aborts on a
         * transient failure and the unreplayed writes must wait for the next reconnect.
         */
        public void requeue(List<QueuedMutation> entries) {
            if (entries.isEmpty()) {
                return;
            }

            items.addAll(0, entries);
            notifySize();
        }

        /**
         * Drops the writes named in {@code stale} and returns them. Run at the start of a flush to
         * weed out writes whose assumptions died while the client was offline; the admitted writes
         * keep their FIFO order.
         *
         * <p>It takes the VERDICTS, not the predicates: a {@code precondition} is the consumer's
         * own code and must run with this client's monitor RELEASED, while this call mutates the
         * queue and so must run with it held. Evaluating them inline here would run consumer code
         * inside the lock guarding the subscription registry, stalling the socket read loop — and a
         * predicate that called back into the client would deadlock on the sibling ports whose lock
         * is not reentrant.
         */
        public List<Discarded> drainConflict(Set<String> stale) {
            return drain(item -> stale.contains(item.id)).stream()
                    .map(
                            item ->
                                    new Discarded(
                                            item,
                                            OFFLINE_PRECONDITION_FAILED,
                                            "offline mutation skipped: precondition failed before"
                                                    + " replay"))
                    .toList();
        }

        /** Forgets one write's durable record, after it has terminally settled. */
        public void unpersist(String mutationId) {
            if (persistence == null || mutationId == null) {
                return;
            }

            persist("remove", mutationId, () -> persistence.remove(mutationId));
        }

        /**
         * Empties the queue and returns every pending write, so none is left waiting on a dead
         * client.
         *
         * <p>Durable storage is left INTACT on purpose: closing must not discard writes a future
         * session will restore. Use the adapter's own {@code clear} to purge them.
         */
        public List<Discarded> clear() {
            return drain(null).stream()
                    .map(
                            item ->
                                    new Discarded(
                                            item,
                                            CLIENT_CLOSED,
                                            "client closed with the write still queued"))
                    .toList();
        }

        /**
         * Drops from the FRONT (the oldest) until the queue is within capacity. Shared by {@link
         * #enqueue} and {@link #hydrate} so an overflow always drops the same way regardless of
         * which side pushed past the cap.
         *
         * <p>The dropped entries are returned, never rejected here — a hydrated record has no live
         * caller, so the caller reporting them is the only thing that keeps an eviction from
         * dropping a durable write in total silence.
         */
        private List<Discarded> evictOverflow() {
            List<Discarded> evicted = new ArrayList<>();

            while (items.size() > maxItems) {
                QueuedMutation dropped = items.remove(0);

                unpersist(dropped.id);
                evicted.add(
                        new Discarded(dropped, OFFLINE_QUEUE_OVERFLOW, "offline queue overflow"));
            }

            return evicted;
        }

        private void persist(String operation, String mutationId, Runnable call) {
            try {
                call.run();
            } catch (RuntimeException error) {
                if (onPersistenceError != null) {
                    onPersistenceError.accept(operation, error, mutationId);
                }
            }
        }

        private void notifySize() {
            if (onSizeChange != null) {
                onSizeChange.accept(items.size());
            }
        }
    }
}
