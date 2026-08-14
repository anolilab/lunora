import Foundation

/// The oldest write was dropped because the queue is at capacity.
public let lunoraOfflineQueueOverflow = "OFFLINE_QUEUE_OVERFLOW"
/// The write's precondition no longer held when the flush reached it.
public let lunoraOfflinePreconditionFailed = "OFFLINE_PRECONDITION_FAILED"
/// The write was queued under a different identity than the one now in effect.
public let lunoraOfflineIdentityChanged = "OFFLINE_IDENTITY_CHANGED"
/// The client was closed while the write was still queued.
public let lunoraClientClosed = "CLIENT_CLOSED"

/// The coded errors a replay must NOT treat as the server's final word.
///
/// The shard was momentarily unreachable, so the identical call under the same
/// idempotency key is expected to succeed later, and dropping the write would
/// lose it to a transient condition. Every other coded error IS a verdict:
/// replaying it would only re-trigger the same failure, a poison-message loop.
public let lunoraTransientErrorCodes: Set<String> = ["SHARD_ERROR", "SHARD_UNAVAILABLE"]

/// Bounds the queue when no capacity is configured.
public let lunoraDefaultMaxQueuedMutations = 1000

/// Who made a queued write.
///
/// Three cases, not two, and the third is load-bearing. `absent` is a record that
/// carries no stamp at all — written before stamping existed — and replays
/// ambiently under whatever identity is current. `signedOut` is a write made with
/// nobody signed in, which must replay signed out. `subject` names who made it.
/// Collapsing the first two would either strand every old record or silently push
/// one user's queued writes as another.
public enum LunoraIdentity: Equatable {
    case absent
    case signedOut
    case subject(String)

    /// The identity a live write is stamped with; nil means signed out.
    public static func stamp(_ subject: String?) -> LunoraIdentity {
        guard let subject else { return .signedOut }

        return .subject(subject)
    }
}

/// Whether a write stamped `stamped` may replay under `current` (nil = signed out).
public func lunoraIdentityAllowsReplay(_ stamped: LunoraIdentity, _ current: String?) -> Bool {
    switch stamped {
    case .absent: return true
    case .signedOut: return current == nil
    case .subject(let subject): return subject == current
    }
}

/// Durable storage for queued writes. Injected, and synchronous.
///
/// `append` and `remove` are best-effort from the queue's point of view: a thrown
/// error is reported through the persistence-error observer and the write carries
/// on, because losing durability is strictly better than losing the write itself.
/// `load` is the one call whose failure propagates — hydrating from a store that
/// cannot be read must not look like an empty store.
public protocol LunoraPersistenceAdapter: AnyObject {
    func append(_ record: [String: Any]) throws
    func load() throws -> [[String: Any]]
    func remove(_ mutationID: String) throws
    func clear() throws
}

/// One write waiting for the socket to come back.
public final class LunoraQueuedMutation {
    /// The stable idempotency key the replay sends as `x-lunora-mutation-id`, so
    /// the server de-duplicates a write it already committed rather than applying
    /// it twice.
    public var id: String
    public let functionPath: String
    public let args: Any?
    /// Nil routes to the default shard.
    public let shardKey: String?

    /// The client id that ISSUED the write. Persisted and restored, so a replay
    /// namespaces server-side under the id that made it rather than whatever the
    /// current session minted.
    public var clientID: String?

    public var identity: LunoraIdentity = .absent

    /// False for a write restored from storage after a restart — its original
    /// caller is gone, so the settle observer is the only report it will produce.
    public var liveAwaiter = false

    /// Re-evaluated just before replay; false drops the write instead of replaying
    /// one that can only fail (the row it edited was deleted while offline).
    public var precondition: (() -> Bool)?

    /// The optimistic layers this write registered. The client confirms or rolls
    /// these back when the write settles.
    public var handles: [LunoraOptimisticHandle] = []

    /// Reports this write's terminal verdict. Nil for a restored write: the caller
    /// that submitted it did not survive the restart, so only the client-level
    /// observers hear about it.
    public var onSettled: ((LunoraMutationSettled) -> Void)?

    public init(id: String, functionPath: String, args: Any?, shardKey: String? = nil) {
        self.id = id
        self.functionPath = functionPath
        self.args = args
        self.shardKey = shardKey
    }

    /// The durable form. Callback fields are deliberately not persisted.
    public func record(version: String?) throws -> [String: Any] {
        var record: [String: Any] = [
            "args": try Wire.encode(args ?? [String: Any]()),
            "functionPath": functionPath,
            "id": id,
        ]

        if let clientID { record["clientId"] = clientID }

        switch identity {
        case .absent: break
        case .signedOut: record["identity"] = NSNull()
        case .subject(let subject): record["identity"] = subject
        }

        if let shardKey { record["shardKey"] = shardKey }
        if let version { record["version"] = version }

        return record
    }

    /// Rebuilds a queued write from durable storage.
    ///
    /// The restored entry carries no settle handler: the caller that submitted it
    /// did not survive the restart. A missing `identity` key restores as `.absent`
    /// (a legacy record) while a stored null restores as `.signedOut` — the
    /// distinction the identity gate turns on.
    public static func fromRecord(_ record: [String: Any]) -> LunoraQueuedMutation {
        let entry = LunoraQueuedMutation(
            id: record["id"] as? String ?? "",
            functionPath: record["functionPath"] as? String ?? "",
            args: (try? Wire.decode(record["args"])) ?? [String: Any](),
            shardKey: record["shardKey"] as? String
        )

        entry.clientID = record["clientId"] as? String

        if let raw = record["identity"] {
            entry.identity = (raw as? String).map(LunoraIdentity.subject) ?? .signedOut
        }

        return entry
    }
}

/// Why a write was discarded without reaching the server.
public struct LunoraDiscarded {
    public let entry: LunoraQueuedMutation
    public let code: String
    public let message: String
}

private let lunoraIDLock = NSLock()
private var lunoraIDCounter: UInt64 = 0

/// Mints a process-unique, collision-resistant id.
///
/// It must be globally unique rather than merely locally distinct: the server
/// scopes a replayed write's de-duplication watermark by `(identity, clientId)`,
/// and an anonymous push has no verified identity — so two anonymous clients that
/// collided would share one watermark namespace and each could suppress the
/// other's writes.
public func lunoraRandomID() -> String {
    lunoraIDLock.lock()
    lunoraIDCounter += 1
    let sequence = lunoraIDCounter
    lunoraIDLock.unlock()

    let nanos = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    var entropy = ""

    for _ in 0..<8 {
        entropy += String(format: "%02x", UInt8.random(in: 0...255))
    }

    return String(format: "%016llx%08llx", nanos, sequence & 0xFFFF_FFFF) + entropy
}

/// Whether a persisted record should be dropped and purged on hydrate.
///
/// Gating is OFF until a version is configured, so a consumer that never sets one
/// restores everything. Once set, a record stamped with anything else — including
/// one from before gating was adopted, which carries no stamp — is stale, so
/// adopting a version starts from a clean slate rather than replaying writes
/// shaped for an older schema.
public func lunoraIsStaleVersion(_ current: String?, _ stamped: String?) -> Bool {
    guard let current else { return false }

    return stamped != current
}

/// A bounded FIFO of writes waiting for the socket, optionally durable.
///
/// Writes submitted while the socket is down are enqueued and replayed, in
/// submission order, once it comes back. With a ``LunoraPersistenceAdapter`` wired
/// they are mirrored to durable storage as well, so ``hydrate()`` restores them
/// after a restart and the next flush replays them.
///
/// The queue is deliberately transport-free: it never sends anything. The client
/// owns the flush (``LunoraClient/flushOfflineQueue(shardKey:)``), which is what
/// keeps this class testable with no network and lets a consumer drive a flush
/// from its own reconnect logic.
///
/// Not internally locked, and deliberately so: every method mutates the same
/// array, and the client that owns the queue already holds an `NSLock` over its
/// subscription registry — and `NSLock` is not recursive, so a second lock over
/// one logical operation is a deadlock waiting to be written. Call these with the
/// owning client's lock held (which is what ``LunoraClient`` does) or from one
/// thread.
///
/// **Divergences from `@lunora/client`**, all recorded in `sdks/README.md`: the
/// persistence adapter is SYNCHRONOUS; the identity stamp is an opaque string the
/// CONSUMER sets (``LunoraClient/identity``) rather than a fingerprint derived
/// from an auth token, because these SDKs do not manage auth sessions and a
/// derived stamp would mean persisting a hash of a bearer token in the consumer's
/// storage; and nothing here holds a rejection callback — every method that
/// discards a write RETURNS the discarded entries and the client reports them.
public final class LunoraOfflineQueue {
    private var items: [LunoraQueuedMutation] = []
    private let maxItems: Int
    private let persistence: LunoraPersistenceAdapter?
    private let version: String?

    /// Whether writes may queue before the socket has EVER connected. Off by
    /// default: without it a misconfigured endpoint silently accumulates writes
    /// that will never flush instead of failing on the first one.
    public let queueBeforeFirstConnect: Bool

    /// Notified with the new depth after any size change.
    public var onSizeChange: ((Int) -> Void)?

    /// Notified when a durable append or remove threw: operation, error, write id.
    public var onPersistenceError: ((String, Error, String?) -> Void)?

    public init(
        maxItems: Int = lunoraDefaultMaxQueuedMutations,
        queueBeforeFirstConnect: Bool = false,
        persistence: LunoraPersistenceAdapter? = nil,
        version: String? = nil
    ) {
        self.maxItems = max(1, maxItems)
        self.queueBeforeFirstConnect = queueBeforeFirstConnect
        self.persistence = persistence
        self.version = version
    }

    public var size: Int { items.count }

    /// A snapshot of the queued writes, oldest first.
    public func snapshot() -> [LunoraQueuedMutation] { items }

    /// Adds a write to the back of the queue, persisting it and capping the queue.
    /// Returns whatever the cap evicted, for the caller to report.
    @discardableResult
    public func enqueue(_ entry: LunoraQueuedMutation) -> [LunoraDiscarded] {
        if entry.id.isEmpty { entry.id = lunoraRandomID() }

        items.append(entry)

        if let persistence {
            persist("append", entry.id) { try persistence.append(try entry.record(version: version)) }
        }

        let evicted = evictOverflow()

        notifySize()

        return evicted
    }

    /// Restores writes persisted in a prior session.
    ///
    /// Returns the distinct shard keys of the records that SURVIVED — so the
    /// caller can open exactly those sockets to trigger a flush — alongside
    /// whatever the capacity cap evicted. A no-op with no adapter configured.
    ///
    /// Restored records are placed AHEAD of whatever is already queued. Hydration
    /// runs after construction (a durable load takes time), so a write submitted
    /// during that boot window is already in the array — and the store's order is
    /// authoritative, since a prior-session write is always older. Appending would
    /// let a boot-time write replay first and last-writer-wins clobber newer data
    /// with stale.
    public func hydrate() throws -> (shardKeys: [String?], evicted: [LunoraDiscarded]) {
        guard let persistence else { return ([], []) }

        let persisted = try persistence.load()
        var seen = Set(items.map(\.id))
        var restored: [LunoraQueuedMutation] = []

        for record in persisted {
            let id = record["id"] as? String ?? ""

            if seen.contains(id) { continue }

            seen.insert(id)

            if lunoraIsStaleVersion(version, record["version"] as? String) {
                persist("remove", id) { try persistence.remove(id) }

                continue
            }

            restored.append(LunoraQueuedMutation.fromRecord(record))
        }

        let restoredIDs = restored.map(\.id)

        items = restored + items

        // A store holding more than `maxItems` (the cap was lowered between
        // sessions, or writes piled up across restarts) must not bypass it.
        let evicted = evictOverflow()

        notifySize()

        // Shard keys are read AFTER eviction, from the entries that actually
        // survived: eviction drops from the front — the oldest restored records —
        // so a key gathered beforehand can name a shard with nothing queued.
        let survivors = Set(items.map(\.id))
        var shardKeys: [String?] = []

        for id in restoredIDs where survivors.contains(id) {
            guard let entry = items.first(where: { $0.id == id }) else { continue }

            if !shardKeys.contains(where: { $0 == entry.shardKey }) { shardKeys.append(entry.shardKey) }
        }

        return (shardKeys, evicted)
    }

    /// Removes and returns queued writes, oldest first, keeping only the ones the
    /// predicate accepts. A predicate that always matches drains everything; a
    /// shard-scoped one flushes that shard while others are down, leaving the rest
    /// queued in order.
    public func drain(where predicate: (LunoraQueuedMutation) -> Bool) -> [LunoraQueuedMutation] {
        // One pass, not two filters: the predicate is the caller's, and calling it
        // twice per entry would double any side effect it happens to carry.
        var drained: [LunoraQueuedMutation] = []
        var kept: [LunoraQueuedMutation] = []

        for item in items {
            if predicate(item) {
                drained.append(item)
            } else {
                kept.append(item)
            }
        }

        if !drained.isEmpty {
            items = kept
            notifySize()
        }

        return drained
    }

    /// Returns drained writes to the FRONT, in order, without re-persisting them:
    /// they were never un-persisted, so durable storage still holds them. Used when
    /// a flush aborts on a transient failure and the unreplayed writes must wait
    /// for the next reconnect.
    public func requeue(_ entries: [LunoraQueuedMutation]) {
        guard !entries.isEmpty else { return }

        items = entries + items
        notifySize()
    }

    /// Drops the writes whose precondition no longer holds and returns them. Run at
    /// the start of a flush to weed out writes whose assumptions died while the
    /// client was offline; the admitted writes keep their FIFO order.
    public func drainConflict() -> [LunoraDiscarded] {
        drain { entry in entry.precondition.map { !$0() } ?? false }
            .map {
                LunoraDiscarded(
                    entry: $0,
                    code: lunoraOfflinePreconditionFailed,
                    message: "offline mutation skipped: precondition failed before replay"
                )
            }
    }

    /// Forgets one write's durable record, after it has terminally settled.
    public func unpersist(_ mutationID: String) {
        guard let persistence else { return }

        persist("remove", mutationID) { try persistence.remove(mutationID) }
    }

    /// Empties the queue and returns every pending write, so no caller is left
    /// waiting on a dead client.
    ///
    /// Durable storage is left INTACT on purpose: closing must not discard writes
    /// a future session will restore. Use the adapter's own `clear` to purge them.
    public func clear() -> [LunoraDiscarded] {
        let drained = items

        items = []
        notifySize()

        return drained.map {
            LunoraDiscarded(entry: $0, code: lunoraClientClosed, message: "client closed with the write still queued")
        }
    }

    /// Drops from the FRONT (the oldest) until the queue is within capacity. Shared
    /// by ``enqueue(_:)`` and ``hydrate()`` so an overflow always drops the same
    /// way regardless of which side pushed past the cap.
    private func evictOverflow() -> [LunoraDiscarded] {
        var evicted: [LunoraDiscarded] = []

        while items.count > maxItems {
            let dropped = items.removeFirst()

            unpersist(dropped.id)
            evicted.append(
                LunoraDiscarded(entry: dropped, code: lunoraOfflineQueueOverflow, message: "offline queue overflow")
            )
        }

        return evicted
    }

    private func persist(_ operation: String, _ mutationID: String?, _ call: () throws -> Void) {
        do {
            try call()
        } catch {
            onPersistenceError?(operation, error, mutationID)
        }
    }

    private func notifySize() {
        onSizeChange?(items.count)
    }
}
