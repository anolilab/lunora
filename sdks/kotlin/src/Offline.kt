package dev.lunora

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong

/** The oldest write was dropped because the queue is at capacity. */
const val OFFLINE_QUEUE_OVERFLOW: String = "OFFLINE_QUEUE_OVERFLOW"

/** The write's precondition no longer held when the flush reached it. */
const val OFFLINE_PRECONDITION_FAILED: String = "OFFLINE_PRECONDITION_FAILED"

/** The write was queued under a different identity than the one now in effect. */
const val OFFLINE_IDENTITY_CHANGED: String = "OFFLINE_IDENTITY_CHANGED"

/**
 * The write's arguments cannot be wire-encoded, so it can never succeed.
 *
 * A codec failure carries no server code, which the transient rule would read as
 * "a transport blip, re-queue it" — and a re-queue puts the write back at the
 * FRONT, so it would retry forever, never settle its caller, never roll its
 * overlay back, and block every write behind it in the FIFO.
 */
const val OFFLINE_WRITE_UNENCODABLE: String = "OFFLINE_WRITE_UNENCODABLE"

/**
 * A restored record's args are not readable as wire values — the store was
 * corrupted, or written by an incompatible build.
 *
 * Such a record has no correct replay: sending it with substitute args would
 * commit a DIFFERENT write than the caller made, which is corruption rather than
 * failure, and throwing out of the hydrate kills the whole restart path along
 * with every other queued write.
 */
const val OFFLINE_WRITE_UNDECODABLE: String = "OFFLINE_WRITE_UNDECODABLE"

/** The client was closed while the write was still queued. */
const val CLIENT_CLOSED: String = "CLIENT_CLOSED"

/**
 * The coded errors a replay must NOT treat as the server's final word.
 *
 * The shard was momentarily unreachable, so the identical call under the same
 * idempotency key is expected to succeed later, and dropping the write would lose
 * it to a transient condition. Every other coded error IS a verdict: replaying it
 * would only re-trigger the same failure, a poison-message loop.
 */
val TRANSIENT_ERROR_CODES: Set<String> = setOf("SHARD_ERROR", "SHARD_UNAVAILABLE")

/**
 * The codes that say "not now" rather than "no".
 *
 * A rate-limited replay is the one verdict a durable queue must never honour: the
 * write is perfectly valid and the server is asking for it later, so dropping it
 * loses data for being punctual. The delay comes from the envelope's
 * `data.retryAfterMs` (see `protocol/fixtures/rpc.json`'s `responseError.with-data`).
 */
val RATE_LIMIT_ERROR_CODES: Set<String> = setOf("RATE_LIMITED", "TOO_MANY_REQUESTS")

/**
 * Hard cap on entries in one batch, matching the server's own
 * (`shared/batch-wire.ts`). A Durable Object is single-threaded and replays a
 * batch's entries sequentially, so an unbounded one could pin a shard for tens of
 * thousands of dispatches. A flush with a larger backlog chunks itself.
 */
const val MAX_BATCH_ENTRIES: Int = 500

/**
 * Byte budget for one batch body, under the worker's own 1 MiB body cap
 * (`packages/runtime/src/body-readers.ts`). The entry cap alone is blind to size:
 * 500 writes carrying bytes or long text exceed a megabyte, the worker answers
 * `413 PAYLOAD_TOO_LARGE`, and a whole-batch coded envelope is a verdict on every
 * entry — so a count-only chunker settles 500 durable writes `rejected` that would
 * each have committed alone. The 64 KiB of headroom covers the request line, the
 * headers and the JSON framing this estimate does not weigh.
 */
const val MAX_BATCH_BYTES: Int = 1_048_576 - 65_536

/**
 * The longest rate-limit delay a flush will honour, matching `@lunora/client`.
 *
 * A server that names an hour would otherwise park a durable queue for an hour;
 * the caller re-flushes on its own reconnect long before that, and a limiter that
 * still refuses simply says so again.
 */
const val MAX_RETRY_AFTER_MS: Long = 60_000

/**
 * The worker's answer to a body over its cap. Coded, so it arrives as a
 * whole-batch envelope — which every other coded envelope is a verdict on every
 * entry, and this one is not.
 */
const val PAYLOAD_TOO_LARGE: String = "PAYLOAD_TOO_LARGE"

/** Bounds the queue when no capacity is configured. */
const val DEFAULT_MAX_ITEMS: Int = 1000

/** A coded, queue-scoped failure. */
class OfflineException(val code: String, message: String) : RuntimeException(message)

/**
 * Who made a queued write.
 *
 * Three states, not two, and the third is load-bearing. [Absent] is a record that
 * carries no stamp at all — written before stamping existed — and replays
 * ambiently under whatever identity is current. [SignedOut] is a write made with
 * nobody signed in, which must replay signed out. [Of] names the subject.
 * Collapsing the first two would either strand every old record or silently push
 * one user's queued writes as another.
 */
sealed class Identity {
    object Absent : Identity()

    object SignedOut : Identity()

    data class Of(val subject: String) : Identity()

    companion object {
        /** The identity a live write is stamped with; null means signed out. */
        fun stamp(subject: String?): Identity = if (subject == null) SignedOut else Of(subject)
    }
}

/**
 * Whether two shard keys name the SAME shard.
 *
 * Absent and empty are one key, not two: a consumer that submits with
 * `shardKey = ""` must be drained by the flush for the default shard, and its
 * optimistic overlay must target the subscription opened with no key. Comparing
 * them strictly leaves such a write queued forever, because nothing ever flushes
 * a shard named `""`.
 */
fun sameShard(left: String?, right: String?): Boolean = (left ?: "") == (right ?: "")

/** Whether a write stamped [stamped] may replay under [current] (null = signed out). */
fun identityAllowsReplay(stamped: Identity, current: String?): Boolean = when (stamped) {
    is Identity.Absent -> true
    is Identity.SignedOut -> current == null
    is Identity.Of -> stamped.subject == current
}

/**
 * Durable storage for queued writes. Injected, and synchronous.
 *
 * [append] and [remove] are best-effort from the queue's point of view: a thrown
 * exception is reported through the persistence-error observer and the write
 * carries on, because losing durability is strictly better than losing the write
 * itself. [load] is the one call whose failure propagates — hydrating from a store
 * that cannot be read must not look like an empty store.
 */
interface PersistenceAdapter {
    fun append(record: Map<String, Any?>)

    fun load(): List<Map<String, Any?>>

    fun remove(mutationId: String)

    fun clear()
}

/**
 * A write the queue let go of without sending it, and the coded reason.
 *
 * Returned rather than settled in place, which is the whole point: the client
 * calls into this queue with its own monitor held (see [OfflineQueue]), and
 * settling rolls optimistic layers back and notifies listeners — which needs that
 * same monitor. `synchronized` is reentrant, so this port never deadlocked over
 * it, but it did run a consumer's callback inside the critical section that
 * guards the subscription registry. The caller settles these once it has left the
 * monitor.
 */
data class Discarded(val entry: QueuedMutation, val code: String, val message: String) {
    /** The coded error this write settles with. */
    fun error(): OfflineException = OfflineException(code, message)
}

/** One write waiting for the socket to come back. */
class QueuedMutation(
    /**
     * The stable idempotency key the replay sends as `x-lunora-mutation-id`, so
     * the server de-duplicates a write it already committed rather than applying
     * it twice.
     */
    var id: String,
    val functionPath: String,
    val args: WireValue,
    /** Null routes to the default shard. */
    val shardKey: String? = null,
) {
    /**
     * The client id that ISSUED the write. Persisted and restored, so a replay
     * namespaces server-side under the id that made it rather than whatever the
     * current session minted.
     */
    var clientId: String? = null

    var identity: Identity = Identity.Absent

    /**
     * False for a write restored from storage after a restart — its original
     * caller is gone, so the settle observer is the only report it will produce.
     */
    var liveAwaiter: Boolean = false

    /**
     * Re-evaluated just before replay; false drops the write instead of replaying
     * one that can only fail (the row it edited was deleted while offline).
     */
    var precondition: (() -> Boolean)? = null

    /**
     * Fires on a successful replay with the echoed commit cursor, so a pending
     * optimistic layer drops gaplessly once a frame reaches it.
     */
    var onCommit: ((Long?) -> Unit)? = null

    /** Unwinds this write's optimistic layers when it settles as a rejection. */
    var onRollback: (() -> Unit)? = null

    /**
     * The submitting caller's own settle handler, carried as DATA rather than as a
     * closure that reports the verdict itself: the client emits every terminal
     * verdict to its own listeners unconditionally, and calls this IN ADDITION when
     * a live caller left one. A restored write has neither this nor [liveAwaiter],
     * so routing the report through it would settle an evicted durable write to
     * nobody.
     */
    var onSettled: ((MutationSettled) -> Unit)? = null

    /** The durable form. Callback fields are deliberately not persisted. */
    fun record(version: String?): Map<String, Any?> {
        val record = LinkedHashMap<String, Any?>()

        record["args"] = Wire.encode(args)
        record["functionPath"] = functionPath
        record["id"] = id
        clientId?.let { record["clientId"] = it }

        when (val stamp = identity) {
            is Identity.Absent -> Unit
            is Identity.SignedOut -> record["identity"] = null
            is Identity.Of -> record["identity"] = stamp.subject
        }

        shardKey?.let { record["shardKey"] = it }
        version?.let { record["version"] = it }

        return record
    }

    companion object {
        /**
         * Rebuilds a queued write from durable storage.
         *
         * The restored entry carries no resolve/reject: the caller that submitted
         * it did not survive the restart. A missing `identity` key restores as
         * [Identity.Absent] (a legacy record) while a stored null restores as
         * [Identity.SignedOut] — the distinction the identity gate turns on.
         *
         * Throws [WireFormatException] when the stored args are not wire values.
         * It never substitutes: a record hydrated as empty args replays
         * SUCCESSFULLY with the wrong arguments, which is corruption rather than
         * failure. [OfflineQueue.hydrate] settles such a record terminally.
         */
        fun fromRecord(record: Map<String, Any?>): QueuedMutation {
            val entry = QueuedMutation(
                record["id"] as? String ?: "",
                record["functionPath"] as? String ?: "",
                record["args"]?.let { Wire.decode(it) } ?: WireValue.Obj(emptyList()),
                record["shardKey"] as? String,
            )

            entry.clientId = record["clientId"] as? String
            entry.identity = if (!record.containsKey("identity")) {
                Identity.Absent
            } else {
                (record["identity"] as? String)?.let { Identity.Of(it) } ?: Identity.SignedOut
            }

            return entry
        }
    }
}

private val entropy = SecureRandom()
private val idCounter = AtomicLong()

/**
 * Mints a process-unique, collision-resistant id.
 *
 * It must be globally unique rather than merely locally distinct: the server
 * scopes a replayed write's de-duplication watermark by `(identity, clientId)`,
 * and an anonymous push has no verified identity — so two anonymous clients that
 * collided would share one watermark namespace and each could suppress the
 * other's writes.
 */
fun randomId(): String {
    val bytes = ByteArray(8)

    entropy.nextBytes(bytes)

    val builder = StringBuilder(40)

    builder.append(String.format("%016x", System.nanoTime()))
    builder.append(String.format("%08x", idCounter.incrementAndGet() and 0xFFFFFFFFL))

    for (value in bytes) builder.append(String.format("%02x", value.toInt() and 0xFF))

    return builder.toString()
}

/**
 * Whether a persisted record should be dropped and purged on hydrate.
 *
 * Gating is OFF until a version is configured, so a consumer that never sets one
 * restores everything. Once set, a record stamped with anything else — including
 * one from before gating was adopted, which carries no stamp — is stale, so
 * adopting a version starts from a clean slate rather than replaying writes shaped
 * for an older schema.
 */
fun isStaleVersion(current: String?, stamped: String?): Boolean = current != null && stamped != current

/**
 * A bounded FIFO of writes waiting for the socket, optionally durable.
 *
 * Writes submitted while the socket is down are enqueued and replayed, in
 * submission order, once it comes back. With a [PersistenceAdapter] wired they are
 * mirrored to durable storage as well, so [hydrate] restores them after a restart
 * and the next flush replays them.
 *
 * The queue is deliberately transport-free: it never sends anything. The client
 * owns the flush ([Client.flushOfflineQueue]), which is what keeps this class
 * testable with no network and lets a consumer drive a flush from its own
 * reconnect logic.
 *
 * Not internally synchronized, and deliberately so: every method mutates the same
 * list, and the client that owns the queue already holds a monitor over its
 * subscription registry. Two locks over one logical operation is how a deadlock
 * gets built. Call these with the owning client's monitor held — which is what
 * [Client] does — or from one thread.
 *
 * Nothing here invokes a consumer's callback, which is what makes calling it under
 * that monitor safe: every method that lets go of a write RETURNS it as a
 * [Discarded] instead, and the client settles those once it has left the monitor.
 * See [Discarded] for what the alternative cost.
 *
 * **Divergences from `@lunora/client`**, all recorded in `sdks/README.md`: the
 * persistence adapter is SYNCHRONOUS; the identity stamp is an opaque string the
 * CONSUMER sets ([Client.identity]) rather than a fingerprint derived from an auth
 * token, because these SDKs do not manage auth sessions and a derived stamp would
 * mean persisting a hash of a bearer token in the consumer's storage; and there is
 * no multi-tab leader election, because there are no tabs.
 */
class OfflineQueue(
    maxItems: Int = DEFAULT_MAX_ITEMS,
    /**
     * Whether writes may queue before the socket has EVER connected. Off by
     * default: without it a misconfigured endpoint silently accumulates writes
     * that will never flush instead of failing on the first one.
     */
    val queueBeforeFirstConnect: Boolean = false,
    private val persistence: PersistenceAdapter? = null,
    /**
     * Stamps persisted writes; a record from another version is purged on hydrate.
     * Null turns gating off.
     */
    private val version: String? = null,
) {
    /**
     * Clamped to at least one: a cap of zero accepts a write and evicts it in the
     * same call, so every submit reports "queued" and then settles
     * OFFLINE_QUEUE_OVERFLOW — a queue that cannot hold anything is a
     * misconfiguration, not a policy.
     */
    private val maxItems: Int = maxItems.coerceAtLeast(1)

    private val items = mutableListOf<QueuedMutation>()

    /** Notified with the new depth after any size change. */
    var onSizeChange: ((Int) -> Unit)? = null

    /** Notified when a durable append or remove threw: operation, error, write id. */
    var onPersistenceError: ((String, RuntimeException, String?) -> Unit)? = null

    val size: Int get() = items.size

    /** A snapshot of the queued writes, oldest first. */
    fun items(): List<QueuedMutation> = items.toList()

    /**
     * Adds a write to the back of the queue, persisting it and capping the queue.
     * Returns whatever the cap evicted, for the caller to report.
     */
    fun enqueue(entry: QueuedMutation): List<Discarded> {
        if (entry.id.isEmpty()) entry.id = randomId()

        items.add(entry)

        persistence?.let { store -> persist("append", entry.id) { store.append(entry.record(version)) } }

        val evicted = evictOverflow()

        notifySize()

        return evicted
    }

    /**
     * Restores writes persisted in a prior session.
     *
     * Returns the distinct shard keys of the records that SURVIVED — so the caller
     * can open exactly those sockets to trigger a flush — alongside every record
     * this restore let go of: what the capacity cap evicted, and what would not
     * decode. A no-op with no adapter configured.
     *
     * Restored records are placed AHEAD of whatever is already queued. Hydration
     * runs after construction (a durable load takes time), so a write submitted
     * during that boot window is already in the list — and the store's order is
     * authoritative, since a prior-session write is always older. Appending would
     * let a boot-time write replay first and last-writer-wins clobber newer data
     * with stale.
     */
    fun hydrate(): Hydrated {
        val store = persistence ?: return Hydrated(emptyList(), emptyList())
        val seen = items.mapTo(mutableSetOf()) { it.id }
        val restored = mutableListOf<QueuedMutation>()
        val undecodable = mutableListOf<Discarded>()

        for (record in store.load()) {
            val id = record["id"] as? String ?: ""

            if (!seen.add(id)) continue

            if (isStaleVersion(version, record["version"] as? String)) {
                persist("remove", id) { store.remove(id) }

                continue
            }

            try {
                restored.add(QueuedMutation.fromRecord(record))
            } catch (error: WireFormatException) {
                // Purged and REPORTED, never replayed with substitute args and
                // never thrown: a record whose args do not decode has no correct
                // replay, and failing the hydrate over one of them strands every
                // OTHER durable write in the store.
                persist("remove", id) { store.remove(id) }
                undecodable.add(
                    Discarded(
                        QueuedMutation(id, record["functionPath"] as? String ?: "", WireValue.Obj(emptyList()), record["shardKey"] as? String),
                        OFFLINE_WRITE_UNDECODABLE,
                        "offline mutation restored from storage cannot be wire-decoded: ${error.message}",
                    ),
                )
            }
        }

        items.addAll(0, restored)

        // A store holding more than maxItems (the cap was lowered between
        // sessions, or writes piled up across restarts) must not bypass it.
        val evicted = undecodable + evictOverflow()

        notifySize()

        // Shard keys are read AFTER eviction, from the entries that actually
        // survived: eviction drops from the front — the oldest restored records —
        // so a key gathered beforehand can name a shard with nothing queued.
        val survivors = items.mapTo(mutableSetOf()) { System.identityHashCode(it) }
        val shardKeys = restored.filter { System.identityHashCode(it) in survivors }.map { it.shardKey }.distinct()

        return Hydrated(shardKeys, evicted)
    }

    /** What one [hydrate] restored: the surviving shard keys, and what the cap dropped. */
    data class Hydrated(val shardKeys: List<String?>, val evicted: List<Discarded>)

    /**
     * Removes and returns queued writes, oldest first. A null predicate drains
     * everything; otherwise only the matching writes go and the rest stay queued
     * in order — which is how one shard flushes while others are still down.
     */
    fun drain(predicate: ((QueuedMutation) -> Boolean)? = null): List<QueuedMutation> {
        if (predicate == null) {
            val drained = items.toList()

            items.clear()
            notifySize()

            return drained
        }

        // One pass, not two filters: the predicate is the caller's, and calling it
        // twice per entry would double any side effect it happens to carry.
        val drained = mutableListOf<QueuedMutation>()
        val kept = mutableListOf<QueuedMutation>()

        for (item in items) (if (predicate(item)) drained else kept).add(item)

        if (drained.isNotEmpty()) {
            items.clear()
            items.addAll(kept)
            notifySize()
        }

        return drained
    }

    /**
     * Returns drained writes to the FRONT, in order, without re-persisting them:
     * they were never un-persisted, so durable storage still holds them. Used when
     * a flush aborts on a transient failure and the unreplayed writes must wait for
     * the next reconnect.
     */
    fun requeue(entries: List<QueuedMutation>) {
        if (entries.isEmpty()) return

        items.addAll(0, entries)
        notifySize()
    }

    /**
     * Drops and returns the writes named by [stale] — the ones whose precondition
     * no longer holds. Run at the start of a flush to weed out writes whose
     * assumptions died while the client was offline; the admitted writes keep their
     * FIFO order.
     *
     * The verdicts are the CALLER's to compute, because a precondition is the
     * consumer's own predicate and must run with the owning client's monitor
     * released, while this call mutates the queue and so must run with it held.
     */
    fun drainConflict(stale: Set<String>): List<Discarded> = drain { it.id in stale }
        .map { Discarded(it, OFFLINE_PRECONDITION_FAILED, "offline mutation skipped: precondition failed before replay") }

    /** Forgets one write's durable record, after it has terminally settled. */
    fun unpersist(mutationId: String?) {
        val store = persistence ?: return

        if (mutationId == null) return

        persist("remove", mutationId) { store.remove(mutationId) }
    }

    /**
     * Empties the queue and returns every pending write, so none is left waiting on
     * a dead client.
     *
     * Durable storage is left INTACT on purpose: closing must not discard writes a
     * future session will restore. Use the adapter's own `clear` to purge them.
     */
    fun clear(): List<Discarded> = drain().map { Discarded(it, CLIENT_CLOSED, "client closed with the write still queued") }

    /**
     * Drops from the FRONT (the oldest) until the queue is within capacity. Shared
     * by [enqueue] and [hydrate] so an overflow always drops the same way
     * regardless of which side pushed past the cap.
     *
     * The dropped entries are returned, never rejected here — a hydrated record has
     * no live caller, so the caller reporting them is the only thing that keeps an
     * eviction from dropping a durable write in total silence.
     */
    private fun evictOverflow(): List<Discarded> {
        val evicted = mutableListOf<Discarded>()

        while (items.size > maxItems) {
            val dropped = items.removeAt(0)

            unpersist(dropped.id)
            evicted.add(Discarded(dropped, OFFLINE_QUEUE_OVERFLOW, "offline queue overflow"))
        }

        return evicted
    }

    private fun persist(operation: String, mutationId: String?, call: () -> Unit) {
        try {
            call()
        } catch (error: RuntimeException) {
            onPersistenceError?.invoke(operation, error, mutationId)
        }
    }

    private fun notifySize() {
        onSizeChange?.invoke(items.size)
    }
}
