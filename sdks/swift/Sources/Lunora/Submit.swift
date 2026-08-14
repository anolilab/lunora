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
