import Foundation
import XCTest

@testable import Lunora

/// The entries of a batch request body, or an empty list for a single call.
///
/// A file-scope function rather than a method: it is called from inside a poster
/// closure, where reaching for `self` would capture the test case.
func batchCalls(_ body: Data) -> [[String: Any]] {
    guard let parsed = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
        let calls = parsed["calls"] as? [[String: Any]]
    else { return [] }

    return calls
}

/// The `mutationId` of every entry in a batch request body, in order.
///
/// A flush of two or more writes coalesces into `/_lunora/rpc-batch`, so the
/// idempotency key rides in the ENTRY rather than in an `x-lunora-mutation-id`
/// header.
func batchMutationIDs(_ body: Data) -> [String?] {
    batchCalls(body).map { $0["mutationId"] as? String }
}

/// Answer a request in whichever shape it arrived in: a single call gets a whole
/// response, a batch gets one success slot per entry. A poster that only speaks
/// the single-call shape makes every batched write look unanswered.
func echoBatchSlots(_ body: Data, result: String = "null", commitCursor: Int? = nil) -> Data {
    let cursor = commitCursor.map { ",\"commitCursor\":\($0)" } ?? ""
    let calls = batchCalls(body)

    if calls.isEmpty { return Data("{\"result\":\(result)\(cursor)}".utf8) }

    let slots = calls.indices.map { "{\"id\":\($0),\"body\":{\"result\":\(result)\(cursor)}}" }

    return Data("{\"results\":[\(slots.joined(separator: ","))]}".utf8)
}

/// The cursor-gated optimistic-layer engine and the durable offline write queue,
/// against the shared golden scenarios in
/// `protocol/fixtures/offline-optimistic.json`.
///
/// Every expectation is read from that file so this port and the other six assert
/// the same values rather than each documenting its own behaviour.
///
/// These are `caseX` methods in an extension rather than `testX` methods for the
/// same reason the wire cases are: XCTest has no after-all hook that can fail, so
/// the manifest DRIVES the run and a required name with no dispatch arm fails.
/// `ConformanceTests.testConformanceManifestIsCovered` is their only entry point.
extension ConformanceTests {
    // MARK: - Helpers

    private func scenario(_ block: String, _ name: String) throws -> [String: Any] {
        let document = try fixture("offline-optimistic.json")
        let group = try XCTUnwrap(document[block] as? [String: Any])

        return try XCTUnwrap(group[name] as? [String: Any])
    }

    private func ids(_ value: Any?) -> [String?] {
        (value as? [Any] ?? []).map { $0 as? String }
    }

    private func count(_ value: Any?) -> Int {
        (value as? NSNumber)?.intValue ?? -1
    }

    /// The one transform primitive the fixtures use: push onto a COPY of the list.
    ///
    /// A copy, not an in-place append: a transform is re-run on every rebase, so
    /// one that mutated its input would compound its own effect on each frame.
    private func appender(_ item: Any) -> LunoraOptimistic.Transform {
        { current in
            var next = current as? [Any] ?? []

            next.append(item)

            return next
        }
    }

    /// Feeds one `data` frame through the client's REAL frame handler.
    ///
    /// Not a transcription of it: these cases used to hand-copy the `data` branch
    /// into the test, so a suite could stay green over a handler that forgot to
    /// drop confirmed layers or nulled the tracked cursor. `cursorlessFrame` is
    /// exactly that bug, and it is why the copy is gone.
    private func deliver(_ client: LunoraClient, _ frame: [String: Any], kind: String = "data") throws {
        var payload = frame

        payload["id"] = "sub_1"
        payload["type"] = kind

        let raw = try JSONSerialization.data(withJSONObject: payload)

        _ = try client.handleFrame(try XCTUnwrap(String(data: raw, encoding: .utf8)))
    }

    /// A client with one live subscription, seeded from `base` through that same
    /// handler. `sub_1` is its id — the first subscription on a fresh client.
    private func subscribedClient(
        base: Any?,
        onData: @escaping (Any) -> Void = { _ in }
    ) throws -> (client: LunoraClient, state: LunoraOptimisticState) {
        let client = LunoraClient(url: "https://app.example")

        client.attachSocket { _ in }
        client.subscribe("messages:list", args: [String: Any](), onData: onData)

        try deliver(client, ["data": base ?? NSNull()])

        return (client, try XCTUnwrap(client.optimisticState("sub_1")))
    }

    // MARK: - Optimistic layers

    func caseOptimisticLayerRebasesOntoServerFrame() throws {
        let testCase = try scenario("optimistic", "rebase")
        var seen: [Any] = []
        let (client, state) = try subscribedClient(base: testCase["base"]) { seen.append($0) }

        // The seeding frame delivered the base; count only what the layer causes.
        seen.removeAll()

        var deferred: LunoraOptimistic.Deferred = []

        _ = LunoraOptimistic.applyLayer(state, appender(testCase["appended"] ?? NSNull()), &deferred)

        for call in deferred { call() }

        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterApply"]),
            "the predicted value is displayed as soon as the layer is applied"
        )
        XCTAssertEqual(seen.count, 1, "and the handler is told exactly once")

        try deliver(client, try XCTUnwrap(testCase["frame"] as? [String: Any]))

        // The overlay survived the frame and was RE-FOLDED onto the new base,
        // rather than being clobbered by it.
        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterFrame"]),
            "a pending layer rebases onto the new authoritative base"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterFrame"]), "and is still pending afterwards")

        // A layer that DECLINES is skipped by the fold, not fatal to it: one
        // optimistic update that cannot apply must not blank the query for every
        // other layer. Built directly, because `applyLayer` refuses a transform
        // that declines on first application — this is the other case, a layer
        // that worked once and declines on a later rebase.
        let skipped = try scenario("optimistic", "throwingLayerSkipped")
        let second = LunoraOptimisticState(base: skipped["base"] ?? NSNull())
        var secondDeferred: LunoraOptimistic.Deferred = []

        second.layers.append(LunoraOptimisticLayer(transform: { _ in nil }))
        _ = LunoraOptimistic.applyLayer(second, appender(skipped["appended"] ?? NSNull()), &secondDeferred)

        XCTAssertEqual(second.layers.count, count(skipped["layers"]), "the declining layer is kept")
        XCTAssertEqual(
            canonical(LunoraOptimistic.fold(second.serverBase, second.layers)),
            canonical(skipped["displayed"]),
            "but skipped by the fold, so the good layer still applies"
        )
    }

    /// A byte-identical write yields a `settled` frame, never a `data` frame.
    /// Sweeping confirmed layers only on data frames leaves the prediction on
    /// screen until some unrelated write happens to change this query — on a
    /// quiet one, forever.
    func caseOptimisticLayerDropsOnSettledFrame() throws {
        let testCase = try scenario("optimistic", "settledFrameDrop")
        let commitCursor = count(testCase["commitCursor"])
        let (client, state) = try subscribedClient(base: testCase["base"])
        var deferred: LunoraOptimistic.Deferred = []
        let handle = try XCTUnwrap(
            LunoraOptimistic.applyLayer(state, appender(testCase["appended"] ?? NSNull()), &deferred)
        )

        handle.confirm(commitCursor, &deferred)
        try deliver(client, try XCTUnwrap(testCase["belowFrame"] as? [String: Any]), kind: "settled")

        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterBelowFrame"]),
            "a settled frame below the commit cursor keeps the overlay"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterBelowFrame"]), "and the layer with it")

        try deliver(client, try XCTUnwrap(testCase["atFrame"] as? [String: Any]), kind: "settled")

        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterAtFrame"]),
            "a settled frame reaching the commit cursor drops the overlay"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterAtFrame"]), "and the layer is gone")
    }

    func caseOptimisticLayerDropsOnCommitCursor() throws {
        let testCase = try scenario("optimistic", "commitCursorDrop")
        let commitCursor = count(testCase["commitCursor"])
        let (client, state) = try subscribedClient(base: testCase["base"])
        var deferred: LunoraOptimistic.Deferred = []
        let handle = try XCTUnwrap(
            LunoraOptimistic.applyLayer(state, appender(testCase["appended"] ?? NSNull()), &deferred)
        )

        handle.confirm(commitCursor, &deferred)
        try deliver(client, try XCTUnwrap(testCase["belowFrame"] as? [String: Any]))

        // Below the commit cursor: the write is NOT in the server base yet, so
        // dropping the overlay here would blink the value away and back.
        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterBelowFrame"]),
            "a frame below the commit cursor keeps the overlay"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterBelowFrame"]), "and the layer with it")

        try deliver(client, try XCTUnwrap(testCase["atFrame"] as? [String: Any]))

        // The frame reached the commit cursor: the effect is in the base, so the
        // overlay drops without the value ever double-counting it.
        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterAtFrame"]),
            "the confirming frame does not double-count the write"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterAtFrame"]), "and the layer is gone")

        // CDC is off on this shard, so there is no cursor to gate on. The layer
        // goes, but the display does not revert: the write DID commit.
        let without = try scenario("optimistic", "confirmWithoutCursor")
        let degraded = LunoraOptimisticState(base: without["base"] ?? NSNull())
        var degradedDeferred: LunoraOptimistic.Deferred = []
        let degradedHandle = try XCTUnwrap(
            LunoraOptimistic.applyLayer(degraded, appender(without["appended"] ?? NSNull()), &degradedDeferred)
        )

        degradedHandle.confirm(nil, &degradedDeferred)

        XCTAssertEqual(
            canonical(degraded.lastValue),
            canonical(without["displayedAfterConfirm"]),
            "confirming with no cursor does not revert a committed write"
        )
        XCTAssertEqual(degraded.layers.count, count(without["layersAfterConfirm"]), "but does drop the layer")

        // The confirming frame beat the RPC response — the common race. The overlay
        // must drop on confirm rather than linger until the next frame.
        let atFrame = try XCTUnwrap(testCase["atFrame"] as? [String: Any])
        let (racedClient, raced) = try subscribedClient(base: NSNull())
        var racedDeferred: LunoraOptimistic.Deferred = []

        // The cursor is the one the REAL handler tracked off that frame.
        try deliver(racedClient, atFrame)

        let racedHandle = try XCTUnwrap(LunoraOptimistic.applyLayer(raced, appender("x"), &racedDeferred))

        racedHandle.confirm(commitCursor, &racedDeferred)

        XCTAssertTrue(raced.layers.isEmpty, "a cursor the frames already reached drops the layer now")
        XCTAssertEqual(canonical(raced.lastValue), canonical(atFrame["data"]), "and the display reverts to the base")
    }

    func caseOptimisticLayerRollsBackOnFailure() throws {
        let testCase = try scenario("optimistic", "rollback")
        var seen: [Any] = []
        let state = LunoraOptimisticState(base: testCase["base"] ?? NSNull())

        state.callbacks.append { seen.append($0) }

        var deferred: LunoraOptimistic.Deferred = []
        let handle = try XCTUnwrap(
            LunoraOptimistic.applyLayer(state, appender(testCase["appended"] ?? NSNull()), &deferred)
        )

        handle.rollback(&deferred)

        for call in deferred { call() }

        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterRollback"]),
            "a rolled-back write leaves the server value displayed"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterRollback"]), "and no layer")
        XCTAssertEqual(canonical(seen.last), canonical(testCase["displayedAfterRollback"]), "the handler saw it")

        // A constant layer is an absolute override: while pending it re-clamps and
        // HIDES the concurrent server change rather than merging with it.
        let mask = try scenario("optimistic", "constantMask")
        let (maskClient, masked) = try subscribedClient(base: mask["base"])
        let store = LunoraOptimisticLocalStore(
            find: { _, _ in [masked] },
            matching: { _ in [LunoraQueryEntry(args: [String: Any](), value: masked.lastValue)] }
        )

        store.setQuery("messages:list", args: [String: Any](), value: mask["value"] ?? NSNull())
        // `setQuery` only RECORDS: the consumer's closure runs with the client
        // unlocked, and the layers it asked for are installed afterwards, under it.
        store.install()

        for call in store.deferred { call() }

        XCTAssertEqual(
            canonical(masked.lastValue),
            canonical(mask["displayedAfterApply"]),
            "setQuery displays the predicted value"
        )
        XCTAssertEqual(
            canonical(store.getQuery("messages:list", args: [String: Any]())),
            canonical(mask["displayedAfterApply"]),
            "and getQuery reads it back"
        )

        try deliver(maskClient, try XCTUnwrap(mask["frame"] as? [String: Any]))

        XCTAssertEqual(
            canonical(masked.lastValue),
            canonical(mask["displayedAfterFrame"]),
            "the override masks a concurrent server change"
        )

        var rollbackDeferred: LunoraOptimistic.Deferred = []

        LunoraOptimistic.rollbackAll(store.handles, &rollbackDeferred)

        XCTAssertEqual(
            canonical(masked.lastValue),
            canonical(mask["displayedAfterRollback"]),
            "and rolling back reveals it"
        )
    }

    /// A frame may omit `cursor` (see `protocol/README.md`), and one that does must
    /// leave the tracked cursor where it was — it is what a later `commitCursor` is
    /// compared against, so nulling it keeps an overlay the confirm should have
    /// dropped and the write renders twice.
    func caseOptimisticCursorlessFramePreservesCursor() throws {
        let testCase = try scenario("optimistic", "cursorlessFrame")
        let (client, state) = try subscribedClient(base: testCase["base"])
        var deferred: LunoraOptimistic.Deferred = []
        let handle = try XCTUnwrap(
            LunoraOptimistic.applyLayer(state, appender(testCase["appended"] ?? NSNull()), &deferred)
        )

        try deliver(client, try XCTUnwrap(testCase["cursoredFrame"] as? [String: Any]))
        try deliver(client, try XCTUnwrap(testCase["cursorlessFrame"] as? [String: Any]))

        XCTAssertEqual(
            state.serverCursor,
            count(testCase["cursorAfterCursorlessFrame"]),
            "a cursorless frame leaves the tracked cursor alone"
        )
        XCTAssertEqual(
            canonical(state.lastValue),
            canonical(testCase["displayedAfterCursorlessFrame"]),
            "and still rebases the pending layer onto its payload"
        )
        XCTAssertEqual(state.layers.count, count(testCase["layersAfterCursorlessFrame"]), "which is still pending")

        handle.confirm(count(testCase["commitCursor"]), &deferred)

        XCTAssertEqual(
            state.layers.count,
            count(testCase["layersAfterConfirm"]),
            "so the confirm has a cursor to compare against and drops the overlay"
        )
    }

    // MARK: - Offline queue

    private func entry(_ id: String, shardKey: String? = nil, args: Any = [String: Any]()) -> LunoraQueuedMutation {
        LunoraQueuedMutation(id: id, functionPath: "messages:send", args: args, shardKey: shardKey)
    }

    private func queuedIDs(_ queue: LunoraOfflineQueue) -> [String?] {
        queue.items().map { $0.id }
    }

    /// A fixture's `persisted` list, as durable records.
    private func persistedRecords(_ testCase: [String: Any]) -> [[String: Any]] {
        (testCase["persisted"] as? [[String: Any]] ?? []).map { spec in
            [
                "args": [String: Any](),
                "functionPath": "messages:send",
                "id": spec["id"] ?? "",
                "shardKey": spec["shardKey"] ?? NSNull(),
                "version": spec["version"] ?? NSNull(),
            ]
        }
    }

    /// A predicate drain flushes one shard and leaves the rest queued in order.
    func caseOfflineQueueDrainsOnlyTheNamedShard() throws {
        let shard = try scenario("offlineQueue", "shardDrain")
        let sharded = LunoraOfflineQueue()

        for spec in shard["entries"] as? [[String: Any]] ?? [] {
            sharded.enqueue(entry(try XCTUnwrap(spec["id"] as? String), shardKey: spec["shardKey"] as? String))
        }

        let target = shard["drainShardKey"] as? String

        // Normalised, exactly as the client's flush drains: a write submitted with
        // `shardKey: ""` belongs to the default shard, and comparing the two
        // strictly leaves it queued for a shard nothing ever flushes.
        XCTAssertEqual(
            sharded.drain { lunoraSameShard($0.shardKey, target) }.map { $0.id },
            ids(shard["drained"]).compactMap { $0 },
            "one shard's writes drained, an empty key counting as the null one"
        )
        XCTAssertEqual(queuedIDs(sharded), ids(shard["remaining"]), "and the rest stay queued in order")

        // The same normalisation through the CLIENT, which is where a strict
        // comparison actually strands the write: the flush is the only thing that
        // ever names a shard.
        var replayed: [String?] = []
        // Three writes drain together, so they coalesce into ONE batch hop and
        // their idempotency keys ride in the entries rather than in a header.
        let flushing = LunoraClient(
            url: "https://app.example",
            post: { _, _, body in
                replayed.append(contentsOf: batchMutationIDs(body))

                return (200, echoBatchSlots(body))
            }
        )

        for spec in shard["entries"] as? [[String: Any]] ?? [] {
            flushing.offlineQueue.enqueue(
                entry(try XCTUnwrap(spec["id"] as? String), shardKey: spec["shardKey"] as? String)
            )
        }

        flushing.flushOfflineQueue(shardKey: target)

        XCTAssertEqual(replayed, ids(shard["drained"]), "an empty shard key replays on the default shard's flush")
    }

    func caseOfflineQueueFifoReplayOrder() throws {
        let fifo = try scenario("offlineQueue", "fifo")
        var sizes: [Int] = []
        let queue = LunoraOfflineQueue()

        queue.onSizeChange = { sizes.append($0) }

        for id in ids(fifo["enqueue"]) {
            queue.enqueue(entry(try XCTUnwrap(id)))
        }

        XCTAssertEqual(queue.size, count(fifo["sizeAfterEnqueue"]), "every write is queued")
        XCTAssertEqual(
            queue.drain { _ in true }.map { $0.id },
            ids(fifo["drained"]).compactMap { $0 },
            "writes drain in submission order"
        )
        XCTAssertEqual(sizes.last, count(fifo["sizeAfterDrain"]), "and the depth observer sees the queue empty")

        let requeue = try scenario("offlineQueue", "requeue")
        let store = MemoryPersistence()
        let durable = LunoraOfflineQueue(persistence: store)

        for id in ids(requeue["enqueue"]) {
            durable.enqueue(entry(try XCTUnwrap(id)))
        }

        let wanted = ids(requeue["requeued"]).compactMap { $0 }

        durable.requeue(durable.drain { _ in true }.filter { wanted.contains($0.id) })

        XCTAssertEqual(
            queuedIDs(durable),
            ids(requeue["queuedAfterRequeue"]),
            "requeued writes return to the front, in order"
        )
        // Durable storage still holds them — they were never un-persisted, so a
        // re-append would duplicate the record.
        XCTAssertEqual(
            store.appended.count,
            count(requeue["persistAppendCalls"]),
            "and a requeue does not re-persist them"
        )
    }

    func caseOfflineQueueOverflowEvictsOldest() throws {
        let testCase = try scenario("offlineQueue", "overflow")
        let store = MemoryPersistence()
        let queue = LunoraOfflineQueue(maxItems: count(testCase["maxItems"]), persistence: store)
        var evicted: [String] = []

        for id in ids(testCase["enqueue"]) {
            for discarded in queue.enqueue(entry(try XCTUnwrap(id))) {
                XCTAssertEqual(discarded.code, LunoraOfflineCode.queueOverflow, "the eviction is coded")
                evicted.append(discarded.entry.id)
            }
        }

        XCTAssertEqual(queuedIDs(queue), ids(testCase["remaining"]), "the newest writes survive the cap")
        XCTAssertEqual(evicted, ids(testCase["evicted"]).compactMap { $0 }, "the OLDEST write is the one dropped")
        XCTAssertEqual(
            store.removed,
            ids(testCase["persistRemoveCalls"]).compactMap { $0 },
            "an evicted write is un-persisted"
        )

        // Closing rejects every pending write so no caller waits on a dead client,
        // but leaves durable storage INTACT: the next session restores them.
        let clear = try scenario("offlineQueue", "clear")
        let clearStore = MemoryPersistence()
        let closing = LunoraOfflineQueue(persistence: clearStore)
        let enqueued = ids(clear["enqueue"]).compactMap { $0 }

        for id in enqueued {
            closing.enqueue(entry(id))
        }

        let discarded = closing.clear()

        XCTAssertEqual(discarded.map { $0.entry.id }, ids(clear["rejected"]).compactMap { $0 })
        XCTAssertTrue(discarded.allSatisfy { $0.code == LunoraOfflineCode.clientClosed }, "with the documented code")
        XCTAssertEqual(clearStore.removed, [], "closing un-persists nothing")
        XCTAssertEqual(clearStore.records.count, enqueued.count, "so a later session can restore them")
    }

    func caseOfflineQueuePreconditionDropsStaleWrite() throws {
        let testCase = try scenario("offlineQueue", "precondition")
        let queue = LunoraOfflineQueue()

        for spec in testCase["entries"] as? [[String: Any]] ?? [] {
            let verdict = spec["precondition"] as? Bool ?? true
            let item = entry(try XCTUnwrap(spec["id"] as? String))

            item.precondition = { verdict }
            queue.enqueue(item)
        }

        // The verdicts are computed OUTSIDE the queue, exactly as the client does
        // it: a precondition is consumer code and never runs where the queue is
        // mid-mutation.
        let stale = Set(queue.items().filter { $0.precondition.map { !$0() } ?? false }.map { $0.id })
        let conflicted = queue.drainConflict(stale: stale)

        XCTAssertEqual(
            conflicted.map { $0.entry.id },
            ids(testCase["conflicted"]).compactMap { $0 },
            "only the write whose precondition failed is dropped"
        )
        XCTAssertTrue(conflicted.allSatisfy { $0.code == LunoraOfflineCode.preconditionFailed }, "with the documented code")
        XCTAssertEqual(queuedIDs(queue), ids(testCase["remaining"]), "and the valid writes keep their FIFO order")
    }

    func caseOfflineQueueHydratesPersistedWrites() throws {
        let testCase = try scenario("offlineQueue", "hydrate")
        let store = MemoryPersistence(records: persistedRecords(testCase))
        let queue = LunoraOfflineQueue(persistence: store, version: testCase["version"] as? String)

        // Submitted during the boot window, BEFORE the durable load returns.
        for id in ids(testCase["liveEnqueue"]) {
            queue.enqueue(entry(try XCTUnwrap(id)))
        }

        store.appended = []

        let (shardKeys, evicted) = try queue.hydrate()

        XCTAssertTrue(evicted.isEmpty, "nothing exceeded the default capacity")
        // The durable store's order is authoritative: a prior-session write is
        // always older, so replaying the boot-time write first would let
        // last-writer-wins clobber newer data with stale.
        XCTAssertEqual(
            queuedIDs(queue),
            ids(testCase["queuedAfterHydrate"]),
            "restored writes land ahead of the boot-time write"
        )
        // A record stamped under another app version is dropped AND purged.
        XCTAssertEqual(
            store.removed,
            ids(testCase["purged"]).compactMap { $0 },
            "and a stale-version record is purged rather than replayed"
        )
        XCTAssertEqual(
            Set(shardKeys.map { $0 ?? "" }),
            Set(ids(testCase["shardKeys"]).map { $0 ?? "" }),
            "the surviving writes' shard keys are reported"
        )

        let overflow = try scenario("offlineQueue", "hydrateOverflow")
        let overflowStore = MemoryPersistence(records: persistedRecords(overflow))
        let capped = LunoraOfflineQueue(
            maxItems: count(overflow["maxItems"]),
            persistence: overflowStore,
            version: overflow["version"] as? String
        )
        let (cappedKeys, cappedEvicted) = try capped.hydrate()

        XCTAssertEqual(
            queuedIDs(capped),
            ids(overflow["queuedAfterHydrate"]),
            "hydration respects the capacity cap"
        )
        XCTAssertEqual(
            cappedEvicted.map { $0.entry.id },
            ids(overflow["evicted"]).compactMap { $0 },
            "dropping the oldest restored write"
        )
        try assertTypedArgsSurviveASerialisingStore()
        try assertAnUndecodableRecordSettlesRejected()

        // Only the shards whose writes SURVIVED — a key gathered before eviction
        // would send the caller to open a socket with nothing queued behind it.
        XCTAssertEqual(cappedKeys.map { $0 ?? "" }, ids(overflow["shardKeys"]).map { $0 ?? "" })

        // Version gating is OFF until a version is configured.
        XCTAssertFalse(lunoraIsStaleVersion(nil, nil))
        XCTAssertFalse(lunoraIsStaleVersion(nil, "v1"))
        XCTAssertTrue(lunoraIsStaleVersion("v2", nil))
        XCTAssertTrue(lunoraIsStaleVersion("v2", "v1"))
        XCTAssertFalse(lunoraIsStaleVersion("v2", "v2"))

        // Two anonymous clients that collided on an id would share one
        // de-duplication namespace server-side, letting one suppress the other.
        var minted = Set<String>()

        for _ in 0..<2000 { minted.insert(lunoraRandomID()) }

        XCTAssertEqual(minted.count, 2000, "minted ids must not collide")

        // Same reason the client id is minted per instance rather than being a
        // per-language constant: it namespaces an anonymous caller's idempotency
        // rows, so a shared value lets one client's mutation id suppress another's.
        XCTAssertNotEqual(
            LunoraClient(url: "https://app.example").clientID,
            LunoraClient(url: "https://app.example").clientID,
            "each client mints its own id"
        )
    }

    func caseOfflineQueueIdentityGateRejectsReplay() throws {
        let testCase = try scenario("offlineQueue", "identityGate")

        for spec in testCase["cases"] as? [[String: Any]] ?? [] {
            let stamped: LunoraIdentity

            if let text = spec["stamped"] as? String {
                stamped = text == "absent" ? .absent : .subject(text)
            } else {
                stamped = .signedOut
            }

            XCTAssertEqual(
                stamped.allowsReplay(under: spec["current"] as? String),
                try XCTUnwrap(spec["replays"] as? Bool),
                "identity gate: \(spec["name"] as? String ?? "?")"
            )
        }

        var posts = 0
        var codes: [String] = []
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in
                posts += 1

                return (200, Data("{\"result\":null}".utf8))
            }
        )

        client.identity = "user-b"
        client.onMutationSettled { event in
            if let error = event.error as? LunoraAPIError { codes.append(error.code) }
        }

        let queued = entry("m1")

        queued.identity = .subject("user-a")
        client.offlineQueue.enqueue(queued)

        let report = client.flushOfflineQueue()

        XCTAssertEqual(report.rejected, ["m1"], "the mismatched write is rejected")
        XCTAssertTrue(report.committed.isEmpty, "and nothing commits")
        // Nothing reached the wire: a restart must not push the previous user's
        // queued writes as the current one.
        XCTAssertEqual(posts, 0, "the write never reaches the server")
        XCTAssertEqual(codes, [try XCTUnwrap(testCase["code"] as? String)], "and it carries the documented code")
    }

    /// Two or more queued writes coalesce into ONE `/_lunora/rpc-batch` round trip,
    /// and each slot is classified exactly as a whole single-call response is.
    /// A queued write carrying `bigint`, `bytes` and `Date` args round-trips a
    /// store that serialises.
    ///
    /// Persisting the NATIVE wrappers reports the write "queued" while the adapter
    /// throws and nothing durable is written — or writes whatever the adapter
    /// makes of an opaque value and replays it after a restart with corrupted
    /// args.
    private func assertTypedArgsSurviveASerialisingStore() throws {
        let args: [String: Any] = [
            "amount": WireBigInt("7"),
            "blob": WireBytes(data: Data([1, 2, 3, 4]), ctor: "Int32Array"),
            "when": WireDate(1_700_000_000_000),
        ]
        let store = MemoryPersistence()
        let queue = LunoraOfflineQueue(persistence: store)
        var failures: [String] = []

        queue.onPersistenceError = { operation, _, _ in failures.append(operation) }
        queue.enqueue(LunoraQueuedMutation(id: "m-typed", functionPath: "ledger:add", args: args))

        XCTAssertEqual(failures, [], "the record must serialise, so nothing is reported as a failed append")
        XCTAssertEqual(
            canonical((store.appended.first?["args"] as? [String: Any])?["amount"]),
            canonical([Wire.tag, "bigint", "7"]),
            "the durable record holds the WIRE form"
        )

        let restored = LunoraOfflineQueue(persistence: store)

        _ = try restored.hydrate()

        XCTAssertEqual(queuedIDs(restored), ["m-typed"])

        // Decoded back to the SAME native values, so the replay sends the write
        // that was made rather than whatever the adapter's stringification left.
        let back = try XCTUnwrap(restored.items().first?.args as? [String: Any])

        XCTAssertEqual(back["amount"] as? WireBigInt, WireBigInt("7"))
        XCTAssertEqual(back["blob"] as? WireBytes, WireBytes(data: Data([1, 2, 3, 4]), ctor: "Int32Array"))
        XCTAssertEqual(back["when"] as? WireDate, WireDate(1_700_000_000_000))
    }

    /// A persisted record whose args do not decode is purged and settled, never
    /// replayed with substitute args — that would commit a DIFFERENT write than
    /// the caller made — and never thrown out of hydrate, which would kill the
    /// whole restart path.
    private func assertAnUndecodableRecordSettlesRejected() throws {
        let store = MemoryPersistence(records: [
            ["args": ["amount": [Wire.tag, "bigint", "not-a-number"]], "functionPath": "ledger:add", "id": "m-bad"]
        ])
        var settled: [LunoraMutationSettled] = []
        let client = LunoraClient(url: "https://app.example")

        client.offlineQueue = LunoraOfflineQueue(persistence: store)
        client.onMutationSettled { settled.append($0) }

        _ = try client.hydrateOfflineQueue()

        XCTAssertEqual(queuedIDs(client.offlineQueue), [])
        XCTAssertEqual(settled.map { $0.mutationID }, ["m-bad"])
        XCTAssertEqual(settled.first?.status, .rejected)
        XCTAssertEqual((settled.first?.error as? LunoraAPIError)?.code, LunoraOfflineCode.writeUndecodable)
        XCTAssertEqual(store.removed, ["m-bad"], "the unreadable record is purged, not left to fail every restart")
    }

    /// A batch the worker refuses for SIZE is split and retried, not rejected.
    ///
    /// The worker reads a batch body under a 1 MiB budget
    /// (`packages/runtime/src/body-readers.ts`) and answers 413
    /// `PAYLOAD_TOO_LARGE` past it. A whole-batch coded envelope is a verdict on
    /// every entry, so a count-only chunker settled the lot `rejected` — 500
    /// durable writes dropped for the size of the batch they shared.
    func caseOfflineFlushBatchSplitsOnPayloadTooLarge() throws {
        let budget = 400
        var bodies: [Int] = []
        let store = MemoryPersistence()
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, body in
                bodies.append(body.count)

                if body.count > budget {
                    return (413, Data("{\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"Body too large\"}}".utf8))
                }

                return (200, echoBatchSlots(body, commitCursor: 1))
            }
        )

        client.clientID = "c-1"
        client.offlineQueue = LunoraOfflineQueue(persistence: store)

        let queued = (0..<4).map { "m-\($0)" }

        for id in queued {
            client.offlineQueue.enqueue(entry(id, args: ["text": String(repeating: "x", count: 120)]))
        }

        let report = client.flushOfflineQueue()

        XCTAssertEqual(report.committed, queued, "every write commits; none is dropped for the size of the batch it shared")
        XCTAssertEqual(report.rejected, [])
        XCTAssertTrue(report.requeued.isEmpty)
        XCTAssertEqual(queuedIDs(client.offlineQueue), [])
        XCTAssertGreaterThan(bodies.max() ?? 0, budget, "the first attempt has to be the over-budget one, or nothing was split")
    }

    /// An envelope-less non-2xx and a 429 are both "not now", never "no".
    ///
    /// A 502 edge page is coded `INTERNAL` by `parseRPCResponse`, so a flush of
    /// exactly ONE queued write used to drop it terminally while the same response
    /// with two or more was transient — whether a gateway blip LOST a durable
    /// write depended on the queue's depth. And a rate limit is the one verdict a
    /// durable queue must never honour: the write is valid and the server asked
    /// for it later.
    func testATransportFailureAndARateLimitBothRequeueALoneWrite() throws {
        var settled: [LunoraMutationSettled] = []
        let gatewayStore = MemoryPersistence()
        let gateway = LunoraClient(url: "https://app.example", post: { _, _, _ in (502, Data("{\"message\":\"bad gateway\"}".utf8)) })

        gateway.offlineQueue = LunoraOfflineQueue(persistence: gatewayStore)
        gateway.onMutationSettled { settled.append($0) }
        gateway.offlineQueue.enqueue(entry("m-502"))

        let blip = gateway.flushOfflineQueue()

        XCTAssertEqual(blip.rejected, [])
        XCTAssertEqual(blip.requeued, ["m-502"])
        XCTAssertEqual(queuedIDs(gateway.offlineQueue), ["m-502"])
        XCTAssertTrue(settled.isEmpty, "nothing settled: no verdict was ever reached")
        XCTAssertEqual(gatewayStore.removed, [], "the durable record stays, because the write is still good")

        var posts = 0
        let limited = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in
                posts += 1

                let envelope = "{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":900000},\"message\":\"slow down\"}}"

                return (429, Data(envelope.utf8))
            }
        )

        limited.offlineQueue = LunoraOfflineQueue(persistence: MemoryPersistence())
        limited.offlineQueue.enqueue(entry("m-429"))

        let first = limited.flushOfflineQueue()

        XCTAssertEqual(first.rejected, [])
        XCTAssertEqual(first.requeued, ["m-429"])
        XCTAssertEqual(first.retryAfterMs, lunoraMaxRetryAfterMs, "a delay past the clamp is honoured only up to it")

        let again = limited.flushOfflineQueue()

        XCTAssertEqual(posts, 1, "the second flush must wait out the delay rather than earn the same 429")
        XCTAssertGreaterThan(again.retryAfterMs ?? 0, 0)
        XCTAssertEqual(queuedIDs(limited.offlineQueue), ["m-429"])

        // And per SLOT, through that same predicate: a batch reply that rate-limits
        // one entry is not a verdict on it either.
        let batched = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in
                let slots = [
                    "{\"id\":0,\"body\":{\"commitCursor\":1,\"result\":null}}",
                    "{\"id\":1,\"body\":{\"error\":{\"code\":\"TOO_MANY_REQUESTS\",\"data\":{\"retryAfterMs\":30000},\"message\":\"slow down\"}}}",
                ]

                return (200, Data("{\"results\":[\(slots.joined(separator: ","))]}".utf8))
            }
        )

        batched.offlineQueue = LunoraOfflineQueue(persistence: MemoryPersistence())
        batched.offlineQueue.enqueue(entry("m-ok"))
        batched.offlineQueue.enqueue(entry("m-slot-429"))

        let slotted = batched.flushOfflineQueue()

        XCTAssertEqual(slotted.committed, ["m-ok"])
        XCTAssertEqual(slotted.rejected, [], "a rate-limited slot is retried, not reported failed")
        XCTAssertEqual(slotted.requeued, ["m-slot-429"])
        XCTAssertEqual(slotted.retryAfterMs, 30000, "and the slot's own hint is what the next flush waits out")
    }

    /// The entry cap is not a port's to choose: the worker and the shard DO both
    /// refuse a larger batch with a coded 400, which `protocol/README.md` 4.3
    /// makes a TERMINAL verdict — so a client chunking at a stale value discards
    /// durable writes instead of retrying them. It was a bare 500 in ten
    /// independent places with nothing reconciling them.
    func caseBatchEntryCapMatchesProtocol() throws {
        let testCase = try scenario("offlineQueue", "batchReplay")
        let expected = try XCTUnwrap((testCase["maxEntries"] as? NSNumber)?.intValue)

        XCTAssertEqual(lunoraMaxBatchEntries, expected)
    }

    func caseOfflineFlushBatchesMultipleWrites() throws {
        let testCase = try scenario("offlineQueue", "batchReplay")
        let slots = testCase["slots"] as? [[String: Any]] ?? []
        var urls: [String] = []
        var calls: [[String: Any]] = []
        let store = MemoryPersistence()
        let client = LunoraClient(
            url: "https://app.example",
            post: { url, _, body in
                urls.append(url)
                calls.append(contentsOf: batchCalls(body))

                let answers: [String] = slots.map { slot in
                    let id = (slot["id"] as? NSNumber)?.intValue ?? 0

                    if slot["outcome"] as? String == "ok" {
                        let cursor = (slot["commitCursor"] as? NSNumber)?.intValue ?? 0

                        return "{\"id\":\(id),\"body\":{\"commitCursor\":\(cursor),\"result\":null}}"
                    }

                    let code = slot["code"] as? String ?? "INTERNAL"

                    return "{\"id\":\(id),\"body\":{\"error\":{\"code\":\"\(code)\",\"message\":\"slot failed\"}}}"
                }

                return (200, Data("{\"results\":[\(answers.joined(separator: ","))]}".utf8))
            }
        )

        client.clientID = "c-1"
        client.offlineQueue = LunoraOfflineQueue(persistence: store)

        for id in ids(testCase["queued"]) {
            client.offlineQueue.enqueue(entry(try XCTUnwrap(id)))
        }

        let report = client.flushOfflineQueue()

        XCTAssertEqual(urls.count, count(testCase["requests"]), "the whole flush is one batch hop")
        XCTAssertTrue(
            try XCTUnwrap(urls.first).hasSuffix(try XCTUnwrap(testCase["path"] as? String)),
            "sent to the batch endpoint"
        )

        // The idempotency key and the client id ride in the ENTRY, not in a request
        // header: a batch is one hop carrying independent calls, and a single outer
        // header would de-duplicate the whole chunk against one id.
        let wanted = testCase["calls"] as? [[String: Any]] ?? []

        XCTAssertEqual(calls.count, wanted.count, "one entry per queued write")

        for (index, got) in calls.enumerated() {
            let want = wanted[index]

            XCTAssertEqual(got["clientId"] as? String, want["clientId"] as? String, "entry \(index) client id")
            XCTAssertEqual(got["functionPath"] as? String, want["functionPath"] as? String, "entry \(index) path")
            XCTAssertEqual(count(got["id"]), count(want["id"]), "entry \(index) slot id")
            XCTAssertEqual(got["mutationId"] as? String, want["mutationId"] as? String, "entry \(index) key")
        }

        XCTAssertEqual(report.committed, ids(testCase["committed"]).compactMap { $0 }, "the successful slot commits")
        // A transient shard code in a slot is not a verdict, so that write goes back
        // on the queue instead of being reported as failed — and so does the slot the
        // server never returned at all.
        XCTAssertEqual(report.rejected, ids(testCase["rejected"]).compactMap { $0 }, "only the coded verdict is terminal")
        XCTAssertEqual(queuedIDs(client.offlineQueue), ids(testCase["queuedAfterFlush"]), "the rest are re-queued, in order")
        XCTAssertEqual(store.removed, ids(testCase["persistRemoveCalls"]).compactMap { $0 }, "only the settled writes are un-persisted")
    }

    func caseOfflineFlushReplaysAndConfirmsOptimistic() throws {
        let testCase = try scenario("offlineQueue", "flushReplay")
        let responses = testCase["responses"] as? [[String: Any]] ?? []
        var seenIDs: [String?] = []
        let store = MemoryPersistence()
        // The three fixture outcomes, as this transport now expresses them. Three
        // queued writes coalesce into ONE batch hop, so `ok` and `coded-error` are
        // slots and `transport-error` is an ABSENT slot: a per-entry transport
        // failure is the server not answering for that entry, and an unanswered
        // write is retried under its original idempotency key exactly as an
        // uncoded throw re-queues on the single-call path.
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, body in
                seenIDs.append(contentsOf: batchMutationIDs(body))

                let slots: [String] = responses.enumerated().compactMap { index, spec in
                    switch spec["outcome"] as? String {
                    case "coded-error":
                        let code = spec["code"] as? String ?? "INTERNAL"

                        return "{\"id\":\(index),\"body\":{\"error\":{\"code\":\"\(code)\",\"message\":\"gone\"}}}"
                    case "ok":
                        let cursor = (spec["commitCursor"] as? NSNumber)?.intValue ?? 0

                        return "{\"id\":\(index),\"body\":{\"commitCursor\":\(cursor),\"result\":{\"ok\":true}}}"
                    default:
                        return nil
                    }
                }

                return (200, Data("{\"results\":[\(slots.joined(separator: ","))]}".utf8))
            }
        )

        client.offlineQueue = LunoraOfflineQueue(persistence: store)

        for id in ids(testCase["queued"]) {
            let item = entry(try XCTUnwrap(id))

            item.clientID = "client-1"
            client.offlineQueue.enqueue(item)
        }

        let report = client.flushOfflineQueue()

        // Replayed in FIFO order, each under its own idempotency key so a write the
        // server already committed is de-duplicated rather than re-applied.
        XCTAssertEqual(seenIDs, ids(testCase["mutationIdHeaders"]), "replayed in order")
        XCTAssertEqual(report.committed, ids(testCase["committed"]).compactMap { $0 })
        // A coded verdict is terminal: replaying it would only re-trigger the same
        // failure. A transport failure is not, so that write stays queued.
        XCTAssertEqual(report.rejected, ids(testCase["rejected"]).compactMap { $0 })
        XCTAssertEqual(queuedIDs(client.offlineQueue), ids(testCase["queuedAfterFlush"]))
        XCTAssertEqual(report.requeued, ids(testCase["queuedAfterFlush"]).compactMap { $0 })
        XCTAssertEqual(store.removed, ids(testCase["persistRemoveCalls"]).compactMap { $0 })

        try submitQueuesWhileOffline(commitCursor: count(testCase["confirmedCommitCursor"]))
        try submitBeforeFirstConnectFailsFast()
        try submitRollsBackARejectedWrite()
        try overflowDuringSubmitSettles()
    }

    /// An eviction raised from inside ``LunoraClient/submit(_:)`` settles exactly
    /// once.
    ///
    /// Never a hazard here — ``LunoraOfflineQueue`` returns what it discarded
    /// rather than rejecting in place — but the sibling ports had to be moved onto
    /// this shape to make it true: rejecting inside the queue re-entered the very
    /// lock `submit` was holding, which self-deadlocked Go and had Ruby swallow the
    /// verdict. This asserts the behaviour every port now shares.
    private func overflowDuringSubmitSettles() throws {
        let testCase = try scenario("offlineQueue", "overflow")
        let maxItems = count(testCase["maxItems"])
        var settled: [LunoraMutationSettled] = []
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in (200, Data("{\"result\":null}".utf8)) }
        )

        client.offlineQueue = LunoraOfflineQueue(maxItems: maxItems, queueBeforeFirstConnect: true)
        client.onMutationSettled { settled.append($0) }

        for _ in 0..<ids(testCase["enqueue"]).count {
            _ = try client.submit(LunoraSubmitOptions(functionPath: "messages:send"))
        }

        XCTAssertEqual(settled.count, 1, "the evicted write settles exactly once")
        XCTAssertEqual(settled.first?.status, .rejected, "as a rejection")
        XCTAssertEqual(
            (settled.first?.error as? LunoraAPIError)?.code,
            LunoraOfflineCode.queueOverflow,
            "carrying the documented overflow code"
        )
        XCTAssertEqual(client.pendingMutationCount, maxItems, "and the cap is respected")
    }

    /// A write made with the socket down is queued, keeps its overlay, and replays
    /// on the next flush.
    private func submitQueuesWhileOffline(commitCursor: Int) throws {
        var posts = 0
        var seen: [Any] = []
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in
                posts += 1

                return (200, Data("{\"commitCursor\":\(commitCursor),\"result\":{\"ok\":true}}".utf8))
            }
        )
        let args: [String: Any] = ["channel": "general"]

        client.attachSocket { _ in }
        client.subscribe("messages:list", args: args, onData: { seen.append($0) })
        // Prime the subscription with a server value, then drop the socket.
        _ = try client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}")
        client.detachSocket()

        let outcome = try client.submit(
            LunoraSubmitOptions(functionPath: "messages:list", args: args, optimistic: appender("c"))
        )

        XCTAssertEqual(outcome.status, .queued, "a write with the socket down is queued")
        XCTAssertEqual(canonical(seen.last), canonical(["a", "c"]), "and its overlay is displayed")
        XCTAssertEqual(posts, 0, "nothing reaches the wire while the socket is down")
        XCTAssertEqual(client.pendingMutationCount, 1, "and the queue depth reflects it")

        client.attachSocket { _ in }
        client.flushOfflineQueue()

        XCTAssertEqual(posts, 1, "the flush replays it")
        XCTAssertEqual(client.pendingMutationCount, 0, "and drains the queue")
        // Still displayed: the overlay is confirmed at the commit cursor and drops
        // only once a frame reaches it.
        XCTAssertEqual(canonical(seen.last), canonical(["a", "c"]), "the overlay survives the reply")

        _ = try client.handleFrame(
            "{\"cursor\":\(commitCursor),\"data\":[\"a\",\"c\"],\"id\":\"sub_1\",\"type\":\"data\"}"
        )

        XCTAssertEqual(
            canonical(seen.last),
            canonical(["a", "c"]),
            "and the confirming frame does not double-count it"
        )
    }

    /// Never connected and the opt-in is off, so a misconfigured endpoint surfaces
    /// on the first write rather than silently filling a queue that never flushes.
    private func submitBeforeFirstConnectFailsFast() throws {
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in throw LunoraSubscriptionError(code: nil, message: "no route to host") }
        )

        XCTAssertThrowsError(
            try client.submit(LunoraSubmitOptions(functionPath: "messages:send")),
            "the first write must fail before any connect"
        )
        XCTAssertEqual(client.pendingMutationCount, 0, "and nothing is queued")

        client.offlineQueue = LunoraOfflineQueue(queueBeforeFirstConnect: true)

        let outcome = try client.submit(LunoraSubmitOptions(functionPath: "messages:send"))

        XCTAssertEqual(outcome.status, .queued, "the opt-in queues it instead")
        XCTAssertEqual(client.pendingMutationCount, 1, "and the queue holds it")
    }

    /// A rejected write takes its optimistic overlay down with it.
    private func submitRollsBackARejectedWrite() throws {
        var seen: [Any] = []
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, _, _ in (200, Data("{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"gone\"}}".utf8)) }
        )

        client.attachSocket { _ in }
        client.subscribe("messages:list", args: [String: Any](), onData: { seen.append($0) })
        _ = try client.handleFrame("{\"cursor\":1,\"data\":[\"a\"],\"id\":\"sub_1\",\"type\":\"data\"}")

        XCTAssertThrowsError(
            try client.submit(
                LunoraSubmitOptions(functionPath: "messages:list", args: [String: Any](), optimistic: appender("c"))
            ),
            "the server's verdict reaches the caller"
        )
        XCTAssertEqual(canonical(seen.last), canonical(["a"]), "and the overlay is gone")
    }

    /// A restored write evicted on overflow reports to the CLIENT's observers.
    ///
    /// Driven through ``LunoraClient/hydrateOfflineQueue()`` rather than the
    /// queue's own `hydrate`, which is the test that misses the bug: a hydrated
    /// entry has no settle handler of its own, so a client that reported a discard
    /// through the entry alone would un-persist a durable write and tell nobody.
    func caseOfflineQueueHydrateOverflowSettlesDiscarded() throws {
        let testCase = try scenario("offlineQueue", "hydrateOverflow")
        let store = MemoryPersistence(records: persistedRecords(testCase))
        var settled: [LunoraMutationSettled] = []
        let client = LunoraClient(url: "https://app.example")

        client.offlineQueue = LunoraOfflineQueue(
            maxItems: count(testCase["maxItems"]),
            persistence: store,
            version: testCase["version"] as? String
        )
        client.onMutationSettled { settled.append($0) }

        let shardKeys = try client.hydrateOfflineQueue()

        XCTAssertEqual(shardKeys.map { $0 ?? "" }, ids(testCase["shardKeys"]).map { $0 ?? "" })
        XCTAssertEqual(
            settled.map { $0.mutationID },
            ids(testCase["settledFromClient"]).compactMap { $0 },
            "the evicted durable write settles through the client-level observer"
        )
        XCTAssertEqual(settled.first?.status, .rejected, "as a rejection")
        XCTAssertEqual(
            (settled.first?.error as? LunoraAPIError)?.code,
            testCase["settledCode"] as? String,
            "carrying the documented code"
        )
        // Read from the entry's own `liveAwaiter`, never restated at the settle
        // site: it is what tells a restored write's only report from a live
        // caller's second one.
        XCTAssertEqual(
            settled.first?.hadAwaiter,
            testCase["settledHadAwaiter"] as? Bool,
            "and stamped as having no awaiter, because the caller did not survive the restart"
        )
    }

    /// A queued write whose args cannot be wire-encoded settles TERMINALLY.
    ///
    /// A codec error carries no code, so the transient rule would re-queue it on
    /// every reconnect forever — never settling its caller, never rolling its
    /// overlay back, and blocking every write behind it in the FIFO.
    func caseOfflineFlushUnencodableWriteSettlesTerminal() throws {
        let testCase = try scenario("offlineQueue", "unencodableWrite")
        var seenHeaders: [String?] = []
        var settled: [LunoraMutationSettled] = []
        let store = MemoryPersistence()
        let client = LunoraClient(
            url: "https://app.example",
            post: { _, headers, _ in
                seenHeaders.append(headers["x-lunora-mutation-id"])

                return (200, Data("{\"commitCursor\":4,\"result\":{\"ok\":true}}".utf8))
            }
        )

        client.offlineQueue = LunoraOfflineQueue(persistence: store)
        client.onMutationSettled { settled.append($0) }

        let unencodable = Set(ids(testCase["unencodable"]).compactMap { $0 })

        for id in ids(testCase["queued"]).compactMap({ $0 }) {
            let args: [String: Any] = unencodable.contains(id) ? ["blob": UnencodableArgument()] : [:]

            client.offlineQueue.enqueue(entry(id, args: args))
        }

        let report = client.flushOfflineQueue()

        XCTAssertEqual(seenHeaders, ids(testCase["mutationIdHeaders"]), "only the encodable write reaches the wire")
        XCTAssertEqual(report.rejected, ids(testCase["rejected"]).compactMap { $0 }, "the other one is dropped")
        XCTAssertEqual(report.committed, ids(testCase["committed"]).compactMap { $0 })
        XCTAssertTrue(report.requeued.isEmpty, "and nothing is re-queued to poison the next flush")
        XCTAssertEqual(queuedIDs(client.offlineQueue), ids(testCase["queuedAfterFlush"]))
        XCTAssertEqual(store.removed, ids(testCase["persistRemoveCalls"]).compactMap { $0 }, "both are un-persisted")
        XCTAssertEqual(
            (settled.first(where: { $0.status == .rejected })?.error as? LunoraAPIError)?.code,
            testCase["code"] as? String,
            "with the documented code"
        )
    }

    /// A consumer closure that reads the client back must not deadlock it.
    ///
    /// `optimisticUpdate` is handed a store over this very client and
    /// `precondition` is evaluated mid-flush; run either inside the non-recursive
    /// lock the queue is mutated under and the calling thread wedges forever.
    ///
    /// The work runs off-thread against a timeout, and NOTHING after the wait
    /// touches the client — a regression must fail this test rather than hang the
    /// suite behind a lock the wedged thread still holds.
    func testConsumerCallbacksDoNotDeadlock() {
        let client = LunoraClient(url: "https://app.example", post: { _, _, _ in (200, Data("{\"result\":null}".utf8)) })
        let finished = expectation(description: "a re-entrant consumer callback returns")
        let drained = DrainedFlag()

        client.offlineQueue = LunoraOfflineQueue(queueBeforeFirstConnect: true)
        client.subscribe("messages:list", args: [String: Any](), onData: { _ in })

        DispatchQueue.global().async {
            _ = try? client.submit(
                LunoraSubmitOptions(
                    functionPath: "messages:list",
                    args: [String: Any](),
                    optimisticUpdate: { store, _ in
                        // Both of these take the client's lock.
                        _ = client.pendingMutationCount
                        _ = client.identity
                        store.setQuery("messages:list", args: [String: Any](), value: ["queued"])
                    },
                    precondition: { client.online }
                )
            )
            client.flushOfflineQueue()
            // The precondition read `online` — false with no socket attached — so
            // the flush dropped the write instead of replaying it.
            drained.value = client.pendingMutationCount == 0
            finished.fulfill()
        }

        XCTAssertEqual(
            XCTWaiter.wait(for: [finished], timeout: 10),
            .completed,
            "a consumer callback that reads the client back must not deadlock it"
        )
        XCTAssertTrue(drained.value, "and the flush ran to completion")
    }
}

/// A value outside the wire codec — neither a JSON primitive, a collection, nor
/// one of the `Wire*` wrappers — so encoding it throws.
private struct UnencodableArgument {}

/// Carries one verdict off the worker thread; a plain captured `var` would not
/// compile under strict concurrency.
private final class DrainedFlag {
    var value = false
}

/// A persistence adapter that records every call.
///
/// It JSON round-trips every record, which an adapter holding the dictionaries by
/// reference does not — and that is the whole point: a file, a SQLite text column
/// or a preferences store all serialise, so a record carrying the codec's native
/// wrappers either throws here or is written as something that does not read
/// back. Holding references made this suite blind to both.
final class MemoryPersistence: LunoraPersistenceAdapter {
    var records: [[String: Any]]
    var appended: [[String: Any]] = []
    var removed: [String] = []
    var cleared = 0

    init(records: [[String: Any]] = []) {
        self.records = records
    }

    func append(_ record: [String: Any]) throws {
        let serialised = try MemoryPersistence.roundTrip(record)

        appended.append(serialised)
        records.append(serialised)
    }

    func load() throws -> [[String: Any]] { try records.map(MemoryPersistence.roundTrip) }

    private static func roundTrip(_ record: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: record)

        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    func remove(_ mutationID: String) throws {
        removed.append(mutationID)
        records.removeAll { $0["id"] as? String == mutationID }
    }

    func clear() throws {
        cleared += 1
        records = []
    }
}
