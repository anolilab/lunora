package dev.lunora

// The offline-capable write path: `submit`, the flush that replays what it
// queued, and the optimistic layers both settle.
//
// A separate file from `Client.kt`, which is the transport — the RPC envelope,
// the subscription registry and the frame handler. Kotlin has top-level
// declarations and extension functions, so the split costs nothing at the call
// site: `client.submit(…)` reads exactly as a member would, and the write path's
// value types live beside the code that produces them rather than at the top of a
// thousand-line file.
//
// The client's own fields are `internal` for that reason, and only for it.

/** What [submit] did with a write. */
enum class MutationStatus { COMMITTED, QUEUED, REJECTED }

/**
 * What [submit] did with a write.
 *
 * This is the deliberate divergence from `@lunora/client`, whose `mutation()`
 * returns a promise that stays PENDING until a queued write finally replays. A
 * pending promise is a fine thing to hold in a browser event loop and a bad thing
 * to hold on a pooled JVM thread, so the ports return the outcome immediately and
 * report the eventual verdict through `onSettled` (per write) or
 * [Client.onMutationSettled] (per client). A caller that must not report success
 * early checks [status].
 */
data class MutationOutcome(val status: MutationStatus, val mutationId: String, val value: WireValue? = null, val commitCursor: Long? = null)

/**
 * The terminal verdict on a queued write, once it replays.
 *
 * [hadAwaiter] is false for a write restored from durable storage: the caller that
 * submitted it is gone, so this event is the ONLY report it produces. It is READ
 * from the settling entry's [QueuedMutation.liveAwaiter] rather than restated at
 * each settle site, so the two cannot drift apart.
 */
data class MutationSettled(
    val mutationId: String,
    val status: MutationStatus,
    val value: WireValue? = null,
    val error: RuntimeException? = null,
    val hadAwaiter: Boolean = false,
)

/** What one [flushOfflineQueue] pass achieved. */
class FlushReport {
    /** The ids the server accepted. */
    val committed = mutableListOf<String>()

    /** The ids dropped on a verdict, an identity change, or a stale precondition. */
    val rejected = mutableListOf<String>()

    /** The ids left queued for the next reconnect. */
    val requeued = mutableListOf<String>()

    /** The ids dropped because their precondition no longer held. */
    val conflicted = mutableListOf<String>()
}

/** One offline-capable write. */
class SubmitOptions(val functionPath: String, val args: WireValue? = null) {
    /** Null routes to the default shard; an empty key names that same shard. */
    var shardKey: String? = null

    /** The idempotency key; minted when null. */
    var mutationId: String? = null

    /**
     * The single-query shortcut: the transform is layered onto every subscription
     * registered under the SAME (functionPath, args, shardKey) as this write,
     * mirroring `@lunora/client`'s per-call `optimistic`.
     */
    var optimistic: ((WireValue) -> WireValue)? = null

    /**
     * The general form — it receives an [Optimistic.LocalStore] and may patch any
     * number of subscribed queries. Both settle together, against one cursor.
     */
    var optimisticUpdate: ((Optimistic.LocalStore, WireValue?) -> Unit)? = null

    /**
     * Re-evaluated just before a QUEUED write replays; false drops it rather than
     * replaying a write that can only fail.
     */
    var precondition: (() -> Boolean)? = null

    /** Reports the eventual verdict on a queued write. */
    var onSettled: ((MutationSettled) -> Unit)? = null
}

/**
 * Writes, sending it now or queueing it until the socket is back.
 *
 * It returns as soon as the write is either committed or durably queued. A
 * queued write's optimistic overlay stays displayed until the replay's commit
 * cursor is reached by a server frame; a failed one rolls back.
 */
fun Client.submit(options: SubmitOptions): MutationOutcome {
    val deferred = mutableListOf<() -> Unit>()
    val writeId = options.mutationId ?: randomId()

    // Nothing the consumer supplied runs while this client holds its monitor: the
    // query registry is snapshotted under it, the write's own `optimistic` and
    // `optimisticUpdate` run against that snapshot with it RELEASED, and it is
    // taken again only to install what came back. A callback that re-enters the
    // client it was handed therefore cannot run inside the critical section that
    // guards the subscription registry.
    val recorded = recordOptimistic(options, snapshotQueries())
    val handles: List<Optimistic.Handle>

    // The offline decision and the enqueue are ONE critical section. Split across
    // two, the socket can attach and a whole flush run to completion in the window
    // between them: the write then lands in a queue nothing will drain until the
    // NEXT disconnect, after `submit` has already told its caller it was queued.
    val evicted: List<Discarded>?

    synchronized(lock) {
        // Re-checked: `close` can land while the recording ran, and a write
        // enqueued onto a queue that was just cleared settles to nobody.
        if (closed) throw OfflineException(CLIENT_CLOSED, "client is closed")

        val installed = recorded.map { Optimistic.install(it, deferred) }

        handles = installed
        evicted = if (send != null || !(wasEverConnected || offlineQueue.queueBeforeFirstConnect)) {
            null
        } else {
            offlineQueue.enqueue(queuedWrite(options, writeId, installed))
        }
    }

    for (call in deferred) call()

    if (evicted != null) {
        // Settled with the monitor released: the cap's discard rolls optimistic
        // layers back and reaches the consumer's listeners.
        reportDiscarded(evicted)

        return MutationOutcome(MutationStatus.QUEUED, writeId)
    }

    val reply = try {
        rpcFull(options.functionPath, options.args, options.shardKey, writeId)
    } catch (error: Exception) {
        rollbackLayers(handles)

        throw error
    }

    // Confirmed against the write's COMMITTED cursor, so the overlay drops when
    // (or once) a frame at that cursor lands — never on this call's return,
    // which races the socket broadcast.
    confirmLayers(handles, reply.commitCursor)

    return MutationOutcome(MutationStatus.COMMITTED, writeId, reply.result, reply.commitCursor)
}

/**
 * Replays one shard's queued writes, in order, over HTTP. Call it when that
 * shard's socket comes back.
 *
 * Each write replays under its own idempotency key, so one the server already
 * committed is de-duplicated rather than applied twice. Per write: success
 * confirms its optimistic overlay against the ECHOED commit cursor; a coded
 * verdict is terminal; a transient failure — a raw transport error, or one of
 * [TRANSIENT_ERROR_CODES] — stops the flush and re-queues that write and every
 * unreplayed one, in order, for the next attempt.
 *
 * Every mutation of the queue below runs under the client's monitor, and every
 * piece of consumer-visible work between them — the precondition predicate, a
 * settle, the replay's round trip — runs with it released. Both halves are load
 * bearing: [OfflineQueue.drain] partitions the backing list and then reassigns
 * it, so a concurrent enqueue is either lost outright or throws
 * `ConcurrentModificationException` out of the flush; and settling inside the
 * monitor runs a consumer's callback in the critical section that guards the
 * subscription registry.
 */
fun Client.flushOfflineQueue(shardKey: String? = null): FlushReport {
    val report = FlushReport()
    val queue: OfflineQueue
    val current: String?

    synchronized(lock) {
        queue = offlineQueue
        current = identity
    }

    val stale = staleWrites(queue)
    val conflicted = synchronized(lock) {
        val discarded = queue.drainConflict(stale)

        for (item in discarded) queue.unpersist(item.entry.id)

        discarded
    }

    for (item in conflicted) {
        report.conflicted.add(item.entry.id)
        report.rejected.add(item.entry.id)
    }

    reportDiscarded(conflicted)

    val drained = synchronized(lock) { queue.drain { sameShard(it.shardKey, shardKey) } }

    if (drained.isEmpty()) return report

    // Gated against ONE identity snapshot: a flush is a single authenticated
    // burst, so every write in it necessarily runs under one identity.
    val stamped = mutableListOf<QueuedMutation>()
    val foreign = mutableListOf<QueuedMutation>()

    for (item in drained) (if (identityAllowsReplay(item.identity, current)) stamped else foreign).add(item)

    settleTerminal(queue, foreign, report, OFFLINE_IDENTITY_CHANGED, "offline mutation skipped: auth identity changed before replay")

    // Encodability is decided BEFORE the replay loop: a codec failure carries no
    // server code, so the transient rule would re-queue such a write at the FRONT
    // of the FIFO and retry it on every reconnect forever, never settling its
    // caller and blocking every write behind it.
    val sendable = mutableListOf<QueuedMutation>()
    val unencodable = mutableListOf<QueuedMutation>()

    for (item in stamped) (if (isEncodable(item)) sendable else unencodable).add(item)

    settleTerminal(queue, unencodable, report, OFFLINE_WRITE_UNENCODABLE, "offline mutation dropped: arguments cannot be wire-encoded")

    replay(queue, sendable, report)

    return report
}

/**
 * The ids of the queued writes whose precondition no longer holds.
 *
 * The snapshot is taken under the monitor and the predicates run outside it: a
 * precondition is the consumer's own code and may re-enter this client.
 */
private fun Client.staleWrites(queue: OfflineQueue): Set<String> {
    val pending = synchronized(lock) { queue.items() }

    return pending.filter { item -> item.precondition?.let { !it() } == true }.mapTo(mutableSetOf()) { it.id }
}

/** Whether a queued write's arguments survive the wire codec. */
private fun isEncodable(item: QueuedMutation): Boolean = try {
    Wire.encode(item.args)

    true
} catch (error: Exception) {
    false
}

/** Drops [entries] for good, un-persisting each and settling it with [code]. */
private fun Client.settleTerminal(queue: OfflineQueue, entries: List<QueuedMutation>, report: FlushReport, code: String, message: String) {
    if (entries.isEmpty()) return

    synchronized(lock) {
        for (item in entries) queue.unpersist(item.id)
    }

    for (item in entries) {
        report.rejected.add(item.id)
        settleWrite(item, MutationStatus.REJECTED, null, OfflineException(code, message))
    }
}

private fun Client.replay(queue: OfflineQueue, sendable: List<QueuedMutation>, report: FlushReport) {
    for ((index, item) in sendable.withIndex()) {
        val reply = try {
            rpcFull(item.functionPath, item.args, item.shardKey, item.id, item.clientId)
        } catch (error: RuntimeException) {
            if (!Client.isTransient(error)) {
                synchronized(lock) { queue.unpersist(item.id) }
                report.rejected.add(item.id)
                settleWrite(item, MutationStatus.REJECTED, null, error)

                continue
            }

            // Nothing after this write may go out ahead of it: replaying out of
            // order is how a durable queue corrupts the data it was protecting.
            val pending = sendable.subList(index, sendable.size).toList()

            synchronized(lock) { queue.requeue(pending) }
            pending.mapTo(report.requeued) { it.id }

            return
        }

        synchronized(lock) { queue.unpersist(item.id) }
        // The overlay is confirmed BEFORE the caller is told, so the gapless
        // drop is already in place when the confirming frame lands.
        item.onCommit?.invoke(reply.commitCursor)
        settleWrite(item, MutationStatus.COMMITTED, reply.result, null)
        report.committed.add(item.id)
    }
}

/**
 * Every live subscription as a snapshot slot, read under the monitor.
 *
 * The WHOLE registry, not just this write's targets: an `optimisticUpdate` may
 * ask for any query it likes, and the point of the snapshot is that it need not
 * reach back into the client to do so. The registry is a handful of entries —
 * the same linear scan the write path already did, taken once instead of per
 * lookup.
 */
private fun Client.snapshotQueries(): List<Optimistic.Slot> = synchronized(lock) {
    if (closed) throw OfflineException(CLIENT_CLOSED, "client is closed")

    subscriptions.values.map { Optimistic.Slot(it.state, it.functionPath, it.args, it.argsKey, it.shardKey, it.state.lastValue) }
}

/**
 * Runs both optimistic APIs against [registry] and returns what they recorded.
 *
 * NO LOCK IS HELD: everything invoked here is the consumer's own code. The
 * recorded layers are installed by [submit] afterwards, in one critical section
 * with the offline decision.
 */
private fun recordOptimistic(options: SubmitOptions, registry: List<Optimistic.Slot>): List<Optimistic.Pending> {
    val recorded = mutableListOf<Optimistic.Pending>()

    options.optimistic?.let { transform ->
        for (slot in findQueries(registry, options.functionPath, options.args, options.shardKey)) {
            Optimistic.record(slot, transform)?.let { recorded.add(it) }
        }
    }

    val update = options.optimisticUpdate ?: return recorded
    val store = Optimistic.LocalStore(
        { path, args -> findQueries(registry, path, args, options.shardKey) },
        { path -> registry.filter { it.functionPath == path && sameShard(it.shardKey, options.shardKey) } },
    )

    return try {
        update(store, options.args)

        recorded + store.recorded
    } catch (error: Exception) {
        // A throwing update contributes nothing of its own, so the cache is left
        // exactly as it was found — and since nothing was installed yet, there is
        // no layer to unwind. The write itself proceeds.
        recorded
    }
}

/**
 * The snapshot slots registered under exactly this (path, args, shard).
 *
 * A linear scan, unlike `@lunora/client`'s keyed registry, and deliberately:
 * this client does not de-duplicate subscriptions, so several can share one
 * triple and all of them must receive the overlay. The scan is over a handful
 * of entries on the write path, never the frame path.
 */
private fun findQueries(registry: List<Optimistic.Slot>, functionPath: String, args: WireValue?, shardKey: String?): List<Optimistic.Slot> {
    val argsKey = Key.stableWireKey(args ?: WireValue.Obj(emptyList()))

    return registry.filter { it.functionPath == functionPath && it.argsKey == argsKey && sameShard(it.shardKey, shardKey) }
}

/** The durable entry a queued write is stored and replayed as. */
private fun Client.queuedWrite(options: SubmitOptions, writeId: String, handles: List<Optimistic.Handle>): QueuedMutation {
    val entry = QueuedMutation(writeId, options.functionPath, options.args ?: WireValue.Obj(emptyList()), options.shardKey)

    entry.clientId = clientId
    // Bound at enqueue time, so the write can only ever replay as whoever made it.
    entry.identity = Identity.stamp(identity)
    entry.liveAwaiter = true
    entry.precondition = options.precondition
    entry.onCommit = { cursor -> confirmLayers(handles, cursor) }
    entry.onRollback = { rollbackLayers(handles) }
    entry.onSettled = options.onSettled

    return entry
}

/**
 * Settles every write the queue let go of without sending it.
 *
 * Runs with the monitor RELEASED: a rejection rolls optimistic layers back, and
 * a consumer's callback must never run inside the critical section that guards
 * the subscription registry. Every discard path funnels through here, so an
 * eviction can never drop a durable write in silence — which matters most for a
 * hydrated record, whose original caller did not survive the restart and whose
 * only report is therefore the client-level settled listener.
 */
internal fun Client.reportDiscarded(discarded: List<Discarded>) {
    for (item in discarded) settleWrite(item.entry, MutationStatus.REJECTED, null, item.error())
}

/**
 * One write's terminal verdict: unwind its layers if it failed, then emit.
 *
 * The emission is UNCONDITIONAL — the entry's own handler is called in addition
 * to the client's listeners, never instead of them. A hydrated entry carries no
 * handler at all, so reporting through one would settle an evicted durable write
 * to nobody.
 */
internal fun Client.settleWrite(entry: QueuedMutation, status: MutationStatus, value: WireValue?, error: RuntimeException?) {
    if (status == MutationStatus.REJECTED) entry.onRollback?.invoke()

    emitSettled(MutationSettled(entry.id, status, value, error, entry.liveAwaiter), entry.onSettled)
}

/** Confirms a write's layers under the monitor, delivering notifications outside it. */
private fun Client.confirmLayers(handles: List<Optimistic.Handle>, commitCursor: Long?) {
    val deferred = mutableListOf<() -> Unit>()

    synchronized(lock) { Optimistic.confirmAll(handles, commitCursor, deferred) }

    for (call in deferred) call()
}

/** Unwinds a write's layers, same discipline. */
private fun Client.rollbackLayers(handles: List<Optimistic.Handle>) {
    val deferred = mutableListOf<() -> Unit>()

    synchronized(lock) { Optimistic.rollbackAll(handles, deferred) }

    for (call in deferred) call()
}

private fun Client.emitSettled(event: MutationSettled, onSettled: ((MutationSettled) -> Unit)?) {
    val listeners = mutableListOf<(MutationSettled) -> Unit>()

    onSettled?.let { listeners.add(it) }
    synchronized(lock) { listeners.addAll(settledListeners) }

    for (listener in listeners) {
        try {
            listener(event)
        } catch (error: Exception) {
            // A write's terminal verdict is the only report a restored write
            // ever produces, so one bad observer must not stop the rest.
        }
    }
}
