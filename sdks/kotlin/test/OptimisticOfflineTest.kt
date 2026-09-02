package dev.lunora

import java.io.IOException
import java.math.BigInteger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The cursor-gated optimistic-layer engine and the durable offline write queue,
 * against the shared golden scenarios in
 * `protocol/fixtures/offline-optimistic.json`.
 *
 * Every expectation is read from that file so this port and the other six assert
 * the same values rather than each documenting its own behaviour.
 * `ConformanceTest.kt`'s `main` calls [runOptimisticOfflineCases]; the end of that
 * `main` is the after-all hook that holds this suite to the manifest.
 */
private fun scenario(block: String, name: String): Map<*, *> = (fixture("offline-optimistic.json")[block] as Map<*, *>)[name] as Map<*, *>

private fun ids(value: Any?): List<String?> = (value as List<*>).map { it as String? }

private fun count(value: Any?): Int = (value as Number).toInt()

/** The entries of a batch request body, or an empty list for a single call. */
private fun batchCalls(body: ByteArray): List<Map<*, *>> {
    val parsed = Json.parse(String(body, Charsets.UTF_8)) as? Map<*, *> ?: return emptyList()

    return (parsed["calls"] as? List<*>)?.filterIsInstance<Map<*, *>>() ?: emptyList()
}

/**
 * The `mutationId` of every entry in a batch request body, in order.
 *
 * A flush of two or more writes coalesces into `/_lunora/rpc-batch`, so the
 * idempotency key rides in the ENTRY rather than in an `x-lunora-mutation-id`
 * header.
 */
private fun batchMutationIds(body: ByteArray): List<String?> = batchCalls(body).map { it["mutationId"] as? String }

/**
 * Answer a request in whichever shape it arrived in: a single call gets a whole
 * response, a batch gets one success slot per entry. A poster that only speaks
 * the single-call shape makes every batched write look unanswered.
 */
private fun echoBatchSlots(body: ByteArray, result: String = "null", commitCursor: Int? = null): String {
    val cursor = commitCursor?.let { ",\"commitCursor\":$it" } ?: ""
    val calls = batchCalls(body)

    if (calls.isEmpty()) return "{\"result\":$result$cursor}"

    val slots = calls.indices.joinToString(",") { "{\"id\":$it,\"body\":{\"result\":$result$cursor}}" }

    return "{\"results\":[$slots]}"
}

/** A fixture value as the client would hold it. */
private fun wire(value: Any?): WireValue = Wire.decode(value)

/**
 * The one transform primitive the fixtures use: push onto a COPY of the list.
 *
 * A copy, not an in-place add: a transform is re-run on every rebase, so one that
 * mutated its input would compound its own effect on each server frame.
 */
private fun appender(item: WireValue): (WireValue) -> WireValue = { current ->
    WireValue.Arr(((current as? WireValue.Arr)?.items ?: emptyList()) + item)
}

/**
 * A live client with one subscription, driven through its REAL frame handler and
 * its REAL write path.
 *
 * The optimistic cases used to apply a hand-copied transcription of
 * [Client.handleFrame]'s `data` branch to a bare [Optimistic.State]. That
 * transcription is what let a frame-handler defect pass nine green conformance
 * names: a client that forgot `dropConfirmedLayers`, or nulled the tracked cursor
 * on a cursorless frame, was never the thing under test.
 */
private class Live(val args: WireValue = WireValue.Obj(emptyList()), poster: ((String, Map<String, String>, ByteArray) -> HttpResponse)? = null) {
    val seen = mutableListOf<WireValue>()
    val client = Client("https://app.example", poster)

    init {
        client.attachSocket { }
        client.subscribe("messages:list", args, { seen.add(it) })
    }

    /** The value the subscription's handler was last given. */
    fun displayed(): WireValue = seen.last()

    /** The subscription's layer state, for the counts the fixtures assert. */
    fun state(): Optimistic.State = client.subscriptions.getValue("sub_1").state

    /** Feeds one server data frame, exactly as a socket reader would. */
    fun frame(spec: Map<*, *>, kind: String = "data") {
        val json = LinkedHashMap<String, Any?>()

        for ((key, value) in spec) json[key.toString()] = value

        json["id"] = "sub_1"
        json["type"] = kind

        client.handleFrame(Json.write(json))
    }

    /** A write against this subscription's exact (path, args) pair. */
    fun write(transform: ((WireValue) -> WireValue)? = null): SubmitOptions {
        val options = SubmitOptions("messages:list", args)

        options.optimistic = transform

        return options
    }
}

/**
 * Layers one transform onto a bare state, in the two steps the write path uses:
 * record against a snapshot with no lock held, then install.
 */
private fun layer(state: Optimistic.State, transform: (WireValue) -> WireValue) {
    val slot = Optimistic.Slot(state, "messages:list", WireValue.Obj(emptyList()), "", null, state.lastValue)

    Optimistic.record(slot, transform)?.let { Optimistic.install(it, mutableListOf()) }
}

private fun optimisticLayerRebasesOntoServerFrame() {
    covers("optimistic_layer_rebases_onto_server_frame")

    val case = scenario("optimistic", "rebase")
    val live = Live()

    live.frame(mapOf("cursor" to 1.0, "data" to case["base"]))

    // Dropped so the write QUEUES: its layer then stays pending across the frame
    // below, which is the rebase this case is about.
    live.client.detachSocket()

    val before = live.seen.size

    check(live.client.submit(live.write(appender(wire(case["appended"])))).status == MutationStatus.QUEUED, "the write queues with the socket down")
    check(live.displayed() == wire(case["displayedAfterApply"]), "the predicted value is displayed as soon as the layer is applied")
    check(live.seen.size == before + 1, "and the handler is told exactly once")

    live.frame(case["frame"] as Map<*, *>)

    // The overlay survived the frame and was RE-FOLDED onto the new base, rather
    // than being clobbered by it.
    check(live.displayed() == wire(case["displayedAfterFrame"]), "a pending layer rebases onto the new authoritative base")
    check(live.state().layers.size == count(case["layersAfterFrame"]), "and is still pending afterwards")

    // A layer that throws is skipped by the fold, not fatal to it. Registered
    // directly rather than through a write, which refuses a transform that throws
    // on first application — this is the other case: one that worked once and
    // throws on a later rebase. The exception is a Java-CHECKED one, which a
    // `RuntimeException` catch would let abort the whole fold.
    val skipped = scenario("optimistic", "throwingLayerSkipped")
    val second = Optimistic.State(wire(skipped["base"]))

    second.layers.add(Optimistic.Layer { throw IOException("buggy optimistic update") })
    layer(second, appender(wire(skipped["appended"])))

    check(second.layers.size == count(skipped["layers"]), "the throwing layer is kept")
    check(
        Optimistic.fold(second.serverBase, second.layers) == wire(skipped["displayed"]),
        "but skipped by the fold, so the good layer still applies",
    )
}

/**
 * A byte-identical write yields a `settled` frame, never a `data` frame. Sweeping
 * confirmed layers only on data frames leaves the prediction on screen until some
 * unrelated write happens to change this query — on a quiet one, forever.
 */
private fun optimisticLayerDropsOnSettledFrame() {
    covers("optimistic_layer_drops_on_settled_frame")

    val case = scenario("optimistic", "settledFrameDrop")
    val commitCursor = count(case["commitCursor"])
    val live = Live(poster = { _, _, _ -> HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":null}") })

    live.frame(mapOf("data" to case["base"]))
    live.client.submit(live.write(appender(wire(case["appended"]))))
    live.frame(case["belowFrame"] as Map<*, *>, kind = "settled")

    check(live.displayed() == wire(case["displayedAfterBelowFrame"]), "a settled frame below the commit cursor keeps the overlay")
    check(live.state().layers.size == count(case["layersAfterBelowFrame"]), "and the layer with it")

    live.frame(case["atFrame"] as Map<*, *>, kind = "settled")

    check(live.displayed() == wire(case["displayedAfterAtFrame"]), "a settled frame reaching the commit cursor drops the overlay")
    check(live.state().layers.size == count(case["layersAfterAtFrame"]), "and the layer is gone")
}

private fun optimisticLayerDropsOnCommitCursor() {
    covers("optimistic_layer_drops_on_commit_cursor")

    val case = scenario("optimistic", "commitCursorDrop")
    val commitCursor = count(case["commitCursor"])
    val live = Live(poster = { _, _, _ -> HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":null}") })

    live.frame(mapOf("data" to case["base"]))
    live.client.submit(live.write(appender(wire(case["appended"]))))
    live.frame(case["belowFrame"] as Map<*, *>)

    // Below the commit cursor: the write is NOT in the server base yet, so dropping
    // the overlay here would blink the value away and back.
    check(live.displayed() == wire(case["displayedAfterBelowFrame"]), "a frame below the commit cursor keeps the overlay")
    check(live.state().layers.size == count(case["layersAfterBelowFrame"]), "and the layer with it")

    live.frame(case["atFrame"] as Map<*, *>)

    // The frame reached the commit cursor: the effect is in the base, so the
    // overlay drops without the value ever double-counting it.
    check(live.displayed() == wire(case["displayedAfterAtFrame"]), "the confirming frame does not double-count the write")
    check(live.state().layers.size == count(case["layersAfterAtFrame"]), "and the layer is gone")

    // CDC is off on this shard, so the reply echoes no cursor to gate on. The layer
    // goes, but the display does not revert: the write DID commit.
    val without = scenario("optimistic", "confirmWithoutCursor")
    val degraded = Live(poster = { _, _, _ -> HttpResponse(200, "{\"result\":null}") })

    degraded.frame(mapOf("data" to without["base"]))
    degraded.client.submit(degraded.write(appender(wire(without["appended"]))))

    check(degraded.displayed() == wire(without["displayedAfterConfirm"]), "confirming with no cursor does not revert a committed write")
    check(degraded.state().layers.size == count(without["layersAfterConfirm"]), "but does drop the layer")

    // The confirming frame beat the RPC response — the common race, reproduced by
    // delivering it from inside the poster. The overlay must drop on confirm rather
    // than linger until the next frame.
    val atFrame = case["atFrame"] as Map<*, *>
    var deliver: (() -> Unit)? = null
    val raced = Live(poster = { _, _, _ ->
        deliver?.invoke()

        HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":null}")
    })

    deliver = { raced.frame(atFrame) }

    raced.frame(case["belowFrame"] as Map<*, *>)
    raced.client.submit(raced.write(appender(wire(case["appended"]))))

    check(raced.state().layers.isEmpty(), "a cursor the frames already reached drops the layer now")
    check(raced.displayed() == wire(atFrame["data"]), "and the display reverts to the base")
}

private fun optimisticLayerRollsBackOnFailure() {
    covers("optimistic_layer_rolls_back_on_failure")

    val case = scenario("optimistic", "rollback")
    val live = Live(poster = { _, _, _ -> HttpResponse(200, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}") })

    live.frame(mapOf("cursor" to 1.0, "data" to case["base"]))

    var threw = false

    try {
        live.client.submit(live.write(appender(wire(case["appended"]))))
    } catch (expected: ApiException) {
        threw = true
    }

    check(threw, "the server's verdict reaches the caller")
    check(live.displayed() == wire(case["displayedAfterRollback"]), "a rolled-back write leaves the server value displayed")
    check(live.state().layers.size == count(case["layersAfterRollback"]), "and no layer")

    // A constant layer is an absolute override: while pending it re-clamps and
    // HIDES the concurrent server change rather than merging with it.
    val mask = scenario("optimistic", "constantMask")
    val masked = Live(poster = { _, _, _ -> HttpResponse(200, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}") })
    val options = masked.write()

    options.optimisticUpdate = { store, _ ->
        store.setQuery("messages:list", masked.args, wire(mask["value"]))

        check(store.getQuery("messages:list", masked.args) == wire(mask["displayedAfterApply"]), "getQuery reads the override back")
    }

    masked.frame(mapOf("data" to mask["base"]))
    masked.client.detachSocket()
    masked.client.submit(options)

    check(masked.displayed() == wire(mask["displayedAfterApply"]), "setQuery displays the predicted value")

    masked.frame(mask["frame"] as Map<*, *>)

    check(masked.displayed() == wire(mask["displayedAfterFrame"]), "the override masks a concurrent server change")

    // The replay draws a coded verdict, which is terminal — so the write settles
    // rejected and takes its layer down with it.
    masked.client.flushOfflineQueue()

    check(masked.displayed() == wire(mask["displayedAfterRollback"]), "and rolling back reveals it")
}

private fun optimisticCursorlessFramePreservesCursor() {
    covers("optimistic_cursorless_frame_preserves_cursor")

    val case = scenario("optimistic", "cursorlessFrame")
    val commitCursor = count(case["commitCursor"])
    val live = Live(poster = { _, _, _ -> HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":null}") })

    live.frame(mapOf("data" to case["base"]))
    live.client.detachSocket()
    live.client.submit(live.write(appender(wire(case["appended"]))))

    live.frame(case["cursoredFrame"] as Map<*, *>)
    live.frame(case["cursorlessFrame"] as Map<*, *>)

    // `cursor` is optional on data/delta/resume frames. A frame that omits one
    // must leave the tracked cursor alone.
    check(
        live.state().serverCursor == count(case["cursorAfterCursorlessFrame"]).toLong(),
        "a cursorless frame leaves the tracked cursor where it was",
    )
    check(live.displayed() == wire(case["displayedAfterCursorlessFrame"]), "and the pending layer still rebases onto the new base")
    check(live.state().layers.size == count(case["layersAfterCursorlessFrame"]), "with the layer still pending")

    live.client.attachSocket { }
    live.client.flushOfflineQueue()

    // The whole point of preserving it: the tracked cursor is what the reply's
    // commit cursor is compared against. Nulled, this confirm cannot drop the
    // layer and the write renders twice until some later cursored frame lands.
    check(live.state().layers.size == count(case["layersAfterConfirm"]), "so the reply's commit cursor can still drop the overlay")
}

/**
 * A persistence adapter that records every call.
 *
 * It JSON round-trips every record, which an adapter holding the objects by
 * reference does not — and that is the whole point: a file, a SQLite text column
 * or a preferences store all serialise, so a record carrying the codec's native
 * wrappers either throws here or is written as something that does not read back.
 * Holding references made this suite blind to both.
 */
private class MemoryStore(seeded: List<Map<String, Any?>> = emptyList()) : PersistenceAdapter {
    val records = seeded.map { serialise(it) }.toMutableList()
    val appended = mutableListOf<Map<String, Any?>>()
    val removed = mutableListOf<String>()
    var cleared = 0

    override fun append(record: Map<String, Any?>) {
        val stored = serialise(record)

        appended.add(stored)
        records.add(stored)
    }

    override fun load(): List<Map<String, Any?>> = records.map { serialise(it) }

    override fun remove(mutationId: String) {
        removed.add(mutationId)
        records.removeAll { it["id"] == mutationId }
    }

    override fun clear() {
        cleared++
        records.clear()
    }

    companion object {
        @Suppress("UNCHECKED_CAST")
        private fun serialise(record: Map<String, Any?>): Map<String, Any?> = Json.parse(Json.write(record)) as Map<String, Any?>
    }
}

private fun entry(id: String, shardKey: String? = null): QueuedMutation = QueuedMutation(id, "messages:send", WireValue.Obj(emptyList()), shardKey)

/** The "id:code" pairs a queue reported letting go of. */
private fun discardedPairs(discarded: List<Discarded>): List<String> = discarded.map { "${it.entry.id}:${it.code}" }

private fun queuedIds(items: List<QueuedMutation>): List<String?> = items.map { it.id }

/** The coded reason each settled event carried. */
private fun settledCodes(settled: List<MutationSettled>): List<String?> = settled.map { (it.error as? OfflineException)?.code }

/** A fixture's `persisted` list, as durable records. */
private fun persistedRecords(case: Map<*, *>): List<Map<String, Any?>> = (case["persisted"] as List<*>).map { raw ->
    val spec = raw as Map<*, *>

    linkedMapOf(
        "args" to emptyMap<String, Any?>(),
        "functionPath" to "messages:send",
        "id" to spec["id"],
        "shardKey" to spec["shardKey"],
        "version" to spec["version"],
    )
}

private fun offlineQueueFifoReplayOrder() {
    covers("offline_queue_fifo_replay_order")

    val fifo = scenario("offlineQueue", "fifo")
    val sizes = mutableListOf<Int>()
    val queue = OfflineQueue()

    queue.onSizeChange = { sizes.add(it) }

    for (id in ids(fifo["enqueue"])) queue.enqueue(entry(id!!))

    check(queue.size == count(fifo["sizeAfterEnqueue"]), "every write is queued")
    check(queuedIds(queue.drain()) == ids(fifo["drained"]), "writes drain in submission order")
    check(sizes.last() == count(fifo["sizeAfterDrain"]), "and the depth observer sees the queue empty")

    covers("offline_queue_drains_only_the_named_shard")

    val shard = scenario("offlineQueue", "shardDrain")
    val sharded = OfflineQueue()

    for (raw in shard["entries"] as List<*>) {
        val spec = raw as Map<*, *>

        sharded.enqueue(entry(spec["id"] as String, spec["shardKey"] as String?))
    }

    val target = shard["drainShardKey"] as String?
    // An absent shard key and an empty one are the SAME shard: compared strictly,
    // the write submitted under "" is never drained by any flush and sits queued
    // forever, because nothing ever flushes a shard named "".
    val drained = sharded.drain { sameShard(it.shardKey, target) }

    check(queuedIds(drained) == ids(shard["drained"]), "one shard's writes drained")
    check(queuedIds(sharded.items()) == ids(shard["remaining"]), "and the rest stay queued in order")

    val requeue = scenario("offlineQueue", "requeue")
    val store = MemoryStore()
    val durable = OfflineQueue(persistence = store)

    for (id in ids(requeue["enqueue"])) durable.enqueue(entry(id!!))

    val wanted = ids(requeue["requeued"])

    durable.requeue(durable.drain().filter { it.id in wanted })

    check(queuedIds(durable.items()) == ids(requeue["queuedAfterRequeue"]), "requeued writes return to the front, in order")
    // Durable storage still holds them — they were never un-persisted, so a
    // re-append would duplicate the record.
    check(store.appended.size == count(requeue["persistAppendCalls"]), "and a requeue does not re-persist them")
}

private fun offlineQueueOverflowEvictsOldest() {
    covers("offline_queue_overflow_evicts_oldest")

    val case = scenario("offlineQueue", "overflow")
    val evicted = mutableListOf<Discarded>()
    val store = MemoryStore()
    val queue = OfflineQueue(maxItems = count(case["maxItems"]), persistence = store)

    for (id in ids(case["enqueue"])) evicted.addAll(queue.enqueue(entry(id!!)))

    val code = case["code"] as String
    val wantEvicted = ids(case["evicted"])

    check(queuedIds(queue.items()) == ids(case["remaining"]), "the newest writes survive the cap")
    // Returned, not settled in place: the caller settles it once it has left the
    // monitor. A hydrated entry has no live caller at all, so this is the only
    // thing standing between an eviction and a durable write vanishing in silence.
    check(
        discardedPairs(evicted) == listOf("${wantEvicted[0]}:$code"),
        "the OLDEST write is returned as discarded, with the documented code",
    )
    check(store.removed == ids(case["persistRemoveCalls"]), "an evicted write is un-persisted")

    // Taken literally, a cap of zero accepts a write and evicts it in the same
    // call: every submit reports "queued" and then settles OVERFLOW.
    val clamped = OfflineQueue(maxItems = 0)

    check(clamped.enqueue(entry("m1")).isEmpty(), "a zero capacity is clamped to one")
    check(queuedIds(clamped.items()) == listOf("m1"), "so the write it accepted stays queued")

    val clear = scenario("offlineQueue", "clear")
    val clearStore = MemoryStore()
    val closing = OfflineQueue(persistence = clearStore)
    val enqueued = ids(clear["enqueue"])

    for (id in enqueued) closing.enqueue(entry(id!!))

    val closed = closing.clear()

    check(
        discardedPairs(closed) == ids(clear["rejected"]).map { "$it:${clear["code"]}" },
        "closing returns every queued write, with the documented code",
    )
    check(closing.size == 0, "and empties the queue")
    // Closing must NOT discard writes the next session will restore.
    check(clearStore.removed.isEmpty(), "but leaves the durable records alone")
    check(clearStore.records.size == enqueued.size, "so a later session can restore them")
}

/**
 * The precondition is re-evaluated at flush time, through the CLIENT — which
 * snapshots the queue under its monitor, runs the consumer's predicates with the
 * monitor RELEASED, and takes it again to drop the writes the verdicts named.
 */
private fun offlineQueuePreconditionDropsStaleWrite() {
    covers("offline_queue_precondition_drops_stale_write")

    val case = scenario("offlineQueue", "precondition")
    val settled = mutableListOf<MutationSettled>()
    // Transient, so the writes that PASS their precondition are re-queued in order
    // rather than dropped — which is what `remaining` describes.
    val client = Client("https://app.example", { _, _, _ -> throw IllegalStateException("connection reset") })

    client.onMutationSettled { settled.add(it) }

    for (raw in case["entries"] as List<*>) {
        val spec = raw as Map<*, *>
        val verdict = spec["precondition"] as Boolean
        val item = entry(spec["id"] as String)

        item.precondition = { verdict }
        client.offlineQueue.enqueue(item)
    }

    val report = client.flushOfflineQueue()

    check(report.conflicted == ids(case["conflicted"]), "only the write whose precondition failed is dropped")
    check(settled.map { it.mutationId } == ids(case["conflicted"]), "and it settles")
    check(settledCodes(settled) == listOf(case["code"]), "with the documented code")
    check(queuedIds(client.offlineQueue.items()) == ids(case["remaining"]), "the valid writes keep their FIFO order")
}

private fun offlineQueueHydratesPersistedWrites() {
    covers("offline_queue_hydrates_persisted_writes")

    val case = scenario("offlineQueue", "hydrate")
    val store = MemoryStore(persistedRecords(case))
    val queue = OfflineQueue(persistence = store, version = case["version"] as String)

    // Submitted during the boot window, BEFORE the durable load returns.
    for (id in ids(case["liveEnqueue"])) queue.enqueue(entry(id!!))

    val hydrated = queue.hydrate()
    val shardKeys = hydrated.shardKeys

    check(hydrated.evicted.isEmpty(), "nothing exceeded the default capacity")
    // The durable store's order is authoritative: a prior-session write is always
    // older, so replaying the boot-time write first would let last-writer-wins
    // clobber newer data with stale.
    check(queuedIds(queue.items()) == ids(case["queuedAfterHydrate"]), "restored writes land ahead of the boot-time write")
    // A record stamped under another app version is dropped AND purged.
    check(store.removed == ids(case["purged"]), "and a stale-version record is purged rather than replayed")
    check(shardKeys.toSet() == ids(case["shardKeys"]).toSet(), "the surviving writes' shard keys are reported")

    // Version gating is OFF until a version is configured.
    check(!isStaleVersion(null, null), "no version configured, nothing is stale")
    check(!isStaleVersion(null, "v1"), "even a stamped record")
    check(isStaleVersion("v2", null), "an unstamped record is stale once gating is on")
    check(isStaleVersion("v2", "v1"), "and so is one from another version")
    check(!isStaleVersion("v2", "v2"), "the current version is not")

    // Two anonymous clients that collided on an id would share one de-duplication
    // namespace server-side, letting one suppress the other's writes. The same
    // generator mints the default client id, so this covers both.
    check(List(2000) { randomId() }.toSet().size == 2000, "minted ids must not collide")
    check(Client("https://app.example").clientId != Client("https://app.example").clientId, "and two clients never share one")
}

/**
 * A queued write carrying typed arguments survives a store that SERIALISES.
 *
 * Every wrapper below is one the codec understands and a JSON writer does not, so
 * persisting the native form either throws inside the adapter — reporting the
 * write "queued" while nothing durable was written — or stores whatever the
 * adapter makes of an opaque object and replays after a restart with CORRUPTED
 * args.
 */
private fun typedArgsSurviveASerialisingStore() {
    covers("offline_queue_hydrates_persisted_writes")

    val args = WireValue.Obj(
        listOf(
            "amount" to WireValue.BigInt(BigInteger("7")),
            "blob" to WireValue.Bytes(byteArrayOf(1, 2, 3, 4)),
            "when" to WireValue.Date(WireValue.Num(1700000000000.0)),
        ),
    )
    val store = MemoryStore()
    val queue = OfflineQueue(persistence = store)
    val errors = mutableListOf<String>()

    queue.onPersistenceError = { operation, _, id -> errors.add("$operation:$id") }
    queue.enqueue(QueuedMutation("m-typed", "ledger:add", args))

    check(errors.isEmpty(), "the record must serialise, so nothing is reported as a failed append")
    check(Json.write(store.appended[0]["args"]) == Json.write(Wire.encode(args)), "the persisted args are the WIRE form")

    val restored = OfflineQueue(persistence = store)

    restored.hydrate()

    check(queuedIds(restored.items()) == listOf("m-typed"), "the write restores")

    // Decoded back to the SAME native values, so the replay sends the write that
    // was made rather than whatever the adapter's stringification left.
    val fields = (restored.items()[0].args as WireValue.Obj).fields.toMap()

    check(fields["amount"] == WireValue.BigInt(BigInteger("7")), "the bigint round-trips exactly")
    check((fields["blob"] as WireValue.Bytes).data.contentEquals(byteArrayOf(1, 2, 3, 4)), "and the bytes")
    check(fields["when"] == WireValue.Date(WireValue.Num(1700000000000.0)), "and the date")
}

/**
 * A persisted record whose args do not decode is purged and settled, never
 * replayed and never fatal.
 *
 * A wire tag with no usable payload: the store was corrupted, or written by an
 * incompatible build. Replaying it with substitute args would commit a DIFFERENT
 * write than the caller made, and throwing out of the hydrate takes every OTHER
 * durable write down with it.
 */
private fun undecodablePersistedRecordSettlesRejected() {
    covers("offline_queue_hydrates_persisted_writes")

    val record = linkedMapOf<String, Any?>(
        "args" to mapOf("amount" to listOf(Wire.TAG, "bigint", "not-a-number")),
        "functionPath" to "ledger:add",
        "id" to "m-bad",
    )
    val store = MemoryStore(listOf(record))
    val settled = mutableListOf<MutationSettled>()
    val client = Client("https://app.example")

    client.offlineQueue = OfflineQueue(persistence = store)
    client.onMutationSettled { settled.add(it) }

    val shardKeys = client.hydrateOfflineQueue()

    check(shardKeys.isEmpty(), "nothing survived to be flushed")
    check(queuedIds(client.offlineQueue.items()).isEmpty(), "the unreadable record is not queued")
    check(settled.map { it.mutationId } == listOf("m-bad"), "it settles through the client's listener")
    check(settled[0].status == MutationStatus.REJECTED, "as a rejection")
    check(settledCodes(settled) == listOf(OFFLINE_WRITE_UNDECODABLE), "carrying the documented code")
    check(store.removed == listOf("m-bad"), "and is purged, not left to fail every restart")
}

/**
 * A batch the worker refuses for SIZE is split and retried, not settled.
 *
 * The worker reads a batch body under a 1 MiB budget
 * (`packages/runtime/src/body-readers.ts`) and answers `413 PAYLOAD_TOO_LARGE`
 * past it. A whole-batch coded envelope is a verdict on every entry, so a
 * count-only chunker settled the lot `rejected` — 500 durable writes dropped for
 * the size of the request they shared, each of which would have committed alone.
 */
private fun batchSplitsOnPayloadTooLarge() {
    covers("offline_flush_batch_splits_on_payload_too_large")

    val budget = 400
    val bodies = mutableListOf<Int>()
    val store = MemoryStore()
    val client = Client(
        "https://app.example",
        { _, _, body ->
            bodies.add(body.size)

            if (body.size > budget) {
                HttpResponse(413, "{\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"Body too large\"}}")
            } else {
                HttpResponse(200, echoBatchSlots(body, commitCursor = 1))
            }
        },
    )

    client.clientId = "c-1"
    client.offlineQueue = OfflineQueue(persistence = store)

    val queued = List(4) { "m-$it" }

    for (id in queued) {
        client.offlineQueue.enqueue(QueuedMutation(id, "messages:send", WireValue.Obj(listOf("text" to WireValue.Text("x".repeat(120))))))
    }

    val report = client.flushOfflineQueue()

    check(report.committed == queued, "every write commits; none is dropped for the size of the batch it shared")
    check(report.rejected.isEmpty(), "nothing is settled terminally")
    check(queuedIds(client.offlineQueue.items()).isEmpty(), "and the queue drains")
    check(bodies.max() > budget, "the first attempt has to be the over-budget one, or nothing was split")
}

/**
 * A lone queued write survives an envelope-less 502.
 *
 * `parseRpcResponse` codes such a body INTERNAL per protocol §4.2, and INTERNAL
 * is not in [TRANSIENT_ERROR_CODES] — so whether a gateway blip LOST a durable
 * write depended on the queue's depth, because the same response on the batch
 * path was already classified transient.
 */
private fun loneQueuedWriteSurvivesAnEnvelopeLess502() {
    val store = MemoryStore()
    val settled = mutableListOf<MutationSettled>()
    val client = Client("https://app.example", { _, _, _ -> HttpResponse(502, "{\"message\":\"bad gateway\"}") })

    client.offlineQueue = OfflineQueue(persistence = store)
    client.onMutationSettled { settled.add(it) }
    client.offlineQueue.enqueue(entry("m-502"))

    val report = client.flushOfflineQueue()

    check(report.rejected.isEmpty(), "an edge error page is not a verdict")
    check(report.requeued == listOf("m-502"), "the write goes back on the queue")
    check(queuedIds(client.offlineQueue.items()) == listOf("m-502"), "and is still there")
    check(settled.isEmpty(), "nothing settled: no verdict was ever reached")
    check(store.removed.isEmpty(), "the durable record stays, because the write is still good")
}

/**
 * A rate-limited replay requeues and defers the next flush.
 *
 * "Not now", not "no": the write is valid and the server asked for it later, so
 * dropping it loses data for being punctual — and replaying immediately just
 * earns the same 429 forever.
 */
private fun rateLimitedReplayDefersTheNextFlush() {
    var posts = 0
    val client = Client(
        "https://app.example",
        { _, _, _ ->
            posts++

            HttpResponse(429, "{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":60000},\"message\":\"slow down\"}}")
        },
    )

    client.offlineQueue = OfflineQueue(persistence = MemoryStore())
    client.offlineQueue.enqueue(entry("m-429"))

    val report = client.flushOfflineQueue()

    check(report.rejected.isEmpty(), "a rate limit is not a verdict")
    check(report.requeued == listOf("m-429"), "the write stays queued")
    check(report.retryAfterMs == 60000L, "and the envelope's delay is reported")

    val again = client.flushOfflineQueue()

    check(posts == 1, "the second flush waits out the delay rather than earning the same 429")
    check((again.retryAfterMs ?: 0L) > 0L, "reporting what is left of it")
    check(queuedIds(client.offlineQueue.items()) == listOf("m-429"), "with the write still queued")

    rateLimitedBatchSlotRequeues()
}

/**
 * A rate-limited SLOT is transient too, and the honoured delay is clamped.
 *
 * A slot's body is exactly a §4.2 envelope, so it runs through the SAME
 * `isTransient` predicate as a whole batch and a single call — a second code set
 * beside it is how a durable write's fate came to depend on how many siblings
 * were queued alongside it. The clamp keeps a server that names an hour from
 * parking the queue for one.
 */
private fun rateLimitedBatchSlotRequeues() {
    val client = Client(
        "https://app.example",
        { _, _, _ ->
            HttpResponse(
                200,
                "{\"results\":[" +
                    "{\"id\":0,\"body\":{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":900000},\"message\":\"slow down\"}}}," +
                    "{\"id\":1,\"body\":{\"commitCursor\":1,\"result\":null}}]}",
            )
        },
    )

    client.offlineQueue = OfflineQueue(persistence = MemoryStore())
    client.offlineQueue.enqueue(entry("m-slot-429"))
    client.offlineQueue.enqueue(entry("m-slot-ok"))

    val report = client.flushOfflineQueue()

    check(report.rejected.isEmpty(), "a rate-limited slot is not a verdict on that entry")
    check(report.requeued == listOf("m-slot-429"), "it goes back on the queue")
    check(report.committed == listOf("m-slot-ok"), "while its sibling still commits")
    check(report.retryAfterMs == MAX_RETRY_AFTER_MS, "and the slot's delay is honoured, clamped at a minute")
}

/**
 * Restoring past the cap evicts the oldest durable write — and that eviction must
 * reach the CLIENT's settled listener.
 *
 * Driven through [Client.hydrateOfflineQueue], not [OfflineQueue.hydrate]: a
 * hydrated entry has no awaiter and no settle handler of its own, so a client that
 * reports a discard through the entry's own handler reports this one to NOBODY —
 * the durable write is un-persisted and vanishes in silence. Calling the queue
 * directly is the existing case, and it cannot see that.
 */
private fun offlineQueueHydrateOverflowSettlesDiscarded() {
    covers("offline_queue_hydrate_overflow_settles_discarded")

    val case = scenario("offlineQueue", "hydrateOverflow")
    val store = MemoryStore(persistedRecords(case))
    val settled = mutableListOf<MutationSettled>()
    val client = Client("https://app.example")

    client.offlineQueue = OfflineQueue(maxItems = count(case["maxItems"]), persistence = store, version = case["version"] as String)
    client.onMutationSettled { settled.add(it) }

    val shardKeys = client.hydrateOfflineQueue()

    check(queuedIds(client.offlineQueue.items()) == ids(case["queuedAfterHydrate"]), "hydration respects the capacity cap")
    // Only the shards whose writes SURVIVED — a key gathered before eviction would
    // send the caller to open a socket with nothing queued behind it.
    check(shardKeys == ids(case["shardKeys"]), "and reports only the surviving shards")
    check(settled.map { it.mutationId } == ids(case["settledFromClient"]), "the evicted restored write settles through the client's listener")
    check(settled.all { it.status == MutationStatus.REJECTED }, "as a rejection")
    check(settledCodes(settled) == listOf(case["settledCode"]), "carrying the documented overflow code")
    // Read from the entry's own liveAwaiter, so a restored write's ONLY report is
    // distinguishable from a live caller's second one.
    check(settled[0].hadAwaiter == case["settledHadAwaiter"], "and marked as having had no live awaiter")
}

private fun offlineQueueIdentityGateRejectsReplay() {
    covers("offline_queue_identity_gate_rejects_replay")

    val case = scenario("offlineQueue", "identityGate")

    for (raw in case["cases"] as List<*>) {
        val spec = raw as Map<*, *>
        val stampedRaw = spec["stamped"]
        val stamped = when {
            stampedRaw == "absent" -> Identity.Absent
            stampedRaw == null -> Identity.SignedOut
            else -> Identity.Of(stampedRaw as String)
        }

        check(
            identityAllowsReplay(stamped, spec["current"] as String?) == spec["replays"] as Boolean,
            "identity gate: ${spec["name"]}",
        )
    }

    val posts = mutableListOf<Map<String, String>>()
    val perWrite = mutableListOf<MutationSettled>()
    val client = Client(
        "https://app.example",
        { _, headers, _ ->
            posts.add(headers)
            HttpResponse(200, "{\"result\":null}")
        },
        identity = "user-b",
    )
    val queued = QueuedMutation("m1", "messages:send", WireValue.Obj(emptyList()))

    queued.identity = Identity.Of("user-a")
    queued.onSettled = { perWrite.add(it) }
    client.offlineQueue.enqueue(queued)

    val report = client.flushOfflineQueue()

    check(report.rejected == listOf("m1"), "the mismatched write is rejected")
    check(report.committed.isEmpty(), "and nothing commits")
    // Nothing reached the wire: a restart must not push the previous user's queued
    // writes as the current one.
    check(posts.isEmpty(), "the write never reaches the server")
    check(settledCodes(perWrite) == listOf(case["code"]), "and it carries the documented code")
}

private fun offlineFlushReplaysAndConfirmsOptimistic() {
    covers("offline_flush_replays_and_confirms_optimistic")

    val case = scenario("offlineQueue", "flushReplay")
    val responses = case["responses"] as List<*>
    val seenIds = mutableListOf<String?>()
    val confirmed = mutableListOf<Long?>()
    val store = MemoryStore()
    // The three fixture outcomes, as this transport now expresses them. Three
    // queued writes coalesce into ONE batch hop, so `ok` and `coded-error` are
    // slots and `transport-error` is an ABSENT slot: a per-entry transport failure
    // is the server not answering for that entry, and an unanswered write is
    // retried under its original idempotency key exactly as an uncoded throw
    // re-queues on the single-call path.
    val client = Client(
        "https://app.example",
        { _, _, body ->
            seenIds.addAll(batchMutationIds(body))

            val slots = responses.mapIndexedNotNull { index, raw ->
                val spec = raw as Map<*, *>

                when (spec["outcome"]) {
                    "coded-error" -> "{\"id\":$index,\"body\":{\"error\":{\"code\":\"${spec["code"]}\",\"message\":\"gone\"}}}"
                    "ok" -> "{\"id\":$index,\"body\":{\"commitCursor\":${count(spec["commitCursor"])},\"result\":{\"ok\":true}}}"
                    else -> null
                }
            }

            HttpResponse(200, "{\"results\":[${slots.joinToString(",")}]}")
        },
    )

    client.offlineQueue = OfflineQueue(persistence = store)

    for (id in ids(case["queued"])) {
        val item = QueuedMutation(id!!, "messages:send", WireValue.Obj(emptyList()))

        item.clientId = "client-1"
        item.onCommit = { cursor -> confirmed.add(cursor) }
        client.offlineQueue.enqueue(item)
    }

    val report = client.flushOfflineQueue()

    // Replayed in FIFO order, each under its own idempotency key so a write the
    // server already committed is de-duplicated rather than re-applied.
    check(seenIds == ids(case["mutationIdHeaders"]), "queued writes replay in order, under their own idempotency keys")
    check(report.committed == ids(case["committed"]), "the good write commits")
    // A coded verdict is terminal: replaying it would only re-trigger the same
    // failure. A transport failure is not, so that write stays queued.
    check(report.rejected == ids(case["rejected"]), "a coded verdict is terminal")
    check(queuedIds(client.offlineQueue.items()) == ids(case["queuedAfterFlush"]), "and a transport failure leaves its write queued")
    check(report.requeued == ids(case["queuedAfterFlush"]), "as the report says")
    check(store.removed == ids(case["persistRemoveCalls"]), "every terminally settled write is un-persisted")
    check(confirmed == listOf(count(case["confirmedCommitCursor"]).toLong()), "and the committed write confirms against the echoed cursor")

    checkedExceptionRequeuesInOrder()
    submitQueuesWhileOffline(count(case["confirmedCommitCursor"]))
    submitBeforeFirstConnectFailsFast()
    overflowDuringSubmitSettles()
    concurrentSubmitAndFlush()
    optimisticTransformRunsOutsideTheLock()
    emptyShardKeyNeverReachesTheWire()
}

/**
 * A CHECKED exception from the poster requeues the whole remaining backlog, in
 * order, rather than escaping the flush.
 *
 * `IOException` is the canonical transient failure this loop exists for — it is
 * what HttpURLConnection and OkHttp throw on a dropped connection — and a poster
 * is a bare function type, so nothing stops it. The writes have already been
 * drained by then, so an escaping exception destroys every unreplayed one: no
 * settle, no rollback, and with the default in-memory queue no record either.
 */
private fun checkedExceptionRequeuesInOrder() {
    val store = MemoryStore()
    val client = Client("https://app.example", { _, _, _ -> throw IOException("connection reset") })

    client.offlineQueue = OfflineQueue(persistence = store)

    for (id in listOf("m1", "m2", "m3")) client.offlineQueue.enqueue(QueuedMutation(id, "messages:send", WireValue.Obj(emptyList())))

    val report = client.flushOfflineQueue()

    check(report.requeued == listOf("m1", "m2", "m3"), "a checked exception requeues the whole backlog")
    check(queuedIds(client.offlineQueue.items()) == listOf("m1", "m2", "m3"), "at the front, in submission order")
    check(report.rejected.isEmpty(), "and settles none of them terminally")
    check(store.removed.isEmpty(), "nor un-persists them")
}

/**
 * Two or more queued writes coalesce into ONE `/_lunora/rpc-batch` round trip, and
 * each slot is classified exactly as a whole single-call response is.
 */
private fun offlineFlushBatchesMultipleWrites() {
    covers("offline_flush_batches_multiple_writes")

    val case = scenario("offlineQueue", "batchReplay")
    val slots = case["slots"] as List<*>
    val urls = mutableListOf<String>()
    val calls = mutableListOf<Map<*, *>>()
    val confirmed = mutableListOf<Long?>()
    val store = MemoryStore()
    val client = Client(
        "https://app.example",
        { url, _, body ->
            urls.add(url)
            calls.addAll(batchCalls(body))

            val answers = slots.joinToString(",") { raw ->
                val slot = raw as Map<*, *>

                if (slot["outcome"] == "ok") {
                    "{\"id\":${count(slot["id"])},\"body\":{\"commitCursor\":${count(slot["commitCursor"])},\"result\":null}}"
                } else {
                    "{\"id\":${count(slot["id"])},\"body\":{\"error\":{\"code\":\"${slot["code"]}\",\"message\":\"slot failed\"}}}"
                }
            }

            HttpResponse(200, "{\"results\":[$answers]}")
        },
    )

    client.clientId = "c-1"
    client.offlineQueue = OfflineQueue(persistence = store)

    for (id in ids(case["queued"])) {
        val item = QueuedMutation(id!!, "messages:send", WireValue.Obj(emptyList()))

        item.onCommit = { cursor -> confirmed.add(cursor) }
        client.offlineQueue.enqueue(item)
    }

    val report = client.flushOfflineQueue()

    check(urls.size == count(case["requests"]), "the whole flush is one batch hop")
    check(urls[0].endsWith(case["path"] as String), "sent to the batch endpoint")
    // The idempotency key and the client id ride in the ENTRY, not in a request
    // header: a batch is one hop carrying independent calls, and a single outer
    // header would de-duplicate the whole chunk against one id.
    val wanted = (case["calls"] as List<*>).map { it as Map<*, *> }

    check(calls.size == wanted.size, "one entry per queued write")
    check(
        calls.indices.all { index ->
            val got = calls[index]
            val want = wanted[index]

            got["clientId"] == want["clientId"] &&
                got["functionPath"] == want["functionPath"] &&
                count(got["id"]) == count(want["id"]) &&
                got["mutationId"] == want["mutationId"]
        },
        "every entry carries its own slot id, key and client id",
    )
    check(report.committed == ids(case["committed"]), "the successful slot commits")
    // A transient shard code in a slot is not a verdict, so that write goes back on
    // the queue instead of being reported as failed — and so does the slot the
    // server never returned at all.
    check(report.rejected == ids(case["rejected"]), "only the coded verdict is terminal")
    check(queuedIds(client.offlineQueue.items()) == ids(case["queuedAfterFlush"]), "the rest are re-queued, in order")
    check(store.removed == ids(case["persistRemoveCalls"]), "only the settled writes are un-persisted")
    check(confirmed == listOf(count(case["confirmedCommitCursor"]).toLong()), "and the committed write confirms against the echoed cursor")
}

/**
 * A queued write whose args cannot be wire-encoded settles TERMINALLY on the first
 * flush.
 *
 * Without the pre-replay partition it is a permanent poison loop: a codec error
 * carries no code, so the transient rule re-queues it — at the FRONT — and it
 * retries on every reconnect forever, never settling its caller, never rolling its
 * overlay back, and blocking every write behind it.
 */
private fun offlineFlushUnencodableWriteSettlesTerminal() {
    covers("offline_flush_unencodable_write_settles_terminal")

    val case = scenario("offlineQueue", "unencodableWrite")
    val unencodable = ids(case["unencodable"]).toSet()
    val seenHeaders = mutableListOf<String?>()
    val settled = mutableListOf<MutationSettled>()
    val store = MemoryStore()
    val client = Client(
        "https://app.example",
        { _, headers, _ ->
            seenHeaders.add(headers["x-lunora-mutation-id"])

            HttpResponse(200, "{\"commitCursor\":1,\"result\":{\"ok\":true}}")
        },
    )

    client.offlineQueue = OfflineQueue(persistence = store)
    client.onMutationSettled { settled.add(it) }

    for (id in ids(case["queued"])) {
        val args = if (id in unencodable) beyondDepthCap() else WireValue.Obj(emptyList())

        client.offlineQueue.enqueue(QueuedMutation(id!!, "messages:send", args))
    }

    val report = client.flushOfflineQueue()

    check(report.rejected == ids(case["rejected"]), "the unencodable write is rejected")
    check(report.committed == ids(case["committed"]), "and the encodable one still commits")
    check(seenHeaders == ids(case["mutationIdHeaders"]), "only the encodable write reaches the wire")
    check(report.requeued.isEmpty(), "nothing is put back at the front to retry forever")
    check(queuedIds(client.offlineQueue.items()) == ids(case["queuedAfterFlush"]), "and the queue is drained")
    check(store.removed == ids(case["persistRemoveCalls"]), "both are un-persisted")
    check(settled.map { it.mutationId } == ids(case["queued"]), "both settle their callers")
    check(settledCodes(settled) == listOf(case["code"] as String, null), "the unencodable one with the documented code")
}

/** Arguments nested past [Wire.MAX_DEPTH], which the codec refuses to encode. */
private fun beyondDepthCap(): WireValue {
    var value: WireValue = WireValue.Text("leaf")

    repeat(Wire.MAX_DEPTH + 2) { value = WireValue.Arr(listOf(value)) }

    return value
}

/**
 * An eviction triggered from inside [submit] settles rather than running a
 * consumer's callback inside the monitor that guards the subscription registry.
 *
 * This is the regression: the queue used to reject an evicted write in place, and
 * that rejection rolls optimistic layers back — which re-enters the very monitor
 * `submit` was holding. `synchronized` is reentrant so this port never hung, but
 * running a consumer's callback in that critical section is the hazard regardless.
 */
private fun overflowDuringSubmitSettles() {
    val case = scenario("offlineQueue", "overflow")
    val maxItems = count(case["maxItems"])
    val settled = mutableListOf<MutationSettled>()
    val client = Client("https://app.example", { _, _, _ -> HttpResponse(200, "{\"result\":null}") })

    client.offlineQueue = OfflineQueue(maxItems = maxItems, queueBeforeFirstConnect = true)
    client.onMutationSettled { settled.add(it) }

    repeat(ids(case["enqueue"]).size) { client.submit(SubmitOptions("messages:send")) }

    check(settled.size == 1, "the evicted write settles exactly once")
    check(settled[0].status == MutationStatus.REJECTED, "as a rejection")
    check(settledCodes(settled) == listOf(case["code"]), "carrying the documented overflow code")
    check(settled[0].hadAwaiter, "and marked as having had a live awaiter")
    check(client.pendingMutationCount() == maxItems, "and the cap is respected")
}

/**
 * A flush running while another thread submits.
 *
 * `drain` partitions the backing list and then REASSIGNS it. Run with the client's
 * monitor released, an entry appended in that window is either dropped silently —
 * after `submit` already returned QUEUED to its caller — or throws
 * `ConcurrentModificationException` out of the flush. The count is the assertion:
 * every write that was accepted must eventually replay.
 */
private fun concurrentSubmitAndFlush() {
    val writes = 400
    val committed = AtomicInteger()
    val client = Client("https://app.example", { _, _, body -> HttpResponse(200, echoBatchSlots(body)) })

    client.offlineQueue = OfflineQueue(queueBeforeFirstConnect = true)

    val writer = Thread { repeat(writes) { client.submit(SubmitOptions("messages:send")) } }
    val flusher = Thread { repeat(writes) { committed.addAndGet(client.flushOfflineQueue().committed.size) } }

    writer.start()
    flusher.start()
    writer.join()
    flusher.join()

    committed.addAndGet(client.flushOfflineQueue().committed.size)

    check(committed.get() == writes, "every accepted write replayed exactly once")
    check(client.pendingMutationCount() == 0, "and nothing is left queued")
}

/** A write made with the socket down is queued, keeps its overlay, and replays on the flush. */
private fun submitQueuesWhileOffline(commitCursor: Int) {
    var posts = 0
    val live = Live(
        WireValue.Obj(listOf("channel" to WireValue.Text("general"))),
        { _, _, _ ->
            posts++

            HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":{\"ok\":true}}")
        },
    )

    // Prime the subscription with a server value, then drop the socket.
    live.frame(mapOf("cursor" to 1.0, "data" to listOf("a")))
    live.client.detachSocket()

    val outcome = live.client.submit(live.write(appender(WireValue.Text("c"))))
    val predicted = WireValue.Arr(listOf(WireValue.Text("a"), WireValue.Text("c")))

    check(outcome.status == MutationStatus.QUEUED, "a write with the socket down is queued")
    check(live.displayed() == predicted, "and its overlay is displayed")
    check(posts == 0, "nothing reaches the wire while the socket is down")
    check(live.client.pendingMutationCount() == 1, "and the queue depth reflects it")

    live.client.attachSocket { }
    live.client.flushOfflineQueue()

    check(posts == 1, "the flush replays it")
    check(live.client.pendingMutationCount() == 0, "and drains the queue")
    // Still displayed: the overlay is confirmed at the commit cursor and drops only
    // once a frame reaches it.
    check(live.displayed() == predicted, "the overlay survives the reply")

    live.frame(mapOf("cursor" to commitCursor.toDouble(), "data" to listOf("a", "c")))

    check(live.displayed() == predicted, "and the confirming frame does not double-count it")
}

/**
 * Never connected and the opt-in is off, so a misconfigured endpoint surfaces on
 * the first write rather than silently filling a queue that will never flush.
 */
private fun submitBeforeFirstConnectFailsFast() {
    val client = Client("https://app.example", { _, _, _ -> throw IllegalStateException("no route to host") })
    var threw = false

    try {
        client.submit(SubmitOptions("messages:send"))
    } catch (expected: RuntimeException) {
        threw = true
    }

    check(threw, "the first write fails before any connect")
    check(client.pendingMutationCount() == 0, "and nothing is queued")

    client.offlineQueue = OfflineQueue(queueBeforeFirstConnect = true)

    val outcome = client.submit(SubmitOptions("messages:send"))

    check(outcome.status == MutationStatus.QUEUED, "the opt-in queues it instead")
    check(client.pendingMutationCount() == 1, "and the queue holds it")
}

/**
 * A consumer's optimistic transform does not run inside the client's monitor.
 *
 * `synchronized` is reentrant, so this port cannot deadlock the way its
 * non-reentrant siblings did — the defect is narrower and invisible from one
 * thread: the callback ran in the critical section guarding the subscription
 * registry, shutting every other thread out of the client for its duration. A
 * second thread makes that observable, and the latch timeout means a regression
 * FAILS here rather than hanging the suite.
 */
private fun optimisticTransformRunsOutsideTheLock() {
    val live = Live()

    live.frame(mapOf("cursor" to 1.0, "data" to listOf("a")))
    live.client.detachSocket()

    val running = CountDownLatch(1)
    val probed = CountDownLatch(1)
    var reached = false
    var reentered = false

    val prober = Thread {
        if (!running.await(5, TimeUnit.SECONDS)) return@Thread

        // Blocks until the monitor is free. Held across the transform, this never
        // returns before submit does, and the latch below times out.
        live.client.pendingMutationCount()
        probed.countDown()
    }

    prober.start()

    val outcome = live.client.submit(
        live.write { current ->
            running.countDown()
            reached = probed.await(5, TimeUnit.SECONDS)
            // The transform may also re-enter the client it was handed.
            reentered = !live.client.online()

            current
        },
    )

    prober.join()

    check(reached, "another thread reached the client while the consumer's transform was running")
    check(reentered, "and the transform itself re-entered the client it was handed")
    check(outcome.status == MutationStatus.QUEUED, "while the write still went through")
    check(live.displayed() == WireValue.Arr(listOf(WireValue.Text("a"))), "and its recorded layer was installed")
}

/**
 * An empty shard key names the DEFAULT shard on the wire, not a shard called "".
 *
 * `packages/runtime/src/create-worker.ts` treats an empty string as a valid NAMED
 * shard, so sending it routes to a different Durable Object than the null-shard
 * subscription the write just overlaid — and than the null-shard flush that
 * drained it. Normalising the comparisons without normalising the wire is worse
 * than the bug it replaced: the write replays against the wrong shard instead of
 * never replaying at all.
 */
private fun emptyShardKeyNeverReachesTheWire() {
    val bodies = mutableListOf<String>()
    val client = Client(
        "https://app.example",
        { _, _, payload ->
            bodies.add(String(payload, Charsets.UTF_8))

            HttpResponse(200, "{\"result\":null}")
        },
    )
    val options = SubmitOptions("messages:send")

    options.shardKey = ""

    client.attachSocket { }
    client.submit(options)

    check(bodies.size == 1 && !bodies[0].contains("shardKey"), "an empty shard key is omitted from the RPC body")
    check(!client.wsUrl("").contains("shard="), "and from the socket URL")
    // A real key still rides both, or the omission would have swallowed sharding.
    check(Json.write(Client.buildRpcBody("messages:send", null, "room-1")).contains("\"shardKey\":\"room-1\""), "a named shard still rides the body")
    check(client.wsUrl("room-1").contains("shard=room-1"), "and the socket URL")
}

/** Runs every optimistic-layer and offline-queue case. */
internal fun runOptimisticOfflineCases() {
    optimisticLayerRebasesOntoServerFrame()
    optimisticLayerDropsOnCommitCursor()
    optimisticLayerDropsOnSettledFrame()
    optimisticLayerRollsBackOnFailure()
    optimisticCursorlessFramePreservesCursor()
    offlineQueueFifoReplayOrder()
    offlineQueueOverflowEvictsOldest()
    offlineQueuePreconditionDropsStaleWrite()
    offlineQueueHydratesPersistedWrites()
    typedArgsSurviveASerialisingStore()
    undecodablePersistedRecordSettlesRejected()
    offlineQueueHydrateOverflowSettlesDiscarded()
    offlineQueueIdentityGateRejectsReplay()
    offlineFlushReplaysAndConfirmsOptimistic()
    offlineFlushBatchesMultipleWrites()
    batchSplitsOnPayloadTooLarge()
    loneQueuedWriteSurvivesAnEnvelopeLess502()
    rateLimitedReplayDefersTheNextFlush()
    offlineFlushUnencodableWriteSettlesTerminal()
}
