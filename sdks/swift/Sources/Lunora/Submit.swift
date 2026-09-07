import Foundation

/// What ``LunoraClient/submit(_:)`` did with a write.
public enum LunoraMutationStatus: String, Sendable {
    /// The write went out and the server answered.
    case committed
    /// The socket was down and the write was enqueued for replay.
    case queued
    /// A settled verdict, never a `submit` outcome.
    case rejected
}

/// What ``LunoraClient/submit(_:)`` did with a write.
///
/// This is the deliberate divergence from `@lunora/client`, whose `mutation()`
/// returns a promise that stays PENDING until a queued write finally replays. A
/// pending promise is a fine thing to hold in a browser event loop and a bad thing
/// to hold on a blocked thread, so the ports return the outcome immediately and
/// report the eventual verdict through `onSettled` (per write) or
/// ``LunoraClient/onMutationSettled(_:)`` (per client). A caller that must not
/// report success early checks ``status``.
public struct LunoraMutationOutcome {
    public let status: LunoraMutationStatus
    public let mutationID: String
    public let value: Any?
    public let commitCursor: Int?

    public init(status: LunoraMutationStatus, mutationID: String, value: Any? = nil, commitCursor: Int? = nil) {
        self.status = status
        self.mutationID = mutationID
        self.value = value
        self.commitCursor = commitCursor
    }
}

/// The terminal verdict on a queued write, once it replays.
public struct LunoraMutationSettled {
    public let mutationID: String
    public let status: LunoraMutationStatus
    public let value: Any?
    public let error: Error?
    /// False for a write restored from durable storage: the caller that submitted
    /// it is gone, so this event is the ONLY report it produces.
    public let hadAwaiter: Bool

    public init(mutationID: String, status: LunoraMutationStatus, value: Any?, error: Error?, hadAwaiter: Bool) {
        self.mutationID = mutationID
        self.status = status
        self.value = value
        self.error = error
        self.hadAwaiter = hadAwaiter
    }
}

/// What one ``LunoraClient/flushOfflineQueue(shardKey:)`` pass achieved.
public struct LunoraFlushReport {
    /// The ids the server accepted.
    public var committed: [String] = []
    /// The ids dropped on a verdict, an identity change, or a stale precondition.
    public var rejected: [String] = []
    /// The ids left queued for the next reconnect.
    public var requeued: [String] = []
    /// The ids dropped because their precondition no longer held.
    public var conflicted: [String] = []

    /// Milliseconds the server asked the caller to wait before flushing again,
    /// when a replay came back rate-limited. Nil otherwise. The client enforces
    /// it too — a flush inside the window is a no-op — so this is for a caller
    /// that schedules its own retry.
    public var retryAfterMs: Int?

    public init() {}
}

/// One offline-capable write.
public struct LunoraSubmitOptions {
    public let functionPath: String
    public let args: Any?
    /// Nil routes to the default shard.
    public var shardKey: String?
    /// The idempotency key; minted when nil.
    public var mutationID: String?

    /// The single-query shortcut: the transform is layered onto every subscription
    /// registered under the SAME (functionPath, args, shardKey) as this write,
    /// mirroring `@lunora/client`'s per-call `optimistic`.
    public var optimistic: LunoraOptimistic.Transform?

    /// The general form — it receives a ``LunoraOptimisticLocalStore`` and may
    /// patch any number of subscribed queries. Both settle together, against the
    /// same commit cursor.
    public var optimisticUpdate: ((LunoraOptimisticLocalStore, Any?) -> Void)?

    /// Re-evaluated just before a QUEUED write replays; false drops it rather than
    /// replaying a write that can only fail.
    public var precondition: (() -> Bool)?

    /// Reports the eventual verdict on a queued write.
    public var onSettled: ((LunoraMutationSettled) -> Void)?

    public init(
        functionPath: String,
        args: Any? = nil,
        shardKey: String? = nil,
        mutationID: String? = nil,
        optimistic: LunoraOptimistic.Transform? = nil,
        optimisticUpdate: ((LunoraOptimisticLocalStore, Any?) -> Void)? = nil,
        precondition: (() -> Bool)? = nil,
        onSettled: ((LunoraMutationSettled) -> Void)? = nil
    ) {
        self.functionPath = functionPath
        self.args = args
        self.shardKey = shardKey
        self.mutationID = mutationID
        self.optimistic = optimistic
        self.optimisticUpdate = optimisticUpdate
        self.precondition = precondition
        self.onSettled = onSettled
    }
}

// MARK: - The write path

/// ``LunoraClient``'s offline-capable writes, beside the value types they use.
///
/// Split from `Client.swift` for the reason Go's `submit.go` and Rust's
/// `submit.rs` are: the read path (subscriptions, frames, shapes) and the write
/// path share only the client's lock, and the two together outgrew one file.
///
/// **Locking.** Every queue mutation happens inside the client's critical
/// section — `drain` partitions the item list and then REASSIGNS it, so an entry
/// appended in that window is silently discarded after `submit` already answered
/// `queued`. Everything consumer-visible stays outside it: `precondition`,
/// `optimisticUpdate`, settling a discard, and the replay's round trip. `NSLock`
/// is not recursive, so a callback that touches the client it was handed
/// deadlocks the thread that invoked it.
extension LunoraClient {
    /// Writes, sending it now or queueing it until the socket is back.
    ///
    /// It returns as soon as the write is either committed or durably queued. A
    /// queued write's optimistic overlay stays displayed until the replay's commit
    /// cursor is reached by a server frame; a failed one rolls back.
    @discardableResult
    public func submit(_ options: LunoraSubmitOptions) throws -> LunoraMutationOutcome {
        let writeID = options.mutationID ?? lunoraRandomID()

        // Checked before any overlay is applied, so the common "already closed"
        // case leaves nothing displayed. The enqueue below re-checks it.
        if withLock({ closed }) {
            throw LunoraAPIError(code: LunoraOfflineCode.clientClosed, message: "client is closed")
        }

        var deferred: LunoraOptimistic.Deferred = []
        let handles = applyOptimistic(options, &deferred)

        LunoraClient.runDeferred(deferred)

        let queued: (offline: Bool, discarded: [LunoraDiscarded])

        do {
            // The offline decision and the enqueue are ONE critical section. Split,
            // a socket can attach and a flush run to completion in the window
            // between them, and the write lands in a queue nothing drains until the
            // next disconnect — after `submit` has already answered `queued`.
            queued = try withLock { () -> (Bool, [LunoraDiscarded]) in
                if closed {
                    throw LunoraAPIError(code: LunoraOfflineCode.clientClosed, message: "client is closed")
                }

                guard send == nil, wasEverConnected || storedOfflineQueue.queueBeforeFirstConnect else {
                    return (false, [])
                }

                return (true, storedOfflineQueue.enqueue(queuedEntryLocked(options, writeID: writeID, handles: handles)))
            }
        } catch {
            settleLayers(confirm: [], rollback: handles, commitCursor: nil)

            throw error
        }

        if queued.offline {
            // Settled out here: rolling an eviction back notifies the consumer.
            reportDiscarded(queued.discarded)

            return LunoraMutationOutcome(status: .queued, mutationID: writeID)
        }

        do {
            let reply = try rpcFull(
                options.functionPath,
                args: options.args,
                shardKey: options.shardKey,
                mutationID: writeID
            )

            // Confirmed against the write's COMMITTED cursor, so the overlay drops
            // when (or once) a frame at that cursor lands — never on this call's
            // return, which races the socket broadcast.
            settleLayers(confirm: handles, rollback: [], commitCursor: reply.commitCursor)

            return LunoraMutationOutcome(
                status: .committed,
                mutationID: writeID,
                value: reply.result,
                commitCursor: reply.commitCursor
            )
        } catch {
            settleLayers(confirm: [], rollback: handles, commitCursor: nil)

            throw error
        }
    }

    /// Restores writes persisted in a prior session; returns their shard keys.
    ///
    /// Open a socket for each returned key and flush it to replay them. A restored
    /// write has no live caller, so its verdict arrives only through
    /// ``onMutationSettled(_:)`` — including the verdict on one the capacity cap
    /// evicted during the restore, which is why the eviction is reported here
    /// rather than through the entry's own handler (it has none).
    public func hydrateOfflineQueue() throws -> [String?] {
        let queue = offlineQueue
        let (shardKeys, evicted) = try withLock { try queue.hydrate() }

        reportDiscarded(evicted)

        return shardKeys
    }

    /// Replays one shard's queued writes, in order, over HTTP. Call it when that
    /// shard's socket comes back.
    ///
    /// Each write replays under its own idempotency key, so one the server already
    /// committed is de-duplicated rather than applied twice. Per write: success
    /// confirms its optimistic overlay against the ECHOED commit cursor; a coded
    /// verdict is terminal; a transient failure — a raw transport error, or one of
    /// ``LunoraOfflineCode.transient`` — stops the flush and re-queues that write and
    /// every unreplayed one, in order, for the next attempt.
    @discardableResult
    public func flushOfflineQueue(shardKey: String? = nil) -> LunoraFlushReport {
        var report = LunoraFlushReport()
        let (queue, current, remaining) = withLock {
            (storedOfflineQueue, storedIdentity, storedFlushNotBefore - ProcessInfo.processInfo.systemUptime)
        }

        // A server that answered "not now" gets waited out. Without this the
        // caller's own reconnect loop replays the identical burst immediately and
        // earns the same 429, indefinitely.
        if remaining > 0 {
            report.retryAfterMs = Int(remaining * 1000) + 1

            return report
        }

        // The consumer's `precondition` is evaluated with the lock RELEASED — one
        // that touches this client would deadlock the flush — and only its verdict
        // is carried back into the locked drain.
        let stale = Set(
            withLock { queue.items() }
                .filter { entry in entry.precondition.map { !$0() } ?? false }
                .map(\.id)
        )
        let conflicted = withLock { queue.drain { stale.contains($0.id) } }
            .map {
                LunoraDiscarded(
                    entry: $0,
                    code: LunoraOfflineCode.preconditionFailed,
                    message: "offline mutation skipped: precondition failed before replay"
                )
            }

        for discarded in conflicted {
            withLock { queue.unpersist(discarded.entry.id) }
            report.conflicted.append(discarded.entry.id)
            report.rejected.append(discarded.entry.id)
        }

        reportDiscarded(conflicted)

        // An absent shard key and an empty one are the SAME shard: without the
        // normalisation a write submitted under `""` waits for a flush of a shard
        // nothing ever names.
        let drained = withLock { queue.drain { lunoraSameShard($0.shardKey, shardKey) } }

        if drained.isEmpty { return report }

        // Gated against ONE identity snapshot: a flush is a single authenticated
        // burst, so every write in it necessarily runs under one identity.
        var sendable: [LunoraQueuedMutation] = []

        for entry in drained {
            if entry.identity.allowsReplay(under: current) {
                sendable.append(entry)

                continue
            }

            withLock { queue.unpersist(entry.id) }
            report.rejected.append(entry.id)
            reportDiscarded([
                LunoraDiscarded(
                    entry: entry,
                    code: LunoraOfflineCode.identityChanged,
                    message: "offline mutation skipped: auth identity changed before replay"
                )
            ])
        }

        let encodable = encodableOrSettleTerminal(queue, sendable, &report)

        replay(queue, encodable, &report)

        return report
    }

    /// Partitions gated writes into the ones that can reach the wire and the ones
    /// that never will, settling the latter TERMINALLY.
    ///
    /// A codec failure is deterministic, not a blip, and it carries no code — so
    /// left to the replay loop it is classified transient and re-queued on every
    /// reconnect forever: the caller never settles, the overlay never rolls back,
    /// and because a requeue goes to the FRONT it blocks every write behind it.
    private func encodableOrSettleTerminal(
        _ queue: LunoraOfflineQueue,
        _ entries: [LunoraQueuedMutation],
        _ report: inout LunoraFlushReport
    ) -> [LunoraQueuedMutation] {
        var encodable: [LunoraQueuedMutation] = []

        for entry in entries {
            do {
                _ = try Wire.encode(entry.args ?? [String: Any]())
                encodable.append(entry)
            } catch {
                withLock { queue.unpersist(entry.id) }
                settleLayers(confirm: [], rollback: entry.handles, commitCursor: nil)
                report.rejected.append(entry.id)
                emitSettled(
                    LunoraMutationSettled(
                        mutationID: entry.id,
                        status: .rejected,
                        value: nil,
                        error: LunoraAPIError(
                            code: LunoraOfflineCode.writeUnencodable,
                            message: "offline mutation dropped: \(error)"
                        ),
                        hadAwaiter: entry.liveAwaiter
                    ),
                    entry.onSettled
                )
            }
        }

        return encodable
    }

    private func replay(_ queue: LunoraOfflineQueue, _ sendable: [LunoraQueuedMutation], _ report: inout LunoraFlushReport) {
        // A lone write rides the single-call path, which is the proven one. Two
        // or more coalesce into batch round trips — the flaky-reconnect win,
        // where N queued writes cost a handful of hops instead of N.
        guard sendable.count > 1 else {
            replaySequential(queue, sendable, &report)

            return
        }

        var toRequeue: [LunoraQueuedMutation] = []
        let chunks = LunoraClient.chunkBatches(sendable)

        for (index, chunk) in chunks.enumerated() {
            // Chunks replay sequentially, which is what preserves FIFO across a
            // flush longer than one batch.
            let outcome = replayBatched(queue, chunk, &report)

            toRequeue.append(contentsOf: outcome.requeue)

            if outcome.stop {
                // A whole-chunk transport failure. Leave every write not yet sent
                // queued, in order, rather than sending on into a connection that
                // just failed.
                for later in chunks[(index + 1)...] {
                    toRequeue.append(contentsOf: later)
                }

                break
            }
        }

        guard !toRequeue.isEmpty else { return }

        withLock { queue.requeue(toRequeue) }
        report.requeued.append(contentsOf: toRequeue.map(\.id))
    }

    /// Replays writes one at a time. FIFO is preserved by the loop itself.
    private func replaySequential(_ queue: LunoraOfflineQueue, _ sendable: [LunoraQueuedMutation], _ report: inout LunoraFlushReport) {
        for (index, entry) in sendable.enumerated() {
            do {
                let reply = try rpcFull(
                    entry.functionPath,
                    args: entry.args,
                    shardKey: entry.shardKey,
                    mutationID: entry.id,
                    issuingClientID: entry.clientID
                )

                withLock { queue.unpersist(entry.id) }
                // The overlay is confirmed BEFORE the caller is told, so the
                // gapless drop is already in place when the confirming frame lands.
                settleLayers(confirm: entry.handles, rollback: [], commitCursor: reply.commitCursor)
                report.committed.append(entry.id)
                emitSettled(
                    LunoraMutationSettled(
                        mutationID: entry.id,
                        status: .committed,
                        value: reply.result,
                        error: nil,
                        hadAwaiter: entry.liveAwaiter
                    ),
                    entry.onSettled
                )
            } catch {
                if LunoraClient.isTransient(error) {
                    noteRetryAfter(&report, error)
                    // Nothing after this write may go out ahead of it: replaying
                    // out of order is how a durable queue corrupts the data it was
                    // protecting.
                    let pending = Array(sendable[index...])

                    withLock { queue.requeue(pending) }
                    report.requeued.append(contentsOf: pending.map(\.id))

                    return
                }

                withLock { queue.unpersist(entry.id) }
                settleLayers(confirm: [], rollback: entry.handles, commitCursor: nil)
                report.rejected.append(entry.id)
                emitSettled(
                    LunoraMutationSettled(
                        mutationID: entry.id,
                        status: .rejected,
                        value: nil,
                        error: error,
                        hadAwaiter: entry.liveAwaiter
                    ),
                    entry.onSettled
                )
            }
        }
    }

    /// Replays one chunk over `POST /_lunora/rpc-batch`.
    ///
    /// The worker forwards the entries to their shard, which dispatches each
    /// through its ordinary single-call path — so per-entry `mutationId`
    /// idempotency and in-order application are inherited from the proven route
    /// rather than re-implemented here.
    ///
    /// Returns the writes to put back and whether the caller should STOP because
    /// the whole chunk failed at the transport level. Re-queuing is the caller's,
    /// once and in order, so a write cannot land twice in the queue.
    private func replayBatched(
        _ queue: LunoraOfflineQueue,
        _ items: [LunoraQueuedMutation],
        _ report: inout LunoraFlushReport
    ) -> (requeue: [LunoraQueuedMutation], stop: Bool) {
        var calls: [Any] = []

        for (index, entry) in items.enumerated() {
            guard let encoded = try? Wire.encode(entry.args ?? [:]) else {
                // Unreachable: the caller already partitioned the unencodable
                // writes out. Re-queue rather than drop, so a future codec change
                // cannot silently lose a durable write here.
                return (items, true)
            }

            var call: [String: Any] = [
                "args": encoded,
                "functionPath": entry.functionPath,
                // The slot this entry's result comes back in.
                "id": index,
                // The same stable key the single-call replay sends, beside the id
                // that namespaces its de-duplication row for an anonymous caller.
                // Per ENTRY, not on the outer request: a batch is one hop, but its
                // entries are dispatched as independent single calls.
                "mutationId": entry.id,
                "clientId": entry.clientID ?? clientID,
            ]

            if let shardKey = entry.shardKey, !shardKey.isEmpty { call["shardKey"] = shardKey }

            calls.append(call)
        }

        guard let reply = try? rpcBatch(calls) else {
            // Transport failure — nothing committed, so retry everything.
            return (items, true)
        }

        if let results = reply.body["results"] as? [Any] {
            return (settleBatchSlots(queue, items, results, &report), false)
        }

        // No per-slot results. A coded envelope is a verdict on the WHOLE batch —
        // a bad request, an authorization denial — and therefore terminal for
        // every entry; anything else is transport, and transient.
        guard let envelope = reply.body["error"] as? [String: Any] else { return (items, true) }

        let error = LunoraClient.batchSlotError(envelope, fallback: "batch rejected", transient: reply.status >= 500)

        // The body was too big, not wrong — every entry in it would have committed
        // alone. Halve and retry; the estimate the chunker used cannot see the
        // framing the worker actually measured, and only the answer can.
        if error.code == LunoraOfflineCode.payloadTooLarge, items.count > 1 {
            let middle = items.count / 2
            let left = replayBatched(queue, Array(items[..<middle]), &report)

            if left.stop { return (left.requeue + Array(items[middle...]), true) }

            let right = replayBatched(queue, Array(items[middle...]), &report)

            return (left.requeue + right.requeue, right.stop)
        }

        // A shard blip or a rate limit is not a verdict on the batch's contents.
        // Requeue it whole and stop the flush, exactly as the single-call path
        // does for the same codes.
        if LunoraClient.isTransient(error) {
            noteRetryAfter(&report, error)

            return (items, true)
        }

        for entry in items {
            settleBatchRejection(queue, entry, error, &report)
        }

        return ([], false)
    }

    /// A batch entry's contribution to the request body, in bytes.
    ///
    /// The args dominate and are the only part that can be large; the constant
    /// covers the entry's fixed keys and the comma joining it to the next one.
    /// Encoding twice (here and in ``replayBatched(_:_:_:)``) is deliberate — the
    /// flush is the slow path, and carrying the encoded form through the chunker
    /// would put a second representation of every queued write in memory.
    private static func entryBytes(_ item: LunoraQueuedMutation) -> Int {
        let encoded = Wire.stableStringify((try? Wire.encode(item.args ?? [String: Any]())) ?? NSNull())

        return encoded.utf8.count + item.functionPath.utf8.count + item.id.utf8.count + 160
    }

    /// Splits a flush into batch bodies the worker will accept.
    ///
    /// By BYTES as well as by count: the worker reads a batch body under a 1 MiB
    /// budget and answers `413 PAYLOAD_TOO_LARGE` past it, so 500 writes carrying
    /// bytes or long text are one request the server refuses whole. A single write
    /// over the budget still forms its own chunk — splitting cannot help it, and
    /// ``replayBatched(_:_:_:)`` settles it on the answer.
    private static func chunkBatches(_ items: [LunoraQueuedMutation]) -> [[LunoraQueuedMutation]] {
        var chunks: [[LunoraQueuedMutation]] = []
        var current: [LunoraQueuedMutation] = []
        var size = 0

        for item in items {
            let cost = entryBytes(item)

            if !current.isEmpty && (current.count >= lunoraMaxBatchEntries || size + cost > lunoraMaxBatchBytes) {
                chunks.append(current)
                current = []
                size = 0
            }

            current.append(item)
            size += cost
        }

        if !current.isEmpty { chunks.append(current) }

        return chunks
    }

    /// Records a rate limit's delay, and holds the next flush off until it passes.
    private func noteRetryAfter(_ report: inout LunoraFlushReport, _ error: Error) {
        guard let delay = LunoraClient.retryAfterMs(error) else { return }

        report.retryAfterMs = delay

        withLock {
            storedFlushNotBefore = max(storedFlushNotBefore, ProcessInfo.processInfo.systemUptime + Double(delay) / 1000)
        }
    }

    /// Demuxes a batch reply back onto the writes it replayed, in input order,
    /// classifying each slot exactly as ``replaySequential(_:_:_:)`` classifies a
    /// whole response. Returns the writes the caller must re-queue.
    private func settleBatchSlots(
        _ queue: LunoraOfflineQueue,
        _ items: [LunoraQueuedMutation],
        _ results: [Any],
        _ report: inout LunoraFlushReport
    ) -> [LunoraQueuedMutation] {
        var bySlot: [Int: [String: Any]] = [:]

        for raw in results {
            guard let entry = raw as? [String: Any],
                let id = LunoraClient.parseSlotID(entry["id"]),
                let slot = entry["body"] as? [String: Any]
            else { continue }

            bySlot[id] = slot
        }

        var requeue: [LunoraQueuedMutation] = []

        for (index, entry) in items.enumerated() {
            guard let slot = bySlot[index] else {
                // The server never returned this slot. It may or may not have
                // committed, so retry it — the `mutationId` makes that safe.
                requeue.append(entry)

                continue
            }

            if let envelope = slot["error"] as? [String: Any] {
                let error = LunoraClient.batchSlotError(envelope, fallback: "request failed")

                // The SAME predicate the whole-batch and single-call paths use, so
                // a durable write's fate never depends on how many siblings were
                // queued alongside it. The server reached no verdict on a slot
                // coded transient — it could not reach the shard, or a limiter
                // refused to look — so the write goes back on the queue rather
                // than being reported as failed.
                if LunoraClient.isTransient(error) {
                    noteRetryAfter(&report, error)
                    requeue.append(entry)

                    continue
                }

                settleBatchRejection(queue, entry, error, &report)

                continue
            }

            withLock { queue.unpersist(entry.id) }
            // The overlay is confirmed BEFORE the caller is told, so the gapless
            // drop is already in place when the confirming frame lands.
            settleLayers(confirm: entry.handles, rollback: [], commitCursor: LunoraClient.parseSlotID(slot["commitCursor"]))
            report.committed.append(entry.id)
            emitSettled(
                LunoraMutationSettled(
                    mutationID: entry.id,
                    status: .committed,
                    value: (try? Wire.decode(slot["result"] ?? NSNull())) ?? NSNull(),
                    error: nil,
                    hadAwaiter: entry.liveAwaiter
                ),
                entry.onSettled
            )
        }

        return requeue
    }

    /// Un-persists a batch-rejected write, rolls its overlay back and settles it.
    private func settleBatchRejection(
        _ queue: LunoraOfflineQueue,
        _ entry: LunoraQueuedMutation,
        _ error: Error,
        _ report: inout LunoraFlushReport
    ) {
        withLock { queue.unpersist(entry.id) }
        settleLayers(confirm: [], rollback: entry.handles, commitCursor: nil)
        report.rejected.append(entry.id)
        emitSettled(
            LunoraMutationSettled(
                mutationID: entry.id,
                status: .rejected,
                value: nil,
                error: error,
                hadAwaiter: entry.liveAwaiter
            ),
            entry.onSettled
        )
    }

    /// Whether a failed replay may be retried rather than dropped.
    ///
    /// A raw error from the injected poster is the network, not the server: no
    /// verdict was reached, so the write is still good.
    public static func isTransient(_ error: Error) -> Bool {
        guard let api = error as? LunoraAPIError else { return true }

        return api.transient
            || LunoraOfflineCode.transient.contains(api.code)
            || LunoraOfflineCode.rateLimited.contains(api.code)
    }

    /// How long a rate-limited replay asks to wait, if the envelope said.
    ///
    /// Nil when the server named no delay — the caller then decides its own
    /// backoff rather than hammering, which is what
    /// ``LunoraFlushReport/retryAfterMs`` reports.
    ///
    /// The `Retry-After` HEADER is deliberately not read: ``LunoraHTTPPoster``
    /// surfaces `(status, body)` only, and the RPC plane's rate-limit envelope
    /// carries `retryAfterMs`.
    public static func retryAfterMs(_ error: Error) -> Int? {
        guard let api = error as? LunoraAPIError, LunoraOfflineCode.rateLimited.contains(api.code) else { return nil }
        guard let data = api.data as? [String: Any], let delay = intValue(data["retryAfterMs"]), delay > 0 else { return nil }

        return min(delay, lunoraMaxRetryAfterMs)
    }

    /// Registers both optimistic paths' layers.
    ///
    /// Nothing the consumer supplies runs while the lock is held: the single-query
    /// transform is run against a snapshot of each target's displayed value and its
    /// result RECORDED, `optimisticUpdate` is handed a store over a snapshotted
    /// registry, and the lock is then taken only to install what came back — where
    /// every transform left to run is a constant.
    ///
    /// The frame path is the documented exception: a fold re-runs the transform
    /// under the lock, because the fold IS the value that frame delivers and it
    /// must see a base nothing else is mutating. That is why an optimistic
    /// transform must be a pure function of the value it is handed.
    private func applyOptimistic(
        _ options: LunoraSubmitOptions,
        _ deferred: inout LunoraOptimistic.Deferred
    ) -> [LunoraOptimisticHandle] {
        let registry = withLock { Array(subscriptions.values) }
        var handles: [LunoraOptimisticHandle] = []

        if let transform = options.optimistic {
            let predicted = LunoraClient.matching(registry, options.functionPath, options.args, options.shardKey)
                .compactMap { entry in transform(entry.state.lastValue).map { (entry.state, $0) } }

            withLock {
                for (state, value) in predicted {
                    handles.append(LunoraOptimistic.installLayer(state, transform, value, &deferred))
                }
            }
        }

        guard let update = options.optimisticUpdate else { return handles }

        let store = LunoraOptimisticLocalStore(
            find: { path, args in
                LunoraClient.matching(registry, path, args, options.shardKey).map(\.state)
            },
            matching: { path in
                registry
                    .filter { $0.functionPath == path && lunoraSameShard($0.shardKey, options.shardKey) }
                    .map { LunoraQueryEntry(args: $0.args, value: $0.state.lastValue) }
            }
        )

        update(store, options.args)
        withLock { store.install() }

        deferred.append(contentsOf: store.deferred)
        handles.append(contentsOf: store.handles)

        return handles
    }

    /// The subscriptions registered under exactly this (path, args, shard).
    ///
    /// A linear scan, unlike `@lunora/client`'s keyed registry, and deliberately:
    /// this client does not de-duplicate subscriptions, so several can share one
    /// triple and all of them must receive the overlay. The scan is over a handful
    /// of entries on the write path, never the frame path. An absent shard key and
    /// an empty one match, exactly as the queue's drain treats them.
    private static func matching(
        _ registry: [Subscription],
        _ functionPath: String,
        _ args: Any?,
        _ shardKey: String?
    ) -> [Subscription] {
        let argsKey = (try? Wire.stableWireKey(args ?? [String: Any]())) ?? ""

        return registry.filter {
            $0.functionPath == functionPath
                && $0.argsKey == argsKey
                && lunoraSameShard($0.shardKey, shardKey)
        }
    }

    /// The durable record of one write. Runs with the lock held: the identity and
    /// client-id stamps it binds are the ones in effect at the moment the write
    /// joins the queue, so it can only ever replay as whoever made it.
    private func queuedEntryLocked(
        _ options: LunoraSubmitOptions,
        writeID: String,
        handles: [LunoraOptimisticHandle]
    ) -> LunoraQueuedMutation {
        let entry = LunoraQueuedMutation(
            id: writeID,
            functionPath: options.functionPath,
            args: options.args,
            shardKey: options.shardKey
        )

        entry.clientID = storedClientID
        entry.identity = LunoraIdentity.stamp(storedIdentity)
        entry.liveAwaiter = true
        entry.precondition = options.precondition
        entry.handles = handles
        entry.onSettled = options.onSettled

        return entry
    }

    /// Rolls back and reports every write the queue discarded without sending it.
    ///
    /// Every discard path funnels through here, so an eviction can never drop a
    /// durable write in silence — which matters most for a hydrated record, whose
    /// original caller did not survive the restart.
    func reportDiscarded(_ discarded: [LunoraDiscarded]) {
        for item in discarded {
            settleLayers(confirm: [], rollback: item.entry.handles, commitCursor: nil)
            emitSettled(
                LunoraMutationSettled(
                    mutationID: item.entry.id,
                    status: .rejected,
                    value: nil,
                    error: LunoraAPIError(code: item.code, message: item.message),
                    hadAwaiter: item.entry.liveAwaiter
                ),
                item.entry.onSettled
            )
        }
    }

    /// Runs a write's confirms or rollbacks under the lock and delivers the
    /// resulting notifications outside it.
    private func settleLayers(
        confirm: [LunoraOptimisticHandle],
        rollback: [LunoraOptimisticHandle],
        commitCursor: Int?
    ) {
        let deferred = withLock { () -> LunoraOptimistic.Deferred in
            var queued: LunoraOptimistic.Deferred = []

            LunoraOptimistic.confirmAll(confirm, commitCursor, &queued)
            LunoraOptimistic.rollbackAll(rollback, &queued)

            return queued
        }

        LunoraClient.runDeferred(deferred)
    }

    /// Reports one write's terminal verdict.
    ///
    /// The client-level observers hear it unconditionally, and the entry's own
    /// handler — when it has one — IN ADDITION. A write restored from durable
    /// storage has no handler at all, so routing a discard through the entry alone
    /// would report it to nobody.
    private func emitSettled(_ event: LunoraMutationSettled, _ onSettled: ((LunoraMutationSettled) -> Void)?) {
        var listeners = withLock { settledListeners }

        if let onSettled { listeners.insert(onSettled, at: 0) }

        for listener in listeners {
            listener(event)
        }
    }
}
