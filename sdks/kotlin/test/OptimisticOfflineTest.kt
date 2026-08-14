package dev.lunora

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

/** Applies one server data frame the way [Client.handleFrame] does. */
private fun applyFrame(state: Optimistic.State, frame: Map<*, *>) {
    state.serverBase = wire(frame["data"])
    state.serverCursor = (frame["cursor"] as? Number)?.toLong()
    Optimistic.dropConfirmedLayers(state, state.serverCursor)
    Optimistic.notifySubscription(state, Optimistic.fold(state.serverBase, state.layers), mutableListOf())
}

private fun optimisticLayerRebasesOntoServerFrame() {
    covers("optimistic_layer_rebases_onto_server_frame")

    val case = scenario("optimistic", "rebase")
    val seen = mutableListOf<WireValue>()
    val state = Optimistic.State(wire(case["base"]))

    state.callbacks.add { seen.add(it) }

    val deferred = mutableListOf<() -> Unit>()

    Optimistic.applyLayer(state, appender(wire(case["appended"])), deferred)
    for (call in deferred) call()

    check(state.lastValue == wire(case["displayedAfterApply"]), "the predicted value is displayed as soon as the layer is applied")
    check(seen.size == 1, "and the handler is told exactly once")

    applyFrame(state, case["frame"] as Map<*, *>)

    // The overlay survived the frame and was RE-FOLDED onto the new base, rather
    // than being clobbered by it.
    check(state.lastValue == wire(case["displayedAfterFrame"]), "a pending layer rebases onto the new authoritative base")
    check(state.layers.size == count(case["layersAfterFrame"]), "and is still pending afterwards")

    // A layer that throws is skipped by the fold, not fatal to it. Registered
    // directly rather than through applyLayer, which refuses a transform that
    // throws on first application — this is the other case: one that worked once
    // and throws on a later rebase.
    val skipped = scenario("optimistic", "throwingLayerSkipped")
    val second = Optimistic.State(wire(skipped["base"]))

    second.layers.add(Optimistic.Layer { throw IllegalStateException("buggy optimistic update") })
    Optimistic.applyLayer(second, appender(wire(skipped["appended"])), mutableListOf())

    check(second.layers.size == count(skipped["layers"]), "the throwing layer is kept")
    check(
        Optimistic.fold(second.serverBase, second.layers) == wire(skipped["displayed"]),
        "but skipped by the fold, so the good layer still applies",
    )
}

private fun optimisticLayerDropsOnCommitCursor() {
    covers("optimistic_layer_drops_on_commit_cursor")

    val case = scenario("optimistic", "commitCursorDrop")
    val state = Optimistic.State(wire(case["base"]))
    val deferred = mutableListOf<() -> Unit>()
    val handle = Optimistic.applyLayer(state, appender(wire(case["appended"])), deferred)!!

    handle.confirm(count(case["commitCursor"]).toLong(), deferred)
    applyFrame(state, case["belowFrame"] as Map<*, *>)

    // Below the commit cursor: the write is NOT in the server base yet, so dropping
    // the overlay here would blink the value away and back.
    check(state.lastValue == wire(case["displayedAfterBelowFrame"]), "a frame below the commit cursor keeps the overlay")
    check(state.layers.size == count(case["layersAfterBelowFrame"]), "and the layer with it")

    applyFrame(state, case["atFrame"] as Map<*, *>)

    // The frame reached the commit cursor: the effect is in the base, so the
    // overlay drops without the value ever double-counting it.
    check(state.lastValue == wire(case["displayedAfterAtFrame"]), "the confirming frame does not double-count the write")
    check(state.layers.size == count(case["layersAfterAtFrame"]), "and the layer is gone")

    // CDC is off on this shard, so there is no cursor to gate on. The layer goes,
    // but the display does not revert: the write DID commit.
    val without = scenario("optimistic", "confirmWithoutCursor")
    val degraded = Optimistic.State(wire(without["base"]))
    val degradedHandle = Optimistic.applyLayer(degraded, appender(wire(without["appended"])), mutableListOf())!!

    degradedHandle.confirm(null, mutableListOf())

    check(degraded.lastValue == wire(without["displayedAfterConfirm"]), "confirming with no cursor does not revert a committed write")
    check(degraded.layers.size == count(without["layersAfterConfirm"]), "but does drop the layer")

    // The confirming frame beat the RPC response — the common race. The overlay
    // must drop on confirm rather than linger until the next frame.
    val atFrame = case["atFrame"] as Map<*, *>
    val raced = Optimistic.State(wire(atFrame["data"]))

    raced.serverCursor = count(atFrame["cursor"]).toLong()

    val racedHandle = Optimistic.applyLayer(raced, appender(WireValue.Text("x")), mutableListOf())!!

    racedHandle.confirm(count(case["commitCursor"]).toLong(), mutableListOf())

    check(raced.layers.isEmpty(), "a cursor the frames already reached drops the layer now")
    check(raced.lastValue == wire(atFrame["data"]), "and the display reverts to the base")
}

private fun optimisticLayerRollsBackOnFailure() {
    covers("optimistic_layer_rolls_back_on_failure")

    val case = scenario("optimistic", "rollback")
    val seen = mutableListOf<WireValue>()
    val state = Optimistic.State(wire(case["base"]))

    state.callbacks.add { seen.add(it) }

    val deferred = mutableListOf<() -> Unit>()
    val handle = Optimistic.applyLayer(state, appender(wire(case["appended"])), deferred)!!

    handle.rollback(deferred)
    for (call in deferred) call()

    check(state.lastValue == wire(case["displayedAfterRollback"]), "a rolled-back write leaves the server value displayed")
    check(state.layers.size == count(case["layersAfterRollback"]), "and no layer")
    check(seen.last() == wire(case["displayedAfterRollback"]), "the handler saw it")

    // A constant layer is an absolute override: while pending it re-clamps and
    // HIDES the concurrent server change rather than merging with it.
    val mask = scenario("optimistic", "constantMask")
    val masked = Optimistic.State(wire(mask["base"]))
    val maskDeferred = mutableListOf<() -> Unit>()
    val store = Optimistic.LocalStore(
        { _, _ -> listOf(masked) },
        { _ -> listOf(Optimistic.QueryEntry(WireValue.Obj(emptyList()), masked.lastValue)) },
        maskDeferred,
    )

    store.setQuery("messages:list", WireValue.Obj(emptyList()), wire(mask["value"]))
    for (call in maskDeferred) call()

    check(masked.lastValue == wire(mask["displayedAfterApply"]), "setQuery displays the predicted value")
    check(store.getQuery("messages:list", WireValue.Obj(emptyList())) == wire(mask["displayedAfterApply"]), "and getQuery reads it back")

    applyFrame(masked, mask["frame"] as Map<*, *>)

    check(masked.lastValue == wire(mask["displayedAfterFrame"]), "the override masks a concurrent server change")

    Optimistic.rollbackAll(store.rollbacks, mutableListOf())

    check(masked.lastValue == wire(mask["displayedAfterRollback"]), "and rolling back reveals it")
}

/** A persistence adapter that records every call. */
private class MemoryStore(seeded: List<Map<String, Any?>> = emptyList()) : PersistenceAdapter {
    val records = seeded.toMutableList()
    val appended = mutableListOf<Map<String, Any?>>()
    val removed = mutableListOf<String>()
    var cleared = 0

    override fun append(record: Map<String, Any?>) {
        appended.add(record)
        records.add(record)
    }

    override fun load(): List<Map<String, Any?>> = records.toList()

    override fun remove(mutationId: String) {
        removed.add(mutationId)
        records.removeAll { it["id"] == mutationId }
    }

    override fun clear() {
        cleared++
        records.clear()
    }
}

private fun entry(id: String, shardKey: String? = null, codes: MutableList<String>? = null): QueuedMutation {
    val item = QueuedMutation(id, "messages:send", WireValue.Obj(emptyList()), shardKey)

    if (codes != null) {
        item.reject = { error -> codes.add((error as? OfflineException)?.code ?: "?") }
    }

    return item
}

private fun queuedIds(items: List<QueuedMutation>): List<String?> = items.map { it.id }

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

private fun offlineQueueFifoAndShardDrain() {
    covers("offline_queue_fifo_and_shard_drain")

    val fifo = scenario("offlineQueue", "fifo")
    val sizes = mutableListOf<Int>()
    val queue = OfflineQueue()

    queue.onSizeChange = { sizes.add(it) }

    for (id in ids(fifo["enqueue"])) queue.enqueue(entry(id!!))

    check(queue.size == count(fifo["sizeAfterEnqueue"]), "every write is queued")
    check(queuedIds(queue.drain()) == ids(fifo["drained"]), "writes drain in submission order")
    check(sizes.last() == count(fifo["sizeAfterDrain"]), "and the depth observer sees the queue empty")

    val shard = scenario("offlineQueue", "shardDrain")
    val sharded = OfflineQueue()

    for (raw in shard["entries"] as List<*>) {
        val spec = raw as Map<*, *>

        sharded.enqueue(entry(spec["id"] as String, spec["shardKey"] as String?))
    }

    val target = shard["drainShardKey"] as String?
    val drained = sharded.drain { it.shardKey == target }

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
    val codes = mutableListOf<String>()
    val evicted = mutableListOf<String>()
    val store = MemoryStore()
    val queue = OfflineQueue(maxItems = count(case["maxItems"]), persistence = store)

    queue.onEvict = { item, error -> evicted.add("${item.id}:${error.code}") }

    for (id in ids(case["enqueue"])) queue.enqueue(entry(id!!, codes = codes))

    val code = case["code"] as String
    val wantEvicted = ids(case["evicted"])

    check(queuedIds(queue.items()) == ids(case["remaining"]), "the newest writes survive the cap")
    check(codes == listOf(code), "the evicted write is rejected with the documented code")
    // The evict observer is the only report a HYDRATED entry can produce — its
    // original caller did not survive the restart.
    check(evicted == listOf("${wantEvicted[0]}:$code"), "and the eviction is reported to the observer")
    check(store.removed == ids(case["persistRemoveCalls"]), "an evicted write is un-persisted")

    val clear = scenario("offlineQueue", "clear")
    val clearCodes = mutableListOf<String>()
    val clearStore = MemoryStore()
    val closing = OfflineQueue(persistence = clearStore)
    val enqueued = ids(clear["enqueue"])

    for (id in enqueued) closing.enqueue(entry(id!!, codes = clearCodes))

    closing.clear()

    check(clearCodes == enqueued.map { clear["code"] as String }, "closing rejects every queued write")
    check(closing.size == 0, "and empties the queue")
    // Closing must NOT discard writes the next session will restore.
    check(clearStore.removed.isEmpty(), "but leaves the durable records alone")
    check(clearStore.records.size == enqueued.size, "so a later session can restore them")
}

private fun offlineQueuePreconditionDropsStaleWrite() {
    covers("offline_queue_precondition_drops_stale_write")

    val case = scenario("offlineQueue", "precondition")
    val codes = mutableListOf<String>()
    val queue = OfflineQueue()

    for (raw in case["entries"] as List<*>) {
        val spec = raw as Map<*, *>
        val verdict = spec["precondition"] as Boolean
        val item = entry(spec["id"] as String, codes = codes)

        item.precondition = { verdict }
        queue.enqueue(item)
    }

    val conflicted = queue.drainConflict()

    check(queuedIds(conflicted) == ids(case["conflicted"]), "only the write whose precondition failed is dropped")
    check(queuedIds(queue.items()) == ids(case["remaining"]), "and the valid writes keep their FIFO order")
    check(codes == listOf(case["code"]), "the dropped write carries the documented code")
}

private fun offlineQueueHydratesPersistedWrites() {
    covers("offline_queue_hydrates_persisted_writes")

    val case = scenario("offlineQueue", "hydrate")
    val store = MemoryStore(persistedRecords(case))
    val queue = OfflineQueue(persistence = store, version = case["version"] as String)

    // Submitted during the boot window, BEFORE the durable load returns.
    for (id in ids(case["liveEnqueue"])) queue.enqueue(entry(id!!))

    val shardKeys = queue.hydrate()

    // The durable store's order is authoritative: a prior-session write is always
    // older, so replaying the boot-time write first would let last-writer-wins
    // clobber newer data with stale.
    check(queuedIds(queue.items()) == ids(case["queuedAfterHydrate"]), "restored writes land ahead of the boot-time write")
    // A record stamped under another app version is dropped AND purged.
    check(store.removed == ids(case["purged"]), "and a stale-version record is purged rather than replayed")
    check(shardKeys.toSet() == ids(case["shardKeys"]).toSet(), "the surviving writes' shard keys are reported")

    val overflow = scenario("offlineQueue", "hydrateOverflow")
    val evicted = mutableListOf<String>()
    val overflowStore = MemoryStore(persistedRecords(overflow))
    val capped = OfflineQueue(
        maxItems = count(overflow["maxItems"]),
        persistence = overflowStore,
        version = overflow["version"] as String,
    )

    capped.onEvict = { item, _ -> evicted.add(item.id) }

    val cappedKeys = capped.hydrate()

    check(queuedIds(capped.items()) == ids(overflow["queuedAfterHydrate"]), "hydration respects the capacity cap")
    check(evicted == ids(overflow["evicted"]), "dropping the oldest restored write")
    // Only the shards whose writes SURVIVED — a key gathered before eviction would
    // send the caller to open a socket with nothing queued behind it.
    check(cappedKeys == ids(overflow["shardKeys"]), "and reports only the surviving shards")

    // Version gating is OFF until a version is configured.
    check(!isStaleVersion(null, null), "no version configured, nothing is stale")
    check(!isStaleVersion(null, "v1"), "even a stamped record")
    check(isStaleVersion("v2", null), "an unstamped record is stale once gating is on")
    check(isStaleVersion("v2", "v1"), "and so is one from another version")
    check(!isStaleVersion("v2", "v2"), "the current version is not")

    // Two anonymous clients that collided on an id would share one de-duplication
    // namespace server-side, letting one suppress the other's writes.
    check(List(2000) { randomId() }.toSet().size == 2000, "minted ids must not collide")
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
    val codes = mutableListOf<String>()
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
    queued.reject = { error -> codes.add((error as? OfflineException)?.code ?: "?") }
    client.offlineQueue.enqueue(queued)

    val report = client.flushOfflineQueue()

    check(report.rejected == listOf("m1"), "the mismatched write is rejected")
    check(report.committed.isEmpty(), "and nothing commits")
    // Nothing reached the wire: a restart must not push the previous user's queued
    // writes as the current one.
    check(posts.isEmpty(), "the write never reaches the server")
    check(codes == listOf(case["code"]), "and it carries the documented code")
}

private fun offlineFlushReplaysAndConfirmsOptimistic() {
    covers("offline_flush_replays_and_confirms_optimistic")

    val case = scenario("offlineQueue", "flushReplay")
    val bySlot = (case["responses"] as List<*>).associate { raw ->
        val spec = raw as Map<*, *>

        spec["id"] as String to spec
    }
    val seenHeaders = mutableListOf<String?>()
    val confirmed = mutableListOf<Long?>()
    val store = MemoryStore()
    val client = Client(
        "https://app.example",
        { _, headers, _ ->
            val mutationId = headers["x-lunora-mutation-id"]

            seenHeaders.add(mutationId)

            val spec = bySlot.getValue(mutationId!!)

            when (spec["outcome"]) {
                "transport-error" -> throw IllegalStateException("connection reset")
                "coded-error" -> HttpResponse(200, "{\"error\":{\"code\":\"${spec["code"]}\",\"message\":\"gone\"}}")
                else -> HttpResponse(200, "{\"commitCursor\":${count(spec["commitCursor"])},\"result\":{\"ok\":true}}")
            }
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
    check(seenHeaders == ids(case["mutationIdHeaders"]), "queued writes replay in order, under their own idempotency keys")
    check(report.committed == ids(case["committed"]), "the good write commits")
    // A coded verdict is terminal: replaying it would only re-trigger the same
    // failure. A transport failure is not, so that write stays queued.
    check(report.rejected == ids(case["rejected"]), "a coded verdict is terminal")
    check(queuedIds(client.offlineQueue.items()) == ids(case["queuedAfterFlush"]), "and a transport failure leaves its write queued")
    check(report.requeued == ids(case["queuedAfterFlush"]), "as the report says")
    check(store.removed == ids(case["persistRemoveCalls"]), "every terminally settled write is un-persisted")
    check(confirmed == listOf(count(case["confirmedCommitCursor"]).toLong()), "and the committed write confirms against the echoed cursor")

    submitQueuesWhileOffline(count(case["confirmedCommitCursor"]))
    submitBeforeFirstConnectFailsFast()
    submitRollsBackARejectedWrite()
}

/** A write made with the socket down is queued, keeps its overlay, and replays on the flush. */
private fun submitQueuesWhileOffline(commitCursor: Int) {
    var posts = 0
    val seen = mutableListOf<WireValue>()
    val client = Client(
        "https://app.example",
        { _, _, _ ->
            posts++
            HttpResponse(200, "{\"commitCursor\":$commitCursor,\"result\":{\"ok\":true}}")
        },
    )
    val args = WireValue.Obj(listOf("channel" to WireValue.Text("general")))

    client.attachSocket { }
    client.subscribe("messages:list", args, { seen.add(it) })
    // Prime the subscription with a server value, then drop the socket.
    client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}")
    client.detachSocket()

    val options = SubmitOptions("messages:list", args)

    options.optimistic = appender(WireValue.Text("c"))

    val outcome = client.submit(options)
    val predicted = WireValue.Arr(listOf(WireValue.Text("a"), WireValue.Text("c")))

    check(outcome.status == MutationStatus.QUEUED, "a write with the socket down is queued")
    check(seen.last() == predicted, "and its overlay is displayed")
    check(posts == 0, "nothing reaches the wire while the socket is down")
    check(client.pendingMutationCount() == 1, "and the queue depth reflects it")

    client.attachSocket { }
    client.flushOfflineQueue()

    check(posts == 1, "the flush replays it")
    check(client.pendingMutationCount() == 0, "and drains the queue")
    // Still displayed: the overlay is confirmed at the commit cursor and drops only
    // once a frame reaches it.
    check(seen.last() == predicted, "the overlay survives the reply")

    client.handleFrame("{\"cursor\":$commitCursor,\"data\":[\"a\",\"c\"],\"id\":\"sub_1\",\"type\":\"data\"}")

    check(seen.last() == predicted, "and the confirming frame does not double-count it")
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

/** A rejected write takes its optimistic overlay down with it. */
private fun submitRollsBackARejectedWrite() {
    val seen = mutableListOf<WireValue>()
    val client = Client(
        "https://app.example",
        { _, _, _ -> HttpResponse(200, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}") },
    )

    client.attachSocket { }
    client.subscribe("messages:list", WireValue.Obj(emptyList()), { seen.add(it) })
    client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}")

    val options = SubmitOptions("messages:list", WireValue.Obj(emptyList()))

    options.optimistic = appender(WireValue.Text("c"))

    var threw = false

    try {
        client.submit(options)
    } catch (expected: ApiException) {
        threw = true
    }

    check(threw, "the server's verdict reaches the caller")
    check(seen.last() == WireValue.Arr(listOf(WireValue.Text("a"))), "and the overlay is gone")
}

/** Runs every optimistic-layer and offline-queue case. */
internal fun runOptimisticOfflineCases() {
    optimisticLayerRebasesOntoServerFrame()
    optimisticLayerDropsOnCommitCursor()
    optimisticLayerRollsBackOnFailure()
    offlineQueueFifoAndShardDrain()
    offlineQueueOverflowEvictsOldest()
    offlineQueuePreconditionDropsStaleWrite()
    offlineQueueHydratesPersistedWrites()
    offlineQueueIdentityGateRejectsReplay()
    offlineFlushReplaysAndConfirmsOptimistic()
}
