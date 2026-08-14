package dev.lunora

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong

/** The oldest write was dropped because the queue is at capacity. */
const val OFFLINE_QUEUE_OVERFLOW: String = "OFFLINE_QUEUE_OVERFLOW"

/** The write's precondition no longer held when the flush reached it. */
const val OFFLINE_PRECONDITION_FAILED: String = "OFFLINE_PRECONDITION_FAILED"

/** The write was queued under a different identity than the one now in effect. */
const val OFFLINE_IDENTITY_CHANGED: String = "OFFLINE_IDENTITY_CHANGED"

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

    var resolve: ((WireValue) -> Unit)? = null
    var reject: ((RuntimeException) -> Unit)? = null

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
 * **Divergences from `@lunora/client`**, all recorded in `sdks/README.md`: the
 * persistence adapter is SYNCHRONOUS; the identity stamp is an opaque string the
 * CONSUMER sets ([Client.identity]) rather than a fingerprint derived from an auth
 * token, because these SDKs do not manage auth sessions and a derived stamp would
 * mean persisting a hash of a bearer token in the consumer's storage; and there is
 * no multi-tab leader election, because there are no tabs.
 */
class OfflineQueue(
    private val maxItems: Int = DEFAULT_MAX_ITEMS,
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
    private val items = mutableListOf<QueuedMutation>()

    /** Notified when the cap discards a write, with the coded reason. */
    var onEvict: ((QueuedMutation, OfflineException) -> Unit)? = null

    /** Notified with the new depth after any size change. */
    var onSizeChange: ((Int) -> Unit)? = null

    /** Notified when a durable append or remove threw: operation, error, write id. */
    var onPersistenceError: ((String, RuntimeException, String?) -> Unit)? = null

    val size: Int get() = items.size

    /** A snapshot of the queued writes, oldest first. */
    fun items(): List<QueuedMutation> = items.toList()

    fun enqueue(entry: QueuedMutation) {
        if (entry.id.isEmpty()) entry.id = randomId()

        items.add(entry)

        persistence?.let { store -> persist("append", entry.id) { store.append(entry.record(version)) } }

        evictOverflow()
        notifySize()
    }

    /**
     * Restores writes persisted in a prior session, returning the distinct shard
     * keys of the records that SURVIVED so the caller can open exactly those
     * sockets to trigger a flush. A no-op with no adapter configured.
     *
     * Restored records are placed AHEAD of whatever is already queued. Hydration
     * runs after construction (a durable load takes time), so a write submitted
     * during that boot window is already in the list — and the store's order is
     * authoritative, since a prior-session write is always older. Appending would
     * let a boot-time write replay first and last-writer-wins clobber newer data
     * with stale.
     */
    fun hydrate(): List<String?> {
        val store = persistence ?: return emptyList()
        val seen = items.mapTo(mutableSetOf()) { it.id }
        val restored = mutableListOf<QueuedMutation>()

        for (record in store.load()) {
            val id = record["id"] as? String ?: ""

            if (!seen.add(id)) continue

            if (isStaleVersion(version, record["version"] as? String)) {
                persist("remove", id) { store.remove(id) }

                continue
            }

            restored.add(QueuedMutation.fromRecord(record))
        }

        items.addAll(0, restored)

        // A store holding more than maxItems (the cap was lowered between
        // sessions, or writes piled up across restarts) must not bypass it.
        evictOverflow()
        notifySize()

        // Shard keys are read AFTER eviction, from the entries that actually
        // survived: eviction drops from the front — the oldest restored records —
        // so a key gathered beforehand can name a shard with nothing queued.
        val survivors = items.mapTo(mutableSetOf()) { System.identityHashCode(it) }

        return restored.filter { System.identityHashCode(it) in survivors }.map { it.shardKey }.distinct()
    }

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
     * Drops the writes whose precondition no longer holds, rejecting each, and
     * returns them. Run at the start of a flush to weed out writes whose
     * assumptions died while the client was offline; the admitted writes keep their
     * FIFO order.
     */
    fun drainConflict(): List<QueuedMutation> {
        val conflicted = drain { item -> item.precondition?.let { !it() } == true }

        for (item in conflicted) {
            settleRejected(
                item,
                OfflineException(OFFLINE_PRECONDITION_FAILED, "offline mutation skipped: precondition failed before replay"),
            )
        }

        return conflicted
    }

    /** Forgets one write's durable record, after it has terminally settled. */
    fun unpersist(mutationId: String?) {
        val store = persistence ?: return

        if (mutationId == null) return

        persist("remove", mutationId) { store.remove(mutationId) }
    }

    /**
     * Rejects every pending write so no caller waits on a dead client.
     *
     * Durable storage is left INTACT on purpose: closing must not discard writes a
     * future session will restore. Use the adapter's own `clear` to purge them.
     */
    fun clear() {
        val drained = items.toList()

        items.clear()
        notifySize()

        for (item in drained) {
            settleRejected(item, OfflineException(CLIENT_CLOSED, "client closed with the write still queued"))
        }
    }

    /**
     * Drops from the FRONT (the oldest) until the queue is within capacity. Shared
     * by [enqueue] and [hydrate] so an overflow always drops the same way
     * regardless of which side pushed past the cap.
     */
    private fun evictOverflow() {
        while (items.size > maxItems) {
            val dropped = items.removeAt(0)

            unpersist(dropped.id)

            val error = OfflineException(OFFLINE_QUEUE_OVERFLOW, "offline queue overflow")

            settleRejected(dropped, error)

            // Also reported to the evict observer: a hydrated record has no live
            // caller, so without this an eviction would drop a durable write in
            // total silence.
            onEvict?.invoke(dropped, error)
        }
    }

    private fun settleRejected(item: QueuedMutation, error: OfflineException) {
        try {
            item.reject?.invoke(error)
        } catch (thrown: RuntimeException) {
            // A consumer's rejection handler throwing is not this queue's problem.
        }
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
