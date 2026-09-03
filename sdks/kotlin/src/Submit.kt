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
    val error: Exception? = null,
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

    /**
     * Milliseconds the server asked the caller to wait before flushing again, when
     * a replay came back rate-limited; null otherwise. The client enforces it too
     * — a flush inside the window is a no-op — so this is for a caller that
     * schedules its own retry.
     */
    var retryAfterMs: Long? = null
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
 * [TRANSIENT_ERROR_CODES], a rate limit, or a status that reached no verdict —
 * stops the flush and re-queues that write and every unreplayed one, in order,
 * for the next attempt.
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
        // A server that answered "not now" gets waited out. Without this the
        // caller's own reconnect loop replays the identical burst immediately and
        // earns the same 429, indefinitely.
        val remaining = flushNotBefore - System.nanoTime()

        if (remaining > 0) {
            report.retryAfterMs = remaining / 1_000_000 + 1

            return report
        }

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
    val unencodable = mutableListOf<Pair<QueuedMutation, String>>()

    for (item in stamped) {
        val failure = encodeFailure(item)

        if (failure == null) sendable.add(item) else unencodable.add(item to failure)
    }

    for ((item, failure) in unencodable) {
        settleTerminal(queue, listOf(item), report, OFFLINE_WRITE_UNENCODABLE, "offline mutation dropped: its arguments cannot be wire-encoded: $failure")
    }

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

/**
 * Why a queued write's arguments do not survive the wire codec, or null if they do.
 *
 * The codec's own message, not a fixed string: which cap was exceeded — depth,
 * bigint digits, an unsupported type — is the only thing that tells a consumer
 * what to change about the write it can never send.
 */
private fun encodeFailure(item: QueuedMutation): String? = try {
    Wire.encode(item.args)

    null
} catch (error: Exception) {
    error.message ?: error.toString()
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
    // A lone write rides the single-call path, which is the proven one. Two or
    // more coalesce into batch round trips — the flaky-reconnect win, where N
    // queued writes cost a handful of hops instead of N.
    if (sendable.size < 2) {
        replaySequential(queue, sendable, report)

        return
    }

    val toRequeue = mutableListOf<QueuedMutation>()
    val chunks = chunkBatches(sendable)

    for ((index, chunk) in chunks.withIndex()) {
        // Chunks replay sequentially, which is what preserves FIFO across a flush
        // longer than one batch.
        val (requeue, stop) = replayBatched(queue, chunk, report)

        toRequeue.addAll(requeue)

        if (stop) {
            // A whole-chunk transport failure. Leave every write not yet sent
            // queued, in order, rather than sending on into a connection that
            // just failed.
            for (later in chunks.subList(index + 1, chunks.size)) toRequeue.addAll(later)

            break
        }
    }

    if (toRequeue.isEmpty()) return

    synchronized(lock) { queue.requeue(toRequeue) }
    toRequeue.mapTo(report.requeued) { it.id }
}

/**
 * A batch entry's contribution to the request body, in bytes.
 *
 * The args dominate and are the only part that can be large; the constant covers
 * the entry's fixed keys and the comma joining it to the next one. Encoding twice
 * — here and in [replayBatched] — is deliberate: the flush is the slow path, and
 * carrying the encoded form through the chunker would put a second representation
 * of every queued write in memory.
 */
private fun entryBytes(item: QueuedMutation): Int =
    Json.write(Wire.encode(item.args)).toByteArray(Charsets.UTF_8).size + item.functionPath.length + item.id.length + 160

/**
 * Splits a flush into batch bodies the worker will accept.
 *
 * By BYTES as well as by count: the worker reads a batch body under a 1 MiB budget
 * and answers `413 PAYLOAD_TOO_LARGE` past it, so 500 writes carrying bytes or
 * long text are one request the server refuses whole. A single write over the
 * budget still forms its own chunk — splitting cannot help it, and [replayBatched]
 * settles it on the answer.
 */
private fun chunkBatches(items: List<QueuedMutation>): List<List<QueuedMutation>> {
    val chunks = mutableListOf<List<QueuedMutation>>()
    var current = mutableListOf<QueuedMutation>()
    var size = 0

    for (item in items) {
        val cost = entryBytes(item)

        if (current.isNotEmpty() && (current.size >= MAX_BATCH_ENTRIES || size + cost > MAX_BATCH_BYTES)) {
            chunks.add(current)
            current = mutableListOf()
            size = 0
        }

        current.add(item)
        size += cost
    }

    if (current.isNotEmpty()) chunks.add(current)

    return chunks
}

/**
 * How long a rate-limited replay asks to wait, if the envelope said.
 *
 * Null when the server named no delay — the caller then decides its own backoff
 * rather than hammering, which is what [FlushReport.retryAfterMs] reports.
 */
private fun retryAfterMs(error: Exception): Long? {
    if (error !is ApiException || error.code !in RATE_LIMIT_ERROR_CODES) return null

    val fields = (error.data as? WireValue.Obj)?.fields ?: return null
    val delay = fields.firstOrNull { it.first == "retryAfterMs" }?.second as? WireValue.Num ?: return null

    // Clamped: a server naming an hour would otherwise park a durable queue for
    // an hour.
    return delay.value.toLong().takeIf { it > 0 }?.let { minOf(it, MAX_RETRY_AFTER_MS) }
}

/** Records a rate limit's delay, and holds the next flush off until it passes. */
private fun Client.noteRetryAfter(report: FlushReport, error: Exception) {
    val delay = retryAfterMs(error) ?: return

    report.retryAfterMs = delay

    synchronized(lock) { flushNotBefore = maxOf(flushNotBefore, System.nanoTime() + delay * 1_000_000) }
}

/** Replays writes one at a time. FIFO is preserved by the loop itself. */
private fun Client.replaySequential(queue: OfflineQueue, sendable: List<QueuedMutation>, report: FlushReport) {
    for ((index, item) in sendable.withIndex()) {
        val reply = try {
            rpcFull(item.functionPath, item.args, item.shardKey, item.id, item.clientId)
        } catch (error: Exception) {
            if (!Client.isTransient(error)) {
                synchronized(lock) { queue.unpersist(item.id) }
                report.rejected.add(item.id)
                settleWrite(item, MutationStatus.REJECTED, null, error)

                continue
            }

            noteRetryAfter(report, error)

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
 * Replays one chunk over `POST /_lunora/rpc-batch`.
 *
 * The worker forwards the entries to their shard, which dispatches each through
 * its ordinary single-call path — so per-entry `mutationId` idempotency and
 * in-order application are inherited from the proven route rather than
 * re-implemented here.
 *
 * Returns the writes to put back and whether the caller should STOP because the
 * whole chunk failed at the transport level. Re-queuing is the caller's, once and
 * in order, so a write cannot land twice in the queue.
 */
private fun Client.replayBatched(queue: OfflineQueue, items: List<QueuedMutation>, report: FlushReport): Pair<List<QueuedMutation>, Boolean> {
    val calls = items.mapIndexed { index, item ->
        buildMap<String, Any?> {
            put("args", Wire.encode(item.args))
            put("functionPath", item.functionPath)
            // The slot this entry's result comes back in.
            put("id", index)
            // The same stable key the single-call replay sends, beside the id that
            // namespaces its de-duplication row for an anonymous caller. Per
            // ENTRY, not on the outer request: a batch is one hop, but its entries
            // are dispatched as independent single calls.
            put("mutationId", item.id)
            put("clientId", item.clientId ?: clientId)

            item.shardKey?.takeIf { it.isNotEmpty() }?.let { put("shardKey", it) }
        }
    }

    val body = try {
        rpcBatch(calls)
    } catch (error: Exception) {
        // Transport failure — nothing committed, so retry everything.
        return items to true
    }

    (body["results"] as? List<*>)?.let { return settleBatchSlots(queue, items, it, report) to false }

    // No per-slot results. A coded envelope is a verdict on the WHOLE batch — a
    // bad request, an authorization denial — and therefore terminal for every
    // entry; anything else is transport, and transient.
    val envelope = body["error"] as? Map<*, *> ?: return items to true
    val error = batchSlotError(envelope, "batch rejected")

    // The body was too big, not wrong — every entry in it would have committed
    // alone. Halve and retry: the estimate the chunker used cannot see the framing
    // the worker actually measured, and only the answer can.
    if (error.code == PAYLOAD_TOO_LARGE && items.size > 1) {
        val middle = items.size / 2
        val (left, leftStop) = replayBatched(queue, items.subList(0, middle), report)

        if (leftStop) return left + items.subList(middle, items.size) to true

        val (right, stop) = replayBatched(queue, items.subList(middle, items.size), report)

        return left + right to stop
    }

    // A shard blip or a rate limit is not a verdict on the batch's contents.
    // Requeue it whole and stop the flush, exactly as the single-call path does
    // for the same codes.
    if (Client.isTransient(error)) {
        noteRetryAfter(report, error)

        return items to true
    }

    for (item in items) {
        synchronized(lock) { queue.unpersist(item.id) }
        report.rejected.add(item.id)
        settleWrite(item, MutationStatus.REJECTED, null, error)
    }

    return emptyList<QueuedMutation>() to false
}

/**
 * Demuxes a batch reply back onto the writes it replayed, in input order,
 * classifying each slot exactly as [replaySequential] classifies a whole
 * response. Returns the writes the caller must re-queue.
 */
private fun Client.settleBatchSlots(queue: OfflineQueue, items: List<QueuedMutation>, results: List<*>, report: FlushReport): List<QueuedMutation> {
    val bySlot = mutableMapOf<Int, Map<*, *>>()

    for (raw in results) {
        val entry = raw as? Map<*, *> ?: continue
        val id = (entry["id"] as? Number)?.toInt()
        val slot = entry["body"] as? Map<*, *>

        if (id != null && slot != null) bySlot[id] = slot
    }

    val requeue = mutableListOf<QueuedMutation>()

    for ((index, item) in items.withIndex()) {
        // The server never returned this slot. It may or may not have committed,
        // so retry it — the `mutationId` makes that safe.
        val slot = bySlot[index] ?: run {
            requeue.add(item)

            null
        } ?: continue

        val envelope = slot["error"] as? Map<*, *>

        if (envelope != null) {
            val error = batchSlotError(envelope, "request failed")

            // Classified by the SAME predicate as a whole batch and a single call,
            // never a second code set beside it: a slot's body is exactly a §4.2
            // envelope, so a durable write's fate must not depend on how many
            // siblings were queued alongside it. A shard blip or a limiter means
            // the server reached no verdict on this entry, so it goes back on the
            // queue rather than being reported as failed.
            if (Client.isTransient(error)) {
                noteRetryAfter(report, error)
                requeue.add(item)

                continue
            }

            synchronized(lock) { queue.unpersist(item.id) }
            report.rejected.add(item.id)
            settleWrite(item, MutationStatus.REJECTED, null, error)

            continue
        }

        synchronized(lock) { queue.unpersist(item.id) }
        // The overlay is confirmed BEFORE the caller is told, so the gapless drop
        // is already in place when the confirming frame lands.
        item.onCommit?.invoke((slot["commitCursor"] as? Number)?.toLong())
        settleWrite(item, MutationStatus.COMMITTED, Wire.decode(slot["result"]), null)
        report.committed.add(item.id)
    }

    return requeue
}

/**
 * Rebuilds an [ApiException] from a slot's or a batch's error envelope,
 * defaulting the way `parseRpcResponse` does.
 */
private fun batchSlotError(envelope: Map<*, *>, fallback: String): ApiException = ApiException(
    envelope["code"] as? String ?: "INTERNAL",
    envelope["message"] as? String ?: fallback,
    envelope["data"]?.let { Wire.decode(it) },
)

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
internal fun Client.settleWrite(entry: QueuedMutation, status: MutationStatus, value: WireValue?, error: Exception?) {
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
